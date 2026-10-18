import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, app, dialog, ipcMain, shell, systemPreferences } from 'electron'
import { Cause, Effect, type ManagedRuntime } from 'effect'
import type { AudioAnalysis, IpcResult, MemoryView, NewAttachmentInput, SessionPatch, SettingsPatch } from '@shared/types'
import { errorMessage } from './errors'
import { checkForUpdates, installUpdate, updateState } from './updater'
import { publishArtifact } from './protocols'
import { Attachments } from './services/Attachments'
import { Browser } from './services/Browser'
import { Chat, NEW_SESSION_TITLE } from './services/Chat'
import { Computer } from './services/Computer'
import { PROTECTED_APPS, PROTECTED_TITLES } from '@shared/computer'
import { Db, type DbApi } from './services/Db'
import { isSensitive } from './memory'
import { ElevenLabs } from './services/ElevenLabs'
import { OpenRouter } from './services/OpenRouter'
import { SettingsStore } from './services/SettingsStore'
import { Sketches } from './services/Sketches'

export type MainServices = Db | Chat | Attachments | SettingsStore | OpenRouter | ElevenLabs | Browser | Sketches | Computer

type Handler = (...args: any[]) => Effect.Effect<unknown, { readonly _tag: string; readonly message: string }, MainServices>

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw new TypeError(`${name} must be a string`)
  return v
}
type Rect = { x: number; y: number; width: number; height: number }
const rect = (v: unknown): Rect | undefined => {
  const r = v as Partial<Rect> | undefined
  return r && [r.x, r.y, r.width, r.height].every((n) => typeof n === 'number') ? (r as Rect) : undefined
}
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

const int = (v: unknown, name: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new TypeError(`${name} must be an integer`)
  return v
}

/** A fact typed in Settings: one line, ending like a sentence. Secrets are refused here too. */
const typedFact = (v: unknown): string => {
  const fact = str(v, 'fact').replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!fact) throw new TypeError('The fact is empty')
  if (isSensitive(fact)) throw new TypeError("That looks like a password, key or account number, which memory doesn't keep")
  return /[.!?…]$/.test(fact) ? fact : `${fact}.`
}

const memoryView = Effect.gen(function* () {
  const lastRun = yield* (yield* Chat).lastMemoryRun
  return yield* (yield* Db).use((d): MemoryView => ({ facts: d.liveFacts(), revisions: d.memoryHistory(), lastRun }))
})

/** Runs a change to memory made in Settings, then returns the new state. */
const editMemory = (f: (d: DbApi) => unknown) => Db.use((db) => db.use(f)).pipe(Effect.andThen(memoryView))

/**
 * macOS asks for the microphone once and remembers the answer. Asking before the window opens
 * the mic lets a refusal be explained. The status is read back rather than trusting the reply:
 * opening the mic while macOS has no answer on record brings the prompt straight back.
 */
const microphoneAccess = async (): Promise<boolean> => {
  if (process.platform !== 'darwin') return true
  if (systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') await systemPreferences.askForMediaAccess('microphone')
  return systemPreferences.getMediaAccessStatus('microphone') === 'granted'
}

/**
 * Pins the window above other apps. On macOS the default 'floating' level stays on this
 * desktop only and below full-screen apps; Windows has a single topmost band.
 */
export const pinWindow = (win: BrowserWindow, on: boolean) => {
  if (!win.isDestroyed() && win.isAlwaysOnTop() !== on) win.setAlwaysOnTop(on)
}

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
  'sessions:update': (id, patch: SessionPatch) =>
    Db.use((db) =>
      db.use((d) =>
        d.updateSession(str(id, 'id'), {
          ...(patch.model !== undefined ? { model: patch.model || null } : {}),
          ...(patch.systemPrompt !== undefined ? { systemPrompt: patch.systemPrompt?.trim() ? patch.systemPrompt : null } : {}),
          ...(typeof patch.browserEnabled === 'boolean' ? { browserEnabled: patch.browserEnabled } : {}),
          ...(typeof patch.computerEnabled === 'boolean' ? { computerEnabled: patch.computerEnabled } : {}),
          ...(typeof patch.pinned === 'boolean' ? { pinned: patch.pinned } : {})
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

  'memory:get': () => memoryView,
  'memory:add': (fact) => editMemory((d) => d.changeMemory({ add: [typedFact(fact)], update: [], remove: [] }, { kind: 'edited' })),
  'memory:edit': (id, fact) =>
    editMemory((d) => d.changeMemory({ add: [], update: [{ id: int(id, 'id'), fact: typedFact(fact) }], remove: [] }, { kind: 'edited' })),
  'memory:remove': (id) => editMemory((d) => d.changeMemory({ add: [], update: [], remove: [int(id, 'id')] }, { kind: 'edited' })),
  'memory:clear': () =>
    editMemory((d) => d.changeMemory({ add: [], update: [], remove: d.liveFacts().map((f) => f.id) }, { kind: 'cleared' })),
  'memory:restore': (rev) => editMemory((d) => d.restoreMemory(int(rev, 'rev'))),

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
  'attachments:setAnalysis': (id, analysis: AudioAnalysis) =>
    Db.use((db) => db.use((d) => d.setAnalysis(str(id, 'id'), analysis))),

  'settings:get': () => SettingsStore.use((s) => s.view),
  'settings:update': (patch: SettingsPatch) =>
    SettingsStore.use((s) => s.update(patch)).pipe(
      Effect.tap((view) =>
        Effect.sync(() => {
          for (const win of BrowserWindow.getAllWindows()) pinWindow(win, view.settings.alwaysOnTop)
        })
      )
    ),
  'settings:openConfigFile': () =>
    Effect.gen(function* () {
      const view = yield* (yield* SettingsStore).view
      yield* Effect.promise(() => shell.openPath(view.configPath))
    }),

  'models:list': () => OpenRouter.use((o) => o.listModels),
  'models:images': () => OpenRouter.use((o) => o.listImageModels),

  'stt:microphone': () => Effect.promise(microphoneAccess),
  'stt:transcribe': (audio: ArrayBuffer, mime) =>
    ElevenLabs.use((e) => e.transcribe(new Uint8Array(audio), str(mime, 'mime'))),

  'artifacts:publish': (html) => Effect.sync(() => publishArtifact(str(html, 'html'))),

  'boards:get': (messageId, identifier) => Db.use((db) => db.use((d) => d.getBoard(str(messageId, 'messageId'), str(identifier, 'identifier')))),
  'boards:save': (messageId, identifier, doc) =>
    Db.use((db) => db.use((d) => d.saveBoard(str(messageId, 'messageId'), str(identifier, 'identifier'), doc))),
  'boards:sketch': (prompt, variant) =>
    Sketches.use((s) => s.get(str(prompt, 'prompt'), typeof variant === 'number' ? variant : 0)),
  'boards:savePng': (name, data: ArrayBuffer) =>
    Effect.promise(async () => {
      const file = `${str(name, 'name').replace(/[\\/:*?"<>|]+/g, '-') || 'mood-board'}.png`
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const options = { defaultPath: join(app.getPath('pictures'), file), filters: [{ name: 'PNG image', extensions: ['png'] }] }
      const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return null
      writeFileSync(result.filePath, new Uint8Array(data))
      return result.filePath
    }),

  'updates:get': () => Effect.sync(updateState),
  'updates:check': () => Effect.promise(checkForUpdates),
  'updates:install': () => Effect.promise(installUpdate),

  'browser:attach': (id) => Browser.use((b) => b.attach(Number(id))),
  'browser:screenshot': (r) =>
    Effect.gen(function* () {
      const shot = yield* (yield* Browser).screenshot(rect(r))
      return yield* (yield* Attachments).add({ name: `screenshot-${stamp()}.png`, mime: 'image/png', data: shot.png.buffer })
    }),
  'browser:capture': (r) =>
    Browser.use((b) => b.screenshot(rect(r))).pipe(
      Effect.map((shot) => `data:image/png;base64,${Buffer.from(shot.png).toString('base64')}`)
    ),
  'browser:elementAt': (x, y) => Browser.use((b) => b.elementAt(Number(x), Number(y))),
  'browser:screencast': (on) => Browser.use((b) => b.screencast(on === true)),
  'browser:saveRecording': (data: ArrayBuffer) =>
    Effect.sync(() => {
      const dir = join(app.getPath('videos'), 'chat-v2')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `recording-${stamp()}.webm`)
      writeFileSync(file, new Uint8Array(data))
      return file
    }),
  'browser:reveal': (path) => Effect.sync(() => shell.showItemInFolder(str(path, 'path'))),

  'computer:tips': () => Computer.use((c) => c.tips),
  'computer:removeTip': (id) => Computer.use((c) => c.removeTip(str(id, 'id'))),
  'computer:protectedApps': () => Effect.succeed([...PROTECTED_APPS.map((a) => a.label), ...PROTECTED_TITLES.map((t) => t.label)])
}

/** Calls made while the app quits are never answered; the window closes before it could use one. */
const unanswered = new Promise<never>(() => {})

export const registerIpc = (runtime: ManagedRuntime.ManagedRuntime<MainServices, unknown>, quitting: () => boolean) => {
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, ...args: unknown[]): Promise<IpcResult<unknown>> =>
      quitting() ? unanswered : runtime.runPromise(
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
        // A call still running when quitting starts is cut off by the shutdown; that is no error.
      ).catch((e: unknown) => (quitting() ? unanswered : Promise.reject(e)))
    )
  }

  // Computer mode is on while any window shows a chat with computer use switched on.
  const computerWindows = new Set<number>()
  const applyMode = () => void runtime.runPromise(Computer.use((c) => c.setMode(computerWindows.size > 0))).catch(() => undefined)
  ipcMain.on('computer:mode', (event, on: unknown) => {
    const id = event.sender.id
    if (on === true && !computerWindows.has(id)) {
      computerWindows.add(id)
      event.sender.once('destroyed', () => {
        if (computerWindows.delete(id) && !quitting()) applyMode()
      })
    } else if (on !== true) computerWindows.delete(id)
    applyMode()
  })
}
