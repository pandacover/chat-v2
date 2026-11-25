// Videos for models: their length and size, and stills from them. Claude can't watch a video, so it
// looks at frames.
//
// Probing runs here, in the main process: Mediabunny reads the container's headers (MP4, MOV, WebM,
// MKV and more) in a few milliseconds, without decoding anything or opening a window.
//
// Frames come from a worker page (renderer/src/video/worker.ts) in a hidden WebContentsView, which
// decodes with WebCodecs in software and never touches the GPU process (see there for why). It
// reads the file through `video:read`, a byte range at a time, so a 1 GB video costs only the
// packets each frame needs. Each call gets a fresh view, closed the moment it is done, one call at
// a time: starting one costs about 200 ms, and a view kept for reuse slowed down after a few heavy
// videos (HEVC went from 0.6 s to 16 s for 16 frames, waiting, not working), while its memory
// stayed held. A view isn't a window, so it never keeps the app open.
import { open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { WebContentsView, app, ipcMain } from 'electron'
import type { VideoInfo } from '@shared/types'
import type { GrabRequest, GrabResult } from '@shared/video'

/** The longest edge a frame goes to a model at (Claude scales larger images down to about this). */
export const FRAME_EDGE = 1024
/** Codecs WebCodecs decodes here (HEVC only where the OS has a decoder). */
const DECODABLE = new Set(['avc', 'hevc', 'vp8', 'vp9', 'av1'])
/** The worker stops taking frames after this long and hands back those it has. */
const BUDGET_MS = 20_000
/** Past this the worker is taken to be stuck, and closed. */
const HARD_MS = 35_000
const PROBE_MS = 10_000
/** The most one read may ask for (the reader asks for far less). */
const MAX_READ = 32 * 1024 * 1024

const timeout = <A>(p: Promise<A>, ms: number, what: string, onTimeout?: () => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.()
        reject(new Error(what))
      }, ms)
    })
  ]).finally(() => clearTimeout(timer))
}

/** The video's length and picture size (as shown, turned by its rotation), or null when it can't be decoded here. */
export const probeVideo = async (path: string): Promise<VideoInfo | null> => {
  // Loaded the first time a video is read, not with the app.
  const { ALL_FORMATS, FilePathSource, Input } = await import('mediabunny')
  const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(path) })
  try {
    return await timeout(
      (async () => {
        const track = await input.getPrimaryVideoTrack()
        const codec = track ? await track.getCodec() : null
        if (!track || !codec || !DECODABLE.has(codec)) return null
        const duration = (await input.getDurationFromMetadata()) ?? (await input.computeDuration())
        // As shown: after its rotation (a phone video held upright is tall) and pixel aspect.
        return { duration: Math.round(duration * 100) / 100, width: await track.getDisplayWidth(), height: await track.getDisplayHeight() }
      })(),
      PROBE_MS,
      'Reading the video took too long'
    )
  } catch {
    return null
  } finally {
    input.dispose()
  }
}

let view: WebContentsView | null = null
let queue: Promise<unknown> = Promise.resolve()
/** The file the worker reads now. */
let reading: { file: FileHandle; size: number } | null = null

const close = () => {
  const v = view
  view = null
  if (v && !v.webContents.isDestroyed()) v.webContents.close()
}

let wired = false
const wire = () => {
  if (wired) return
  wired = true
  // Only the worker reads, and only the file it was given, within it.
  ipcMain.handle('video:read', async (e, start: unknown, end: unknown) => {
    if (!view || e.sender !== view.webContents || !reading) throw new Error('Nothing is being read')
    const from = Number(start)
    const to = Number(end)
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to > reading.size || to <= from || to - from > MAX_READ)
      throw new Error('Bad range')
    const buffer = Buffer.allocUnsafe(to - from)
    const { bytesRead } = await reading.file.read(buffer, 0, to - from, from)
    return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead)
  })
  app.once('will-quit', close)
}

const worker = async () => {
  close()
  wire()
  const v = new WebContentsView({
    webPreferences: { preload: join(__dirname, '../preload/video.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false }
  })
  view = v
  v.webContents.setAudioMuted(true)
  // It only ever runs its own page: nothing in it may open windows or navigate away.
  v.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  v.webContents.on('will-navigate', (e) => e.preventDefault())
  v.webContents.on('render-process-gone', () => view === v && close())
  const url = process.env.ELECTRON_RENDERER_URL
  await (url ? v.webContents.loadURL(`${url}/video-worker.html`) : v.webContents.loadFile(join(__dirname, '../renderer/video-worker.html')))
  // The page's module script runs after load; wait until its function is there.
  for (let i = 0; i < 100 && !(await v.webContents.executeJavaScript('typeof window.tomoGrab === "function"')); i++) await new Promise((r) => setTimeout(r, 20))
  return v
}

export interface Frame {
  /** Seconds into the video. */
  time: number
  /** JPEG, base64. */
  data: string
}

/**
 * Stills near `times` (seconds), no larger than `edge` on their longest side. A time within `snap`
 * seconds of a keyframe is taken at the keyframe, which decodes alone (each frame says its real
 * time); 0 takes the exact moments. `partial` when the time budget ran out first.
 */
export const videoFrames = (path: string, times: readonly number[], edge = FRAME_EDGE, snap = 0): Promise<{ frames: Frame[]; partial: boolean }> => {
  const run = queue.then(async () => {
    const file = await open(path, 'r')
    try {
      reading = { file, size: (await file.stat()).size }
      const v = await worker()
      const req: GrabRequest = { size: reading.size, times: [...times].sort((a, b) => a - b), snap, edge, budgetMs: BUDGET_MS }
      // A decode that hangs takes the worker with it; the next call makes a new one.
      const result = await timeout<GrabResult>(v.webContents.executeJavaScript(`window.tomoGrab(${JSON.stringify(req)})`), HARD_MS, 'Taking frames took too long', close)
      if ('error' in result) throw new Error(result.error)
      return { frames: result.frames.map((f) => ({ time: f.time, data: Buffer.from(f.jpeg).toString('base64') })), partial: result.partial }
    } finally {
      reading = null
      close()
      await file.close().catch(() => undefined)
    }
  })
  queue = run.catch(() => undefined)
  return run
}
