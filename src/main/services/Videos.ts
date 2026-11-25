// What the video tools (agent/video.ts) run on: finding the video a call names, frames from the
// video worker (video.ts, passed in so tests can fake them), and Scribe's transcripts, kept with the attachment
// once made. Every reply gets the tools: a video may be attached, or saved on the computer (a
// browser recording, say), and a bot handed the work may be given its id or path.
import { stat } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import { Effect, Layer } from 'effect'
import type { VideoInfo } from '@shared/types'
import { ComputerUse } from '../computer'
import { decide } from '../agent/rules'
import { type FoundVideo, type Segment, type VideoDeps, segmentWords, videoModule } from '../agent/video'
import { errorMessage } from '../errors'
import { Chat } from './Chat'
import { Db } from './Db'
import { ElevenLabs } from './ElevenLabs'

export interface VideoTools {
  readonly probe: VideoDeps['probe']
  readonly frames: VideoDeps['frames']
}

const MIMES: Record<string, string> = {
  mov: 'video/quicktime',
  qt: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  flac: 'audio/flac'
}
const mimeOf = (path: string) => MIMES[extname(path).slice(1).toLowerCase()] ?? 'video/mp4'

export const videosLayer = (tools: VideoTools) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const chat = yield* Chat
      const db = yield* Db
      const elevenLabs = yield* ElevenLabs
      const computer = yield* ComputerUse
      const sync = <A>(f: Parameters<typeof db.use<A>>[0]) => Effect.runSync(db.use(f))

      const find: VideoDeps['find'] = async (ctx, ref, signal) => {
        const want = ref.trim().replace(/^["']|["']$/g, '')
        if (!want) return { error: 'Name the video: its id, its file name in this chat, or a file path.' }
        if (isAbsolute(want)) {
          const isFile = await stat(want).then((s) => s.isFile(), () => false)
          if (!isFile) return { error: `There is no file at ${want}.` }
          // A file on the computer is read under the bot's rule for reading files.
          const bot = sync((d) => d.botOf(ctx.sessionId))
          const rule = decide(bot, 'Read', { file_path: want })
          if (rule.verdict === 'block') return { error: rule.reason ?? `${bot.name} may not read files.` }
          if (rule.verdict === 'ask') {
            const ok = await Effect.runPromise(computer.ask({ sessionId: ctx.sessionId, messageId: ctx.messageId }, rule.title, want, 'files.read'), { signal }).catch(() => false)
            if (!ok) return { error: 'The user denied this.' }
          }
          return { path: want, name: basename(want), mime: mimeOf(want), info: null }
        }
        const a = sync((d) => {
          const byId = d.getAttachment(want)
          return byId?.kind === 'video' ? byId : d.videoNamed(ctx.sessionId, want)
        })
        if (!a) return { error: `There is no video “${want}” here. Use the id from the video's <video> tag, or the full path of a file.` }
        return { path: a.path, name: a.name, mime: a.mime, info: a.video }
      }

      /** Transcripts being made now, so two calls for one file make it once. */
      const making = new Map<string, Promise<{ segments: Segment[]; language: string | null }>>()
      const transcript = (video: FoundVideo) => {
        const kept = sync((d) => d.transcriptOf(video.path))
        if (kept) {
          try {
            return Promise.resolve(JSON.parse(kept) as { segments: Segment[]; language: string | null })
          } catch {}
        }
        const running = making.get(video.path)
        if (running) return running
        const made = Effect.runPromise(
          elevenLabs.transcribeFile(video.path, video.mime).pipe(
            Effect.map((r) => ({ segments: segmentWords(r.words), language: r.language })),
            Effect.tap((t) => db.use((d) => d.setTranscript(video.path, JSON.stringify(t))).pipe(Effect.ignore)),
            Effect.mapError((e) =>
              e._tag === 'MissingApiKey'
                ? new Error('Transcripts come from ElevenLabs, and no ElevenLabs API key is set. Tell the user they can add one in Settings › Account, under API keys; meanwhile frames still work.')
                : new Error(errorMessage(e))
            )
          )
        ).finally(() => making.delete(video.path))
        making.set(video.path, made)
        return made
      }

      const module = videoModule({ find, probe: tools.probe, frames: tools.frames, transcript })
      chat.provideTools(() => [module])
    })
  )

export type { VideoInfo }
