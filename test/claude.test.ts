import { afterEach, describe, expect, test } from 'bun:test'
import { Effect, Stream } from 'effect'
import { claudeClient, claudeParams, claudeUsage, streamClaude, toClaudeMessages } from '../src/main/claude'
import type { ChatDelta, ChatMessage, ChatRequest } from '../src/main/services/OpenRouter'
import { parseStep, splitSteps } from '../src/shared/steps'

// These run the real Anthropic SDK against a local server that streams scripted SSE.

type Event = { type: string; [key: string]: unknown }

const sse = (events: Event[]) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')

const start = (model = 'claude-opus-5-5', usage: object = { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }): Event => ({
  type: 'message_start',
  message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage }
})
const end = (stop_reason: string, usage: object = { output_tokens: 200 }): Event[] => [
  { type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage },
  { type: 'message_stop' }
]
const block = (index: number, content_block: object, deltas: object[] = []): Event[] => [
  { type: 'content_block_start', index, content_block },
  ...deltas.map((delta) => ({ type: 'content_block_delta', index, delta })),
  { type: 'content_block_stop', index }
]

let server: ReturnType<typeof Bun.serve> | null = null
afterEach(() => {
  delete process.env.ANTHROPIC_BASE_URL
  server?.stop(true)
  server = null
})

/** Serves one scripted response per request, in order, and keeps the request bodies. */
const serve = (responses: Event[][]) => {
  const bodies: any[] = []
  const headers: Headers[] = []
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      bodies.push(await req.json())
      headers.push(req.headers)
      const events = responses[bodies.length - 1]
      if (!events) return new Response('no more responses', { status: 500 })
      return new Response(sse(events), { headers: { 'content-type': 'text/event-stream' } })
    }
  })
  return { url: `http://localhost:${server.port}`, bodies, headers }
}

const run = (url: string, req: ChatRequest, research: { effort: 'high'; maxSearches: number } | null = null) => {
  process.env.ANTHROPIC_BASE_URL = url
  const client = claudeClient('test-key')
  return Effect.runPromise(Stream.runCollect(streamClaude(client, req, research, new AbortController().signal)))
}

const textOf = (deltas: readonly ChatDelta[]) => deltas.flatMap((d) => (d.type === 'text' ? [d.text] : [])).join('')

describe('toClaudeMessages', () => {
  test('keeps the system prompt apart, and turns tool calls and results into blocks in the right turns', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Buy it' },
      { role: 'assistant', content: 'Looking.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'browser_click', arguments: '{"ref":"e1"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'Clicked' },
      { role: 'user', content: [{ type: 'text', text: 'Screenshot after that step:' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] }
    ]
    const out = toClaudeMessages(messages)
    expect(out.system).toBe('Be brief.')
    expect(out.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Buy it' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'call_1', name: 'browser_click', input: { ref: 'e1' } }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'Clicked' },
          { type: 'text', text: 'Screenshot after that step:' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }
        ]
      }
    ])
  })

  test('an assistant turn Claude wrote goes back exactly as it came, thinking included', () => {
    const raw = [
      { type: 'thinking', thinking: '', signature: 'sig-abc' },
      { type: 'tool_use', id: 'toolu_1', name: 'browser_search', input: { query: 'x' } }
    ]
    const out = toClaudeMessages([
      { role: 'user', content: 'Find x' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'browser_search', arguments: '{"query":"x"}' } }],
        reasoning_details: [{ type: 'anthropic.content', index: 0, content: raw }]
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'Results' }
    ])
    expect(out.messages[1]).toEqual({ role: 'assistant', content: raw as any })
    expect(out.messages[2]!.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Results' }])
  })

  test('a message with only files carries no empty text block, which the API would reject', () => {
    const out = toClaudeMessages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'text', text: '' }] }])
    expect(out.messages[0]!.content).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }])
  })

  test('PDFs become documents', () => {
    const out = toClaudeMessages([{ role: 'user', content: [{ type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' } }, { type: 'text', text: 'Sum up' }] }])
    expect(out.messages[0]!.content).toEqual([
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' }, title: 'a.pdf' },
      { type: 'text', text: 'Sum up' }
    ])
  })
})

describe('claudeParams', () => {
  const base: ChatRequest = { model: 'claude/claude-opus-5-5', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'Hi' }], temperature: 0.7 }

  test('sends no temperature, sets an effort, and opts into refusal fallbacks', () => {
    const p = claudeParams({ ...base, reasoning: { effort: 'none' } }, null) as any
    expect(p.model).toBe('claude-opus-5-5')
    expect('temperature' in p).toBe(false)
    expect(p.output_config).toEqual({ effort: 'low' })
    expect(p.thinking).toEqual({ type: 'adaptive' })
    expect(p.fallbacks).toBe('default')
    expect(p.betas).toEqual(['server-side-fallback-2026-07-01'])
    expect(p.system).toEqual([{ type: 'text', text: 'S', cache_control: { type: 'ephemeral' } }])
  })

  test('research adds web search and fetch, and asks for progress notes', () => {
    const p = claudeParams(base, { effort: 'high', maxSearches: 12 }) as any
    expect(p.tools).toEqual([
      { type: 'web_search_20260209', name: 'web_search', max_uses: 12 },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 12 }
    ])
    expect(p.output_config).toEqual({ effort: 'high' })
    expect(p.thinking).toEqual({ type: 'adaptive', display: 'updates' })
    expect(p.max_tokens).toBe(64000)
  })

  test('a run with tools drops thinking blocks a replaced screenshot invalidates, rather than failing', () => {
    const p = claudeParams({ ...base, tools: [{ type: 'function', function: { name: 'browser_click', description: 'Click', parameters: { type: 'object' } } }] }, null) as any
    expect(p.thinking).toEqual({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } })
    expect(p.betas).toContain('thinking-binding-controls-2026-08-01')
    expect(p.tools).toEqual([{ name: 'browser_click', description: 'Click', input_schema: { type: 'object' } }])
    expect(p.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true })
    // Computer use asks for several actions a turn.
    expect((claudeParams({ ...base, tools: p.tools.map(() => ({ type: 'function', function: { name: 'computer_click', description: 'Click', parameters: { type: 'object' } } })), parallel_tool_calls: true }, null) as any).tool_choice).toBeUndefined()
  })

  test('Haiku gets no server-side fallback and the basic web tools', () => {
    const p = claudeParams({ ...base, model: 'claude/claude-haiku-5-5' }, { effort: 'high', maxSearches: 5 }) as any
    expect(p.fallbacks).toBeUndefined()
    expect(p.tools.map((t: any) => t.type)).toEqual(['web_search_20250305', 'web_fetch_20250910'])
  })
})

describe('claudeUsage', () => {
  test('prices tokens, cache and searches at list prices', () => {
    const u = claudeUsage('claude/claude-opus-5-5', {
      input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      output_tokens: 100_000,
      server_tool_use: { web_search_requests: 10, web_fetch_requests: 3 }
    } as any)
    // $4 input + $0.20 cache read + $2 output + $0.10 searches
    expect(u.cost).toBeCloseTo(6.3, 6)
    expect(u.promptTokens).toBe(2_000_000)
    expect(u.cachedTokens).toBe(1_000_000)
  })
})

describe('streamClaude', () => {
  test('research: shows searches and reads as steps, resumes a paused turn, and links the sources it cites', async () => {
    const search = { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} }
    const results = {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: [
        { type: 'web_search_result', url: 'https://example.com/pricing', title: 'Pricing', encrypted_content: 'x', page_age: null },
        { type: 'web_search_result', url: 'https://other.test/', title: 'Other', encrypted_content: 'y', page_age: null }
      ]
    }
    const fetchCall = { type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_fetch', input: {} }
    const fetched = {
      type: 'web_fetch_tool_result',
      tool_use_id: 'srvtoolu_2',
      content: { type: 'web_fetch_result', url: 'https://example.com/pricing', retrieved_at: null, content: { type: 'document', title: 'Pricing page', source: { type: 'text', media_type: 'text/plain', data: '...' } } }
    }
    const citation = { type: 'web_search_result_location', url: 'https://example.com/pricing', title: 'Pricing', cited_text: 'It costs $5', encrypted_index: 'z' }
    const { url, bodies } = serve([
      [
        start(),
        ...block(0, { type: 'text', text: '' }, [{ type: 'text_delta', text: 'I will compare prices.' }]),
        ...block(1, search, [{ type: 'input_json_delta', partial_json: '{"query":"hosting prices"}' }]),
        ...block(2, results),
        ...end('pause_turn', { output_tokens: 50, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } })
      ],
      [
        start(),
        ...block(0, fetchCall, [{ type: 'input_json_delta', partial_json: '{"url":"https://example.com/pricing"}' }]),
        ...block(1, fetched),
        ...block(2, { type: 'thinking', thinking: '', signature: '' }, [{ type: 'thinking_delta', thinking: 'The pricing page lists two plans.' }, { type: 'signature_delta', signature: 's' }]),
        ...block(3, { type: 'text', text: '', citations: [] }, [{ type: 'text_delta', text: '## Report\nIt costs $5.' }, { type: 'citations_delta', citation }]),
        ...end('end_turn')
      ]
    ])
    const deltas = await run(url, { model: 'claude/claude-opus-5-5', messages: [{ role: 'user', content: 'Compare hosting' }], research: true }, { effort: 'high', maxSearches: 10 })

    // The paused turn went back as the assistant's, with nothing added after it.
    expect(bodies).toHaveLength(2)
    expect(bodies[1].messages.at(-1).role).toBe('assistant')
    expect(bodies[1].messages.at(-1).content.map((b: any) => b.type)).toEqual(['text', 'server_tool_use', 'web_search_tool_result'])
    expect(bodies[0].tools.map((t: any) => t.name)).toEqual(['web_search', 'web_fetch'])

    const text = textOf(deltas)
    const steps = text.split('\n').map(parseStep).filter((s) => s !== null)
    expect(steps.map((s) => s.label)).toEqual(['Searched “hosting prices”', 'Read “Pricing page”', 'The pricing page lists two plans.'])
    expect(steps[0]!.detail).toBe('2 results')
    // Every step stands on its own line, so the reply splits into prose and step runs.
    expect(splitSteps(text).map((s) => s.type)).toEqual(['text', 'steps', 'text'])
    expect(text).toContain('It costs $5. [[1]](https://example.com/pricing)')
    expect(text).toContain('**Sources**\n\n1. [Pricing](https://example.com/pricing)')

    const usage = deltas.filter((d) => d.type === 'usage')
    expect(usage).toHaveLength(2)
    // The search is billed on top of the tokens.
    expect(usage[0]!.type === 'usage' && usage[0]!.usage.cost).toBeCloseTo((1000 * 4 + 50 * 20) / 1e6 + 0.01, 8)
  })

  test('tool calls stream as tool deltas, and the content comes back for the next step', async () => {
    const { url } = serve([
      [
        start(),
        ...block(0, { type: 'thinking', thinking: '', signature: '' }, [{ type: 'signature_delta', signature: 'sig-1' }]),
        ...block(1, { type: 'tool_use', id: 'toolu_9', name: 'browser_navigate', input: {} }, [
          { type: 'input_json_delta', partial_json: '{"url":' },
          { type: 'input_json_delta', partial_json: '"https://a.test"}' }
        ]),
        ...end('tool_use')
      ]
    ])
    const deltas = await run(url, {
      model: 'claude/claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'Open a.test' }],
      tools: [{ type: 'function', function: { name: 'browser_navigate', description: 'Go', parameters: { type: 'object' } } }]
    })
    const tool = deltas.filter((d) => d.type === 'tool')
    expect(tool).toEqual([
      { type: 'tool', index: 0, id: 'toolu_9', name: 'browser_navigate' },
      { type: 'tool', index: 0, args: '{"url":' },
      { type: 'tool', index: 0, args: '"https://a.test"}' }
    ])
    const reasoning = deltas.find((d) => d.type === 'reasoning')
    expect(reasoning?.type === 'reasoning' && (reasoning.details?.[0]?.content as any[]).map((b) => b.type)).toEqual(['thinking', 'tool_use'])
    expect(reasoning?.type === 'reasoning' && (reasoning.details?.[0]?.content as any[])[0].signature).toBe('sig-1')
  })

  test('API errors become provider errors with their status', async () => {
    server = Bun.serve({
      port: 0,
      fetch: () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad thing' } }), { status: 400, headers: { 'content-type': 'application/json' } })
    })
    process.env.ANTHROPIC_BASE_URL = `http://localhost:${server.port}`
    const client = claudeClient('test-key')
    const exit = await Effect.runPromise(Effect.exit(Stream.runCollect(streamClaude(client, { model: 'claude/claude-opus-5-5', messages: [{ role: 'user', content: 'x' }] }, null, new AbortController().signal))))
    expect(exit._tag).toBe('Failure')
    expect(JSON.stringify(exit)).toContain('bad thing')
    expect(JSON.stringify(exit)).toContain('"status":400')
  })
})
