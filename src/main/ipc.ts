import { ipcMain, shell } from 'electron'
import { Cause, Effect, type ManagedRuntime } from 'effect'
import type { IpcResult, NewAttachmentInput, SettingsPatch } from '@shared/types'
import { errorMessage } from './errors'
import { publishArtifact } from './protocols'
import { Attachments } from './services/Attachments'
import { Chat, NEW_SESSION_TITLE } from './services/Chat'
import { Db } from './services/Db'
import { ElevenLabs } from './services/ElevenLabs'
import { OpenRouter } from './services/OpenRouter'
import { SettingsStore } from './services/SettingsStore'

export type MainServices = Db | Chat | Attachments | SettingsStore | OpenRouter | ElevenLabs

type Handler = (...args: any[]) => Effect.Effect<unknown, { readonly _tag: string; readonly message: string }, MainServices>

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw new TypeError(`${name} must be a string`)
  return v
}
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

const handlers: Record<string, Handler> = {
  'sessions:list': () => Db.use((db) => db.use((d) => d.listSessions())),
  'sessions:create': () =>
    Effect.gen(function* () {
      const db = yield* Db
      const session = yield* db.use((d) =>
        d.createSession({ title: NEW_SESSION_TITLE, model: null, systemPrompt: null, forkedFromSessionId: null })
      )
      return yield* (yield* Chat).view(session.id)
    }),
  'sessions:get': (id) => Chat.use((chat) => chat.view(str(id, 'id'))),
  'sessions:rename': (id, title) =>
    Db.use((db) =>
      db.use((d) => d.updateSession(str(id, 'id'), { title: str(title, 'title').trim() || NEW_SESSION_TITLE }))
    ),
  'sessions:update': (id, patch: { model?: string | null; systemPrompt?: string | null }) =>
    Db.use((db) =>
      db.use((d) =>
        d.updateSession(str(id, 'id'), {
          ...(patch.model !== undefined ? { model: patch.model || null } : {}),
          ...(patch.systemPrompt !== undefined ? { systemPrompt: patch.systemPrompt?.trim() ? patch.systemPrompt : null } : {})
        })
      )
    ),
  'sessions:remove': (id) =>
    Effect.gen(function* () {
      const db = yield* Db
      const chat = yield* Chat
      for (const messageId of yield* db.use((d) => d.streamingIds(str(id, 'id')))) yield* chat.stop(messageId)
      const orphanFiles = yield* db.use((d) => d.deleteSession(id))
      yield* (yield* Attachments).removeFiles(orphanFiles)
    }),
  'sessions:fork': (sessionId, messageId) =>
    Effect.gen(function* () {
      const db = yield* Db
      const fork = yield* db.use((d) => d.forkSession(str(sessionId, 'sessionId'), str(messageId, 'messageId')))
      return yield* (yield* Chat).view(fork.id)
    }),

  'chat:send': (input) =>
    Chat.use((chat) =>
      chat.send({
        sessionId: str(input.sessionId, 'sessionId'),
        parentId: str(input.parentId, 'parentId'),
        text: str(input.text, 'text'),
        attachmentIds: ids(input.attachmentIds)
      })
    ),
  'chat:edit': (input) =>
    Chat.use((chat) =>
      chat.edit({
        sessionId: str(input.sessionId, 'sessionId'),
        messageId: str(input.messageId, 'messageId'),
        text: str(input.text, 'text'),
        attachmentIds: ids(input.attachmentIds)
      })
    ),
  'chat:regenerate': (input) =>
    Chat.use((chat) =>
      chat.regenerate({ sessionId: str(input.sessionId, 'sessionId'), assistantId: str(input.assistantId, 'assistantId') })
    ),
  'chat:continue': (input) =>
    Chat.use((chat) =>
      chat.continue({ sessionId: str(input.sessionId, 'sessionId'), assistantId: str(input.assistantId, 'assistantId') })
    ),
  'chat:stop': (messageId) => Chat.use((chat) => chat.stop(str(messageId, 'messageId'))),
  'chat:switchBranch': (input) =>
    Chat.use((chat) =>
      chat.switchBranch({ sessionId: str(input.sessionId, 'sessionId'), messageId: str(input.messageId, 'messageId') })
    ),
  'chat:linesSince': (messageId, fromIndex) =>
    Chat.use((chat) =>
      chat.linesSince(str(messageId, 'messageId'), typeof fromIndex === 'number' ? fromIndex : 0)
    ),

  'attachments:add': (input: NewAttachmentInput) =>
    Attachments.use((a) =>
      a.add({ name: str(input.name, 'name'), mime: typeof input.mime === 'string' ? input.mime : '', data: input.data })
    ),
  'attachments:discard': (id) => Attachments.use((a) => a.discard(str(id, 'id'))),

  'settings:get': () => SettingsStore.use((s) => s.view),
  'settings:update': (patch: SettingsPatch) => SettingsStore.use((s) => s.update(patch)),
  'settings:openConfigFile': () =>
    Effect.gen(function* () {
      const view = yield* (yield* SettingsStore).view
      yield* Effect.promise(() => shell.openPath(view.configPath))
    }),

  'models:list': () => OpenRouter.use((o) => o.listModels),

  'stt:transcribe': (audio: ArrayBuffer, mime) =>
    ElevenLabs.use((e) => e.transcribe(new Uint8Array(audio), str(mime, 'mime'))),

  'artifacts:publish': (html) => Effect.sync(() => publishArtifact(str(html, 'html')))
}

export const registerIpc = (runtime: ManagedRuntime.ManagedRuntime<MainServices, unknown>) => {
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, ...args: unknown[]): Promise<IpcResult<unknown>> =>
      runtime.runPromise(
        Effect.suspend(() => handler(...args)).pipe(
          Effect.map((value): IpcResult<unknown> => ({ ok: true, value })),
          Effect.catch((e) => Effect.succeed<IpcResult<unknown>>({ ok: false, error: { tag: e._tag, message: e.message } })),
          Effect.catchCause((cause) =>
            Effect.succeed<IpcResult<unknown>>({
              ok: false,
              error: { tag: 'Defect', message: errorMessage(Cause.squash(cause)) }
            })
          )
        )
      )
    )
  }
}
