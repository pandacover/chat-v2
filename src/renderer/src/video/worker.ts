// The video worker's page (main/video.ts runs it in a hidden view): stills from a video, decoded with
// WebCodecs. The main process lends it the file a byte range at a time, so only the container's index
// and the packets each frame needs are read, never the whole file. Reads come in large chunks (the
// 'network' prefetch): each is a round trip through the main process, and a busy one slows many small
// ones (a WebM without cues took 119 reads to plan, 9 this way).
//
// Kept off the GPU on purpose. Chromium's hardware decoder, and drawing a VideoFrame onto a canvas,
// both grow the app's shared GPU process by hundreds of MB that it never gives back (measured: +220
// MB after one 4K grab). Here frames decode in software (HEVC has no software decoder, so it takes
// whatever Chromium has), are copied out as RGBA on the CPU and scaled on a CPU canvas: everything
// lives in this page's own process, which goes when the worker closes.
import { ALL_FORMATS, CustomSource, EncodedPacketSink, Input, type InputVideoTrack, VideoSampleSink } from 'mediabunny'
import type { GrabRequest, GrabResult } from '@shared/video'

declare global {
  interface Window {
    tomoVideo: { read(start: number, end: number): Promise<Uint8Array> }
    tomoGrab(req: GrabRequest): Promise<GrabResult>
  }
}

/** Each time, moved to the keyframe nearest it when one is within `snap`; sorted, once each. */
const plan = async (track: InputVideoTrack, times: number[], snap: number) => {
  if (snap <= 0) return times
  const packets = new EncodedPacketSink(track)
  const out: number[] = []
  for (const t of times) {
    const before = await packets.getKeyPacket(t, { metadataOnly: true })
    const after = before ? await packets.getNextKeyPacket(before, { metadataOnly: true }) : await packets.getFirstKeyPacket({ metadataOnly: true })
    const near = [before, after].filter((p) => p && Math.abs(p.timestamp - t) <= snap).sort((a, b) => Math.abs(a!.timestamp - t) - Math.abs(b!.timestamp - t))[0]
    out.push(near ? near.timestamp : t)
  }
  return [...new Set(out)].sort((a, b) => a - b)
}

window.tomoGrab = async (req) => {
  const started = performance.now()
  const input = new Input({
    formats: ALL_FORMATS,
    source: new CustomSource({ getSize: () => req.size, read: (start, end) => window.tomoVideo.read(start, end), maxCacheSize: 16 << 20, prefetchProfile: 'network' })
  })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) return { error: 'The file has no picture to take frames from' }
    const times = await plan(track, req.times, req.snap)
    // The size as shown: already turned by its rotation, and stretched to its pixel aspect.
    const rotation = await track.getRotation()
    const turned = rotation % 180 !== 0
    const w = await track.getDisplayWidth()
    const h = await track.getDisplayHeight()
    const scale = Math.min(1, req.edge / Math.max(w, h))
    const out = new OffscreenCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)))
    const ctx = out.getContext('2d', { willReadFrequently: true, alpha: false })!
    ctx.imageSmoothingQuality = 'high'
    // The decoded picture, at its own size; made once and reused.
    let raw: OffscreenCanvas | null = null
    let rawCtx: OffscreenCanvasRenderingContext2D | null = null
    let pixels: Uint8ClampedArray<ArrayBuffer> | null = null
    const sink = new VideoSampleSink(track, { hardwareAcceleration: (await track.getCodec()) === 'hevc' ? 'no-preference' : 'prefer-software' })
    const frames: Array<{ time: number; jpeg: Uint8Array }> = []
    let partial = false
    let last = -1
    for await (const sample of sink.samplesAtTimestamps(times)) {
      if (!sample) continue
      try {
        if (performance.now() - started > req.budgetMs) {
          partial = true
          break
        }
        if (sample.timestamp === last) continue
        last = sample.timestamp
        const frame = sample.toVideoFrame()
        try {
          const { width: vw, height: vh } = frame.visibleRect!
          if (!raw || raw.width !== vw || raw.height !== vh) {
            raw = new OffscreenCanvas(vw, vh)
            rawCtx = raw.getContext('2d', { willReadFrequently: true, alpha: false })
            pixels = new Uint8ClampedArray(vw * vh * 4)
          }
          await frame.copyTo(pixels!, { format: 'RGBA' })
          rawCtx!.putImageData(new ImageData(pixels!, vw, vh), 0, 0)
        } finally {
          frame.close()
        }
        // The decoded picture is unturned: it is drawn turned about the middle, at the size that fills
        // the frame once turned (which also stretches it to the display aspect).
        const [dw, dh] = turned ? [out.height, out.width] : [out.width, out.height]
        ctx.setTransform(1, 0, 0, 1, out.width / 2, out.height / 2)
        ctx.rotate((rotation * Math.PI) / 180)
        ctx.drawImage(raw!, -dw / 2, -dh / 2, dw, dh)
        const blob = await out.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
        frames.push({ time: Math.round(sample.timestamp * 1000) / 1000, jpeg: new Uint8Array(await blob.arrayBuffer()) })
      } finally {
        sample.close()
      }
    }
    return { frames, partial }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  } finally {
    input.dispose()
  }
}
