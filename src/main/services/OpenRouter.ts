import { Context, Effect, Layer, Stream } from 'effect'
import type { ModelInfo, Usage } from '@shared/types'
import { type ConfigError, type MissingApiKey, ProviderError, errorMessage } from '../errors'
import { type ReasoningDetail, parseSseLine } from '../sse'
import { CurrentStopwatch } from '../timing'
import { SettingsStore } from './SettingsStore'

// Overridable for local testing against a mock server.
const BASE = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1'

/** Marks the end of a prefix Anthropic should cache (see withCacheBreakpoints). */
export interface CacheControl {
  type: 'ephemeral'
}

export type ContentPart =
  | { type: 'text'; text: string; cache_control?: CacheControl }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } }

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string | ContentPart[] }
  | {
      role: 'assistant'
      content: string | ContentPart[] | null
      tool_calls?: ToolCall[]
      /** The thinking behind the tool calls, sent back so the model keeps it across steps. */
      reasoning_details?: ReasoningDetail[]
      reasoning?: string
    }
  // Text parts only when the result carries a cache breakpoint (see withCacheBreakpoints).
  | { role: 'tool'; tool_call_id: string; content: string | Array<Extract<ContentPart, { type: 'text' }>> }

export interface ToolDefinition {
  type: 'function'
  function: { name: string; description: string; parameters: object }
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  temperature?: number
  max_tokens?: number
  plugins?: unknown[]
  tools?: ToolDefinition[]
  /** `effort: 'none'` turns thinking off; thinking tokens count against `max_tokens`. */
  reasoning?: { effort: ReasoningEffort }
}

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high'

/** What a streamed completion yields: text, thinking, or a fragment of a tool call. */
export type ChatDelta =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text?: string; details?: ReasoningDetail[] }
  | { type: 'tool'; index: number; id?: string; name?: string; args?: string }
  | { type: 'usage'; usage: Omit<Usage, 'requests'> }

export interface ImageRequest {
  model: string
  prompt: string
  /** Sent only when the model lists it as supported. */
  aspectRatio?: string
}

export interface GeneratedImage {
  data: Uint8Array
  mime: string
  /** USD charged, when OpenRouter reports it. */
  cost: number | null
}

/** What /images/models says a model accepts; used to avoid sending options it would reject. */
interface ImageModelParams {
  aspectRatios: string[]
  resolutions: string[]
}

const headers = (key: string) => ({
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
  'HTTP-Referer': 'https://github.com/pandacover/chat-v2',
  'X-Title': 'chat-v2'
})

/** OpenRouter prices are USD per token as strings; "-1" marks variable pricing (routers). */
const perMillion = (v: unknown): number | null => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : null
}

const countImages = (messages: ChatMessage[]) =>
  messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').length : 0), 0)

/** Claude models, which cache only up to the breakpoints a request marks. */
export const isAnthropic = (model: string) => /^~?anthropic\//.test(model)

const EPHEMERAL: CacheControl = { type: 'ephemeral' }

/**
 * The message with a cache breakpoint on its last text, or on a text part added for one. Tool
 * results take one too. An assistant turn with only tool calls has no text to mark (Anthropic
 * rejects an empty text block), but its results always follow it and are marked instead.
 */
const marked = (m: ChatMessage): ChatMessage => {
  if (m.content === null) return m
  if (typeof m.content === 'string') return m.content === '' ? m : ({ ...m, content: [{ type: 'text', text: m.content, cache_control: EPHEMERAL }] } as ChatMessage)
  const at = m.content.findLastIndex((p) => p.type === 'text')
  if (at < 0) return m
  return { ...m, content: m.content.map((p, i) => (i === at && p.type === 'text' ? { ...p, cache_control: EPHEMERAL } : p)) } as ChatMessage
}

/**
 * Anthropic caches a request's prefix only up to a `cache_control` breakpoint (OpenAI and Gemini
 * cache on their own). Two are marked: the system prompt, which also covers the tools (Anthropic
 * orders them first), and the newest message that can carry one and has no image, so the next step
 * reads every earlier step from the cache. In a run with tools that is usually the newest tool
 * result, so the pages and windows read so far are cached as well; the newest message before it
 * that isn't a tool result is marked too, a third breakpoint, so the cache still grows step by step
 * should a provider not take one on a tool result. A message with a screenshot is passed over: the
 * next step replaces it with a note (see DROPPED_SCREENSHOT in Chat.ts), so a breakpoint there would
 * never be read. Browser page snapshots, in tool results, are replaced too, but only in batches
 * once stale ones add up (see pruneSnapshots in Chat.ts), so most steps still read the breakpoint
 * before them. The request's own messages are left as they are, so breakpoints never pile up past
 * Anthropic's limit of four.
 */
export const withCacheBreakpoints = (model: string, messages: ChatMessage[]): ChatMessage[] => {
  if (!isAnthropic(model)) return messages
  const out = [...messages]
  if (out[0]?.role === 'system') out[0] = marked(out[0])
  let toolMarked = false
  for (let i = out.length - 1; i > 0; i--) {
    const content = out[i]!.content
    if (Array.isArray(content) && content.some((p) => p.type === 'image_url')) continue
    if (toolMarked && out[i]!.role === 'tool') continue
    const m = marked(out[i]!)
    if (m === out[i]) continue
    out[i] = m
    if (m.role !== 'tool') break
    toolMarked = true
  }
  return out
}

const providerError = (status: number | undefined, message: string) =>
  new ProviderError({ provider: 'OpenRouter', status, message })

/** Pulls a readable message out of an OpenRouter error body. */
const describeFailure = (status: number, body: string): string => {
  try {
    const json = JSON.parse(body)
    const msg = json?.error?.message ?? json?.message
    if (msg) return `OpenRouter ${status}: ${msg}`
  } catch {
    // not JSON
  }
  return `OpenRouter ${status}: ${body.slice(0, 300) || 'request failed'}`
}

export class OpenRouter extends Context.Service<
  OpenRouter,
  {
    /** Streams a chat completion. Interrupting the stream aborts the request. */
    readonly streamChat: (req: ChatRequest) => Stream.Stream<ChatDelta, ProviderError | MissingApiKey | ConfigError>
    readonly listModels: Effect.Effect<ModelInfo[], ProviderError>
    readonly listImageModels: Effect.Effect<ModelInfo[], ProviderError>
    /** Generates one image with the images endpoint. */
    readonly generateImage: (req: ImageRequest) => Effect.Effect<GeneratedImage, ProviderError | MissingApiKey | ConfigError>
  }
>()('chat-v2/OpenRouter') {
  static readonly layer = Layer.effect(
    OpenRouter,
    Effect.gen(function* () {
      const settings = yield* SettingsStore

      const streamChat = (req: ChatRequest) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const key = yield* settings.apiKey('openrouter')
            // A reply times its calls (see timing.ts); other requests carry no stopwatch.
            const sw = yield* CurrentStopwatch
            const controller = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (c) => Effect.sync(() => c.abort())
            )
            const body = JSON.stringify({
              ...req,
              messages: withCacheBreakpoints(req.model, req.messages),
              stream: true,
              // One action at a time keeps the browser's state predictable.
              ...(req.tools?.length ? { tool_choice: 'auto', parallel_tool_calls: false } : {})
            })
            sw?.note('bytes', Buffer.byteLength(body))
            sw?.note('images', countImages(req.messages))
            const res = yield* Effect.tryPromise({
              try: () =>
                fetch(`${BASE}/chat/completions`, {
                  method: 'POST',
                  headers: headers(key),
                  body,
                  signal: controller.signal
                }),
              catch: (cause) => providerError(undefined, `Could not reach OpenRouter: ${errorMessage(cause)}`)
            })
            sw?.mark('headers')
            if (!res.ok || !res.body) {
              const body = yield* Effect.promise(() => res.text().catch(() => ''))
              return yield* Effect.fail(providerError(res.status, describeFailure(res.status, body)))
            }
            const stream = res.body
            return Stream.fromReadableStream({
              evaluate: () => stream,
              onError: (cause) => providerError(undefined, `Stream interrupted: ${errorMessage(cause)}`)
            }).pipe(
              Stream.decodeText,
              Stream.splitLines,
              Stream.flatMap((line) => {
                // Any chunk counts, thinking included; keep-alive comments don't.
                if (sw && line.startsWith('data:')) sw.mark('firstDelta')
                return Stream.fromIterable(parseSseLine(line))
              }),
              Stream.takeWhile((e) => e.type !== 'done'),
              Stream.tap((e) => {
                if (!sw) return Effect.void
                if (e.type === 'delta' || e.type === 'tool') sw.mark('firstContent')
                else if (e.type === 'usage') sw.note('usage', e.usage)
                else if (e.type === 'meta') {
                  if (e.model) sw.note('model', e.model)
                  if (e.provider) sw.note('provider', e.provider)
                }
                return Effect.void
              }),
              Stream.mapEffect((e): Effect.Effect<ChatDelta | null, ProviderError> =>
                e.type === 'error'
                  ? Effect.fail(providerError(undefined, e.message))
                  : e.type === 'delta'
                    ? Effect.succeed({ type: 'text', text: e.text })
                    : e.type === 'tool' || e.type === 'usage' || e.type === 'reasoning'
                      ? Effect.succeed(e)
                      : Effect.succeed(null)
              ),
              Stream.filter((e): e is ChatDelta => e !== null)
            )
          })
        )

      let modelCache: ModelInfo[] | null = null
      const fetchModels = Effect.gen(function* () {
        const res = yield* Effect.tryPromise({
          try: () => fetch(`${BASE}/models`),
          catch: (cause) => providerError(undefined, `Could not reach OpenRouter: ${errorMessage(cause)}`)
        })
        if (!res.ok) return yield* Effect.fail(providerError(res.status, `OpenRouter ${res.status}: could not list models`))
        const json = (yield* Effect.tryPromise({
          try: () => res.json(),
          catch: () => providerError(res.status, 'Malformed model list')
        })) as { data?: any[] }
        return (json.data ?? [])
          .map(
            (m): ModelInfo => ({
              id: String(m.id),
              name: String(m.name ?? m.id),
              contextLength: typeof m.context_length === 'number' ? m.context_length : null,
              inputModalities: Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities : ['text'],
              supportsTools: Array.isArray(m.supported_parameters) && m.supported_parameters.includes('tools'),
              pricing: {
                input: perMillion(m.pricing?.prompt),
                output: perMillion(m.pricing?.completion),
                cacheRead: perMillion(m.pricing?.input_cache_read),
                cacheWrite: perMillion(m.pricing?.input_cache_write)
              }
            })
          )
          .sort((a, b) => a.name.localeCompare(b.name))
      })
      // Only successful lookups are cached, so a failed fetch is retried next time.
      const listModels = Effect.suspend(() =>
        modelCache ? Effect.succeed(modelCache) : fetchModels.pipe(Effect.tap((m) => Effect.sync(() => (modelCache = m))))
      )

      let imageCache: { models: ModelInfo[]; params: Map<string, ImageModelParams> } | null = null
      const fetchImageModels = Effect.gen(function* () {
        const res = yield* Effect.tryPromise({
          try: () => fetch(`${BASE}/images/models`),
          catch: (cause) => providerError(undefined, `Could not reach OpenRouter: ${errorMessage(cause)}`)
        })
        if (!res.ok) return yield* Effect.fail(providerError(res.status, `OpenRouter ${res.status}: could not list image models`))
        const json = (yield* Effect.tryPromise({
          try: () => res.json(),
          catch: () => providerError(res.status, 'Malformed image model list')
        })) as { data?: any[] }
        const params = new Map<string, ImageModelParams>()
        const values = (p: any): string[] => (Array.isArray(p?.values) ? p.values.map(String) : [])
        const models = (json.data ?? [])
          .map((m): ModelInfo => {
            params.set(String(m.id), {
              aspectRatios: values(m.supported_parameters?.aspect_ratio),
              resolutions: values(m.supported_parameters?.resolution)
            })
            return {
              id: String(m.id),
              name: String(m.name ?? m.id),
              contextLength: null,
              inputModalities: Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities : ['text'],
              supportsTools: false,
              image: true,
              pricing: { input: null, output: null, cacheRead: null, cacheWrite: null }
            }
          })
          .sort((a, b) => a.name.localeCompare(b.name))
        return { models, params }
      })
      const imageModels = Effect.suspend(() =>
        imageCache ? Effect.succeed(imageCache) : fetchImageModels.pipe(Effect.tap((c) => Effect.sync(() => (imageCache = c))))
      )
      const listImageModels = Effect.map(imageModels, (c) => c.models)

      const generateImage = Effect.fn('OpenRouter.generateImage')(function* (req: ImageRequest) {
        const key = yield* settings.apiKey('openrouter')
        // Unknown models get no optional parameters rather than ones they may reject.
        const params = yield* imageModels.pipe(
          Effect.map((c) => c.params.get(req.model)),
          Effect.orElseSucceed(() => undefined)
        )
        const aspect = req.aspectRatio && params?.aspectRatios.includes(req.aspectRatio) ? req.aspectRatio : undefined
        // The smallest size is plenty for a sketch and the cheapest.
        const resolution = ['768', '1K'].find((r) => params?.resolutions.includes(r))
        const controller = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (c) => Effect.sync(() => c.abort())
        )
        const res = yield* Effect.tryPromise({
          try: () =>
            fetch(`${BASE}/images`, {
              method: 'POST',
              headers: headers(key),
              body: JSON.stringify({
                model: req.model,
                prompt: req.prompt,
                n: 1,
                ...(aspect ? { aspect_ratio: aspect } : {}),
                ...(resolution ? { resolution } : {})
              }),
              signal: controller.signal
            }),
          catch: (cause) => providerError(undefined, `Could not reach OpenRouter: ${errorMessage(cause)}`)
        })
        const body = yield* Effect.promise(() => res.text().catch(() => ''))
        if (!res.ok) return yield* Effect.fail(providerError(res.status, describeFailure(res.status, body)))
        let json: { data?: Array<{ b64_json?: string; media_type?: string }>; usage?: { cost?: number } }
        try {
          json = JSON.parse(body)
        } catch {
          return yield* Effect.fail(providerError(res.status, 'OpenRouter returned an unreadable image response'))
        }
        const image = json.data?.find((d) => typeof d.b64_json === 'string' && d.b64_json)
        if (!image?.b64_json) return yield* Effect.fail(providerError(res.status, `${req.model} returned no image`))
        return {
          data: Uint8Array.from(Buffer.from(image.b64_json, 'base64')),
          mime: image.media_type ?? 'image/png',
          cost: typeof json.usage?.cost === 'number' ? json.usage.cost : null
        }
      }, Effect.scoped)

      return OpenRouter.of({ streamChat, listModels, listImageModels, generateImage })
    })
  )
}
