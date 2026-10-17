import { Context, Effect, Layer, Stream } from 'effect'
import type { ModelInfo, Usage } from '@shared/types'
import { type ConfigError, type MissingApiKey, ProviderError, errorMessage } from '../errors'
import { parseSseLine } from '../sse'
import { SettingsStore } from './SettingsStore'

// Overridable for local testing against a mock server.
const BASE = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1'

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } }

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | ContentPart[] | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

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
}

/** What a streamed completion yields: text, or a fragment of a tool call. */
export type ChatDelta =
  | { type: 'text'; text: string }
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
            const controller = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (c) => Effect.sync(() => c.abort())
            )
            const res = yield* Effect.tryPromise({
              try: () =>
                fetch(`${BASE}/chat/completions`, {
                  method: 'POST',
                  headers: headers(key),
                  body: JSON.stringify({
                    ...req,
                    stream: true,
                    // One action at a time keeps the browser's state predictable.
                    ...(req.tools?.length ? { tool_choice: 'auto', parallel_tool_calls: false } : {})
                  }),
                  signal: controller.signal
                }),
              catch: (cause) => providerError(undefined, `Could not reach OpenRouter: ${errorMessage(cause)}`)
            })
            if (!res.ok || !res.body) {
              const body = yield* Effect.promise(() => res.text().catch(() => ''))
              return yield* Effect.fail(providerError(res.status, describeFailure(res.status, body)))
            }
            const body = res.body
            return Stream.fromReadableStream({
              evaluate: () => body,
              onError: (cause) => providerError(undefined, `Stream interrupted: ${errorMessage(cause)}`)
            }).pipe(
              Stream.decodeText,
              Stream.splitLines,
              Stream.flatMap((line) => Stream.fromIterable(parseSseLine(line))),
              Stream.takeWhile((e) => e.type !== 'done'),
              Stream.mapEffect((e): Effect.Effect<ChatDelta | null, ProviderError> =>
                e.type === 'error'
                  ? Effect.fail(providerError(undefined, e.message))
                  : e.type === 'delta'
                    ? Effect.succeed({ type: 'text', text: e.text })
                    : e.type === 'tool' || e.type === 'usage'
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
