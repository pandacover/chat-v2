// Parsing of OpenRouter's OpenAI-compatible server-sent events, one SSE line at a time.
import type { Usage } from '@shared/types'

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** OpenRouter puts usage on the last chunk of every stream; cost is in credits. */
export const parseUsage = (u: any): Omit<Usage, 'requests'> => ({
  promptTokens: num(u?.prompt_tokens),
  completionTokens: num(u?.completion_tokens),
  totalTokens: num(u?.total_tokens) || num(u?.prompt_tokens) + num(u?.completion_tokens),
  cachedTokens: num(u?.prompt_tokens_details?.cached_tokens),
  reasoningTokens: num(u?.completion_tokens_details?.reasoning_tokens),
  cost: typeof u?.cost === 'number' ? u.cost : null
})

export type SseEvent =
  | { type: 'delta'; text: string }
  /** A fragment of a streamed tool call; fragments with the same index belong together. */
  | { type: 'tool'; index: number; id?: string; name?: string; args?: string }
  | { type: 'usage'; usage: Omit<Usage, 'requests'> }
  /**
   * A fragment of the model's thinking: plain `text`, and/or `details` as OpenRouter structures it
   * (`reasoning_details`), which go back to the model on the next step (see mergeReasoning).
   */
  | { type: 'reasoning'; text?: string; details?: ReasoningDetail[] }
  /** The model and provider that answered, which chunks carry beside their content. */
  | { type: 'meta'; model?: string; provider?: string }
  | { type: 'error'; message: string }
  | { type: 'done' }

/**
 * One block of thinking as OpenRouter returns it: `reasoning.text` (with a signature),
 * `reasoning.summary` or `reasoning.encrypted` (`data`). Passed back as received.
 */
export type ReasoningDetail = { type: string; index?: number; text?: string; summary?: string; data?: string; [key: string]: unknown }

/** Text fields that stream in pieces; the rest (id, format, signature) arrive whole, usually last. */
const STREAMED = ['text', 'summary', 'data'] as const

/**
 * Adds streamed `reasoning_details` fragments to the blocks so far. Fragments of one block share
 * its `index` (or, without one, follow it with the same type) and their text is joined; other
 * fields keep the latest value given. Order and types are kept as they came.
 */
export const mergeReasoning = (blocks: ReasoningDetail[], fragments: ReasoningDetail[]): ReasoningDetail[] => {
  for (const f of fragments) {
    const last = blocks.at(-1)
    const same =
      typeof f.index === 'number'
        ? blocks.find((b) => b.index === f.index && b.type === f.type)
        : last && last.index === undefined && last.type === f.type && last.type !== 'reasoning.encrypted'
          ? last
          : undefined
    if (!same) {
      blocks.push({ ...f })
      continue
    }
    for (const [k, v] of Object.entries(f)) {
      if (v === undefined || v === null) continue
      if ((STREAMED as readonly string[]).includes(k) && typeof v === 'string') same[k] = `${typeof same[k] === 'string' ? same[k] : ''}${v}`
      else same[k] = v
    }
  }
  return blocks
}

export const parseSseLine = (line: string): SseEvent[] => {
  // Blank lines separate events; lines starting with ':' are keep-alive comments
  // (OpenRouter sends ": OPENROUTER PROCESSING").
  if (!line.startsWith('data:')) return []
  const data = line.slice(5).trim()
  if (data === '[DONE]') return [{ type: 'done' }]
  if (data === '') return []
  let json: any
  try {
    json = JSON.parse(data)
  } catch {
    return []
  }
  if (json?.error) {
    const message = typeof json.error === 'string' ? json.error : (json.error.message ?? 'Provider error')
    return [{ type: 'error', message: String(message) }]
  }
  const choice = json?.choices?.[0]
  if (choice?.finish_reason === 'error') return [{ type: 'error', message: 'The model stopped with an error' }]
  const events: SseEvent[] = []
  if (typeof json?.model === 'string' || typeof json?.provider === 'string')
    events.push({
      type: 'meta',
      ...(typeof json.model === 'string' ? { model: json.model } : {}),
      ...(typeof json.provider === 'string' ? { provider: json.provider } : {})
    })
  if (json?.usage) events.push({ type: 'usage', usage: parseUsage(json.usage) })
  const text = choice?.delta?.content
  if (typeof text === 'string' && text !== '') events.push({ type: 'delta', text })
  const thought = choice?.delta?.reasoning
  const details = choice?.delta?.reasoning_details
  const blocks = Array.isArray(details) ? details.filter((d): d is ReasoningDetail => !!d && typeof d === 'object' && typeof d.type === 'string') : []
  if ((typeof thought === 'string' && thought !== '') || blocks.length > 0)
    events.push({ type: 'reasoning', ...(typeof thought === 'string' && thought !== '' ? { text: thought } : {}), ...(blocks.length ? { details: blocks } : {}) })
  const calls = choice?.delta?.tool_calls
  if (Array.isArray(calls)) {
    for (const c of calls) {
      events.push({
        type: 'tool',
        index: typeof c.index === 'number' ? c.index : 0,
        ...(c.id ? { id: String(c.id) } : {}),
        ...(c.function?.name ? { name: String(c.function.name) } : {}),
        ...(typeof c.function?.arguments === 'string' && c.function.arguments ? { args: c.function.arguments } : {})
      })
    }
  }
  return events
}
