// Runs replies, chat titles and memory reads on Claude Code, through the Claude Agent SDK.
//
// A reply is one `query()`: the chat's own system prompt, the tool sets it has on (see
// module.ts), and the new user message. Each tool set is an in-process MCP server whose tools are
// all deferred behind the SDK's ToolSearch, so the prompt carries one tool schema however many
// tools there are; the model loads the ones it needs. Claude Code keeps each chat's history in
// its own session files (in this app's data folder, not the user's ~/.claude), and the next turn
// resumes the session of the reply it answers (see history.ts).
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { CanUseTool, HookCallback, HookJSONOutput, McpServerConfig, McpServerStatus, Options, SDKAssistantMessageError, SDKMessage, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { Context, Layer } from 'effect'
import type { Step } from '@shared/steps'
import type { Effort, NewAttachmentInput, Usage } from '@shared/types'
import { errorMessage } from '../errors'
import type { RunContext, ToolModule, ToolModuleFactory } from './module'
import type { HookAnswer, Pause, Watch, WatchControl } from './watch'
import { type AccountReading, REJECTED, probeAccount, rateLimitOf } from '../usage/sdk'

/** `query` from the SDK, or a stand-in in tests. */
export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage>

/** A content block of a user message, as the Messages API takes it. */
export type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string }; title?: string }

export type Auth = { kind: 'login' } | { kind: 'apiKey'; key: string }

export interface AgentDeps {
  query: QueryFn
  /** Claude Code's own folder for this app (CLAUDE_CONFIG_DIR): sessions and its state. */
  configDir: string
  /**
   * The working directory of every query. It names the sessions folder, so it never changes; a
   * computer chat's shell commands start here too.
   */
  cwd: string
  /** "tomo/<version>", sent with every request. */
  clientApp: string
  /** The Claude Code binary, where the SDK can't find it (a packaged app keeps it outside app.asar). */
  executable?: string
  spawn?: Options['spawnClaudeCodeProcess']
}

/** Which Claude Code session a reply runs in. */
export interface SessionPlan {
  /** The session's id: the one resumed, or a new one. */
  id: string
  /** Continues `session` from its entry `at`, on a copy (`fork`) when other turns came after it. */
  resume: { session: string; at: string; fork: boolean } | null
  /** Claude Code's running total for the resumed session, which a resumed reply's total starts from. */
  baseCost: number
}

export interface ReplyRequest {
  /** The chat and the assistant message being written, for the tool sets. */
  sessionId: string
  messageId: string
  /** The job the chat is a thread of, for tool sets that keep job notes. */
  jobId?: string | null
  model: string
  effort: Effort
  /** The system prompt; each tool set's section follows it, then `profile` (what memory knows). */
  instructions: string
  profile: string
  prompt: PromptBlock[]
  session: SessionPlan
  modules: readonly ToolModuleFactory[]
  auth: Auth
  /** Watches the reply for being stuck (watch.ts): it nudges the model, or pauses the reply. */
  watch?: (control: WatchControl) => Watch
}

export interface ReplyHooks {
  text(delta: string): void
  step(step: Step): Promise<void>
  attach(file: NewAttachmentInput): Promise<void>
  /** The newest entry of this reply in its session: where the next turn continues from. */
  checkpoint(uuid: string): void
  /** A rate-limit event (the SDK's SDKRateLimitInfo; see usage/sdk.ts), or a failure on a rate limit. */
  rateLimit?(info: unknown): void
  /** A tool call started (true) or the last one running ended (false): the bot is working, or thinking again. */
  tool?(running: boolean): void
  /** What came for the reply while it ran (steering), taken once: it reaches the model with the next tool result. */
  steer?(): string | null
}

export interface ReplyResult {
  usage: Usage | null
  /** Claude Code's running total for the session afterwards, in dollars. */
  sessionCost: number | null
  /** The reply was paused because it seemed stuck; Continue resumes it. */
  paused: Pause | null
}

export interface AskRequest {
  model: string
  system: string
  prompt: string
  auth: Auth
}

export class AgentError extends Error {}

/** How long an interrupted (paused) reply gets to end on its own before it is aborted. */
const INTERRUPT_GRACE_MS = 5000

const once = async function* (content: PromptBlock[]): AsyncGenerator<SDKUserMessage> {
  yield { type: 'user', message: { role: 'user', content: content as SDKUserMessage['message']['content'] }, parent_tool_use_id: null }
}

/**
 * The environment of the Claude Code process. CLAUDE_CONFIG_DIR keeps its sessions and state in
 * this app's folder, out of the user's own Claude Code history; CLAUDE_SECURESTORAGE_CONFIG_DIR
 * keeps the sign-in where `claude` /login put it (the user's ~/.claude, or the macOS keychain
 * entry for it), so the app shares that login without copying it.
 */
export const agentEnv = (base: NodeJS.ProcessEnv, deps: Pick<AgentDeps, 'configDir' | 'clientApp'>, auth: Auth): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...base }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  if (auth.kind === 'apiKey') env.ANTHROPIC_API_KEY = auth.key
  return {
    ...env,
    CLAUDE_CONFIG_DIR: deps.configDir,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: base.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? base.CLAUDE_CONFIG_DIR ?? '',
    // A Claude sign-in otherwise brings the account's claude.ai connectors: about 25k tokens of schemas.
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    // Every MCP tool is deferred behind ToolSearch, however few there are.
    ENABLE_TOOL_SEARCH: 'true',
    CLAUDE_AGENT_SDK_CLIENT_APP: deps.clientApp
  }
}

const textOf = (content: unknown) =>
  Array.isArray(content) ? content.map((b: { type?: string; text?: string }) => (b.type === 'text' ? (b.text ?? '') : '')).join('') : ''

/**
 * The HTTP status and message of an API error as Claude Code words it, e.g. `API Error: 500
 * {"type":"error","error":{"type":"api_error","message":"Internal server error"},"request_id":"…"}`.
 */
export const apiErrorOf = (text: string): { status: number; message: string | null } | null => {
  const m = /API Error:\s*(\d{3})\b\s*([\s\S]*)/i.exec(text)
  if (!m) return null
  let message: string | null = null
  try {
    const body = JSON.parse(m[2]!.trim()) as { error?: { message?: unknown }; message?: unknown }
    const said = body.error?.message ?? body.message
    if (typeof said === 'string') message = said
  } catch {
    message = m[2]!.replace(/\s+/g, ' ').trim().slice(0, 120) || null
  }
  return { status: Number(m[1]), message }
}

/** What to tell the user when Claude Code reports an error, plus what it said (`detail`). `retries`: how often Claude Code had retried the request. */
export const describeFailure = (kind: SDKAssistantMessageError | null, detail: string, auth: Auth, model: string, retries = 0) => {
  const api = apiErrorOf(detail)
  const tried = retries > 0 ? `, still failing after ${retries} ${retries === 1 ? 'retry' : 'retries'}` : ''
  const lead = (() => {
    switch (kind) {
      case 'authentication_failed':
      case 'oauth_org_not_allowed':
        return auth.kind === 'apiKey'
          ? "Anthropic didn't accept the API key. Check it in Settings."
          : "Claude Code isn't signed in. Run `claude` in a terminal and sign in with /login, or use an Anthropic API key in Settings."
      case 'billing_error':
        return 'Your Anthropic account has a billing problem or no credit left.'
      case 'rate_limit':
        return "You've reached a usage or rate limit."
      case 'overloaded':
        return `Claude is overloaded right now${tried}. Nothing was wrong with the task or its tools; the work so far is kept, so Continue in a minute.`
      case 'server_error':
        return `Claude's API had a server error${api ? ` (${api.status})` : ''}${tried}. That's on Anthropic's side, not a problem with the task or a tool; the work so far is kept, so Continue in a minute.`
      case 'max_output_tokens':
        return 'The reply hit the longest output Claude can write in one go. Continue picks it up from there.'
      case 'invalid_request':
        return "Claude's API refused the request as invalid. Retry it; if it keeps happening, start a new chat."
      case 'model_not_found':
        return `${model} isn't available to your account.`
      case 'account_on_hold':
      case 'verification_required':
        return 'Your Anthropic account needs attention before it can be used.'
      default:
        return null
    }
  })()
  // What it said: an API error's own message, not its JSON envelope.
  const said = (api?.message ? `${api.status}: ${api.message}` : detail).replace(/\s+/g, ' ').trim().slice(0, 300)
  if (!lead) return said || 'Claude Code stopped with an error.'
  return said && !lead.includes(said) ? `${lead} (${said})` : lead
}

/** An error Claude Code reported in words only, without an assistant message saying what kind. */
const kindOf = (text: string): SDKAssistantMessageError | null =>
  /not logged in|\/login|invalid api key|invalid x-api-key/i.test(text)
    ? 'authentication_failed'
    : /credit balance|billing/i.test(text)
      ? 'billing_error'
      : /rate limit|hit your limit/i.test(text)
        ? 'rate_limit'
        : /overloaded|API Error:\s*529\b/i.test(text)
          ? 'overloaded'
          : /API Error:\s*5\d\d\b|internal server error|"api_error"/i.test(text)
            ? 'server_error'
            : null

type Failure = { kind: SDKAssistantMessageError; text: string }

/**
 * The message for a query that failed: from its error message if there was one, else from what the
 * SDK threw or the result said. An 'unknown' kind is read from the words (an API 500 can come so).
 */
const explain = (failure: Failure | null, said: string, auth: Auth, model: string, retries = 0) => {
  const detail = (failure?.text || said).replace(/^Claude Code returned an error result:\s*/, '')
  const kind = failure?.kind && failure.kind !== 'unknown' ? failure.kind : (kindOf(detail) ?? failure?.kind ?? null)
  return describeFailure(kind, detail, auth, model, retries)
}

type CallUsage = { input_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null; output_tokens?: number | null }

/** What one model call read (all of its input) and wrote: the session's size after it. */
const callSize = (u: CallUsage | null | undefined): number | null => {
  if (!u || typeof u.input_tokens !== 'number') return null
  return u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0)
}

/**
 * The reply's usage. The result sums every model call, so the session's size is the last call's
 * (`lastCall`); without one, a one-call reply's sum is that call.
 */
const usageOf = (r: SDKResultMessage, cost: number | null, lastCall: number | null = null): Usage => {
  const u = r.usage
  const input = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  const thinking = (u as { output_tokens_details?: { thinking_tokens?: number } }).output_tokens_details?.thinking_tokens ?? 0
  const contextTokens = lastCall ?? (r.num_turns <= 1 ? input + u.output_tokens : null)
  return {
    ...(contextTokens !== null ? { contextTokens } : {}),
    promptTokens: input,
    completionTokens: u.output_tokens,
    totalTokens: input + u.output_tokens,
    cachedTokens: u.cache_read_input_tokens,
    cacheWriteTokens: u.cache_creation_input_tokens,
    reasoningTokens: thinking,
    cost,
    requests: r.num_turns
  }
}

const NO_ANSWER: HookAnswer = { context: null, stop: null }

/** A failed tool result's words, in one short line for its step (Claude Code wraps them in <tool_use_error>). */
export const failureLine = (content: unknown): string | null => {
  const text = typeof content === 'string' ? content : textOf(content)
  const line = text
    .replace(/<\/?tool_use_error>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return line ? (line.length > 160 ? `${line.slice(0, 159).trimEnd()}…` : line) : null
}

/**
 * Tool results reach the watch as soon as Claude Code has them, before the model sees them: a
 * nudge rides along with the result (additionalContext), and a pause stops the reply right there
 * (continue: false). What came for the reply meanwhile (`steer`) rides along the same way. A
 * subagent's calls are its own.
 */
export const replyHooks = (watch: Watch | null, steer: (() => string | null) | undefined): Options['hooks'] => {
  const answer = (a: HookAnswer, event: 'PostToolUse' | 'PostToolUseFailure'): HookJSONOutput => {
    if (a.stop) return { continue: false, stopReason: a.stop.reason }
    const context = [a.context, steer?.()].filter(Boolean).join('\n\n')
    return context ? { hookSpecificOutput: { hookEventName: event, additionalContext: context } } : {}
  }
  const after: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PostToolUse' || input.agent_id) return {}
    const r = input.tool_response as { isError?: unknown } | null
    const failed = !!r && typeof r === 'object' && r.isError === true
    return answer(watch ? watch.hook(input.tool_use_id, input.tool_name, input.tool_input, input.tool_response, failed) : NO_ANSWER, 'PostToolUse')
  }
  const failure: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PostToolUseFailure' || input.agent_id || input.is_interrupt) return {}
    return answer(watch ? watch.hook(input.tool_use_id, input.tool_name, input.tool_input, input.error, true) : NO_ANSWER, 'PostToolUseFailure')
  }
  return { PostToolUse: [{ hooks: [after] }], PostToolUseFailure: [{ hooks: [failure] }] }
}

/** Asks each tool set whether a call may run; calls no set owns are refused. */
const permit =
  (modules: readonly ToolModule[]): CanUseTool =>
  async (name, input, { signal }) => {
    if (name === 'ToolSearch') return { behavior: 'allow', updatedInput: input }
    for (const m of modules) {
      const own = name.startsWith(`mcp__${m.name}__`) || (m.builtins?.includes(name) ?? false)
      const answer = m.canUseTool ? await m.canUseTool(name, input, signal) : null
      if (answer) return answer.behavior === 'allow' ? { updatedInput: input, ...answer } : answer
      if (own && !m.canUseTool) return { behavior: 'allow', updatedInput: input }
    }
    return { behavior: 'deny', message: `${name} isn't available in this chat.` }
  }

const abortError = () => Object.assign(new Error('The reply was stopped'), { name: 'AbortError' })

/** A query's MCP status request (Query.mcpServerStatus), where the stream has one. */
type StatusQuery = { mcpServerStatus?: () => Promise<McpServerStatus[]> }

/** The step line for a server of the user's that a reply couldn't reach. */
export const unreachableStep = (s: Pick<McpServerStatus, 'name' | 'status' | 'error'>): Step => ({
  tool: 'mcp',
  label: `Couldn't connect to ${s.name}`,
  ok: false,
  detail: s.status === 'needs-auth' ? 'It asks for a browser sign-in, which Tomo can’t do yet: see Settings › Connections' : (s.error?.trim() || 'It failed to connect').slice(0, 160)
})

/**
 * Starts the given MCP servers in a Claude Code process that sends no message, so no model is
 * called, and waits until none is still connecting (or `timeoutMs` passes): how each one went, with
 * its tools. The process is closed afterwards, which stops the servers it started.
 */
export const probeMcp = async (query: QueryFn, options: Options, servers: Record<string, McpServerConfig>, timeoutMs = 45_000, pollMs = 300): Promise<McpServerStatus[]> => {
  let release = () => {}
  const held = new Promise<void>((r) => (release = r))
  const abort = new AbortController()
  const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
    await held
  })()
  const q = query({ prompt, options: { ...options, abortController: abort, persistSession: false, tools: [], maxTurns: 1, mcpServers: servers } }) as AsyncIterable<SDKMessage> &
    StatusQuery & { close?: () => void }
  let ended: unknown = null
  const drain = (async () => {
    try {
      for await (const _ of q) void _
    } catch (e) {
      ended = e
    }
    ended ??= new Error('Claude Code ended before the servers connected.')
  })()
  try {
    if (typeof q.mcpServerStatus !== 'function') throw new Error("This version of Claude Code can't report MCP servers.")
    const until = Date.now() + timeoutMs
    let last: McpServerStatus[] = []
    for (;;) {
      if (ended) throw ended
      last = await q.mcpServerStatus()
      if (!last.some((s) => s.status === 'pending') || Date.now() >= until) return last
      await new Promise((r) => setTimeout(r, pollMs))
    }
  } finally {
    release()
    abort.abort()
    try {
      q.close?.()
    } catch {
      // Already closed.
    }
    void drain
  }
}

export interface AgentApi {
  /** Runs one reply. Aborting `signal` stops it; the promise then rejects with an AbortError. */
  readonly reply: (req: ReplyRequest, hooks: ReplyHooks, signal: AbortSignal) => Promise<ReplyResult>
  /** One short answer, no tools: a chat title, a memory read. */
  readonly ask: (req: AskRequest, signal: AbortSignal) => Promise<string>
  /** Whether Claude Code still has this session's file to resume. */
  readonly hasSession: (id: string) => boolean
  /** Deletes the files of sessions no chat needs any more. */
  readonly forget: (ids: readonly string[]) => void
  /** A session's transcript files: its own, then its subagents' (kept beside it), each with a name relative to the session. */
  readonly transcripts: (id: string) => Array<{ path: string; name: string }>
  /** Reads the account's usage meter, without calling a model (see usage/sdk.ts). */
  readonly readUsage: (auth: Auth) => Promise<AccountReading>
  /** Connects to MCP servers as a reply would, without calling a model: how each went, and its tools. */
  readonly mcpStatus: (servers: Record<string, McpServerConfig>, timeoutMs?: number) => Promise<McpServerStatus[]>
}

export const makeAgent = (deps: AgentDeps): AgentApi => {
  const base = (auth: Auth): Options => ({
    env: agentEnv(process.env, deps, auth),
    cwd: deps.cwd,
    // None of the user's Claude Code settings, CLAUDE.md files, MCP servers or plugins.
    settingSources: [],
    strictMcpConfig: true,
    // A title of its own stops Claude Code naming the session with a model call of its own.
    title: 'Tomo',
    ...(deps.executable ? { pathToClaudeCodeExecutable: deps.executable } : {}),
    ...(deps.spawn ? { spawnClaudeCodeProcess: deps.spawn } : {})
  })

  const sessionFiles = (id: string) => {
    const projects = join(deps.configDir, 'projects')
    if (!existsSync(projects)) return []
    return readdirSync(projects).flatMap((dir) => {
      const file = join(projects, dir, `${id}.jsonl`)
      return existsSync(file) ? [file] : []
    })
  }

  const reply: AgentApi['reply'] = async (req, hooks, signal) => {
    const abort = new AbortController()
    const stop = () => abort.abort()
    signal.addEventListener('abort', stop)
    if (signal.aborted) stop()
    // A new text block after earlier text starts a new paragraph (a step between them already did).
    let wroteText = false
    let endsWithNewline = true
    const text = (delta: string) => {
      if (delta === '' || abort.signal.aborted) return
      hooks.text(delta)
      wroteText = true
      endsWithNewline = delta.endsWith('\n')
    }
    const ctx: RunContext = {
      sessionId: req.sessionId,
      messageId: req.messageId,
      jobId: req.jobId ?? null,
      signal: abort.signal,
      step: async (step) => {
        if (abort.signal.aborted) return
        await hooks.step(step)
        wroteText = false
      },
      attach: (file) => hooks.attach(file)
    }
    const modules: ToolModule[] = []
    // A pause away from a hook: the query is interrupted (aborted if that fails or takes too
    // long), and the reply ends paused with everything it did kept.
    let pausing: Pause | null = null
    let running: { interrupt?: () => Promise<unknown> } | null = null
    let grace: ReturnType<typeof setTimeout> | null = null
    const control: WatchControl = {
      stop: (p) => {
        if (pausing || abort.signal.aborted) return
        pausing = p
        const interrupt = running?.interrupt
        if (typeof interrupt !== 'function') return abort.abort()
        grace = setTimeout(() => abort.abort(), INTERRUPT_GRACE_MS)
        interrupt.call(running).catch(() => abort.abort())
      }
    }
    const watch = req.watch?.(control) ?? null
    /**
     * The user's own servers not known to be up yet. Claude Code connects to them while the reply
     * starts; one that fails gets a step line, so the user knows why its tools didn't come.
     */
    const unsettled = new Set<string>()
    let checking = false
    const checkServers = () => {
      const q = running as StatusQuery | null
      if (unsettled.size === 0 || checking || typeof q?.mcpServerStatus !== 'function') return
      checking = true
      q.mcpServerStatus()
        .then(async (list) => {
          for (const s of list) {
            if (!unsettled.has(s.name) || s.status === 'pending') continue
            unsettled.delete(s.name)
            if (s.status === 'failed' || s.status === 'needs-auth') await ctx.step(unreachableStep(s))
          }
        })
        .catch(() => undefined)
        .finally(() => (checking = false))
    }
    /** The size of the session after the reply's latest model call, as that call reported it. */
    let lastCall: number | null = null
    /** The reply's pause, if the watch paused it (and the user didn't stop it meanwhile). */
    const pausedResult = (result: SDKResultMessage | null): ReplyResult | null => {
      const p = watch?.paused ?? pausing
      if (!p || signal.aborted) return null
      const sessionCost = result?.total_cost_usd ?? null
      return { usage: result ? usageOf(result, Math.max(0, result.total_cost_usd - req.session.baseCost), lastCall) : null, sessionCost, paused: p }
    }
    try {
      for (const make of req.modules) modules.push(make(ctx))
      for (const m of modules) if (m.external) unsettled.add(m.name)
      const system = [req.instructions, ...modules.map((m) => m.instructions), req.profile]
        .map((s) => s.trim())
        .filter(Boolean)
        .join('\n\n')
      const { resume } = req.session
      const options: Options = {
        ...base(req.auth),
        model: req.model,
        effort: req.effort,
        // Rendered on every request rather than kept from the first: a chat's instructions and
        // tools can change between turns.
        systemPrompt: { type: 'custom', prompt: system, snapshot: false },
        // No built-in tools but what a tool set asks for, and ToolSearch to load the sets' tools.
        tools: modules.length > 0 ? ['ToolSearch', ...new Set(modules.flatMap((m) => m.builtins ?? []))] : [],
        mcpServers: Object.fromEntries(modules.map((m) => [m.name, m.server])),
        canUseTool: permit(modules),
        includePartialMessages: true,
        // No cap on model calls: the watch pauses a reply that is stuck instead.
        ...(watch || hooks.steer ? { hooks: replyHooks(watch, hooks.steer && (() => (abort.signal.aborted ? null : hooks.steer!()))) } : {}),
        abortController: abort,
        ...(resume
          ? { resume: resume.session, resumeSessionAt: resume.at, ...(resume.fork ? { forkSession: true, sessionId: req.session.id } : {}) }
          : { sessionId: req.session.id })
      }
      let result: SDKResultMessage | null = null
      let failure: Failure | null = null
      // Built-in tool calls waiting for their result, with the step line each gets then.
      const builtinCalls = new Map<string, Step>()
      // Tool calls waiting for their result, for the bot's presence.
      const pendingCalls = new Set<string>()
      // A failure on a rate limit pauses the reply (services/Chat.ts) when no event said so already.
      let rejected = false
      // How often Claude Code retried a failing API request (a 500, an overload) before giving up.
      let retries = 0
      const limited = (said: string) => {
        if (rejected || (failure?.kind ?? kindOf(said)) !== 'rate_limit') return
        rejected = true
        hooks.rateLimit?.(REJECTED)
      }
      try {
        const stream = deps.query({ prompt: once(req.prompt), options })
        running = stream as { interrupt?: () => Promise<unknown> }
        for await (const m of stream) {
          if (abort.signal.aborted) break
          const limit = rateLimitOf(m)
          if (limit !== undefined) {
            rejected ||= (limit as { status?: string }).status === 'rejected'
            hooks.rateLimit?.(limit)
            continue
          }
          if (m.type === 'system' && m.subtype === 'api_retry') {
            retries = Math.max(retries, m.attempt)
            continue
          }
          // A subagent's messages; the reply is the main thread's.
          if ('parent_tool_use_id' in m && m.parent_tool_use_id) continue
          if (m.type === 'stream_event') {
            const e = m.event
            // Once paused, what still streams in before the query ends isn't kept.
            if (pausing || watch?.paused) continue
            if (e.type === 'content_block_start' && e.content_block.type === 'text' && wroteText) text(endsWithNewline ? '\n' : '\n\n')
            else if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') {
              text(e.delta.text)
              watch?.text(e.delta.text)
            }
          } else if (m.type === 'assistant') {
            hooks.checkpoint(m.uuid)
            lastCall = callSize((m.message as { usage?: CallUsage }).usage) ?? lastCall
            // One model call can come as several assistant messages, all with its message id.
            watch?.step((m.message as { id?: string }).id ?? m.uuid)
            if (m.error) failure = { kind: m.error, text: textOf(m.message.content) }
            // A call went through: retries before it are over.
            else retries = 0
            if (m.error === 'rate_limit') limited('')
            // A tool call: the text before it is done, so a step line can come now.
            if (m.message.content.some((b) => b.type === 'tool_use')) checkServers()
            for (const b of m.message.content) {
              if (b.type !== 'tool_use') continue
              if (pendingCalls.size === 0) hooks.tool?.(true)
              pendingCalls.add(b.id)
              watch?.call(b.id, b.name, b.input)
              const owner = modules.find((x) => x.builtins?.includes(b.name) || (x.external && b.name.startsWith(`mcp__${x.name}__`)))
              const step = owner?.stepFor?.(b.name, (b.input ?? {}) as Record<string, unknown>)
              if (step) builtinCalls.set(b.id, step)
            }
          } else if (m.type === 'user') {
            // Tool results: a reply stopped after one continues from there.
            const uuid = (m as { uuid?: string }).uuid
            if (uuid) hooks.checkpoint(uuid)
            const content = m.message.content
            for (const b of Array.isArray(content) ? content : []) {
              if (b.type === 'tool_result') {
                watch?.result(b.tool_use_id, b.content, b.is_error ?? false)
                if (pendingCalls.delete(b.tool_use_id) && pendingCalls.size === 0) hooks.tool?.(false)
              }
              const step = b.type === 'tool_result' ? builtinCalls.get(b.tool_use_id) : undefined
              if (!step || b.type !== 'tool_result') continue
              builtinCalls.delete(b.tool_use_id)
              // A failed built-in says why on its step line, not only that it failed.
              const why = b.is_error ? failureLine(b.content) : null
              await ctx.step({ ...step, ok: step.ok && !b.is_error, ...(why ? { detail: step.detail ? `${step.detail} · ${why}` : why } : {}) })
            }
          } else if (m.type === 'result') result = m
        }
      } catch (e) {
        // Paused: however the query ended, the work so far is kept and Continue resumes it.
        const p = pausedResult(result)
        if (p) return p
        if (abort.signal.aborted) throw abortError()
        limited(errorMessage(e))
        throw new AgentError(explain(failure, errorMessage(e), req.auth, req.model, retries))
      }
      const p = pausedResult(result)
      if (p) return p
      if (abort.signal.aborted) throw abortError()
      if (!result) throw new AgentError(failure ? explain(failure, '', req.auth, req.model, retries) : 'Claude Code ended before the reply did.')
      const sessionCost = result.total_cost_usd
      const usage = usageOf(result, Math.max(0, sessionCost - req.session.baseCost), lastCall)
      if (result.subtype !== 'success' || result.is_error) {
        const said = result.subtype === 'success' ? result.result : result.errors.join(' ')
        limited(said)
        throw new AgentError(explain(failure, said, req.auth, req.model, retries))
      }
      return { usage, sessionCost, paused: null }
    } finally {
      signal.removeEventListener('abort', stop)
      if (grace) clearTimeout(grace)
      watch?.end()
      // The tool sets' signal: the reply has ended, however it ended.
      abort.abort()
      await Promise.allSettled(modules.map((m) => m.end?.()))
    }
  }

  const ask: AgentApi['ask'] = async (req, signal) => {
    const abort = new AbortController()
    const stop = () => abort.abort()
    signal.addEventListener('abort', stop)
    try {
      let text = ''
      let result: SDKResultMessage | null = null
      let failure: Failure | null = null
      const options: Options = {
        ...base(req.auth),
        model: req.model,
        systemPrompt: { type: 'custom', prompt: req.system, snapshot: false },
        tools: [],
        persistSession: false,
        maxTurns: 1,
        effort: 'low',
        thinking: { type: 'disabled' },
        abortController: abort
      }
      try {
        for await (const m of deps.query({ prompt: once([{ type: 'text', text: req.prompt }]), options })) {
          if (m.type === 'assistant' && !m.parent_tool_use_id) {
            if (m.error) failure = { kind: m.error, text: textOf(m.message.content) }
            else text += textOf(m.message.content)
          } else if (m.type === 'result') result = m
        }
      } catch (e) {
        if (abort.signal.aborted) throw abortError()
        throw new AgentError(explain(failure, errorMessage(e), req.auth, req.model))
      }
      if (abort.signal.aborted) throw abortError()
      if (failure || !result || result.is_error || result.subtype !== 'success')
        throw new AgentError(explain(failure, result?.subtype === 'success' ? result.result : (result?.errors.join(' ') ?? ''), req.auth, req.model))
      return text
    } finally {
      signal.removeEventListener('abort', stop)
      abort.abort()
    }
  }

  return {
    reply,
    ask,
    hasSession: (id) => sessionFiles(id).length > 0,
    transcripts: (id) =>
      sessionFiles(id).flatMap((file) => {
        const beside = file.replace(/\.jsonl$/, '')
        const extra = existsSync(beside)
          ? readdirSync(beside, { recursive: true, withFileTypes: true })
              .filter((e) => e.isFile())
              .map((e) => {
                const path = join(e.parentPath, e.name)
                return { path, name: `${id}/${relative(beside, path).replace(/\\/g, '/')}` }
              })
          : []
        return [{ path: file, name: `${id}.jsonl` }, ...extra]
      }),
    readUsage: (auth) => probeAccount(deps.query, base(auth)),
    mcpStatus: (servers, timeoutMs) => probeMcp(deps.query, base({ kind: 'login' }), servers, timeoutMs),
    forget: (ids) => {
      for (const id of ids)
        for (const file of sessionFiles(id)) {
          rmSync(file, { force: true })
          // Claude Code keeps a session's subagent transcripts beside it.
          rmSync(file.replace(/\.jsonl$/, ''), { recursive: true, force: true })
        }
    }
  }
}

export class Agent extends Context.Service<Agent, AgentApi>()('chat-v2/Agent') {
  static readonly layer = (deps: AgentDeps) => Layer.sync(Agent, () => Agent.of(makeAgent(deps)))
}
