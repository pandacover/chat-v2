import { join } from 'node:path'
import { BrowserWindow, app, nativeTheme, safeStorage, session, shell } from 'electron'
import { Effect, Layer, ManagedRuntime } from 'effect'
import type { StreamEvent } from '@shared/types'
import { type MainServices, registerIpc } from './ipc'
import { handleProtocols, registerSchemes } from './protocols'
import { AppPaths } from './services/AppPaths'
import { Attachments } from './services/Attachments'
import { Broadcaster, Chat } from './services/Chat'
import { Db } from './services/Db'
import { ElevenLabs } from './services/ElevenLabs'
import { OpenRouter } from './services/OpenRouter'
import { type SecretCipher, SettingsStore } from './services/SettingsStore'

registerSchemes()

const cipher: SecretCipher = {
  encrypt: (plain) =>
    safeStorage.isEncryptionAvailable()
      ? `enc:${safeStorage.encryptString(plain).toString('base64')}`
      : `b64:${Buffer.from(plain).toString('base64')}`,
  decrypt: (value) =>
    value.startsWith('enc:')
      ? safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'))
      : Buffer.from(value.replace(/^b64:/, ''), 'base64').toString('utf8')
}

const broadcaster = Broadcaster.of({
  send: (event: StreamEvent) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('chat:event', event)
    }
  }
})

const makeRuntime = () => {
  const root = app.getPath('userData')
  const paths = AppPaths.layer(root)
  const db = Db.layer(join(root, 'chat.db'))
  const settings = SettingsStore.layer(cipher).pipe(Layer.provide(paths))
  const base = Layer.mergeAll(db, settings, paths)
  const providers = Layer.mergeAll(OpenRouter.layer, ElevenLabs.layer, Attachments.layer).pipe(Layer.provideMerge(base))
  const chat = Chat.layer.pipe(
    Layer.provide(providers),
    Layer.provide(Layer.succeed(Broadcaster, broadcaster))
  )
  return ManagedRuntime.make(Layer.mergeAll(chat, providers))
}

let runtime: ManagedRuntime.ManagedRuntime<MainServices | AppPaths, unknown> | null = null

// For automated testing: the window is never shown but keeps rendering, so screenshots still work.
const headless = process.env.CHAT_V2_HEADLESS === '1'

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 760,
    minHeight: 520,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#171614' : '#f7f5f0',
    title: 'chat-v2',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !headless
    }
  })
  if (!headless) win.once('ready-to-show', () => win.show())
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

const isAppUrl = (url: string) =>
  url.startsWith('file://') || (!!process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL))

app.on('web-contents-created', (_event, contents) => {
  // Links open in the system browser; nothing navigates the app window away.
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })
})

app.whenReady().then(async () => {
  const rt = makeRuntime()
  runtime = rt as typeof runtime

  // Crash recovery: replies that were mid-stream when the app last stopped.
  await rt.runPromise(
    Effect.gen(function* () {
      const db = yield* Db
      const attachments = yield* Attachments
      const recovered = yield* db.use((d) => d.markInterrupted())
      if (recovered > 0) yield* Effect.logInfo(`Marked ${recovered} interrupted replies`)
      const stale = yield* db.use((d) => d.pruneOrphanAttachments(Date.now() - 24 * 60 * 60 * 1000))
      yield* attachments.removeFiles(stale)
    })
  )

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'clipboard-sanitized-write')
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')

  registerIpc(rt)
  handleProtocols(rt)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Disposing the runtime interrupts in-flight generations, which marks them `interrupted`
// so they can be continued on next launch.
let disposed = false
app.on('before-quit', (event) => {
  if (disposed || !runtime) return
  event.preventDefault()
  disposed = true
  void runtime.dispose().finally(() => app.quit())
})
