import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, app, dialog, ipcMain, shell, systemPreferences } from 'electron'
import { Cause, Effect, type ManagedRuntime } from 'effect'
import type { AudioAnalysis, BotPatch, IpcResult, MemoryView, NewAttachmentInput, RecordReply, SessionPatch, SettingsPatch } from '@shared/types'
import { isClaudeModel } from '@shared/models'
import { cleanModules, cleanRules } from '@shared/rules'
import { cleanAvatar } from '@shared/bots'
import { FileError, errorMessage } from './errors'
import { collectLog, exportLog, logFileName } from './logExport'
import { checkForUpdates, downloadUpdate, installUpdate, updateState } from './updater'
import { publishArtifact } from './protocols'
import { Attachments } from './services/Attachments'
import { Browser } from './services/Browser'
import { Chat, NEW_SESSION_TITLE } from './services/Chat'
import { Agent } from './agent/driver'
import { ComputerUse } from './computer'
import { Db, type DbApi } from './services/Db'
import { isSensitive } from './memory'
import { ElevenLabs } from './services/ElevenLabs'
import { Jobs } from './services/Jobs'
import { SettingsStore } from './services/SettingsStore'
import { McpStore } from './services/McpStore'
import { testServer } from './services/McpTools'
import type { McpServerInput } from '@shared/mcp'
import { Usage } from './usage/Usage'
import { Reconciler } from './services/Reconciler'
import { Team } from './services/Team'

export type MainServices = Db | Chat | Jobs | Team | Attachments | SettingsStore | McpStore | Agent | ElevenLabs | Browser | ComputerUse | Usage | Reconciler

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** A change to a bot from Settings: blank instructions or an unknown model or effort are refused rather than saved. */
const botPatch = (v: unknown): BotPatch => {
  const p = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return {
    ...(typeof p.name === 'string' && p.name.trim() ? { name: p.name.trim().slice(0, 40) } : {}),
    ...(typeof p.instructions === 'string' ? { instructions: p.instructions } : {}),
    ...(typeof p.model === 'string' && isClaudeModel(p.model) ? { model: p.model } : {}),
    ...(EFFORTS.find((e) => e === p.effort) ? { effort: p.effort as BotPatch['effort'] } : {}),
    // The fox, the name's initial (on a tint), or a small picture.
    ...(cleanAvatar(p.avatar) !== undefined ? { avatar: cleanAvatar(p.avatar)! } : {}),
    ...(Array.isArray(p.modules) ? { modules: cleanModules(p.modules) } : {}),
    ...(p.rules && typeof p.rules === 'object' ? { rules: cleanRules(p.rules) } : {})
  }
}

/** A server from Settings, in the shape the store takes; the store checks the values. */
const mcpInput = (v: unknown): McpServerInput => {
  const p = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const pairs = (x: unknown) =>
    Array.isArray(x)
      ? x.flatMap((e) => {
          const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
          return typeof o.key === 'string' ? [{ key: o.key, ...(typeof o.value === 'string' ? { value: o.value } : {}) }] : []
        })
      : undefined
  const strs = (x: unknown) => (Array.isArray(x) ? x.filter((a): a is string => typeof a === 'string') : undefined)
  const input: McpServerInput = {}
  for (const k of ['name', 'note', 'command', 'url'] as const) if (typeof p[k] === 'string') input[k] = p[k] as string
  if (typeof p.enabled === 'boolean') input.enabled = p.enabled
  if (p.transport === 'stdio' || p.transport === 'http' || p.transport === 'sse') input.transport = p.transport
  if (strs(p.args)) input.args = strs(p.args)!
  if (pairs(p.env)) input.env = pairs(p.env)!
  if (pairs(p.headers)) input.headers = pairs(p.headers)!
  if (p.access === 'allow' || p.access === 'ask' || p.access === 'block') input.access = p.access
  if (p.toolAccess && typeof p.toolAccess === 'object') input.toolAccess = p.toolAccess as McpServerInput['toolAccess']
  if (p.bots === 'all' || strs(p.bots)) input.bots = p.bots === 'all' ? 'all' : strs(p.bots)!
  return input
}

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

/** Writes a browser recording to Videos/Tomo and returns its path. */
const saveRecording = (data: ArrayBuffer) => {
  const dir = join(app.getPath('videos'), 'Tomo')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `recording-${stamp()}.webm`)
  writeFileSync(file, new Uint8Array(data))
  return file
}

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
  const running = yield* (yield* Reconciler).running
  return yield* (yield* Db).use((d): MemoryView => {
    const playbooks = d.playbooks()
    return {
      records: d.profile(),
      revisions: d.memoryHistory(),
      lastRun,
      reconciler: { lastRun: d.lastReconcilerRun(), running, pending: d.pendingReconcileCount() },
      playbooks: d.playbookBots().map((b) => ({ botId: b.id, botName: b.name, avatar: b.avatar, records: playbooks.get(b.id) ?? [] }))
    }
  })
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
  'sessions:markRead': (id) => Db.use((db) => db.use((d) => d.markRead(str(id, 'id')))),
  // A new job's thread, owned by the primary bot.
  'sessions:create': () =>
    Effect.gen(function* () {
      const db = yield* Db
      const { thread } = yield* db.use((d) => d.createJob({ title: NEW_SESSION_TITLE, botId: d.primaryBot().id }))
      return yield* (yield* Chat).view(thread.id)
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
          ...(typeof patch.pinned === 'boolean' ? { pinned: patch.pinned } : {})
        })
      )
    ),
  'sessions:remove': (id) =>
    Effect.gen(function* () {
      const db = yield* Db
      const chat = yield* Chat
      for (const messageId of yield* db.use((d) => d.streamingIds(str(id, 'id')))) yield* chat.stop(messageId)
      const orphans = yield* db.use((d) => d.deleteSession(id))
      yield* (yield* Attachments).removeFiles(orphans.files)
      yield* Agent.use((a) => Effect.sync(() => a.forget(orphans.agentSessions)))
    }),
  // Export log: the thread's job, its transcripts and files in a zip the user saves, to attach to an issue.
  'sessions:exportLog': (id) =>
    Effect.gen(function* () {
      const data = yield* (yield* Db).require('Thread', (d) => collectLog(d, str(id, 'id')))
      const settings = yield* (yield* SettingsStore).get.pipe(Effect.orElseSucceed(() => null))
      const agent = yield* Agent
      const title = data.job?.title ?? data.threads[0]?.session.title ?? 'thread'
      const file = yield* Effect.promise(async () => {
        // CHAT_V2_EXPORT_DIR (tests only): saves there without asking.
        if (process.env.CHAT_V2_EXPORT_DIR) return join(process.env.CHAT_V2_EXPORT_DIR, logFileName(title, new Date()))
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
        const options = { title: 'Export log', defaultPath: join(app.getPath('downloads'), logFileName(title, new Date())), filters: [{ name: 'Zip archive', extensions: ['zip'] }] }
        const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
        return result.canceled || !result.filePath ? null : result.filePath
      })
      if (!file) return null
      const about = { version: app.getVersion(), platform: process.platform, arch: process.arch, os: `${os.type()} ${os.release()}`, electron: process.versions.electron ?? null }
      const saved = yield* Effect.tryPromise({
        try: () => exportLog(data, file, { transcripts: agent.transcripts, about, settings }),
        catch: (cause) => new FileError({ message: `Could not export the log: ${errorMessage(cause)}`, cause })
      })
      if (!process.env.CHAT_V2_EXPORT_DIR) shell.showItemInFolder(saved.path)
      return saved
    }),
  'sessions:fork': (sessionId, messageId) =>
    Effect.gen(function* () {
      const db = yield* Db
      // A fork is a job of its own, a child of the one it came from.
      const fork = yield* db.use((d) => d.forkThread(str(sessionId, 'sessionId'), str(messageId, 'messageId')))
      return yield* (yield* Chat).view(fork.id)
    }),

  'bots:list': () => Db.use((db) => db.use((d) => d.listBots())),
  'bots:update': (id, patch) => Db.use((db) => db.use((d) => (d.updateBot(str(id, 'id'), botPatch(patch)), d.listBots()))),
  'bots:create': (patch) => Team.use((t) => t.createBot(botPatch(patch))),
  'bots:remove': (id) => Team.use((t) => t.removeBot(str(id, 'id'))),
  'bots:setPrimary': (id) => Team.use((t) => t.setPrimary(str(id, 'id'))),
  'bots:presence': () => Team.use((t) => t.presence),

  'jobs:list': () => Db.use((db) => db.use((d) => d.listJobs())),
  'jobs:primary': () => Jobs.use((j) => j.primary),
  'jobs:send': (input) =>
    Jobs.use((j) => j.send({ text: str(input.text, 'text'), attachmentIds: ids(input.attachmentIds) })),
  'jobs:newTopic': () => Jobs.use((j) => j.newTopic),
  'jobs:setStatus': (id, status) => Jobs.use((j) => j.setStatus(str(id, 'id'), status === 'done' ? 'done' : 'open')),
  'jobs:detail': (id) => Team.use((t) => t.detail(str(id, 'id'))),
  'jobs:rename': (id, title) => Db.use((db) => db.use((d) => d.renameJob(str(id, 'id'), str(title, 'title').trim() || NEW_SESSION_TITLE))),
  'jobs:remove': (id) => Jobs.use((j) => j.remove(str(id, 'id'))),
  // The user takes approvals back from Tomo on a job (Tomo turns it on only when they tell it to).
  'jobs:stopApproving': (id) => Db.use((db) => db.use((d) => d.setJobApprover(str(id, 'id'), null))),

  'memory:get': () => memoryView,
  'memory:add': (fact) => editMemory((d) => d.changeMemory({ add: [typedFact(fact)], update: [], remove: [] }, { kind: 'edited' })),
  'memory:edit': (id, fact) =>
    editMemory((d) => d.changeMemory({ add: [], update: [{ id: int(id, 'id'), fact: typedFact(fact) }], remove: [] }, { kind: 'edited' })),
  'memory:purge': (id) => editMemory((d) => d.purgeRecord(int(id, 'id'))),
  'memory:versions': (id) => Db.use((db) => db.use((d) => d.recordVersions(int(id, 'id')))),
  'memory:clear': () => editMemory((d) => d.clearMemory()),
  'memory:restore': (rev) => editMemory((d) => d.restoreMemory(int(rev, 'rev'))),
  'memory:reconcile': () => Reconciler.use((r) => r.runNow).pipe(Effect.andThen(memoryView)),

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
  // The user's Stop ends the reply; messages held behind it are answered next.
  'chat:stop': (messageId) =>
    Effect.gen(function* () {
      const chat = yield* Chat
      const id = str(messageId, 'messageId')
      const sessionId = yield* (yield* Db).use((d) => d.getMessage(id)?.sessionId ?? null)
      yield* chat.stop(id)
      if (sessionId) yield* chat.drain(sessionId).pipe(Effect.ignore)
    }),
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
  'attachments:addVideoFile': (input: { path: string; name: string; mime: string }) =>
    Attachments.use((a) =>
      a.addVideoFile({ path: str(input.path, 'path'), name: str(input.name, 'name'), mime: typeof input.mime === 'string' ? input.mime : '' })
    ),
  'attachments:discard': (id) => Attachments.use((a) => a.discard(str(id, 'id'))),
  'attachments:saveAs': (id, name) =>
    Effect.gen(function* () {
      const file = yield* (yield* Attachments).read(str(id, 'id'))
      const fileName = str(name, 'name').replace(/[\\/:*?"<>|]+/g, '-')
      const where = file.mime.startsWith('image/') ? 'pictures' : 'downloads'
      return yield* Effect.promise(async () => {
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
        const options = { defaultPath: join(app.getPath(where), fileName) }
        const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
        if (result.canceled || !result.filePath) return null
        writeFileSync(result.filePath, file.data)
        return result.filePath
      })
    }),
  'attachments:setAnalysis': (id, analysis: AudioAnalysis) =>
    Db.use((db) => db.use((d) => d.setAnalysis(str(id, 'id'), analysis))),

  'mcp:list': () => McpStore.use((m) => m.list),
  'mcp:create': (input) => McpStore.use((m) => m.create(mcpInput(input))),
  'mcp:update': (id, input) => McpStore.use((m) => m.update(str(id, 'id'), mcpInput(input))),
  'mcp:remove': (id) => McpStore.use((m) => m.remove(str(id, 'id'))),
  'mcp:import': (text) => McpStore.use((m) => m.importJson(str(text, 'text'))),
  'mcp:test': (id) => testServer(str(id, 'id')),
  'mcp:setBot': (id, botId, on) =>
    Effect.gen(function* () {
      const bots = yield* (yield* Db).use((d) => d.listBots().map((b) => b.id))
      return yield* (yield* McpStore).setBot(str(id, 'id'), str(botId, 'botId'), on === true, bots)
    }),
  'mcp:openFile': () =>
    Effect.gen(function* () {
      const store = yield* McpStore
      // A file that isn't there yet can't be opened: write the empty list first.
      if (!existsSync(store.file)) writeFileSync(store.file, JSON.stringify({ servers: [] }, null, 2) + '\n', 'utf8')
      yield* Effect.promise(() => shell.openPath(store.file))
    }),

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

  'stt:microphone': () => Effect.promise(microphoneAccess),
  'stt:transcribe': (audio: ArrayBuffer, mime) =>
    ElevenLabs.use((e) => e.transcribe(new Uint8Array(audio), str(mime, 'mime'))),

  'artifacts:publish': (html) => Effect.sync(() => publishArtifact(str(html, 'html'))),

  'updates:get': () => Effect.sync(updateState),
  'updates:check': () => Effect.promise(checkForUpdates),
  'updates:download': () => Effect.promise(downloadUpdate),
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
  'browser:saveRecording': (data: ArrayBuffer) => Effect.sync(() => saveRecording(data)),
  // The panel answering the assistant's start or stop; a finished video is saved where the user's own go.
  'browser:recordReply': (reply: RecordReply) =>
    Effect.gen(function* () {
      const browser = yield* Browser
      if (!reply.ok) return yield* browser.recordReply({ ok: false, error: str(reply.error, 'error') }).pipe(Effect.as(null))
      if (!(reply.data instanceof ArrayBuffer)) return yield* browser.recordReply({ ok: true }).pipe(Effect.as(null))
      let path: string
      try {
        path = saveRecording(reply.data)
      } catch (e) {
        yield* browser.recordReply({ ok: false, error: `Could not save the recording: ${errorMessage(e)}` })
        throw e
      }
      yield* browser.recordReply({ ok: true, path, seconds: Math.round(Number(reply.seconds) || 0) })
      return path
    }),
  'browser:reveal': (path) => Effect.sync(() => shell.showItemInFolder(str(path, 'path'))),

  // The usage meter: `get` answers at once from what is known and reads the meter if a read is due;
  // `refresh` (a view of it opened) waits for that read.
  'usage:get': () => Usage.use((u) => u.view.pipe(Effect.tap(() => Effect.forkDetach(u.refresh(false))))),
  'usage:refresh': () => Usage.use((u) => u.refresh(true)),
  'usage:cancelPause': (messageId) => Usage.use((u) => u.cancelPause(str(messageId, 'messageId'))),
  'usage:jobShare': (jobId) => Usage.use((u) => u.jobShare(str(jobId, 'jobId'))),
  'usage:share': (keys, window) => Usage.use((u) => u.share({ keys: ids(keys), ...(typeof window === 'string' ? { window } : {}) })),

  'computer:supported': () => ComputerUse.use((c) => Effect.succeed(c.supported)),
  'computer:waiting': () => ComputerUse.use((c) => Effect.sync(c.waiting)),
  'computer:approve': (id, approved) => ComputerUse.use((c) => c.approve(str(id, 'id'), approved === true)),
  'computer:teachDone': (id) => ComputerUse.use((c) => c.teachDone(str(id, 'id'))),
  'computer:setMode': (sessionId, messageId, mode) =>
    Chat.use((c) => c.setComputerMode({ sessionId: str(sessionId, 'sessionId'), messageId: str(messageId, 'messageId'), mode: mode === 'teach' ? 'teach' : 'do' }))
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
}
