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
  | { type: 'error'; message: string }
  | { type: 'done' }

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
  if (json?.usage) events.push({ type: 'usage', usage: parseUsage(json.usage) })
  const text = choice?.delta?.content
  if (typeof text === 'string' && text !== '') events.push({ type: 'delta', text })
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
