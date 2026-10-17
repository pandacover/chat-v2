// App updates from this repository's GitHub releases (see electron-builder.yml).
// Windows installs in place on restart. macOS builds are only ad-hoc signed, which rules
// out in-place updates there, so the new DMG is downloaded and opened instead: only the one
// built for this Mac's processor, and only once (a finished download is reused).
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { BrowserWindow, app, net, shell } from 'electron'
import electronUpdater, { type UpdateInfo } from 'electron-updater'
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

/**
 * Releases ship one DMG per processor. This Mac's comes from the hardware, not the running
 * build: an Intel build under Rosetta on Apple silicon reports x64, and moves to the native one.
 */
const macArch = (): 'arm64' | 'x64' => (process.arch === 'arm64' || app.runningUnderARM64Translation ? 'arm64' : 'x64')

const BUILD_NAMES = { arm64: 'Apple silicon', x64: 'Intel' } as const

let state: UpdateState = {
  status: app.isPackaged ? 'idle' : 'unsupported',
  current: app.getVersion(),
  next: null,
  percent: null,
  error: null,
  manual,
  downloaded: false,
  build: manual ? BUILD_NAMES[macArch()] : null
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

/** The release metadata from the last check, for the DMG's size and checksum. */
let latest: UpdateInfo | null = null

const dmgName = (version: string) => `chat-v2-${version}-${macArch()}.dmg`
const dmgPath = (version: string) => join(app.getPath('downloads'), dmgName(version))

/** The release's record of this Mac's DMG, when latest-mac.yml lists it. */
const dmgInfo = (version: string) =>
  latest?.version === version ? latest.files.find((f) => f.url.endsWith(dmgName(version))) : undefined

const sha512 = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const hash = createHash('sha512')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('base64')))
      .on('error', reject)
  })

/** Whether the file matches the release's checksum (or size); true when the release lists neither. */
const intact = async (file: string, version: string) => {
  const info = dmgInfo(version)
  if (info?.sha512) return (await sha512(file)) === info.sha512
  if (info?.size) return (await stat(file)).size === info.size
  return true
}

/**
 * Whether this version's DMG is already in Downloads. Downloads are written to a `.part`
 * file and renamed only once complete, so a file under the final name is a whole one.
 */
const alreadyDownloaded = async (version: string) => {
  const file = dmgPath(version)
  const info = await stat(file).catch(() => null)
  return !!info?.isFile() && info.size > 0 && (await intact(file, version).catch(() => false))
}

/** macOS: fetch this Mac's DMG into Downloads (unless it is there already) and open it. */
const downloadDmg = async (version: string) => {
  const file = dmgPath(version)
  if (!(await alreadyDownloaded(version))) {
    const part = `${file}.part`
    set({ status: 'downloading', percent: 0, error: null })
    const res = await net.fetch(`${RELEASES}/download/v${version}/${dmgName(version)}`)
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`)
    const total = Number(res.headers.get('content-length')) || 0
    let received = 0
    const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>)
    body.on('data', (chunk: Buffer) => {
      received += chunk.length
      const percent = Math.round((received / total) * 100)
      if (total && percent !== state.percent) set({ percent })
    })
    await pipeline(body, createWriteStream(part))
    if (!(await intact(part, version))) {
      await rm(part, { force: true })
      throw new Error('The download was damaged. Try again.')
    }
    await rename(part, file)
  }
  set({ status: 'ready', percent: 100, downloaded: true })
  await shell.openPath(file)
}

export const installUpdate = async () => {
  try {
    if (!state.next || state.status === 'downloading') return state
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
  autoUpdater.on('update-available', (info) => {
    latest = info
    set({ status: 'available', next: info.version, error: null, downloaded: false })
    // A DMG fetched before a restart is reused rather than downloaded again.
    if (manual)
      void alreadyDownloaded(info.version).then((done) => {
        if (done && state.next === info.version && state.status === 'available') set({ downloaded: true })
      })
  })
  autoUpdater.on('update-not-available', () => set({ status: 'idle', next: null }))
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', next: info.version, percent: 100 }))
  autoUpdater.on('error', (e) => set({ status: 'error', error: describe(e) }))
  setTimeout(() => void checkForUpdates(), 8000)
  setInterval(() => void checkForUpdates(), CHECK_EVERY)
}
