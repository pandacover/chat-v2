// The hidden page that keeps a stream of the screen open while computer use works, so a
// screenshot is a frame already in hand instead of a fresh desktopCapturer call (about 270 ms
// each). The main process drives it with executeJavaScript (see streamedScreen in desktop.ts);
// it never shows and has no bridge to the app.

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

// Chromium's insertable streams; not in TypeScript's DOM library yet.
declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack })
  readonly readable: ReadableStream<VideoFrame>
}

/** Width and height of the signature `probe` returns, in grey levels. */
const SIG_W = 64
const SIG_H = 36
/** How long `grab` waits for a frame newer than its `after` mark before giving up (main then grabs anew). */
const FRESH_WAIT_MS = 150
/**
 * A frame counts as after a mark only if it came in this long after it: a change made just after
 * the mark (content protection) reaches the screen with the next composition, and the stream a
 * moment later. A frame from in between could still show what was there before.
 */
const SETTLE_IN_MS = 34

let stream: MediaStream | null = null
/** The newest frame. Chromium sends frames only when the screen changes, so it stays current. */
let latest: VideoFrame | null = null
/** When the newest frame came in (Date.now(), which the main process shares). */
let latestAt = 0
let frames = 0
let signed = -1
let signature: number[] | null = null

const sigCanvas = new OffscreenCanvas(SIG_W, SIG_H)
const sigCtx = sigCanvas.getContext('2d', { willReadFrequently: true })!

/** Grey with diagonal stripes, as paintHidden in desktop.ts paints them, tiled from the corner. */
const stripes = (() => {
  const tile = new OffscreenCanvas(16, 16)
  const ctx = tile.getContext('2d')!
  const img = ctx.createImageData(16, 16)
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const v = (x + y) % 16 < 3 ? 0x6e : 0x9a
      img.data.set([v, v, v, 0xff], (y * 16 + x) * 4)
    }
  }
  ctx.putImageData(img, 0, 0)
  return tile
})()

const stop = () => {
  for (const t of stream?.getTracks() ?? []) t.stop()
  stream = null
  latest?.close()
  latest = null
  signature = null
}

const pump = async (reader: ReadableStreamDefaultReader<VideoFrame>) => {
  for (;;) {
    const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }))
    if (done || !value) return stop()
    latest?.close()
    latest = value
    latestAt = Date.now()
    frames++
  }
}

const api = {
  /** Opens the stream of a screen at its physical size; true once the first frame is in. */
  start: async (sourceId: string, w: number, h: number): Promise<boolean> => {
    stop()
    // 15 frames a second is plenty: the main process samples the stream every 80 ms at most while
    // it waits for the screen to settle, and each frame costs a full-size copy of the screen.
    const video = { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, minWidth: w, maxWidth: w, minHeight: h, maxHeight: h, maxFrameRate: 15 } }
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video } as unknown as MediaStreamConstraints)
    const track = stream.getVideoTracks()[0]!
    track.addEventListener('ended', stop)
    void pump(new MediaStreamTrackProcessor({ track }).readable.getReader())
    for (let i = 0; i < 100 && !latest && stream; i++) await new Promise((r) => setTimeout(r, 20))
    return latest !== null
  },

  stop,

  /** A small grey thumbnail of the newest frame, for telling whether the screen still changes. */
  probe: (): number[] | null => {
    if (!latest) return null
    if (signed !== frames) {
      sigCtx.drawImage(latest, 0, 0, SIG_W, SIG_H)
      const px = sigCtx.getImageData(0, 0, SIG_W, SIG_H).data
      const out = new Array<number>(SIG_W * SIG_H)
      for (let i = 0; i < out.length; i++) out[i] = Math.round(px[i * 4]! * 0.299 + px[i * 4 + 1]! * 0.587 + px[i * 4 + 2]! * 0.114)
      signature = out
      signed = frames
    }
    return signature
  },

  /**
   * The newest frame as a JPEG at `size`, with `cover` (image pixels) painted over. With `crop`
   * (physical pixels from the display's corner, which is `physicalW` wide), only that part,
   * scaled to `size`. With `after` (a Date.now() mark), only a frame that came in at least
   * SETTLE_IN_MS after it, waiting FRESH_WAIT_MS at most for one. Null when there is no such frame.
   */
  grab: async (size: { w: number; h: number }, cover: Rect[], crop: Rect | null, physicalW: number, after: number | null = null) => {
    if (after !== null) {
      const fresh = () => latestAt >= after + SETTLE_IN_MS
      for (let waited = 0; !fresh() && stream && waited < FRESH_WAIT_MS; waited += 10) await new Promise((r) => setTimeout(r, 10))
      if (!fresh()) return null
    }
    const frame = latest
    if (!frame) return null
    const k = frame.displayWidth / physicalW
    const t0 = performance.now()
    const canvas = new OffscreenCanvas(size.w, size.h)
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    if (crop) ctx.drawImage(frame, crop.x * k, crop.y * k, Math.max(1, crop.w * k), Math.max(1, crop.h * k), 0, 0, size.w, size.h)
    else ctx.drawImage(frame, 0, 0, size.w, size.h)
    const t1 = performance.now()
    if (cover.length > 0) {
      ctx.fillStyle = ctx.createPattern(stripes, 'repeat')!
      for (const r of cover) {
        const x0 = Math.max(0, Math.floor(r.x))
        const y0 = Math.max(0, Math.floor(r.y))
        const x1 = Math.min(size.w, Math.ceil(r.x + r.w))
        const y1 = Math.min(size.h, Math.ceil(r.y + r.h))
        if (x1 > x0 && y1 > y0) ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
      }
    }
    const t2 = performance.now()
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 })
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
    return { dataUrl, w: size.w, h: size.h, ms: { draw: t1 - t0, cover: t2 - t1, encode: performance.now() - t2 } }
  }
}

;(window as unknown as { capture: typeof api }).capture = api

export {}
