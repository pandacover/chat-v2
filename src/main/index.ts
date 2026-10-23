import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { BrowserWindow, app, autoUpdater as nativeUpdater, nativeTheme, safeStorage, screen, session, shell, webContents } from 'electron'
import { Effect, Layer, ManagedRuntime } from 'effect'
import type { BrowserEvent, StreamEvent } from '@shared/types'
import { type MainServices, pinWindow, registerIpc } from './ipc'
import { killAllChildren, runningChildren, stopAllChildren, trackChild } from './helperProcess'
import { setAppMenu } from './menu'
import { handleProtocols, registerSchemes } from './protocols'
import { initUpdater, offerMoveToApplications } from './updater'
import { AppPaths } from './services/AppPaths'
import { Sketches } from './services/Sketches'
import { Attachments } from './services/Attachments'
import { shrinkImage } from './images'
import { Browser } from './services/Browser'
import { Broadcaster, Chat } from './services/Chat'
import { Computer } from './services/Computer'
import { electronChatWindows, electronOverlay, electronScreen, macHasPermissions, macPermissions, macScreen } from './desktop'
import { macDriver } from './macHelper'
import { windowsDriver } from './winHelper'
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

/**
 * How long quitting waits for the services to close (replies marked interrupted, the database
 * closed) before it goes ahead anyway. Anything left is recovered on the next launch.
 */
const DISPOSE_TIMEOUT_MS = 3000
/** After that, how long app.quit() gets before app.exit() ends the process regardless. */
const EXIT_DEADLINE_MS = 2000

let quitStarted = 0
/** Each step of quitting, timed from its start, to find whatever holds it up. */
const quitLog = (step: string) => console.log(`[quit] ${step} +${Math.round(performance.now() - quitStarted)} ms`)

/**
 * The first request to quit (Cmd+Q, the Dock, an update): from here the app looks gone at once,
 * and the helper processes are asked to exit, before the services close.
 */
const beginQuit = (why: string) => {
  if (quitting) return
  quitting = true
  quitStarted = performance.now()
  quitLog(`${why}, ${runningChildren()} child processes`)
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.hide()
  stopAllChildren()
}

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
  const mac = process.platform === 'darwin'
  const overlay = electronOverlay(headless)
  // On a Mac the capture helper also lists the windows and types, faster than the input helper.
  const macCapture = mac ? macScreen(overlay) : null
  const computer = Computer.layer({
    driver:
      process.platform === 'win32'
        ? windowsDriver(join(root, 'computer-helper.ps1'))
        : mac
          ? macDriver(
              join(root, 'computer-helper.js'),
              () => {
                const d = screen.getPrimaryDisplay()
                return { w: d.size.width, h: d.size.height, scale: d.scaleFactor }
              },
              macCapture?.input
            )
          : null,
    os: mac ? 'darwin' : 'win32',
    ...(mac ? { permissions: macPermissions, hasPermissions: macHasPermissions } : {}),
    screen: macCapture ?? electronScreen,
    overlay,
    chatWindows: electronChatWindows(headless),
    selfPid: process.pid
  })
  const providers = Layer.mergeAll(OpenRouter.layer, ElevenLabs.layer, Attachments.layerWith(shrinkImage), Browser.layer(emitBrowser, (id) => webContents.fromId(id)), computer).pipe(
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
  setAppMenu()
  await createWindow()
  initUpdater()
  void offerMoveToApplications()
  if (process.env.CHAT_V2_QUIT_TEST) quitTest()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Disposing the runtime interrupts in-flight generations, which marks them `interrupted`
// so they can be continued on next launch. The first quit waits for that, but only so long: a
// dispose that never finished used to swallow Cmd+Q, and only a second Quit (the Dock's) got out.
let disposed = false
app.on('before-quit', (event) => {
  beginQuit('before-quit')
  if (disposed || !runtime) return
  event.preventDefault()
  disposed = true
  const disposing = process.env.CHAT_V2_QUIT_TEST === 'hang' ? new Promise<void>(() => {}) : runtime.dispose()
  const timeout = new Promise<string>((resolve) => setTimeout(() => resolve('timed out'), DISPOSE_TIMEOUT_MS))
  void Promise.race([disposing.then(() => 'done', (e: unknown) => `failed: ${String(e)}`), timeout]).then((how) => {
    quitLog(`dispose ${how}`)
    app.quit()
    // Something still holding the quit up (a window that won't close) doesn't keep the app alive.
    setTimeout(() => {
      quitLog('app.quit() did not finish: exiting')
      app.exit(0)
    }, EXIT_DEADLINE_MS)
  })
})

app.on('will-quit', () => quitLog('will-quit'))
app.on('quit', () => quitLog('quit'))
// Whatever helper is still running when the process ends is killed with it.
process.on('exit', () => killAllChildren())

// Installing an update closes the windows before before-quit, so quitting starts here for it.
if (process.platform === 'darwin') nativeUpdater.on('before-quit-for-update', () => beginQuit('before-quit-for-update'))

/**
 * CHAT_V2_QUIT_TEST (scripts/quit-smoke.ts): starts a stand-in helper process that never exits on
 * its own, prints its pid, and quits. `hang` also makes closing the services never finish.
 */
const quitTest = () => {
  const child = trackChild(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe' }))
  console.log(`[quit-test] child ${child.pid}`)
  setTimeout(() => {
    console.log('[quit-test] quitting')
    app.quit()
  }, 1000)
}
