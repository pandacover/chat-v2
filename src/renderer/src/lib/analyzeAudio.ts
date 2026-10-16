// Decodes an audio upload and measures its tempo twice: with the app's own analysis
// (lib/audio.worker.ts) and with web-audio-beat-detector, then compares the two.
import { guess } from 'web-audio-beat-detector'
import { compareTempos, type SignalAnalysis } from '@shared/audio-analysis'
import type { AudioAnalysis } from '@shared/types'

const runWorker = (samples: Float32Array, rate: number) =>
  new Promise<SignalAnalysis>((resolve, reject) => {
    const worker = new Worker(new URL('./audio.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ ok: boolean; result?: SignalAnalysis; error?: string }>) => {
      worker.terminate()
      if (e.data.ok && e.data.result) resolve(e.data.result)
      else reject(new Error(e.data.error ?? 'analysis failed'))
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(new Error(e.message || 'analysis worker failed'))
    }
    worker.postMessage({ samples, rate }, [samples.buffer])
  })

export const analyzeAudio = async (data: ArrayBuffer): Promise<AudioAnalysis> => {
  // An offline context decodes without touching the audio output device.
  const ctx = new OfflineAudioContext(1, 1, 44100)
  const buffer = await ctx.decodeAudioData(data.slice(0))
  const mono = new Float32Array(buffer.length)
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c)
    for (let i = 0; i < ch.length; i++) mono[i] = mono[i]! + ch[i]! / buffer.numberOfChannels
  }
  const [own, library] = await Promise.all([
    runWorker(mono, buffer.sampleRate),
    guess(buffer).then(
      (g) => ({ bpm: g.bpm, offset: Math.round(g.offset * 1000) / 1000 }),
      () => null
    )
  ])
  return {
    ...own,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    library,
    agreement: compareTempos(own.bpm, library?.bpm ?? null)
  }
}
