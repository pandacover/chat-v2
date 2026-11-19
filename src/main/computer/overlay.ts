// The computer-use overlay: a full-screen, click-through, always-on-top window. While computer use
// drives, it draws a hairline frame around the screen; in Show-me mode, a spotlight on the exact
// control with the instruction and a Done button beside it, which the user can drag aside. While a
// computer reply runs and no chat-v2 window has focus, a notch at the top of the screen says what
// it is doing, with Stop. Screen captures leave the overlay out. The global Stop shortcut is here
// too: the chat window is often covered while computer use acts.
//
// The window takes the mouse only while the pointer is on one of its controls (the callout, the
// notch). Main watches the pointer itself rather than forwarding mouse moves to the click-through
// window (setIgnoreMouseEvents' `forward`): on Windows that is a low-level mouse hook on this
// thread, which Windows silently removes the first time the thread is busy too long, and this
// thread runs the agent. And it is focusable: Windows asks an inactive window what to do with a
// click, and Chromium answers for a window that can't be activated by dropping it
// (MA_NOACTIVATEANDEAT), so Done never got a real click. Once the user is done with a control,
// focus goes back to the app they were in (`refocus`).
import { join } from 'node:path'
import { app, BrowserWindow, globalShortcut, ipcMain, screen, type Rectangle } from 'electron'
import { STOP_SHORTCUT } from '@shared/computer'
import type { OverlayRect, OverlayState, OverlayTeach } from '../../preload/computer-overlay'
import type { TeachTarget } from './interaction'
import { type Activity, type OverlayPort, cameraHousing } from './port'

/** The platform reports rects in input space (physical pixels on Windows); the overlay works in DIPs. */
const toDip = (r: Rectangle): Rectangle => (process.platform === 'win32' ? screen.screenToDipRect(null, r) : r)

export interface ElectronOverlayOptions {
  /** Never show the window (CHAT_V2_HEADLESS=1); it still renders, so tests can capture it. */
  headless?: boolean
  /** Built files; the defaults are where electron-vite puts them next to out/main. */
  preload?: string
  page?: string
  /** Gives focus back to the app the user was in, after they pressed or dragged something on the overlay. */
  refocus?: () => void
}

/** How often the pointer is checked while the overlay is up. */
const POLL_MS = 40

export const makeElectronOverlay = (opts: ElectronOverlayOptions = {}): OverlayPort & { readonly window: BrowserWindow | null } => {
  const headless = opts.headless ?? process.env.CHAT_V2_HEADLESS === '1'
  let win: BrowserWindow | null = null
  let acting = false
  let teach: TeachTarget | null = null
  let activity: Activity | null = null
  let state: OverlayState = { acting: false, teach: null, notch: null }
  let protecting = false
  const doneListeners: Array<() => void> = []
  const stopListeners: Array<() => void> = []
  let holdingKey = false
  const pressed = () => {
    for (const f of stopListeners) f()
  }
  /** The overlay's controls as the renderer last reported them (DIPs, window-relative). */
  let hits: OverlayRect[] = []
  let taking = false
  let poll: ReturnType<typeof setInterval> | null = null

  const live = () => !!win && !win.isDestroyed()
  const giveBack = () => {
    if (live() && win!.isFocused()) opts.refocus?.()
  }
  const take = (on: boolean) => {
    if (on === taking || !live()) return
    taking = on
    const hadFocus = win!.isFocused()
    win!.setIgnoreMouseEvents(!on)
    if (!on && hadFocus) opts.refocus?.()
  }
  const check = () => {
    if (!live() || hits.length === 0) return take(false)
    const p = screen.getCursorScreenPoint()
    const b = win!.getBounds()
    const x = p.x - b.x
    const y = p.y - b.y
    take(hits.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height))
  }
  const watch = (on: boolean) => {
    if (on && !poll) poll = setInterval(check, POLL_MS)
    if (!on && poll) {
      clearInterval(poll)
      poll = null
    }
  }

  /** The chat window, back in front. */
  const showChat = () => {
    const chat = BrowserWindow.getAllWindows().find((w) => w !== win && !w.isDestroyed())
    if (!chat || headless) return
    if (chat.isMinimized()) chat.restore()
    chat.show()
    chat.focus()
  }
  /** The notch is for when the chat is out of sight: minimised, or behind the app being used. */
  const chatFocused = () => {
    const f = BrowserWindow.getFocusedWindow()
    return !!f && f !== win
  }

  const create = () => {
    const w = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      // Focusable, or Windows drops clicks on it (see the top). It is click-through except on its
      // controls, so only pressing one activates it. Not toggled: on Windows setFocusable adds a
      // taskbar button, and turning it off moves focus to the window below.
      focusable: true,
      // Windows: a tool window, out of the taskbar and Alt+Tab.
      ...(process.platform === 'win32' ? { type: 'toolbar' } : {}),
      // macOS: the first click on the inactive overlay presses the control instead of only activating it.
      acceptFirstMouse: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      enableLargerThanScreen: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: opts.preload ?? join(__dirname, '../preload/computer.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    })
    w.setAlwaysOnTop(true, 'screen-saver')
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    w.setIgnoreMouseEvents(true)
    // Invisible to screenshots, so the model never sees (or clicks) the overlay itself.
    w.setContentProtection(true)
    // A fresh renderer starts from what main last sent.
    w.webContents.on('did-finish-load', () => w.webContents.send('computer-overlay:state', state))
    w.on('closed', () => {
      if (win !== w) return
      win = null
      taking = false
      hits = []
      watch(false)
    })
    const url = process.env.ELECTRON_RENDERER_URL
    if (opts.page) void w.loadFile(opts.page)
    else if (url) void w.loadURL(`${url}/computer-overlay.html`)
    else void w.loadFile(join(__dirname, '../renderer/computer-overlay.html'))
    return w
  }

  const fromOverlay = (sender: Electron.WebContents) => live() && sender === win!.webContents
  ipcMain.on('computer-overlay:hits', (e, rects: OverlayRect[]) => {
    if (!fromOverlay(e.sender) || !Array.isArray(rects)) return
    hits = rects
    check()
  })
  ipcMain.on('computer-overlay:press', (e, what: string) => {
    if (!fromOverlay(e.sender)) return
    if (what === 'done') for (const f of doneListeners) f()
    else if (what === 'stop') pressed()
    else if (what === 'chat') showChat()
    else if (what === 'moved') giveBack()
  })

  const sync = () => {
    const notch = activity !== null && !chatFocused()
    const show = acting || teach !== null || notch
    if (!show && !win) return
    win ??= create()
    if (!show) {
      state = { acting: false, teach: null, notch: null }
      win.webContents.send('computer-overlay:state', state)
      hits = []
      watch(false)
      check()
      if (win.isVisible()) win.hide()
      return
    }
    let display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    let local: OverlayTeach | null = null
    if (teach) {
      const dip = toDip(teach.rect)
      display = screen.getDisplayMatching(dip)
      local = { ...teach, rect: { ...dip, x: dip.x - display.bounds.x, y: dip.y - display.bounds.y } }
    }
    win.setBounds(display.bounds)
    state = { acting, teach: local, notch: notch ? { ...activity!, camera: cameraHousing(display) } : null }
    win.webContents.send('computer-overlay:state', state)
    watch(true)
    if (headless) return
    // Other topmost windows can push it down: put it back on top.
    win.setAlwaysOnTop(true, 'screen-saver')
    if (!win.isVisible()) win.showInactive()
  }
  // The notch comes and goes as the chat window gains and loses focus.
  const refocused = () => sync()
  app.on('browser-window-focus', refocused)
  app.on('browser-window-blur', refocused)

  const protectOne = (w: BrowserWindow) => {
    if (!w.isDestroyed()) w.setContentProtection(protecting || w === win)
  }
  const onCreated = (_e: unknown, w: BrowserWindow) => protectOne(w)

  return {
    get window() {
      return win
    },
    show: (a, t, doing) => {
      acting = a
      teach = t
      activity = doing
      sync()
    },
    protect: (on) => {
      if (on === protecting) return
      protecting = on
      for (const w of BrowserWindow.getAllWindows()) protectOne(w)
      if (on) app.on('browser-window-created', onCreated)
      else app.off('browser-window-created', onCreated)
    },
    onDone: (f) => void doneListeners.push(f),
    stopKey: (on) => {
      if (on === holdingKey) return
      holdingKey = on
      if (!on) return globalShortcut.unregister(STOP_SHORTCUT)
      if (!globalShortcut.register(STOP_SHORTCUT, pressed)) console.warn(`[computer] ${STOP_SHORTCUT} is held by another app; Stop works from the chat only`)
    },
    onStopKey: (f) => void stopListeners.push(f),
    dispose: () => {
      if (holdingKey) globalShortcut.unregister(STOP_SHORTCUT)
      holdingKey = false
      app.off('browser-window-created', onCreated)
      app.off('browser-window-focus', refocused)
      app.off('browser-window-blur', refocused)
      watch(false)
      ipcMain.removeAllListeners('computer-overlay:hits')
      ipcMain.removeAllListeners('computer-overlay:press')
      if (win && !win.isDestroyed()) win.destroy()
      win = null
    }
  }
}
