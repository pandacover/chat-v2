import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { BrowserWindow, type WebContents, WebContentsView, app, ipcMain, autoUpdater as nativeUpdater, nativeTheme, safeStorage, session, shell, webContents } from 'electron'
import { Cause, Effect, Layer, ManagedRuntime } from 'effect'
import { adUrlPatterns } from '@shared/blocklist'
import type { BrowserEvent, StreamEvent } from '@shared/types'
import { type MainServices, pinWindow, registerIpc } from './ipc'
import { killAllChildren, runningChildren, stopAllChildren, trackChild } from './children'
import { setAppMenu } from './menu'
import { handleProtocols, registerSchemes } from './protocols'
import { initUpdater, offerMoveToApplications } from './updater'
import { AppPaths } from './services/AppPaths'
import { Attachments } from './services/Attachments'
import { shrinkImage } from './images'
import { Browser } from './services/Browser'
import { Broadcaster, Chat } from './services/Chat'
import { Agent, type AgentDeps, type QueryFn } from './agent/driver'
import type { RunContext } from './agent/module'
import { ComputerUse, type Platform, makePlatform, supported } from './computer'
import { makeElectronOverlay } from './computer/overlay'
import { type Bitmap, type Pointer, makePointer } from './computer/point'
import { isSensitive } from './memory'
import { Db } from './services/Db'
import { Usage } from './usage/Usage'
import { Jobs } from './services/Jobs'
import { Reconciler } from './services/Reconciler'
import { Team } from './services/Team'
import { ElevenLabs } from './services/ElevenLabs'
import { videosLayer } from './services/Videos'
import { probeVideo, videoFrames } from './video'
import { type SecretCipher, SettingsStore } from './services/SettingsStore'

// The app was called chat-v2, and its data (chats, settings, keys) lives in a folder of that name.
// Renamed Tomo, Electron would default to a new, empty "Tomo" folder: keep the old one. Not when
// --user-data-dir is passed (tests pass a temp folder and must never touch real data).
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', join(app.getPath('appData'), 'chat-v2'))
// On macOS and Linux the key that encrypts saved API keys (safeStorage) is kept in the OS keychain
// under the app's name ("chat-v2 Safe Storage"), read at startup: renamed, the app could no longer
// decrypt them. So the name stays chat-v2 there, and the Mac menu says Tomo itself (menu.ts).
// On Windows the key lives in the userData folder, so the name can follow the brand.
app.setName(process.platform === 'win32' ? 'Tomo' : 'chat-v2')

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
 * and the child processes are asked to exit, before the services close.
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
const isWebUrl = (url: string) => /^https?:\/\//i.test(url)

const originOf = (url: string) => {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * A site's service worker outlives its page and keeps the page's renderer process going: one ran
 * on for minutes after the browser had moved to another site, or closed, holding 70 to 130 MB.
 * Unregistering doesn't end a running worker; DevTools can. This stops the built-in browser's
 * workers through `via`'s DevTools: all of them, or all but those of the page now open (`keep`).
 * A stopped worker starts again when its site needs it.
 */
const stopWorkers = async (via: WebContents, keep?: string | null) => {
  const running = Object.entries(session.fromPartition(BROWSER_PARTITION).serviceWorkers.getAllRunning())
  const ids = running.filter(([, worker]) => keep === undefined || originOf(worker.scope) !== keep).map(([id]) => id)
  if (ids.length === 0) return
  // Browser.ts works the page through the same DevTools session, and leaves it attached too.
  if (!via.debugger.isAttached()) via.debugger.attach('1.3')
  await via.debugger.sendCommand('ServiceWorker.enable')
  try {
    for (const versionId of ids) await via.debugger.sendCommand('ServiceWorker.stopWorker', { versionId })
  } finally {
    await via.debugger.sendCommand('ServiceWorker.disable')
  }
}

/**
 * Closing the browser panel takes its page's DevTools with it, so a hidden page in the browser's
 * session stops the workers instead, a moment later: by then a window closing for good has started
 * the app quitting, and there's nothing to stop.
 */
const stopWorkersAfterClose = () =>
  setTimeout(() => {
    if (quitting || Object.keys(session.fromPartition(BROWSER_PARTITION).serviceWorkers.getAllRunning()).length === 0) return
    const view = new WebContentsView({ webPreferences: { partition: BROWSER_PARTITION, sandbox: true, contextIsolation: true } })
    const page = view.webContents
    void page
      .loadURL('about:blank')
      .then(() => stopWorkers(page))
      .catch(() => undefined)
      .finally(() => {
        // Referring to the view here keeps it, and its page, alive until the job is done.
        if (!view.webContents.isDestroyed()) page.close()
      })
  }, 1000)

const load = createRequire(__filename)

/**
 * The Claude Code binary of a packaged app. The SDK looks for it beside itself, inside app.asar,
 * where nothing can run; electron-builder unpacks it next to the archive (asarUnpack).
 */
const claudeBinary = () =>
  load
    .resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${process.platform === 'win32' ? '.exe' : ''}`)
    .replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')

const agentDeps = (root: string): AgentDeps => {
  const configDir = join(root, 'claude')
  mkdirSync(configDir, { recursive: true })
  return {
    // CHAT_V2_FAKE_QUERY (tests only): a module whose `query` stands in for the SDK's.
    query: process.env.CHAT_V2_FAKE_QUERY ? (load(process.env.CHAT_V2_FAKE_QUERY) as { query: QueryFn }).query : query,
    configDir,
    cwd: root,
    clientApp: `tomo/${app.getVersion()}`,
    ...(app.isPackaged ? { executable: claudeBinary() } : {}),
    // Started as the SDK would, but tracked, so quitting ends every Claude Code process.
    spawn: (o) => {
      const child = trackChild(spawn(o.command, o.args, { cwd: o.cwd, env: o.env, signal: o.signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }))
      child.stderr.on('data', (chunk: Buffer) => console.warn(`[claude] ${chunk.toString().trimEnd()}`))
      return child
    }
  }
}

/** The computer-use overlay window and Stop shortcut; made once the app is ready. */
let overlay: ReturnType<typeof makeElectronOverlay> | null = null
/** What Point (the user marking part of the screen for the agent) needs from the computer layer. */
let pointDeps: { platform: Platform | null; refocus: () => void; capture?: (d: Electron.Display) => Promise<Bitmap>; unavailable?: string } | null = null
let pointer: Pointer | null = null

/**
 * Computer use. `remember` keeps a fact the model was told to save in memory, as one learned in
 * that chat, unless memory is off or the fact looks like a secret.
 */
const computerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const db = yield* Db
    const settings = yield* SettingsStore
    const remember = async (fact: string, ctx: RunContext) => {
      if (!(await Effect.runPromise(settings.get)).memoryModel) throw new Error('Memory is off in Settings, so nothing was saved.')
      if (isSensitive(fact)) throw new Error("That looks like a password, key or account number, which memory doesn't keep.")
      const saved = await Effect.runPromise(db.use((d) => d.changeMemory({ add: [fact], update: [], remove: [] }, { kind: 'learned', writer: 'bot', sessionId: ctx.sessionId, jobId: ctx.jobId ?? null })))
      if (saved) broadcaster.send({ type: 'memory', sessionId: ctx.sessionId, added: saved.added, removed: saved.removed })
    }
    // CHAT_V2_FAKE_COMPUTER (tests only): a module whose `platform` stands in for the real one,
    // or whose `wrap` changes it (a live test refuses everything that would act).
    // A fake may also export `capture` (Point's screen capture).
    const fake = process.env.CHAT_V2_FAKE_COMPUTER
      ? (load(process.env.CHAT_V2_FAKE_COMPUTER) as { platform?: Platform; wrap?: (p: Platform) => Platform; capture?: (d: Electron.Display) => Promise<Bitmap> })
      : null
    const real = supported && !fake?.platform ? makePlatform({ track: trackChild }) : null
    const platform = fake?.platform ?? (real && fake?.wrap ? fake.wrap(real) : real)
    // After a press on the overlay, focus goes back to the app the user was in (the one under it).
    const refocus = () => void platform?.remember().then(() => platform.restoreFocus()).catch(() => undefined)
    // On Linux the overlay is never shown unless CHAT_V2_LINUX_OVERLAY=1: without a compositing
    // manager X11 draws its transparent window solid black over the whole screen (and into every
    // screenshot), and it can't be hidden from capture there anyway. The Stop shortcut still works.
    const linuxNoOverlay = process.platform === 'linux' && process.env.CHAT_V2_LINUX_OVERLAY !== '1'
    overlay = makeElectronOverlay({ refocus, ...(linuxNoOverlay ? { headless: true } : {}) })
    pointDeps = {
      platform,
      refocus,
      ...(fake?.capture ? { capture: fake.capture } : {}),
      ...(linuxNoOverlay ? { unavailable: 'Point needs the computer-use overlay, which is off on Linux unless CHAT_V2_LINUX_OVERLAY=1 (it needs a compositing window manager).' } : {})
    }
    return ComputerUse.layer({ platform, overlay, remember })
  })
)

/**
 * An approval waits in its chat, and the app computer use drives often covers the chat window.
 * The windows come to the front without taking focus, so a key meant for that app can't answer
 * it. Answering focuses the chat, and the next input gives focus back to the app first.
 */
const raiseForApproval = () => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win === overlay?.window || win.isDestroyed() || !win.isVisible()) continue
    if (win.isMinimized()) win.showInactive()
    win.moveTop()
  }
}

const makeRuntime = () => {
  const root = app.getPath('userData')
  const paths = AppPaths.layer(root)
  const db = Db.layer(join(root, 'chat.db'))
  const settings = SettingsStore.layer(cipher).pipe(Layer.provide(paths))
  const base = Layer.mergeAll(db, settings, paths)
  const providers = Layer.mergeAll(Agent.layer(agentDeps(root)), ElevenLabs.layer, Attachments.layerWith(shrinkImage, probeVideo), Browser.layer(emitBrowser, (id) => webContents.fromId(id))).pipe(
    Layer.provideMerge(base)
  )
  const computer = computerLayer.pipe(Layer.provide(base))
  // The usage meter and limit pauses (src/main/usage), which Chat reports replies to.
  // CHAT_V2_MIN_PAUSE_MS (tests only): how soon a paused reply may continue, instead of a minute.
  const minPause = Number(process.env.CHAT_V2_MIN_PAUSE_MS)
  const timing = Number.isFinite(minPause) && minPause >= 0 ? { minPauseMs: minPause, marginMs: Math.min(minPause, 15_000) } : {}
  const usage = Usage.layer((e) => sendAll('usage:event', e), timing).pipe(Layer.provide(providers))
  const chat = Chat.layer.pipe(
    Layer.provide(Layer.mergeAll(providers, computer, usage)),
    Layer.provide(Layer.succeed(Broadcaster, broadcaster))
  )
  // The primary bot's conversation and its jobs, over Chat.
  const jobs = Jobs.layer.pipe(
    Layer.provideMerge(chat),
    Layer.provide(Layer.merge(providers, computer)),
    Layer.provide(Layer.succeed(Broadcaster, broadcaster))
  )
  // Workers: the team tools, reports and presence (services/Team.ts), over the same Chat.
  const team = Team.layer.pipe(Layer.provide(Layer.mergeAll(chat, providers, computer)), Layer.provide(Layer.succeed(Broadcaster, broadcaster)))
  // The video tools (agent/video.ts): frames decoded in a short-lived worker view (video.ts), transcripts from Scribe.
  const videos = videosLayer({ probe: probeVideo, frames: videoFrames }).pipe(Layer.provide(Layer.mergeAll(chat, providers, computer)))
  // The daily memory review (reconciler.ts), when the app is idle.
  const reconciler = Reconciler.layer.pipe(Layer.provide(providers), Layer.provide(Layer.succeed(Broadcaster, broadcaster)))
  return ManagedRuntime.make(Layer.mergeAll(jobs, team, videos, providers, computer, usage, reconciler))
}

let runtime: ManagedRuntime.ManagedRuntime<MainServices | AppPaths, unknown> | null = null

// For automated testing: the window is never shown but keeps rendering, so screenshots still work.
const headless = process.env.CHAT_V2_HEADLESS === '1'

/**
 * The window has no title bar of its own: the top strip of the page, in the sidebar's colour
 * (app.css --side, --bar-h), is Tomo's app bar. Windows and Linux draw their window buttons over
 * its right end in the same colour, with the theme's text colour (--fg-2), and the page tells the
 * window when the theme changes; a Mac keeps its traffic lights, at the bar's left end.
 */
const BAR_HEIGHT = 36
/** A colour under black at `alpha`, as a modal's scrim (app.css --scrim) shows it. */
const dim = (hex: string, alpha: number) =>
  `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`
const barOverlay = (dark: boolean, dimmed = false) => {
  const color = dark ? '#09090a' : '#f5f3f1'
  const symbolColor = dark ? '#d6d3d1' : '#292524'
  const scrim = dimmed ? (dark ? 0.55 : 0.3) : 0
  return { color: dim(color, scrim), symbolColor: dim(symbolColor, scrim), height: BAR_HEIGHT }
}
const isMac = process.platform === 'darwin'
ipcMain.on('window:theme', (event, theme: unknown, dimmed: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || (theme !== 'dark' && theme !== 'light')) return
  win.setBackgroundColor(barOverlay(theme === 'dark').color)
  if (!isMac) win.setTitleBarOverlay(barOverlay(theme === 'dark', dimmed === true))
})

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
    // The sidebar's colour (app.css --side), so the window never flashes another before it paints.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#09090a' : '#f5f3f1',
    title: 'Tomo',
    autoHideMenuBar: true,
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 11 } }
      : { titleBarStyle: 'hidden' as const, titleBarOverlay: barOverlay(nativeTheme.shouldUseDarkColors) }),
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
    // Leaving a site ends its service workers; closing the browser, all of them (see stopWorkers).
    contents.on('did-navigate', (_event, url) => void stopWorkers(contents, originOf(url)).catch(() => undefined))
    contents.once('destroyed', stopWorkersAfterClose)
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
  // What the last run left waiting (messages held behind a reply, posts a bot never got) is answered now.
  void rt.runPromise(
    Team.use((t) => t.resume).pipe(
      Effect.tap((n) => (n > 0 ? Effect.logInfo(`Answered held messages in ${n} threads`) : Effect.void)),
      Effect.catchCause((cause) => Effect.logWarning(`Answering held messages failed: ${Cause.pretty(cause)}`))
    )
  )

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'clipboard-sanitized-write')
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')
  // Sites in the built-in browser get no camera, microphone, location or notifications.
  const browserSession = session.fromPartition(BROWSER_PARTITION)
  browserSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'clipboard-sanitized-write'))
  browserSession.setPermissionCheckHandler(() => false)
  // Nor ads and trackers (see @shared/blocklist): an ad-heavy page ran a renderer process for each
  // ad frame. Only requests to those hosts come here. Opening one as a page still works, so
  // clicking an ad goes where it leads.
  browserSession.webRequest.onBeforeRequest({ urls: adUrlPatterns() }, (details, callback) => callback({ cancel: details.resourceType !== 'mainFrame' }))

  const computer = await rt.runPromise(ComputerUse.use(Effect.succeed))
  computer.subscribe((waiting) => {
    if (waiting?.kind === 'approval') raiseForApproval()
  })
  // Point: the user marks part of the screen; the mark goes into the next message as attachments.
  if (overlay && pointDeps) {
    const attachments = await rt.runPromise(Attachments.use(Effect.succeed))
    pointer = makePointer({
      overlay,
      ...pointDeps,
      attach: (file) => Effect.runPromise(attachments.add(file)),
      tell: (e) => {
        // While the user points, a computer reply's input would land on Point's layer: it pauses.
        computer.pointing(e.active)
        broadcaster.send({ type: 'point', ...e })
      }
    })
  }

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
  pointer?.dispose()
  pointer = null
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
// Whatever child is still running when the process ends is killed with it.
process.on('exit', () => killAllChildren())

// Installing an update closes the windows before before-quit, so quitting starts here for it.
if (process.platform === 'darwin') nativeUpdater.on('before-quit-for-update', () => beginQuit('before-quit-for-update'))

/**
 * CHAT_V2_QUIT_TEST (scripts/quit-smoke.ts): starts a stand-in child process that never exits on
 * its own, prints its pid, and quits. `hang` also makes closing the services never finish.
 */
const quitTest = () => {
  const child = trackChild(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe' }))
  console.log(`[quit-test] child ${child.pid}`)
  // Quits once the window has loaded and settled, as a user would. On a macOS VM without a GPU
  // (CI), quitting in the first seconds after launch stalls the main thread until startup work
  // drains, on main as well as here (2-5 s, past the test's limit); quitting a few seconds in, it
  // exits in well under a second. That stall isn't what this test is for: a quit that hangs is.
  const quit = () =>
    setTimeout(() => {
      console.log('[quit-test] quitting')
      app.quit()
    }, SETTLE_MS)
  const win = BrowserWindow.getAllWindows()[0]
  if (!win || !win.webContents.isLoading()) quit()
  else win.webContents.once('did-finish-load', quit)
}
/** How long the quit test lets the window settle after it loads. */
const SETTLE_MS = 5000
