import { randomUUID } from 'node:crypto'
import { extname, join } from 'node:path'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { Context, Effect, Layer } from 'effect'
import type { Attachment, AttachmentKind, NewAttachmentInput } from '@shared/types'
import { type DbError, FileError, InvalidInput, NotFound, errorMessage } from '../errors'
import { describeAudio } from '@shared/audio-prompt'
import type { ContentPart } from './OpenRouter'
import { AppPaths } from './AppPaths'
import { Db, type StoredAttachment } from './Db'

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
/** Uncompressed WAV runs about 10 MB a minute, so audio gets more room. */
export const MAX_AUDIO_BYTES = 100 * 1024 * 1024
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'aiff', 'aif', 'weba'])
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

const looksBinary = (bytes: Uint8Array) => bytes.subarray(0, 8000).includes(0)

/** Makes an image smaller before it goes to a model, or returns null to send it as it is. */
export type ShrinkImage = (data: Buffer, mime: string) => { data: Buffer; mime: string } | null

/**
 * Characters of encoded attachments kept in memory. Every reply sends the whole chat again, and
 * reading and base64-encoding each image and PDF in it every time (a 20 MB PDF is a 27 MB string)
 * was most of the work of building a request. The files never change, so their parts are kept.
 */
const PART_CACHE_CHARS = 96 * 1024 * 1024

export class Attachments extends Context.Service<
  Attachments,
  {
    readonly add: (input: NewAttachmentInput) => Effect.Effect<Attachment, InvalidInput | FileError | DbError>
    readonly discard: (id: string) => Effect.Effect<void, DbError>
    readonly read: (id: string) => Effect.Effect<{ data: Uint8Array<ArrayBuffer>; mime: string }, NotFound | FileError | DbError>
    readonly toParts: (
      attachments: readonly StoredAttachment[]
    ) => Effect.Effect<{ parts: ContentPart[]; hasPdf: boolean }, FileError>
    readonly removeFiles: (paths: readonly string[]) => Effect.Effect<void>
  }
>()('chat-v2/Attachments') {
  /** With `shrink`, images too big for a model are made smaller before they are sent. */
  static layerWith(shrink: ShrinkImage) {
    return Layer.effect(
      Attachments,
      Effect.gen(function* () {
        const paths = yield* AppPaths
        const db = yield* Db

        /** Encoded parts by attachment id, least recently used first. */
        const cache = new Map<string, { part: ContentPart; chars: number }>()
        let cachedChars = 0
        const forget = (id: string) => {
          const entry = cache.get(id)
          if (!entry) return
          cache.delete(id)
          cachedChars -= entry.chars
        }
        const keep = (id: string, part: ContentPart, chars: number) => {
          // Room for the largest file allowed (25 MB is 35 M characters of base64), twice over.
          if (chars > PART_CACHE_CHARS / 2) return
          cache.set(id, { part, chars })
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
          const limit = kind === 'audio' ? MAX_AUDIO_BYTES : MAX_ATTACHMENT_BYTES
          if (bytes.byteLength > limit)
            return yield* new InvalidInput({ message: `${input.name} is larger than ${limit / 1024 / 1024} MB` })
          if (kind === 'text' && looksBinary(bytes))
            return yield* new InvalidInput({ message: `${input.name} looks like a binary file` })
          const ext = extname(input.name).toLowerCase().replace(/[^.\w]/g, '')
          const path = join(paths.attachmentsDir, `${randomUUID()}${ext}`)
          yield* Effect.tryPromise({ try: () => writeFile(path, bytes), catch: fileError('Could not save file') })
          const mime =
            kind === 'image' ? imageMime(input.name, input.mime) : input.mime || (kind === 'audio' ? 'audio/mpeg' : 'text/plain')
          const stored = yield* db.use((d) =>
            d.insertAttachment({ name: input.name, mime, size: bytes.byteLength, kind, path })
          )
          const { path: _path, ...attachment } = stored
          return attachment
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

        const toParts = Effect.fn('Attachments.toParts')(function* (
          attachments: readonly StoredAttachment[]
        ) {
          const parts: ContentPart[] = []
          let hasPdf = false
          for (const a of attachments) {
            // Audio goes to the model as its measurements, so the file is never read here.
            if (a.kind === 'audio') {
              parts.push({ type: 'text', text: describeAudio(a.name, a.analysis) })
              continue
            }
            if (a.kind === 'pdf') hasPdf = true
            const known = cache.get(a.id)
            if (known) {
              // Used just now, so it goes to the back of the line.
              cache.delete(a.id)
              cache.set(a.id, known)
              parts.push(known.part)
              continue
            }
            const data = yield* Effect.tryPromise({
              try: () => readFile(a.path),
              catch: fileError(`Attachment ${a.name} is missing`)
            })
            let part: ContentPart
            if (a.kind === 'image') {
              const image = shrink(data, a.mime) ?? { data, mime: a.mime }
              part = { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.data.toString('base64')}` } }
              keep(a.id, part, part.image_url.url.length)
            } else if (a.kind === 'pdf') {
              part = {
                type: 'file',
                file: { filename: a.name, file_data: `data:application/pdf;base64,${data.toString('base64')}` }
              }
              keep(a.id, part, part.file.file_data.length)
            } else {
              let text = data.toString('utf8')
              if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS)}\n…[truncated]`
              part = { type: 'text', text: `<file name="${a.name.replace(/"/g, "'")}">\n${text}\n</file>` }
              keep(a.id, part, part.text.length)
            }
            parts.push(part)
          }
          return { parts, hasPdf }
        })

        return Attachments.of({ add, discard, read, toParts, removeFiles })
      })
    )
  }

  /** Images go to models as they are (tests, and anywhere without Electron's image codecs). */
  static readonly layer = Attachments.layerWith(() => null)
}
