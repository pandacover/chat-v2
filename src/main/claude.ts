// The Claude API, for `claude/` models: the requests Chat builds in OpenRouter's shape go to
// Anthropic's Messages API instead, and its stream comes back as the same ChatDeltas. Research
// replies also get Anthropic's web search and web fetch, which run on Anthropic's servers.
import Anthropic from '@anthropic-ai/sdk'
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaTextCitation,
  BetaToolUnion
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { Stream } from 'effect'
import type { ModelInfo, Usage } from '@shared/types'
import { stepLine } from '@shared/steps'
import { ProviderError, errorMessage } from './errors'
import type { ReasoningDetail } from './sse'
import type { ChatDelta, ChatMessage, ChatRequest, ContentPart, ReasoningEffort } from './services/OpenRouter'

/** Model ids for the Claude API carry this prefix, so they never clash with OpenRouter's `anthropic/` ones. */
export const CLAUDE_PREFIX = 'claude/'
export const isClaudeModel = (model: string) => model.startsWith(CLAUDE_PREFIX)

export type ResearchEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** What one research reply may do: how hard it thinks, and how many searches it may run. */
export interface ResearchOptions {
  effort: ResearchEffort
  maxSearches: number
}

/** USD per million tokens, from Anthropic's pricing page (2026-10). Cache writes are the 5-minute ones. */
const MODELS: Array<{ id: string; name: string; pricing: ModelInfo['pricing']; fallbacks: boolean; latest: boolean }> = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', pricing: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, fallbacks: true, latest: true },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', pricing: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }, fallbacks: true, latest: true },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', pricing: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, fallbacks: true, latest: true },
  // Haiku has no server-side fallback, and only the basic web tools.
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', pricing: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }, fallbacks: false, latest: false }
]

/** USD per web search; fetches cost only the tokens they add. */
const SEARCH_PRICE = 0.01

export const CLAUDE_MODELS: ModelInfo[] = MODELS.map((m) => ({
  id: CLAUDE_PREFIX + m.id,
  name: `${m.name} (Claude API)`,
  contextLength: 1_000_000,
  inputModalities: ['text', 'image', 'file'],
  supportsTools: true,
  pricing: m.pricing
}))

const modelId = (model: string) => model.slice(CLAUDE_PREFIX.length)
const known = (model: string) => MODELS.find((m) => m.id === modelId(model))

/** What a reply cost, from the usage Anthropic reports and the prices above. */
export const claudeUsage = (model: string, u: Anthropic.Beta.BetaUsage): Omit<Usage, 'requests'> => {
  const input = u.input_tokens ?? 0
  const written = u.cache_creation_input_tokens ?? 0
  const read = u.cache_read_input_tokens ?? 0
  const output = u.output_tokens ?? 0
  const searches = u.server_tool_use?.web_search_requests ?? 0
  const p = known(model)?.pricing
  const cost = p
    ? (input * p.input! + written * p.cacheWrite! + read * p.cacheRead! + output * p.output!) / 1e6 + searches * SEARCH_PRICE
    : null
  return { promptTokens: input + written + read, completionTokens: output, totalTokens: input + written + read + output, cachedTokens: read, reasoningTokens: 0, cost }
}

/** Effort on the Claude API: thinking can't be turned off, so `none` and `minimal` ask for the least. */
const effortFor = (e: ReasoningEffort | undefined): ResearchEffort => (e === 'medium' || e === 'high' ? e : e ? 'low' : 'medium')

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const
type ImageType = (typeof IMAGE_TYPES)[number]

const partToBlock = (p: ContentPart): BetaContentBlockParam => {
  if (p.type === 'text') return { type: 'text', text: p.text }
  if (p.type === 'image_url') {
    const m = DATA_URL.exec(p.image_url.url)
    if (!m) return { type: 'image', source: { type: 'url', url: p.image_url.url } }
    const mime = IMAGE_TYPES.find((t) => t === m[1]) ?? 'image/png'
    return { type: 'image', source: { type: 'base64', media_type: mime as ImageType, data: m[2]! } }
  }
  const m = DATA_URL.exec(p.file.file_data)
  if (m?.[1] === 'application/pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: m[2]! }, title: p.file.filename }
  const text = m ? Buffer.from(m[2]!, 'base64').toString('utf8') : p.file.file_data
  return { type: 'text', text: `<file name="${p.file.filename}">\n${text}\n</file>` }
}

/** The API rejects empty text blocks, which a message with only files would otherwise carry. */
const blank = (p: ContentPart) => p.type === 'text' && p.text.trim() === ''

const blocks = (content: string | ContentPart[] | null): BetaContentBlockParam[] =>
  content === null ? [] : typeof content === 'string' ? (content.trim() === '' ? [] : [{ type: 'text', text: content }]) : content.filter((p) => !blank(p)).map(partToBlock)

/**
 * The assistant's content exactly as Claude sent it, which Chat keeps in `reasoning_details` so
 * the thinking blocks between tool calls go back unchanged on the next step.
 */
const RAW = 'anthropic.content'

const rawContent = (details: ReasoningDetail[] | undefined): BetaContentBlockParam[] | null => {
  const raw = details?.find((d) => d.type === RAW)?.content
  return Array.isArray(raw) ? (raw as BetaContentBlockParam[]) : null
}

/**
 * Chat's messages in the Messages API's shape: the system prompt apart, tool calls as `tool_use`
 * blocks, tool results as `tool_result` blocks in the next user turn, and turns of the same role
 * joined (tool results always lead their turn, as the API wants).
 */
export const toClaudeMessages = (messages: ChatMessage[]): { system: string; messages: BetaMessageParam[] } => {
  const system: string[] = []
  const out: BetaMessageParam[] = []
  const push = (role: 'user' | 'assistant', content: BetaContentBlockParam[]) => {
    if (content.length === 0) return
    const last = out.at(-1)
    if (last?.role === role) (last.content as BetaContentBlockParam[]).push(...content)
    else out.push({ role, content: [...content] })
  }
  for (const [i, m] of messages.entries()) {
    if (m.role === 'system') {
      // A system message after the start (none today) reads as a note from the app.
      if (i === 0 || out.length === 0) system.push(typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n'))
      else push('user', [{ type: 'text', text: `[Note from the app] ${typeof m.content === 'string' ? m.content : ''}` }])
    } else if (m.role === 'user') push('user', blocks(m.content))
    else if (m.role === 'assistant') {
      const raw = rawContent(m.reasoning_details)
      if (raw) push('assistant', raw)
      else
        push('assistant', [
          ...blocks(m.content),
          ...(m.tool_calls ?? []).map((c): BetaContentBlockParam => {
            let input: unknown = {}
            try {
              input = JSON.parse(c.function.arguments || '{}')
            } catch {
              // Arguments that aren't JSON go back as they are, so the model sees what it sent.
              input = { arguments: c.function.arguments }
            }
            return { type: 'tool_use', id: c.id, name: c.function.name, input }
          })
        ])
    } else if (m.role === 'tool') {
      const content = typeof m.content === 'string' ? m.content : m.content.filter((p) => !blank(p)).map((p) => ({ type: 'text' as const, text: p.text }))
      const result: BetaContentBlockParam = { type: 'tool_result', tool_use_id: m.tool_call_id, content }
      const last = out.at(-1)
      // Results go before anything else in the user turn that follows the tool calls.
      if (last?.role === 'user') {
        const list = last.content as BetaContentBlockParam[]
        const at = list.findIndex((b) => b.type !== 'tool_result')
        if (at < 0) list.push(result)
        else list.splice(at, 0, result)
      } else out.push({ role: 'user', content: [result] })
    }
  }
  // The API wants the conversation to open with the user.
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: [{ type: 'text', text: '(continuing)' }] })
  return { system: system.filter(Boolean).join('\n\n'), messages: out }
}

/** Server tools for a research reply. Haiku takes only the basic versions. */
const researchTools = (model: string, maxSearches: number): BetaToolUnion[] =>
  known(model)?.latest === false
    ? [
        { type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches },
        { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: maxSearches }
      ]
    : [
        { type: 'web_search_20260209', name: 'web_search', max_uses: maxSearches },
        { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: maxSearches }
      ]

export const RESEARCH_INSTRUCTIONS = `You are running in research mode, with web search and web fetch.
- Research the question thoroughly before answering: run many searches with varied wording, open the most relevant pages with web fetch (primary sources, official docs and pricing pages over summaries), and cross-check claims that matter.
- Before your first search, say in one or two sentences what you will look into.
- Then write a structured report in Markdown: a short summary first, then sections, with comparisons as tables where they help. Say what you could not confirm.
- Cite your sources inline as you use them.
- If you also have the built-in browser's tools, read pages with web fetch first, and use the browser for pages that need it: ones behind a login, built by JavaScript, or that need clicking through.`

/** The Messages API request for one of Chat's requests. */
export const claudeParams = (req: ChatRequest, research: ResearchOptions | null): BetaMessageStreamParams => {
  const { system, messages } = toClaudeMessages(req.messages)
  const meta = known(req.model)
  const tools: BetaToolUnion[] = [
    ...(req.tools ?? []).map((t): BetaToolUnion => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters as Anthropic.Beta.BetaTool.InputSchema })),
    ...(research ? researchTools(req.model, research.maxSearches) : [])
  ]
  const hasClientTools = (req.tools?.length ?? 0) > 0
  const betas = [
    ...(meta?.fallbacks ? ['server-side-fallback-2026-07-01'] : []),
    // Chat replaces stale screenshots and page snapshots in a tool run, which would invalidate the
    // thinking blocks after them; dropping those blocks keeps the request valid.
    ...(hasClientTools ? ['thinking-binding-controls-2026-08-01'] : []),
    ...(research && meta?.latest ? ['thinking-display-updates-2026-08-18'] : [])
  ]
  return {
    model: modelId(req.model),
    // Thinking counts against the limit, so short requests (titles) still get room for it.
    max_tokens: Math.max(req.max_tokens ?? (research ? 64000 : 32000), 4096),
    ...(system ? { system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] } : {}),
    messages,
    // Caches everything up to the newest message, so each step of a run reads the ones before it.
    cache_control: { type: 'ephemeral' },
    thinking: {
      type: 'adaptive',
      ...(hasClientTools ? { block_binding: { prefix_mismatch_behavior: 'drop_block' } } : {}),
      ...(research && meta?.latest ? { display: 'updates' } : {})
    },
    output_config: { effort: research ? research.effort : effortFor(req.reasoning?.effort) },
    ...(tools.length ? { tools } : {}),
    // One action at a time keeps the browser's state predictable, unless the run asks for more (computer use).
    ...(hasClientTools && !req.parallel_tool_calls ? { tool_choice: { type: 'auto', disable_parallel_tool_use: true } } : {}),
    ...(meta?.fallbacks ? { fallbacks: 'default' } : {}),
    ...(betas.length ? { betas } : {})
  } satisfies BetaMessageStreamParams
}

// How many times one reply resumes a turn the server paused (each pause is 10 server-side steps).
const MAX_RESUMES = 20

const short = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Server tool calls shown as step lines while research runs. */
const searchStep = (input: unknown, result: unknown) => {
  const query = String((input as { query?: unknown })?.query ?? '')
  const ok = Array.isArray(result)
  const count = ok ? result.length : 0
  const error = !ok ? String((result as { error_code?: unknown })?.error_code ?? 'error') : ''
  return stepLine({ tool: 'web_search', label: `Searched “${short(query)}”`, ok, detail: ok ? `${count} result${count === 1 ? '' : 's'}` : error })
}

const fetchStep = (input: unknown, result: unknown) => {
  const url = String((input as { url?: unknown })?.url ?? '')
  const r = result as { type?: string; url?: string; content?: { title?: string | null }; error_code?: string } | null
  const ok = r?.type === 'web_fetch_result'
  const title = ok ? r?.content?.title : null
  return stepLine({ tool: 'web_fetch', label: `Read ${title ? `“${short(title, 70)}”` : hostOf(r?.url ?? url)}`, ok, detail: ok ? (r?.url ?? url) : `${url}: ${r?.error_code ?? 'could not read it'}` })
}

const providerError = (cause: unknown) =>
  cause instanceof ProviderError
    ? cause
    : cause instanceof Anthropic.APIError
      ? new ProviderError({ provider: 'Claude', status: cause.status, message: `Claude API ${cause.status ?? ''}: ${cause.message}`.replace('  ', ' ') })
      : new ProviderError({ provider: 'Claude', message: `Claude API: ${errorMessage(cause)}` })

/**
 * Streams one of Chat's requests from the Claude API. Text streams as it comes; tool calls come
 * as `tool` deltas; research searches and reads come as step lines in the text, with numbered
 * links to the sources the report cites and a source list at the end. A turn the server pauses
 * (long research) is resumed until it ends.
 */
export const streamClaude = (
  client: Anthropic,
  req: ChatRequest,
  research: ResearchOptions | null,
  signal: AbortSignal
): Stream.Stream<ChatDelta, ProviderError> => {
  async function* run(): AsyncGenerator<ChatDelta> {
    const params = claudeParams(req, research)
    const content: BetaContentBlock[] = []
    const sources = new Map<string, { n: number; title: string }>()
    let atLineStart = true
    const text = (t: string): ChatDelta => {
      if (t) atLineStart = t.endsWith('\n')
      return { type: 'text', text: t }
    }
    // A step line stands on its own line; text before it may not have ended its line.
    const step = (line: string): ChatDelta => text(`${atLineStart ? '' : '\n'}${line}\n`)
    let toolCount = 0
    for (let resume = 0; resume <= MAX_RESUMES; resume++) {
      const stream = client.beta.messages.stream(
        resume === 0 ? params : { ...params, messages: [...params.messages, { role: 'assistant', content: content as BetaContentBlockParam[] }] },
        { signal }
      )
      // Per content block of this response: what kind it is, and what has come in for it.
      const open = new Map<number, { type: string; tool?: number; json: string; thinking: string; citations: BetaTextCitation[]; id?: string; name?: string }>()
      const serverCalls = new Map<string, { name: string; input: unknown }>()
      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          const b = event.content_block
          const entry = { type: b.type, json: '', thinking: '', citations: [] as BetaTextCitation[] }
          open.set(event.index, entry)
          if (b.type === 'tool_use') {
            const index = toolCount++
            open.set(event.index, { ...entry, tool: index })
            yield { type: 'tool', index, id: b.id, name: b.name }
          } else if (b.type === 'server_tool_use') open.set(event.index, { ...entry, id: b.id, name: b.name })
          else if (b.type === 'web_search_tool_result') {
            const call = serverCalls.get(b.tool_use_id)
            yield step(searchStep(call?.input, b.content))
          } else if (b.type === 'web_fetch_tool_result') {
            const call = serverCalls.get(b.tool_use_id)
            yield step(fetchStep(call?.input, b.content))
          } else if (b.type === 'text' && b.text) yield text(b.text)
        } else if (event.type === 'content_block_delta') {
          const entry = open.get(event.index)
          const d = event.delta
          if (d.type === 'text_delta') yield text(d.text)
          else if (d.type === 'input_json_delta' && entry) {
            if (entry.tool !== undefined) yield { type: 'tool', index: entry.tool, args: d.partial_json }
            else entry.json += d.partial_json
          } else if (d.type === 'citations_delta' && entry) entry.citations.push(d.citation)
          else if (d.type === 'thinking_delta' && entry) entry.thinking += d.thinking
        } else if (event.type === 'content_block_stop') {
          const entry = open.get(event.index)
          if (entry?.type === 'server_tool_use' && entry.id) {
            let input: unknown = {}
            try {
              input = JSON.parse(entry.json || '{}')
            } catch {
              // Shown without its query.
            }
            serverCalls.set(entry.id, { name: entry.name ?? '', input })
          } else if (entry?.type === 'text' && entry.citations.length > 0) {
            // Numbered links to what this stretch of text cites, right after it.
            const marks: string[] = []
            for (const c of entry.citations) {
              const url = 'url' in c && typeof c.url === 'string' ? c.url : null
              if (!url) continue
              let source = sources.get(url)
              if (!source) {
                source = { n: sources.size + 1, title: ('title' in c && typeof c.title === 'string' && c.title) || hostOf(url) }
                sources.set(url, source)
              }
              const mark = `[[${source.n}]](${url})`
              if (!marks.includes(mark)) marks.push(mark)
            }
            if (marks.length) yield text(` ${marks.join(' ')}`)
          } else if (entry?.type === 'thinking' && research && entry.thinking.trim()) {
            // With `display: "updates"`, these are the model's notes on what it found and does next.
            const note = entry.thinking.trim()
            yield step(stepLine({ tool: 'research_note', label: short(note.split('\n')[0]!, 110), ok: true, ...(note.length > 110 || note.includes('\n') ? { detail: note } : {}) }))
          }
        }
      }
      const message = await stream.finalMessage()
      yield { type: 'usage', usage: claudeUsage(req.model, message.usage) }
      content.push(...message.content)
      if (message.stop_reason === 'pause_turn') continue
      if (message.stop_reason === 'refusal') {
        const category = message.stop_details?.category
        yield text(`${atLineStart ? '' : '\n\n'}_Claude declined to go on with this${category ? ` (${category})` : ''}._`)
      } else if (message.stop_reason === 'max_tokens') yield text(`${atLineStart ? '' : '\n\n'}_The reply reached its length limit._`)
      break
    }
    // The source list ends the report, which is the step without tool calls (citations before it keep their links).
    if (sources.size > 0 && toolCount === 0) {
      const list = [...sources.entries()].map(([url, s]) => `${s.n}. [${s.title.replace(/[[\]]/g, '')}](${url})`)
      yield text(`${atLineStart ? '\n' : '\n\n'}**Sources**\n\n${list.join('\n')}\n`)
    }
    // Tool calls go back with the content as it came, thinking included (see toClaudeMessages).
    if (toolCount > 0) yield { type: 'reasoning', details: [{ type: RAW, index: 0, content }] }
  }
  return Stream.fromAsyncIterable({ [Symbol.asyncIterator]: run }, providerError)
}

/** A client for the key; `ANTHROPIC_BASE_URL` points it at a mock server in tests. */
export const claudeClient = (apiKey: string) =>
  new Anthropic({ apiKey, ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}), maxRetries: 2 })
