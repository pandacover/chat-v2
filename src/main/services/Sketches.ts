import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Deferred, Effect, Layer, Semaphore } from 'effect'
import type { ConfigError, MissingApiKey, ProviderError } from '../errors'
import { FileError, errorMessage } from '../errors'
import { AppPaths } from './AppPaths'
import { OpenRouter } from './OpenRouter'
import { SettingsStore } from './SettingsStore'

type SketchError = ProviderError | MissingApiKey | ConfigError | FileError

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
const MIMES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }

/** At most this many images generate at once; a board's other shots wait their turn. */
const CONCURRENCY = 3

export class Sketches extends Context.Service<
  Sketches,
  {
    /** A sketch for `prompt` as a data URL. Each (model, prompt, variant) is generated once and kept on disk. */
    readonly get: (prompt: string, variant: number) => Effect.Effect<string, SketchError>
  }
>()('chat-v2/Sketches') {
  static readonly layer = Layer.effect(
    Sketches,
    Effect.gen(function* () {
      const paths = yield* AppPaths
      const settings = yield* SettingsStore
      const openRouter = yield* OpenRouter
      const permits = yield* Semaphore.make(CONCURRENCY)
      // Two windows (or a quick re-render) asking for the same sketch share one request.
      const inFlight = new Map<string, Deferred.Deferred<string, SketchError>>()

      const fileError = (what: string) => (cause: unknown) => new FileError({ message: `${what}: ${errorMessage(cause)}`, cause })

      const cached = (key: string) =>
        Effect.promise(async () => {
          const name = (await readdir(paths.sketchesDir).catch(() => [] as string[])).find((f) => f.startsWith(`${key}.`))
          if (!name) return null
          const ext = name.slice(key.length + 1)
          const data = await readFile(join(paths.sketchesDir, name)).catch(() => null)
          return data ? `data:${MIMES[ext] ?? 'image/png'};base64,${data.toString('base64')}` : null
        })

      const generate = (key: string, model: string, prompt: string) =>
        Effect.gen(function* () {
          const image = yield* permits.withPermit(openRouter.generateImage({ model, prompt, aspectRatio: '16:9' }))
          const ext = EXTENSIONS[image.mime] ?? 'png'
          yield* Effect.tryPromise({
            try: () => writeFile(join(paths.sketchesDir, `${key}.${ext}`), image.data),
            catch: fileError('Could not save the sketch')
          })
          return `data:${image.mime};base64,${Buffer.from(image.data).toString('base64')}`
        })

      const get = Effect.fn('Sketches.get')(function* (prompt: string, variant: number) {
        const { sketchModel } = yield* settings.get
        const key = createHash('sha256').update(JSON.stringify([sketchModel, prompt, variant])).digest('hex').slice(0, 40)
        const hit = yield* cached(key)
        if (hit) return hit
        const pending = inFlight.get(key)
        if (pending) return yield* Deferred.await(pending)
        const deferred = yield* Deferred.make<string, SketchError>()
        inFlight.set(key, deferred)
        return yield* generate(key, sketchModel, prompt).pipe(
          Effect.onExit((exit) => Effect.andThen(Effect.sync(() => inFlight.delete(key)), Deferred.done(deferred, exit)))
        )
      })

      return Sketches.of({ get })
    })
  )
}
