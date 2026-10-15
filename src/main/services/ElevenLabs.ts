import { Context, Effect, Layer } from 'effect'
import { type ConfigError, InvalidInput, type MissingApiKey, ProviderError, errorMessage } from '../errors'
import { SettingsStore } from './SettingsStore'

const MAX_AUDIO_BYTES = 100 * 1024 * 1024

const extensionFor = (mime: string) =>
  mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : mime.includes('wav') ? 'wav' : 'audio'

export class ElevenLabs extends Context.Service<
  ElevenLabs,
  {
    /** Batch speech-to-text with ElevenLabs Scribe. */
    readonly transcribe: (
      audio: Uint8Array<ArrayBuffer>,
      mime: string
    ) => Effect.Effect<string, ProviderError | MissingApiKey | ConfigError | InvalidInput>
  }
>()('chat-v2/ElevenLabs') {
  static readonly layer = Layer.effect(
    ElevenLabs,
    Effect.gen(function* () {
      const settings = yield* SettingsStore

      const transcribe = Effect.fn('ElevenLabs.transcribe')(function* (audio: Uint8Array<ArrayBuffer>, mime: string) {
        if (audio.byteLength === 0) return yield* new InvalidInput({ message: 'No audio was recorded.' })
        if (audio.byteLength > MAX_AUDIO_BYTES) return yield* new InvalidInput({ message: 'Recording is too long.' })
        const key = yield* settings.apiKey('elevenlabs')
        const config = yield* settings.get

        const form = new FormData()
        form.append('model_id', config.sttModel)
        if (config.sttLanguage) form.append('language_code', config.sttLanguage)
        form.append('tag_audio_events', 'false')
        form.append('file', new Blob([audio], { type: mime }), `recording.${extensionFor(mime)}`)

        const res = yield* Effect.tryPromise({
          try: (signal) =>
            fetch(`${process.env.ELEVENLABS_BASE_URL ?? 'https://api.elevenlabs.io'}/v1/speech-to-text`, {
              method: 'POST',
              headers: { 'xi-api-key': key },
              body: form,
              signal
            }),
          catch: (cause) =>
            new ProviderError({ provider: 'ElevenLabs', message: `Could not reach ElevenLabs: ${errorMessage(cause)}` })
        })
        const body = yield* Effect.promise(() => res.text().catch(() => ''))
        let json: any = null
        try {
          json = JSON.parse(body)
        } catch {
          // handled below
        }
        if (!res.ok) {
          const detail = json?.detail
          const message =
            (typeof detail === 'string' ? detail : (detail?.message ?? detail?.[0]?.msg)) ?? body.slice(0, 300)
          return yield* new ProviderError({
            provider: 'ElevenLabs',
            status: res.status,
            message: `ElevenLabs ${res.status}: ${message || 'transcription failed'}`
          })
        }
        const text = typeof json?.text === 'string' ? json.text : (json?.transcripts?.[0]?.text ?? '')
        return String(text).trim()
      })

      return ElevenLabs.of({ transcribe })
    })
  )
}
