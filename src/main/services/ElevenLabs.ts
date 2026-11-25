import { openAsBlob } from 'node:fs'
import { basename } from 'node:path'
import { Context, Effect, Layer } from 'effect'
import { type ConfigError, InvalidInput, type MissingApiKey, ProviderError, errorMessage } from '../errors'
import { SettingsStore } from './SettingsStore'

const MAX_AUDIO_BYTES = 100 * 1024 * 1024

/** A word (or a sound, like laughter) Scribe heard, with when it was said, in seconds. */
export interface TimedWord {
  text: string
  start: number
  end: number
  type: 'word' | 'spacing' | 'audio_event'
  speaker: string | null
}

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
    /**
     * A saved audio or video file, word by word with times and who spoke (Scribe takes video
     * files as they are). Streamed from disk, so a long video isn't read into memory.
     */
    readonly transcribeFile: (
      path: string,
      mime: string
    ) => Effect.Effect<{ text: string; language: string | null; words: TimedWord[] }, ProviderError | MissingApiKey | ConfigError>
  }
>()('chat-v2/ElevenLabs') {
  static readonly layer = Layer.effect(
    ElevenLabs,
    Effect.gen(function* () {
      const settings = yield* SettingsStore

      /** Posts `form` (with the model and language from Settings added) to Scribe; its JSON reply. */
      const post = Effect.fn('ElevenLabs.post')(function* (form: FormData) {
        const key = yield* settings.apiKey('elevenlabs')
        const config = yield* settings.get
        form.append('model_id', config.sttModel)
        if (config.sttLanguage) form.append('language_code', config.sttLanguage)

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
        return json
      })

      const transcribe = Effect.fn('ElevenLabs.transcribe')(function* (audio: Uint8Array<ArrayBuffer>, mime: string) {
        if (audio.byteLength === 0) return yield* new InvalidInput({ message: 'No audio was recorded.' })
        if (audio.byteLength > MAX_AUDIO_BYTES) return yield* new InvalidInput({ message: 'Recording is too long.' })
        const form = new FormData()
        form.append('tag_audio_events', 'false')
        form.append('file', new Blob([audio], { type: mime }), `recording.${extensionFor(mime)}`)
        const json = yield* post(form)
        const text = typeof json?.text === 'string' ? json.text : (json?.transcripts?.[0]?.text ?? '')
        return String(text).trim()
      })

      const transcribeFile = Effect.fn('ElevenLabs.transcribeFile')(function* (path: string, mime: string) {
        const file = yield* Effect.tryPromise({
          try: () => openAsBlob(path, { type: mime }),
          catch: (cause) => new ProviderError({ provider: 'ElevenLabs', message: `Could not read the file: ${errorMessage(cause)}` })
        })
        const form = new FormData()
        form.append('timestamps_granularity', 'word')
        form.append('diarize', 'true')
        form.append('tag_audio_events', 'true')
        form.append('file', file, basename(path))
        const json = yield* post(form)
        const words: TimedWord[] = Array.isArray(json?.words)
          ? json.words.map((w: any) => ({
              text: String(w?.text ?? ''),
              start: Number(w?.start) || 0,
              end: Number(w?.end) || 0,
              type: w?.type === 'spacing' || w?.type === 'audio_event' ? w.type : 'word',
              speaker: typeof w?.speaker_id === 'string' ? w.speaker_id : null
            }))
          : []
        return { text: String(json?.text ?? '').trim(), language: typeof json?.language_code === 'string' ? json.language_code : null, words }
      })

      return ElevenLabs.of({ transcribe, transcribeFile })
    })
  )
}
