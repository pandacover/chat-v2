// Runs the tempo/beat analysis off the main thread.
import { analyzeSignal } from '@shared/audio-analysis'

self.onmessage = (e: MessageEvent<{ samples: Float32Array; rate: number }>) => {
  try {
    self.postMessage({ ok: true, result: analyzeSignal(e.data.samples, e.data.rate) })
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}
