// The update flow as a state machine over electron-updater's events, apart from Electron so tests
// can drive it with a stand-in (test/updater.test.ts). updater.ts connects it to electron-updater.
//
//   idle ──check──▶ checking ──update-available──▶ available ──download──▶ downloading (n%)
//     ▲                 │                                                      │
//     └─not-available───┘                                         update-downloaded
//                                                                              ▼
//                                          installing ◀──install── downloaded
//
// A failed check goes back to where it was (idle, or available) with the error; a failed download
// goes back to available with the error; downloading again retries. Background checks run quietly:
// they don't show the checking state, and they never interrupt a download or a finished one.
import type { UpdateState } from '@shared/types'

/** What the machine needs from electron-updater's autoUpdater. */
export interface UpdaterPort {
  on(event: 'update-available' | 'update-downloaded', listener: (info: UpdateInfoLike) => void): unknown
  on(event: 'update-not-available', listener: () => void): unknown
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

/** The part of electron-updater's UpdateInfo used here. */
export interface UpdateInfoLike {
  version: string
  releaseNotes?: string | Array<{ version: string; note: string | null }> | null
}

export interface UpdateMachineOptions {
  current: string
  /** Packaged builds only: a development run has nothing to update. */
  supported: boolean
  /** Called with every new state. */
  emit: (state: UpdateState) => void
  platform?: NodeJS.Platform
  now?: () => number
  /** Stops short of quitAndInstall (tests, CHAT_V2_UPDATE_NO_INSTALL). */
  noInstall?: boolean
  /** Runs quitAndInstall; after the reply to the click by default, so the window hears about it. */
  later?: (f: () => void) => void
}

const message = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'string' ? e : String(e))

/** electron-updater errors carry whole HTTP dumps; keep one readable line. */
export const describeUpdateError = (e: unknown, platform: NodeJS.Platform = process.platform) => {
  const text = message(e)
  if (/releases\.atom|\b404\b/.test(text)) return 'No published releases found yet.'
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|net::/.test(text)) return "Couldn't reach GitHub to check for updates."
  // Squirrel.Mac can't replace an app it can't write to (run from the DMG, or not in Applications).
  if (platform === 'darwin' && /read-only|translocat|EACCES|EROFS/i.test(text)) return 'Move chat-v2 into Applications to update it.'
  return text.split('\n')[0]!.slice(0, 200)
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

/**
 * What changed, as plain text, from the release notes. A GitHub release's notes come from its
 * feed as HTML; the release step writes "Built from <sha>: <commit message>", and the sha is left
 * out. A full changelog (an array) keeps the newest note.
 */
export const releaseNotesText = (notes: UpdateInfoLike['releaseNotes']): string | null => {
  const raw = Array.isArray(notes) ? (notes[0]?.note ?? '') : (notes ?? '')
  const text = raw
    .replace(/<br\s*\/?>\n?/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (m, e: string) =>
      e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m)
    )
    .replace(/^\s*Built from [0-9a-f]{7,40}:\s*/i, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text || null
}

export const updateMachine = (port: UpdaterPort, opts: UpdateMachineOptions) => {
  const now = opts.now ?? Date.now
  const platform = opts.platform ?? process.platform
  const later = opts.later ?? ((f) => setImmediate(f))
  let state: UpdateState = {
    status: opts.supported ? 'idle' : 'unsupported',
    current: opts.current,
    next: null,
    notes: null,
    percent: null,
    error: null,
    checkedAt: null
  }
  let checking = false

  const set = (patch: Partial<UpdateState>) => {
    state = { ...state, ...patch }
    opts.emit(state)
  }
  /** The state now: events change it while a call awaits. */
  const current = () => state
  /** Where a failed check or download goes back to. */
  const rest = (): UpdateState['status'] => (state.next ? 'available' : 'idle')
  /** A download started or finished: checks no longer change what's shown. */
  const busy = () => state.status === 'downloading' || state.status === 'downloaded' || state.status === 'installing'

  const failed = (e: unknown) => {
    const error = describeUpdateError(e, platform)
    if (state.status === 'checking') set({ status: rest(), error })
    else if (state.status === 'downloading') set({ status: 'available', percent: null, error })
    else if (state.status === 'installing') set({ status: 'downloaded', error })
    else set({ error })
  }

  port.on('update-available', (info) => {
    if (busy()) return
    set({ status: 'available', next: info.version, notes: releaseNotesText(info.releaseNotes), error: null, checkedAt: now() })
  })
  port.on('update-not-available', () => {
    if (busy()) return
    set({ status: 'idle', next: null, notes: null, percent: null, error: null, checkedAt: now() })
  })
  port.on('download-progress', (p) => {
    if (state.status !== 'downloading') return
    const percent = Number.isFinite(p.percent) ? Math.max(0, Math.min(100, Math.floor(p.percent))) : 0
    if (percent !== state.percent) set({ percent })
  })
  port.on('update-downloaded', (info) => {
    if (state.status === 'installing') return
    set({ status: 'downloaded', next: info.version, percent: 100, error: null })
  })
  port.on('error', failed)

  return {
    state: () => state,

    /** `manual`: the user asked, so it shows the checking state. Background polls don't. */
    check: async (manual = true) => {
      if (state.status === 'unsupported' || busy()) return state
      // A background check already running: the click just shows it.
      if (checking) {
        if (manual && state.status !== 'checking') set({ status: 'checking', error: null })
        return state
      }
      checking = true
      if (manual) set({ status: 'checking', error: null })
      try {
        await port.checkForUpdates()
        // Answered without either event (no feed to read): back to where it was.
        if (state.status === 'checking') set({ status: rest(), checkedAt: now() })
      } catch (e) {
        failed(e)
      } finally {
        checking = false
      }
      return state
    },

    download: async () => {
      if (state.status !== 'available') return state
      set({ status: 'downloading', percent: 0, error: null })
      try {
        await port.downloadUpdate()
        // Finished without update-downloaded (an event can't narrow `state`, so read it fresh).
        if (current().status === 'downloading') set({ status: 'downloaded', percent: 100 })
      } catch (e) {
        failed(e)
      }
      return state
    },

    install: () => {
      if (state.status !== 'downloaded') return state
      set({ status: 'installing', error: null })
      if (opts.noInstall) return state
      later(() => {
        try {
          port.quitAndInstall(true, true)
        } catch (e) {
          failed(e)
        }
      })
      return state
    }
  }
}

export type UpdateMachine = ReturnType<typeof updateMachine>
