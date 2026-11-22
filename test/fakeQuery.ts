// A stand-in for the SDK's `query`: each call runs a script that yields the messages Claude Code
// would, and calls the tool sets' tools for real, through MCP and canUseTool as Claude Code does.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpSdkServerConfigWithInstance, Options, PermissionResult, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { QueryFn } from '../src/main/agent/driver'

export interface Call {
  /** The user message's content blocks. */
  prompt: Array<{ type: string; text?: string; source?: { media_type: string } }>
  options: Options
  /** The session this query writes to: the one resumed in place, or the new id. */
  session: string
}

type ToolResult = { content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean }

export interface Turn {
  call: Call
  /** Text streamed as one block, then the assistant message that holds it. */
  text(...deltas: string[]): SDKMessage[]
  /** A tool call: asks canUseTool, runs the tool, and yields the call and its result. */
  tool(name: string, input?: Record<string, unknown>): AsyncGenerator<SDKMessage, { permission: PermissionResult; result: ToolResult | null }>
  /** The end of the query, with what it cost (Claude Code's running total for the session). */
  result(over?: { cost?: number; turns?: number; subtype?: string; isError?: boolean; text?: string }): SDKMessage
  /** An API error as Claude Code reports it: a synthetic assistant message, then an error result. */
  apiError(kind: string, text: string): SDKMessage[]
  /** Waits for `gate`, or throws as the SDK does when the query is aborted first. */
  wait(gate: Promise<unknown>): Promise<void>
  /** A rate-limit event, as Claude Code sends one on a Claude sign-in (SDKRateLimitInfo). */
  rateLimit(info: Record<string, unknown>): SDKMessage
}

export type Script = (t: Turn) => AsyncGenerator<SDKMessage, void, undefined>

let seq = 0
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

const abortError = () => Object.assign(new Error('Claude Code process aborted by user'), { name: 'AbortError' })

export interface FakeOptions {
  /**
   * Answers the usage control request (SDKControlGetUsageResponse) of a query that sends no
   * message (usage/sdk.ts probeAccount); without it, such a query has no usage method.
   */
  usage?: () => unknown | Promise<unknown>
}

export const fakeQuery = (script: Script, fakeOptions: FakeOptions = {}) => {
  const calls: Call[] = []
  /** Usage reads answered. */
  const usageReads: Options[] = []
  const probe = (options: Options) => {
    const signal = options.abortController?.signal
    const q = (async function* (): AsyncGenerator<SDKMessage> {
      if (signal && !signal.aborted) await new Promise((r) => signal.addEventListener('abort', r))
    })()
    if (!fakeOptions.usage) return q
    const usage = fakeOptions.usage
    return Object.assign(q, {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
        usageReads.push(options)
        return usage()
      },
      close: () => options.abortController?.abort()
    })
  }
  type State = { ended: boolean; interrupted: boolean }
  const run = (params: Parameters<QueryFn>[0], state: State) =>
    (async function* () {
      const options = params.options
      let prompt: Call['prompt'] = []
      for await (const m of params.prompt as AsyncIterable<SDKUserMessage>) {
        prompt = m.message.content as Call['prompt']
        break
      }
      const session = options.resume && !options.forkSession ? options.resume : options.sessionId!
      const call: Call = { prompt, options, session }
      calls.push(call)
      // Claude Code writes the session where CLAUDE_CONFIG_DIR says.
      const configDir = options.env?.CLAUDE_CONFIG_DIR
      if (configDir && options.persistSession !== false) {
        mkdirSync(join(configDir, 'projects', 'C--test'), { recursive: true })
        writeFileSync(join(configDir, 'projects', 'C--test', `${session}.jsonl`), '{}\n')
      }
      const signal = options.abortController?.signal
      const base = { session_id: session, parent_tool_use_id: null }
      const clients = new Map<string, Client>()
      const clientFor = async (server: string) => {
        let client = clients.get(server)
        if (client) return client
        const config = options.mcpServers?.[server] as McpSdkServerConfigWithInstance
        const [a, b] = InMemoryTransport.createLinkedPair()
        await (config.instance as unknown as { connect(t: unknown): Promise<void> }).connect(b)
        client = new Client({ name: 'fake-claude-code', version: '1' })
        await client.connect(a)
        clients.set(server, client)
        return client
      }
      const turn: Turn = {
        call,
        text: (...deltas) => [
          { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, uuid: uuid(), ...base },
          ...deltas.map((d) => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: d } }, uuid: uuid(), ...base })),
          { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: deltas.join('') }] }, uuid: uuid(), ...base }
        ] as unknown as SDKMessage[],
        tool: async function* (name, input = {}) {
          const id = `toolu_${uuid().slice(-6)}`
          yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, uuid: uuid(), ...base } as unknown as SDKMessage
          const permission = (await options.canUseTool!(name, input, { signal: signal ?? new AbortController().signal, toolUseID: id } as never)) as PermissionResult
          let result: ToolResult | null = null
          if (permission.behavior === 'allow') {
            const [, server, tool] = /^mcp__([^_]+)__(.+)$/.exec(name) ?? []
            if (server && tool) result = (await (await clientFor(server)).callTool({ name: tool, arguments: (permission.updatedInput ?? input) as Record<string, unknown> })) as ToolResult
          }
          const content = result?.content ?? [{ type: 'text', text: permission.behavior === 'deny' ? permission.message : '' }]
          // PostToolUse hooks, as Claude Code runs them for a call that ran: their context rides along
          // with the result, and `continue: false` ends the query after it.
          if (permission.behavior === 'allow') {
            const failed = result?.isError === true
            const event = failed ? 'PostToolUseFailure' : 'PostToolUse'
            const input_ = failed
              ? { hook_event_name: event, tool_name: name, tool_input: input, tool_use_id: id, error: content.map((c) => c.text ?? '').join('') }
              : { hook_event_name: event, tool_name: name, tool_input: input, tool_use_id: id, tool_response: result }
            for (const matcher of options.hooks?.[event] ?? [])
              for (const hook of matcher.hooks) {
                const out = (await hook({ session_id: session, transcript_path: '', cwd: '', ...input_ } as never, id, { signal: signal ?? new AbortController().signal })) as {
                  continue?: boolean
                  hookSpecificOutput?: { additionalContext?: string }
                }
                const context = out.hookSpecificOutput?.additionalContext
                if (context) content.push({ type: 'text', text: `<system-reminder>\n${context}\n</system-reminder>` })
                if (out.continue === false) state.ended = true
              }
          }
          yield { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, uuid: uuid(), ...base } as unknown as SDKMessage
          return { permission, result }
        },
        result: (over = {}) =>
          ({
            type: 'result',
            subtype: over.subtype ?? 'success',
            is_error: over.isError ?? false,
            result: over.text ?? '',
            errors: over.text ? [over.text] : [],
            num_turns: over.turns ?? 1,
            total_cost_usd: over.cost ?? 0.001,
            usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 5, output_tokens_details: { thinking_tokens: 2 } },
            duration_ms: 1,
            duration_api_ms: 1,
            stop_reason: null,
            modelUsage: {},
            permission_denials: [],
            uuid: uuid(),
            session_id: session
          }) as unknown as SDKMessage,
        apiError: (kind, text) => [
          { type: 'assistant', error: kind, message: { role: 'assistant', content: [{ type: 'text', text }] }, uuid: uuid(), ...base } as unknown as SDKMessage,
          turn.result({ isError: true, text })
        ],
        rateLimit: (info) => ({ type: 'rate_limit_event', rate_limit_info: info, uuid: uuid(), session_id: session }) as unknown as SDKMessage,
        wait: (gate) =>
          new Promise<void>((resolve, reject) => {
            if (signal?.aborted) return reject(abortError())
            signal?.addEventListener('abort', () => reject(abortError()))
            void gate.then(() => resolve())
          })
      }
      try {
        yield { type: 'system', subtype: 'init', tools: options.tools, mcp_servers: [], model: options.model, session_id: session, uuid: uuid() } as unknown as SDKMessage
        for await (const m of script(turn)) {
          if (signal?.aborted) throw abortError()
          if (state.interrupted) {
            yield turn.result({ subtype: 'error_during_execution', isError: true })
            return
          }
          yield m
          if (state.ended) {
            yield turn.result()
            return
          }
        }
      } finally {
        for (const c of clients.values()) await c.close()
      }
    })()
  /** How many times interrupt() was called, over all queries. */
  let interrupts = 0
  // Like the SDK's Query: an async generator with interrupt(), which ends the turn at the next
  // message. A hook's `continue: false` ends it too. A query with no system prompt sends no
  // message: it only asks Claude Code something (the usage probe).
  const query: QueryFn = (params) => {
    if (!params.options.systemPrompt) return probe(params.options)
    const state: State = { ended: false, interrupted: false }
    return Object.assign(run(params, state), {
      interrupt: async () => {
        interrupts++
        state.interrupted = true
      }
    })
  }
  /** The same without interrupt(), as a stand-in that can only be aborted. */
  const plain: QueryFn = (params) => (!params.options.systemPrompt ? probe(params.options) : run(params, { ended: false, interrupted: false }))
  return { query, plain, calls, usageReads, interrupts: () => interrupts }
}
