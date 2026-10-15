// Parsing of OpenRouter's OpenAI-compatible server-sent events, one SSE line at a time.

export type SseEvent =
  | { type: 'delta'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done' }
  | { type: 'ignore' }

export const parseSseLine = (line: string): SseEvent => {
  // Blank lines separate events; lines starting with ':' are keep-alive comments
  // (OpenRouter sends ": OPENROUTER PROCESSING").
  if (!line.startsWith('data:')) return { type: 'ignore' }
  const data = line.slice(5).trim()
  if (data === '[DONE]') return { type: 'done' }
  if (data === '') return { type: 'ignore' }
  let json: any
  try {
    json = JSON.parse(data)
  } catch {
    return { type: 'ignore' }
  }
  if (json?.error) {
    const message = typeof json.error === 'string' ? json.error : (json.error.message ?? 'Provider error')
    return { type: 'error', message: String(message) }
  }
  const choice = json?.choices?.[0]
  if (choice?.finish_reason === 'error') return { type: 'error', message: 'The model stopped with an error' }
  const text = choice?.delta?.content
  return typeof text === 'string' && text !== '' ? { type: 'delta', text } : { type: 'ignore' }
}
