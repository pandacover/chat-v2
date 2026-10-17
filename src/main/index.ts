import { join } from 'node:path'
import { BrowserWindow, app, nativeTheme, safeStorage, session, shell, webContents } from 'electron'
import { Effect, Layer, ManagedRuntime } from 'effect'
import type { BrowserEvent, StreamEvent } from '@shared/types'
import { type MainServices, pinWindow, registerIpc } from './ipc'
import { handleProtocols, registerSchemes } from './protocols'
import { initUpdater } from './updater'
import { AppPaths } from './services/AppPaths'
import { Sketches } from './services/Sketches'
import { Attachments } from './services/Attachments'
import { Browser } from './services/Browser'
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

/**
 * Set once quitting starts. From then on the window hears nothing more and its calls get no
 * answer: shutting down interrupts replies, and a window that reacted to that would only call
 * back into services that are already closed.
 */
let quitting = false
const isQuitting = () => quitting

const sendAll = (channel: string, payload: unknown) => {
  if (quitting) return
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload)
  }
}

const broadcaster = Broadcaster.of({ send: (event: StreamEvent) => sendAll('chat:event', event) })

const emitBrowser = (event: BrowserEvent) => sendAll('browser:event', event)

/** The built-in browser keeps its own cookies and storage, apart from the app. */
const BROWSER_PARTITION = 'persist:browser'
const isWebUrl = (url: string) => /^https?:///i.test(url)

const makeRuntime = () => {
  const root = app.getPath('userData')
  const paths = AppPaths.layer(root)
  const db = Db.layer(join(root, 'chat.db'))
  const settings = SettingsStore.layer(cipher).pipe(Layer.provide(paths))
  const base = Layer.mergeAll(db, settings, paths)
  const providers = Layer.mergeAll(OpenRouter.layer, ElevenLabs.layer, Attachments.layer, Browser.layer(emitBrowser, (id) => webContents.fromId(id))).pipe(
    Layer.provideMerge(base)
  )
  const chat = Chat.layer.pipe(
    Layer.provide(providers),
    Layer.provide(Layer.succeed(Broadcaster, broadcaster))
  )
  const sketches = Sketches.layer.pipe(Layer.provide(providers))
  return ManagedRuntime.make(Layer.mergeAll(chat, sketches, providers))
}

let runtime: ManagedRuntime.ManagedRuntime<MainServices | AppPaths, unknown> | null = null

// For automated testing: the window is never shown but keeps rendering, so screenshots still work.
const headless = process.env.CHAT_V2_HEADLESS === '1'

const createWindow = async () => {
  const pinned = runtime
    ? await runtime.runPromise(SettingsStore.use((s) => s.get)).then((s) => s.alwaysOnTop, () => false)
    : false
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
      webviewTag: true,
      backgroundThrottling: !headless
    }
  })
  // Every <webview> gets locked-down preferences regardless of what the renderer asked for.
  win.webContents.on('will-attach-webview', (event, prefs, params) => {
    delete prefs.preload
    prefs.nodeIntegration = false
    prefs.contextIsolation = true
    prefs.sandbox = true
    prefs.partition = BROWSER_PARTITION
    if (params.src && params.src !== 'about:blank' && !isWebUrl(params.src)) event.preventDefault()
  })
  pinWindow(win, pinned)
  if (!headless) win.once('ready-to-show', () => win.show())
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

const isAppUrl = (url: string) =>
  url.startsWith('file://') || (!!process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL))

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() === 'webview') {
    // The built-in browser: web pages only, and popups open in the same view.
    contents.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) void contents.loadURL(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (!isWebUrl(url)) event.preventDefault()
    })
    return
  }
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
      yield* db.use((d) => d.pruneEmptySessions())
      const stale = yield* db.use((d) => d.pruneOrphanAttachments(Date.now() - 24 * 60 * 60 * 1000))
      yield* attachments.removeFiles(stale)
    })
  )

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'clipboard-sanitized-write')
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')
  // Sites in the built-in browser get no camera, microphone, location or notifications.
  const browserSession = session.fromPartition(BROWSER_PARTITION)
  browserSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'clipboard-sanitized-write'))
  browserSession.setPermissionCheckHandler(() => false)

  registerIpc(rt, isQuitting)
  handleProtocols(rt, isQuitting)
  await createWindow()
  initUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Disposing the runtime interrupts in-flight generations, which marks them `interrupted`
// so they can be continued on next launch.
let disposed = false
app.on('before-quit', (event) => {
  quitting = true
  if (disposed || !runtime) return
  event.preventDefault()
  disposed = true
  void runtime.dispose().finally(() => app.quit())
})
