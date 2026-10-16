// App updates from this repository's GitHub releases (see electron-builder.yml).
// Windows installs in place on restart. macOS builds are unsigned, which rules out
// in-place updates there, so the new DMG is downloaded and opened instead.
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { BrowserWindow, app, net, shell } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateState } from '@shared/types'
import { errorMessage } from './errors'

const { autoUpdater } = electronUpdater

const RELEASES = 'https://github.com/pandacover/chat-v2/releases'
const CHECK_EVERY = 30 * 60 * 1000
const manual = process.platform === 'darwin'

/** electron-updater errors carry whole HTTP dumps; keep one readable line. */
const describe = (e: unknown) => {
  const text = errorMessage(e)
  if (/releases\.atom|\b404\b/.test(text)) return 'No published releases found yet.'
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::/.test(text)) return "Couldn't reach GitHub to check for updates."
  return text.split('\n')[0]!.slice(0, 200)
}

let state: UpdateState = {
  status: app.isPackaged ? 'idle' : 'unsupported',
  current: app.getVersion(),
  next: null,
  percent: null,
  error: null,
  manual
}

const set = (patch: Partial<UpdateState>) => {
  state = { ...state, ...patch }
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('updates:event', state)
}

export const updateState = () => state

export const checkForUpdates = async () => {
  if (!app.isPackaged) return state
  try {
    await autoUpdater.checkForUpdates()
  } catch (e) {
    set({ status: 'error', error: describe(e) })
  }
  return state
}

/** macOS: fetch the DMG with progress into Downloads and open it. */
const downloadDmg = async (version: string) => {
  const url = `${RELEASES}/download/v${version}/chat-v2-${version}-universal.dmg`
  const file = join(app.getPath('downloads'), `chat-v2-${version}.dmg`)
  set({ status: 'downloading', percent: 0, error: null })
  const res = await net.fetch(url)
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`)
  const total = Number(res.headers.get('content-length')) || 0
  let received = 0
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>)
  body.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (total) set({ percent: Math.round((received / total) * 100) })
  })
  await pipeline(body, createWriteStream(file))
  set({ status: 'ready', percent: 100 })
  await shell.openPath(file)
}

export const installUpdate = async () => {
  try {
    if (!state.next) return state
    if (manual) {
      await downloadDmg(state.next)
      return state
    }
    if (state.status !== 'ready') {
      set({ status: 'downloading', percent: 0, error: null })
      await autoUpdater.downloadUpdate()
    }
    // Silent one-click install, then relaunch. (Tests stop short of installing.)
    if (process.env.CHAT_V2_UPDATE_NO_INSTALL === '1') return state
    setImmediate(() => autoUpdater.quitAndInstall(true, true))
  } catch (e) {
    set({ status: 'error', error: describe(e) })
  }
  return state
}

export const initUpdater = () => {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = !manual
  autoUpdater.on('checking-for-update', () => {
    if (state.status !== 'downloading' && state.status !== 'ready') set({ status: 'checking', error: null })
  })
  autoUpdater.on('update-available', (info) => set({ status: 'available', next: info.version, error: null }))
  autoUpdater.on('update-not-available', () => set({ status: 'idle', next: null }))
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', next: info.version, percent: 100 }))
  autoUpdater.on('error', (e) => set({ status: 'error', error: describe(e) }))
  setTimeout(() => void checkForUpdates(), 8000)
  setInterval(() => void checkForUpdates(), CHECK_EVERY)
}
