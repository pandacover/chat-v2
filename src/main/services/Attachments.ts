import { randomUUID } from 'node:crypto'
import { extname, join } from 'node:path'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { Context, Effect, Layer } from 'effect'
import type { Attachment, AttachmentKind, NewAttachmentInput } from '@shared/types'
import { type DbError, FileError, InvalidInput, NotFound, errorMessage } from '../errors'
import type { ContentPart } from './OpenRouter'
import { AppPaths } from './AppPaths'
import { Db, type StoredAttachment } from './Db'

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
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
  static readonly layer = Layer.effect(
    Attachments,
    Effect.gen(function* () {
      const paths = yield* AppPaths
      const db = yield* Db

      const fileError = (what: string) => (cause: unknown) =>
        new FileError({ message: `${what}: ${errorMessage(cause)}`, cause })

      const add = Effect.fn('Attachments.add')(function* (input: NewAttachmentInput) {
        const bytes = new Uint8Array(input.data)
        const kind = classify(input.name, input.mime)
        if (!kind) return yield* new InvalidInput({ message: `${input.name}: unsupported file type` })
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES)
          return yield* new InvalidInput({ message: `${input.name} is larger than 25 MB` })
        if (kind === 'text' && looksBinary(bytes))
          return yield* new InvalidInput({ message: `${input.name} looks like a binary file` })
        const ext = extname(input.name).toLowerCase().replace(/[^.\w]/g, '')
        const path = join(paths.attachmentsDir, `${randomUUID()}${ext}`)
        yield* Effect.tryPromise({ try: () => writeFile(path, bytes), catch: fileError('Could not save file') })
        const mime = kind === 'image' ? imageMime(input.name, input.mime) : input.mime || 'text/plain'
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
        db.use((d) => d.discardAttachment(id)).pipe(Effect.flatMap((file) => (file ? removeFiles([file]) : Effect.void)))

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
          const data = yield* Effect.tryPromise({
            try: () => readFile(a.path),
            catch: fileError(`Attachment ${a.name} is missing`)
          })
          if (a.kind === 'image') {
            parts.push({ type: 'image_url', image_url: { url: `data:${a.mime};base64,${data.toString('base64')}` } })
          } else if (a.kind === 'pdf') {
            hasPdf = true
            parts.push({
              type: 'file',
              file: { filename: a.name, file_data: `data:application/pdf;base64,${data.toString('base64')}` }
            })
          } else {
            let text = data.toString('utf8')
            if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS)}\n…[truncated]`
            parts.push({ type: 'text', text: `<file name="${a.name.replace(/"/g, "'")}">\n${text}\n</file>` })
          }
        }
        return { parts, hasPdf }
      })

      return Attachments.of({ add, discard, read, toParts, removeFiles })
    })
  )
}
