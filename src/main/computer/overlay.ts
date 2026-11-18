// The computer-use overlay: a full-screen, click-through, always-on-top window. While computer use
// drives, it draws a hairline frame around the screen; in Show-me mode, a spotlight on the exact
// control with the instruction and a Done button beside it. It only takes the mouse while the
// pointer is on that callout, and screen captures leave it out. The global Stop shortcut is here
// too: the chat window is often covered while computer use acts.
import { join } from 'node:path'
import { app, BrowserWindow, globalShortcut, ipcMain, screen, type Rectangle } from 'electron'
import { STOP_SHORTCUT } from '@shared/computer'
import type { OverlayState, OverlayTeach } from '../../preload/computer-overlay'
import type { TeachTarget } from './interaction'
import type { OverlayPort } from './port'

/** The platform reports rects in input space (physical pixels on Windows); the overlay works in DIPs. */
const toDip = (r: Rectangle): Rectangle => (process.platform === 'win32' ? screen.screenToDipRect(null, r) : r)

export interface ElectronOverlayOptions {
  /** Never show the window (CHAT_V2_HEADLESS=1); it still renders, so tests can capture it. */
  headless?: boolean
  /** Built files; the defaults are where electron-vite puts them next to out/main. */
  preload?: string
  page?: string
}

export const makeElectronOverlay = (opts: ElectronOverlayOptions = {}): OverlayPort & { readonly window: BrowserWindow | null } => {
  const headless = opts.headless ?? process.env.CHAT_V2_HEADLESS === '1'
  let win: BrowserWindow | null = null
  let acting = false
  let teach: TeachTarget | null = null
  let state: OverlayState = { acting: false, teach: null }
  let protecting = false
  const doneListeners: Array<() => void> = []
  const stopListeners: Array<() => void> = []
  let holdingKey = false
  const pressed = () => {
    for (const f of stopListeners) f()
  }

  const create = () => {
    const w = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      focusable: false,
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
    w.setIgnoreMouseEvents(true, { forward: true })
    // Invisible to screenshots, so the model never sees (or clicks) the overlay itself.
    w.setContentProtection(true)
    // A fresh renderer starts from what main last sent.
    w.webContents.on('did-finish-load', () => w.webContents.send('computer-overlay:state', state))
    w.on('closed', () => {
      if (win === w) win = null
    })
    const url = process.env.ELECTRON_RENDERER_URL
    if (opts.page) void w.loadFile(opts.page)
    else if (url) void w.loadURL(`${url}/computer-overlay.html`)
    else void w.loadFile(join(__dirname, '../renderer/computer-overlay.html'))
    return w
  }

  const fromOverlay = (sender: Electron.WebContents) => !!win && !win.isDestroyed() && sender === win.webContents
  // Only a Show-me callout ever takes the mouse; the acting frame never does.
  ipcMain.on('computer-overlay:interactive', (e, on: boolean) => {
    if (fromOverlay(e.sender)) win!.setIgnoreMouseEvents(!(on && teach !== null), { forward: true })
  })
  ipcMain.on('computer-overlay:done', (e) => {
    if (fromOverlay(e.sender)) for (const f of doneListeners) f()
  })

  const sync = () => {
    const show = acting || teach !== null
    if (!show && !win) return
    win ??= create()
    // Click-through again on every change; the renderer takes the mouse back only while the pointer is on the callout.
    win.setIgnoreMouseEvents(true, { forward: true })
    if (!show) {
      state = { acting: false, teach: null }
      win.webContents.send('computer-overlay:state', state)
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
    state = { acting, teach: local }
    win.webContents.send('computer-overlay:state', state)
    if (headless) return
    // Other topmost windows can push it down: put it back on top.
    win.setAlwaysOnTop(true, 'screen-saver')
    if (!win.isVisible()) win.showInactive()
  }

  const protectOne = (w: BrowserWindow) => {
    if (!w.isDestroyed()) w.setContentProtection(protecting || w === win)
  }
  const onCreated = (_e: unknown, w: BrowserWindow) => protectOne(w)

  return {
    get window() {
      return win
    },
    show: (a, t) => {
      acting = a
      teach = t
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
      ipcMain.removeAllListeners('computer-overlay:interactive')
      ipcMain.removeAllListeners('computer-overlay:done')
      if (win && !win.isDestroyed()) win.destroy()
      win = null
    }
  }
}
