import { Context, Effect, Layer, Stream } from 'effect'
import type { ModelInfo } from '@shared/types'
import { type ConfigError, type MissingApiKey, ProviderError, errorMessage } from '../errors'
import { parseSseLine } from '../sse'
import { SettingsStore } from './SettingsStore'

// Overridable for local testing against a mock server.
const BASE = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1'

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  temperature?: number
  plugins?: unknown[]
}

const headers = (key: string) => ({
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
  'HTTP-Referer': 'https://github.com/pandacover/chat-v2',
  'X-Title': 'chat-v2'
})

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
    /** Streams text deltas of a chat completion. Interrupting the stream aborts the request. */
    readonly streamChat: (req: ChatRequest) => Stream.Stream<string, ProviderError | MissingApiKey | ConfigError>
    readonly listModels: Effect.Effect<ModelInfo[], ProviderError>
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
                  body: JSON.stringify({ ...req, stream: true }),
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
              Stream.map(parseSseLine),
              Stream.takeWhile((e) => e.type !== 'done'),
              Stream.mapEffect((e) =>
                e.type === 'error' ? Effect.fail(providerError(undefined, e.message)) : Effect.succeed(e)
              ),
              Stream.filter((e): e is Extract<typeof e, { type: 'delta' }> => e.type === 'delta'),
              Stream.map((e) => e.text)
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
              inputModalities: Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities : ['text']
            })
          )
          .sort((a, b) => a.name.localeCompare(b.name))
      })
      // Only successful lookups are cached, so a failed fetch is retried next time.
      const listModels = Effect.suspend(() =>
        modelCache ? Effect.succeed(modelCache) : fetchModels.pipe(Effect.tap((m) => Effect.sync(() => (modelCache = m))))
      )

      return OpenRouter.of({ streamChat, listModels })
    })
  )
}
