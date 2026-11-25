import { randomUUID } from 'node:crypto'
import { extname, join } from 'node:path'
import { copyFile, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { Context, Effect, Layer } from 'effect'
import type { Attachment, AttachmentKind, NewAttachmentInput, VideoInfo } from '@shared/types'
import { type DbError, FileError, InvalidInput, NotFound, errorMessage } from '../errors'
import { describeAudio } from '@shared/audio-prompt'
import type { PromptBlock } from '../agent/driver'
import { AppPaths } from './AppPaths'
import { Db, type StoredAttachment } from './Db'

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
/** Uncompressed WAV runs about 10 MB a minute, so audio gets more room. */
export const MAX_AUDIO_BYTES = 100 * 1024 * 1024
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'aiff', 'aif', 'weba'])
/** Videos never go to the model whole, only frames and a transcript, so they may be large. */
export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'qt', 'webm', 'mkv', 'avi', 'wmv', 'mpg', 'mpeg', '3gp', 'ogv', 'flv', 'm2ts'])
const MAX_TEXT_CHARS = 200_000

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const TEXT_EXTENSIONS = new Set(
  (
    'txt md markdown json jsonl csv tsv xml yaml yml toml ini log html htm css scss js mjs cjs ts tsx jsx svelte vue ' +
    'py rb go rs java kt swift c h cpp hpp cs php sh bash zsh ps1 sql graphql proto env gitignore dockerfile'
  ).split(' ')
)

export const classify = (name: string, mime: string): AttachmentKind | null => {
  const ext = extname(name).slice(1).toLowerCase()
  if (IMAGE_MIMES.has(mime) || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'image'
  if (mime.startsWith('audio/') || AUDIO_EXTENSIONS.has(ext)) return 'audio'
  // Chromium calls a .ts file (TypeScript, far more often than an MPEG stream) video/mp2t: a text extension wins.
  if ((mime.startsWith('video/') && !TEXT_EXTENSIONS.has(ext)) || VIDEO_EXTENSIONS.has(ext)) return 'video'
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (mime.startsWith('text/') || mime === 'application/json' || TEXT_EXTENSIONS.has(ext)) return 'text'
  if (!ext && !mime) return 'text'
  return null
}

const imageMime = (name: string, mime: string) => {
  if (IMAGE_MIMES.has(mime)) return mime
  const ext = extname(name).slice(1).toLowerCase()
  return ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
}

const videoMime = (name: string) => {
  const ext = extname(name).slice(1).toLowerCase()
  return ext === 'mov' || ext === 'qt' ? 'video/quicktime' : ext === 'webm' ? 'video/webm' : ext === 'mkv' ? 'video/x-matroska' : 'video/mp4'
}

const looksBinary = (bytes: Uint8Array) => bytes.subarray(0, 8000).includes(0)

/** Makes an image smaller before it goes to a model, or returns null to send it as it is. */
export type ShrinkImage = (data: Buffer, mime: string) => { data: Buffer; mime: string } | null
/** Reads a saved video's length and size (video.ts), or null when it can't be decoded. */
export type ProbeVideo = (path: string) => Promise<VideoInfo | null>

const clock = (s: number) => {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(Math.floor(s % 60)).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/**
 * How a video is put to the model: what it is, and how to see and hear it. The file itself isn't
 * sent (Claude doesn't take video); the video tools (agent/video.ts) give frames and a transcript.
 */
export const describeVideo = (a: Pick<Attachment, 'id' | 'name' | 'size' | 'video'>): string => {
  const name = a.name.replace(/"/g, "'")
  const mb = `${(a.size / 1024 / 1024).toFixed(1)} MB`
  const about = a.video
    ? `Length ${clock(a.video.duration)} (${a.video.duration.toFixed(1)} s), ${a.video.width}×${a.video.height}, ${mb}.`
    : `${mb}. Its length couldn't be read: it may be in a format the app can't decode.`
  return `<video file="${name}" id="${a.id}">
${about} The video itself isn't in this message: you see it through the video tools, which take its id. Look at frames to see what happens in it, and get the transcript for what is said.
</video>`
}

/**
 * Characters of encoded attachments kept in memory. A reply usually sends only its own message's
 * files (the session has the rest), but one that starts a session sends the whole chat's, and
 * reading and base64-encoding a 20 MB PDF makes a 27 MB string. The files never change, so their
 * blocks are kept.
 */
const PART_CACHE_CHARS = 96 * 1024 * 1024

export class Attachments extends Context.Service<
  Attachments,
  {
    readonly add: (input: NewAttachmentInput) => Effect.Effect<Attachment, InvalidInput | FileError | DbError>
    /** A video the user picked or dropped, copied from where it is on disk (a large one never passes through memory). */
    readonly addVideoFile: (input: { path: string; name: string; mime: string }) => Effect.Effect<Attachment, InvalidInput | FileError | DbError>
    readonly discard: (id: string) => Effect.Effect<void, DbError>
    readonly read: (id: string) => Effect.Effect<{ data: Uint8Array<ArrayBuffer>; mime: string }, NotFound | FileError | DbError>
    /** The files as content blocks: images and PDFs as the model reads them, text files inline. */
    readonly toBlocks: (attachments: readonly StoredAttachment[]) => Effect.Effect<PromptBlock[], FileError>
    readonly removeFiles: (paths: readonly string[]) => Effect.Effect<void>
  }
>()('chat-v2/Attachments') {
  /** With `shrink`, images too big for a model are made smaller before they are sent. */
  static layerWith(shrink: ShrinkImage, probe: ProbeVideo = async () => null) {
    return Layer.effect(
      Attachments,
      Effect.gen(function* () {
        const paths = yield* AppPaths
        const db = yield* Db

        /** Encoded blocks by attachment id, least recently used first. */
        const cache = new Map<string, { block: PromptBlock; chars: number }>()
        let cachedChars = 0
        const forget = (id: string) => {
          const entry = cache.get(id)
          if (!entry) return
          cache.delete(id)
          cachedChars -= entry.chars
        }
        const keep = (id: string, block: PromptBlock, chars: number) => {
          // Room for the largest file allowed (25 MB is 35 M characters of base64), twice over.
          if (chars > PART_CACHE_CHARS / 2) return
          cache.set(id, { block, chars })
          cachedChars += chars
          for (const [old] of cache) {
            if (cachedChars <= PART_CACHE_CHARS) break
            forget(old)
          }
        }

        const fileError = (what: string) => (cause: unknown) =>
          new FileError({ message: `${what}: ${errorMessage(cause)}`, cause })

        const add = Effect.fn('Attachments.add')(function* (input: NewAttachmentInput) {
          const bytes = new Uint8Array(input.data)
          const kind = classify(input.name, input.mime)
          if (!kind) return yield* new InvalidInput({ message: `${input.name}: unsupported file type` })
          const limit = kind === 'audio' ? MAX_AUDIO_BYTES : kind === 'video' ? MAX_VIDEO_BYTES : MAX_ATTACHMENT_BYTES
          if (bytes.byteLength > limit) return yield* tooLarge(input.name, limit)
          if (kind === 'text' && looksBinary(bytes))
            return yield* new InvalidInput({ message: `${input.name} looks like a binary file` })
          return yield* save(input.name, input.mime, kind, bytes.byteLength, (path) => writeFile(path, bytes))
        })

        const tooLarge = (name: string, limit: number) =>
          new InvalidInput({ message: `${name} is larger than ${limit >= 1024 ** 3 ? `${limit / 1024 ** 3} GB` : `${limit / 1024 / 1024} MB`}` })

        /** Writes the file into the attachments folder (`write` given its path) and records it. */
        const save = Effect.fn('Attachments.save')(function* (name: string, given: string, kind: AttachmentKind, size: number, write: (path: string) => Promise<void>) {
          const ext = extname(name).toLowerCase().replace(/[^.\w]/g, '')
          const path = join(paths.attachmentsDir, `${randomUUID()}${ext}`)
          yield* Effect.tryPromise({ try: () => write(path), catch: fileError('Could not save file') })
          const mime =
            kind === 'image' ? imageMime(name, given) : given || (kind === 'audio' ? 'audio/mpeg' : kind === 'video' ? videoMime(name) : 'text/plain')
          // A video's length and size are read now, for its chip and for the model.
          const video = kind === 'video' ? yield* Effect.promise(() => probe(path).catch(() => null)) : null
          const stored = yield* db.use((d) => d.insertAttachment({ name, mime, size, kind, path, video }))
          const { path: _path, ...attachment } = stored
          return attachment
        })

        const addVideoFile = Effect.fn('Attachments.addVideoFile')(function* (input: { path: string; name: string; mime: string }) {
          if (classify(input.name, input.mime) !== 'video') return yield* new InvalidInput({ message: `${input.name} isn't a video` })
          const info = yield* Effect.tryPromise({ try: () => stat(input.path), catch: fileError(`Could not read ${input.name}`) })
          if (!info.isFile()) return yield* new InvalidInput({ message: `${input.name} isn't a file` })
          if (info.size > MAX_VIDEO_BYTES) return yield* tooLarge(input.name, MAX_VIDEO_BYTES)
          return yield* save(input.name, input.mime, 'video', info.size, (path) => copyFile(input.path, path))
        })

        const removeFiles = (files: readonly string[]) =>
          Effect.forEach(files, (f) => Effect.promise(() => rm(f, { force: true }).catch(() => undefined)), {
            discard: true
          })

        const discard = (id: string) =>
          Effect.sync(() => forget(id)).pipe(
            Effect.andThen(db.use((d) => d.discardAttachment(id))),
            Effect.flatMap((file) => (file ? removeFiles([file]) : Effect.void))
          )

        const read = Effect.fn('Attachments.read')(function* (id: string) {
          const a = yield* db.require('Attachment', (d) => d.getAttachment(id))
          const data = yield* Effect.tryPromise({ try: () => readFile(a.path), catch: fileError(`Could not read ${a.name}`) })
          return { data: Uint8Array.from(data), mime: a.mime }
        })

        const toBlocks = Effect.fn('Attachments.toBlocks')(function* (attachments: readonly StoredAttachment[]) {
          const blocks: PromptBlock[] = []
          for (const a of attachments) {
            // Audio goes to the model as its measurements, so the file is never read here.
            if (a.kind === 'audio') {
              blocks.push({ type: 'text', text: describeAudio(a.name, a.analysis) })
              continue
            }
            // So does video: what it is, and the tools that show and transcribe it.
            if (a.kind === 'video') {
              blocks.push({ type: 'text', text: describeVideo(a) })
              continue
            }
            const known = cache.get(a.id)
            if (known) {
              // Used just now, so it goes to the back of the line.
              cache.delete(a.id)
              cache.set(a.id, known)
              blocks.push(known.block)
              continue
            }
            const data = yield* Effect.tryPromise({
              try: () => readFile(a.path),
              catch: fileError(`Attachment ${a.name} is missing`)
            })
            let block: PromptBlock
            let chars: number
            if (a.kind === 'image') {
              const image = shrink(data, a.mime) ?? { data, mime: a.mime }
              const encoded = image.data.toString('base64')
              block = { type: 'image', source: { type: 'base64', media_type: image.mime as 'image/png', data: encoded } }
              chars = encoded.length
            } else if (a.kind === 'pdf') {
              // Claude reads the PDF itself: its text, and its pages as images.
              const encoded = data.toString('base64')
              block = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: encoded }, title: a.name }
              chars = encoded.length
            } else {
              let text = data.toString('utf8')
              if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS)}\n…[truncated]`
              block = { type: 'text', text: `<file name="${a.name.replace(/"/g, "'")}">\n${text}\n</file>` }
              chars = block.text.length
            }
            keep(a.id, block, chars)
            blocks.push(block)
          }
          return blocks
        })

        return Attachments.of({ add, addVideoFile, discard, read, toBlocks, removeFiles })
      })
    )
  }

  /** Images go to models as they are (tests, and anywhere without Electron's image codecs). */
  static readonly layer = Attachments.layerWith(() => null)
}
