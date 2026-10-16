// Tempo and beat analysis of decoded audio, independent of any library:
// onset strength by spectral flux, tempo by autocorrelation, beats by dynamic
// programming (Ellis, "Beat Tracking by Dynamic Programming", 2007).
// Pure functions on samples, so it runs in a worker and in tests.

export interface SignalAnalysis {
  duration: number
  /** Our estimate; null when the audio has no steady pulse. */
  bpm: number | null
  /** 0..1: how strongly the onset pattern repeats at that tempo. */
  confidence: number
  /** Beat times in seconds. */
  beats: number[]
  /** Local tempo per segment, for audio that speeds up or slows down. */
  tempoMap: Array<{ start: number; bpm: number }>
  /** Waveform envelope, 0..99, evenly spaced over the duration. */
  peaks: number[]
}

const MIN_BPM = 50
const MAX_BPM = 220
const FRAME = 1024
const HOP = 128
const TARGET_RATE = 11025

/** In-place iterative radix-2 FFT on separate real/imaginary arrays. */
const fft = (re: Float32Array, im: Float32Array) => {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j]!, re[i]!]
      ;[im[i], im[j]] = [im[j]!, im[i]!]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const xr = re[b]! * cr - im[b]! * ci
        const xi = re[b]! * ci + im[b]! * cr
        re[b] = re[a]! - xr
        im[b] = im[a]! - xi
        re[a] = re[a]! + xr
        im[a] = im[a]! + xi
        const t = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = t
      }
    }
  }
}

/** Box-filter decimation to roughly TARGET_RATE; good enough for onset timing. */
const decimate = (samples: Float32Array, rate: number) => {
  const factor = Math.max(1, Math.floor(rate / TARGET_RATE))
  if (factor === 1) return { data: samples, rate }
  const out = new Float32Array(Math.floor(samples.length / factor))
  for (let i = 0; i < out.length; i++) {
    let sum = 0
    for (let k = 0; k < factor; k++) sum += samples[i * factor + k]!
    out[i] = sum / factor
  }
  return { data: out, rate: rate / factor }
}

/** Spectral-flux onset strength, one value per hop, detrended and normalised. */
export const onsetEnvelope = (samples: Float32Array, rate: number) => {
  const { data, rate: r } = decimate(samples, rate)
  const frames = Math.max(0, Math.floor((data.length - FRAME) / HOP) + 1)
  const window = new Float32Array(FRAME).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)))
  const bins = FRAME / 2
  let prev = new Float32Array(bins)
  const env = new Float32Array(frames)
  const re = new Float32Array(FRAME)
  const im = new Float32Array(FRAME)
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < FRAME; i++) {
      re[i] = data[f * HOP + i]! * window[i]!
      im[i] = 0
    }
    fft(re, im)
    const cur = new Float32Array(bins)
    let flux = 0
    for (let k = 1; k < bins; k++) {
      cur[k] = Math.log1p(1000 * Math.hypot(re[k]!, im[k]!))
      const d = cur[k]! - prev[k]!
      if (d > 0) flux += d
    }
    env[f] = f === 0 ? 0 : flux
    prev = cur
  }
  // Remove the slowly varying loudness so only onsets remain.
  const span = Math.max(1, Math.round((0.4 * r) / HOP))
  const out = new Float32Array(frames)
  let acc = 0
  for (let i = 0; i < frames; i++) {
    acc += env[i]!
    if (i >= span) acc -= env[i - span]!
    const mean = acc / Math.min(i + 1, span)
    out[i] = Math.max(0, env[i]! - mean)
  }
  let sq = 0
  for (const v of out) sq += v * v
  const sd = Math.sqrt(sq / Math.max(1, frames)) || 1
  for (let i = 0; i < frames; i++) out[i] = out[i]! / sd
  return {
    env: out,
    frameRate: r / HOP,
    // Flux peaks once a hit is well inside the window; 0.8 of a frame was measured on
    // click tracks at 90 to 160 BPM (test/audio.test.ts).
    frameTime: (f: number) => (f * HOP + FRAME * 0.8) / r
  }
}

/** Tempo from the autocorrelation of the onset envelope, with a prior around 120 BPM. */
export const estimateTempo = (env: Float32Array, frameRate: number) => {
  const minLag = Math.floor((60 / MAX_BPM) * frameRate)
  const maxLag = Math.min(env.length - 1, Math.ceil((60 / MIN_BPM) * frameRate))
  if (maxLag <= minLag + 2) return { bpm: null as number | null, confidence: 0 }
  const ac = new Float32Array(maxLag * 2 + 2)
  for (let lag = 0; lag < ac.length && lag < env.length; lag++) {
    let s = 0
    for (let i = lag; i < env.length; i++) s += env[i]! * env[i - lag]!
    ac[lag] = s / (env.length - lag)
  }
  let best = -1
  let bestScore = -Infinity
  const scoreAt = (lag: number) => {
    const bpm = (60 * frameRate) / lag
    // Log-normal prior: tempos far from 120 BPM need more evidence (avoids octave errors).
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.0) ** 2)
    // Reward lags whose double also repeats: the pulse, not a subdivision of it.
    return (ac[lag]! + 0.5 * (ac[lag * 2] ?? 0)) * prior
  }
  for (let lag = minLag; lag <= maxLag; lag++) {
    const s = scoreAt(lag)
    if (s > bestScore) {
      bestScore = s
      best = lag
    }
  }
  if (best < 0 || ac[0]! <= 0) return { bpm: null, confidence: 0 }
  // Parabolic interpolation for a sub-frame period.
  const a = ac[best - 1] ?? ac[best]!
  const b = ac[best]!
  const c = ac[best + 1] ?? ac[best]!
  const shift = a - 2 * b + c === 0 ? 0 : (0.5 * (a - c)) / (a - 2 * b + c)
  const lag = best + Math.max(-0.5, Math.min(0.5, shift))
  // Peak height relative to the typical autocorrelation in range.
  let mean = 0
  for (let l = minLag; l <= maxLag; l++) mean += ac[l]!
  mean /= maxLag - minLag + 1
  const confidence = Math.max(0, Math.min(1, (b - mean) / (ac[0]! - mean || 1)))
  return { bpm: (60 * frameRate) / lag, confidence }
}

/** Dynamic-programming beat tracker: strong onsets, spaced close to the tempo period. */
export const trackBeats = (env: Float32Array, frameRate: number, bpm: number, tightness = 120) => {
  const period = (60 / bpm) * frameRate
  const n = env.length
  const score = new Float32Array(n)
  const back = new Int32Array(n).fill(-1)
  const lo = Math.round(period / 2)
  const hi = Math.round(period * 2)
  for (let t = 0; t < n; t++) {
    let bestPrev = -1
    let best = -Infinity
    for (let p = t - hi; p <= t - lo; p++) {
      if (p < 0) continue
      const s = score[p]! - tightness * Math.log((t - p) / period) ** 2
      if (s > best) {
        best = s
        bestPrev = p
      }
    }
    score[t] = env[t]! + (bestPrev >= 0 ? Math.max(0, best) : 0)
    back[t] = bestPrev >= 0 && best > 0 ? bestPrev : -1
  }
  // End on the best-scoring frame within the last period, then walk back.
  let end = Math.max(0, n - Math.ceil(period))
  for (let t = end; t < n; t++) if (score[t]! > score[end]!) end = t
  const frames: number[] = []
  for (let t = end; t >= 0; t = back[t]!) frames.push(t)
  return frames.reverse()
}

const waveformPeaks = (samples: Float32Array, count: number) => {
  const out: number[] = []
  const step = samples.length / count
  let max = 0
  const raw: number[] = []
  for (let i = 0; i < count; i++) {
    let m = 0
    const end = Math.min(samples.length, Math.floor((i + 1) * step))
    for (let k = Math.floor(i * step); k < end; k++) m = Math.max(m, Math.abs(samples[k]!))
    raw.push(m)
    max = Math.max(max, m)
  }
  for (const m of raw) out.push(max ? Math.round((m / max) * 99) : 0)
  return out
}

export const analyzeSignal = (samples: Float32Array, rate: number): SignalAnalysis => {
  const duration = samples.length / rate
  const peaks = waveformPeaks(samples, 300)
  const { env, frameRate, frameTime } = onsetEnvelope(samples, rate)
  const { bpm, confidence } = estimateTempo(env, frameRate)
  // Real pulses score about 0.9 here and noise about 0.04.
  if (bpm === null || confidence < 0.2) return { duration, bpm: null, confidence, beats: [], tempoMap: [], peaks }

  const beats = trackBeats(env, frameRate, bpm).map((f) => Math.round(frameTime(f) * 1000) / 1000)

  // Local tempo over ~20 s windows, only for long recordings.
  const tempoMap: SignalAnalysis['tempoMap'] = []
  const seg = Math.round(20 * frameRate)
  if (env.length > seg * 2) {
    for (let start = 0; start + seg / 2 < env.length; start += seg) {
      const local = estimateTempo(env.subarray(start, Math.min(env.length, start + seg)), frameRate)
      if (local.bpm) tempoMap.push({ start: Math.round((start / frameRate) * 10) / 10, bpm: Math.round(local.bpm * 10) / 10 })
    }
  }
  return { duration, bpm: Math.round(bpm * 10) / 10, confidence: Math.round(confidence * 100) / 100, beats, tempoMap, peaks }
}

/** How two tempo estimates relate: same, octave apart (half/double), or different. */
export const compareTempos = (a: number | null, b: number | null): 'agree' | 'octave' | 'differ' | 'n/a' => {
  if (!a || !b) return 'n/a'
  const close = (x: number, y: number) => Math.abs(x - y) / y < 0.03
  if (close(a, b)) return 'agree'
  if (close(a, b * 2) || close(a * 2, b)) return 'octave'
  return 'differ'
}
