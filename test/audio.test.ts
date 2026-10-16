import { describe, expect, test } from 'bun:test'
import { analyzeSignal, compareTempos } from '../src/shared/audio-analysis'

const RATE = 44100

/** Deterministic noise so tests are stable. */
const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1

type Hit = { at: number; kind: 'kick' | 'hat' | 'click'; gain?: number }

const render = (hits: Hit[], seconds: number, noise = 0.01) => {
  const out = new Float32Array(Math.round(seconds * RATE))
  const rand = rng(7)
  for (let i = 0; i < out.length; i++) out[i] = rand() * noise
  for (const h of hits) {
    const start = Math.round(h.at * RATE)
    const len = Math.round((h.kind === 'kick' ? 0.12 : h.kind === 'hat' ? 0.03 : 0.015) * RATE)
    for (let i = 0; i < len && start + i < out.length; i++) {
      const t = i / RATE
      const env = Math.exp(-t / (h.kind === 'kick' ? 0.04 : 0.006))
      const v =
        h.kind === 'kick' ? Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-t / 0.02)) * t) : h.kind === 'hat' ? rand() * 0.5 : rand()
      out[start + i] = out[start + i]! + v * env * (h.gain ?? 1)
    }
  }
  return out
}

const grid = (bpm: number, seconds: number, start = 0.25) => {
  const times: number[] = []
  for (let t = start; t < seconds - 0.2; t += 60 / bpm) times.push(t)
  return times
}

describe('audio analysis', () => {
  test('click track: tempo and beat times', () => {
    const truth = grid(128, 30)
    const a = analyzeSignal(render(truth.map((at) => ({ at, kind: 'click' })), 30), RATE)
    expect(a.bpm).not.toBeNull()
    expect(Math.abs(a.bpm! - 128)).toBeLessThan(1)
    expect(a.duration).toBeCloseTo(30, 1)
    // Every true beat has a detected beat within 25 ms.
    const errors = truth.slice(2, -2).map((t) => Math.min(...a.beats.map((b) => Math.abs(b - t))))
    expect(Math.max(...errors)).toBeLessThan(0.025)
    expect(a.peaks).toHaveLength(300)
  })

  test('kick on the beat with eighth-note hats reads as 90, not 180', () => {
    const beats = grid(90, 40)
    const hits: Hit[] = beats.flatMap((at) => [
      { at, kind: 'kick' as const },
      { at, kind: 'hat' as const, gain: 0.6 },
      { at: at + 30 / 90, kind: 'hat' as const, gain: 0.35 }
    ])
    const a = analyzeSignal(render(hits, 40), RATE)
    expect(Math.abs(a.bpm! - 90)).toBeLessThan(1.5)
  })

  test('noise has no tempo', () => {
    const a = analyzeSignal(render([], 12, 0.2), RATE)
    expect(a.bpm).toBeNull()
    expect(a.beats).toEqual([])
  })

  test('a tempo change shows up in the tempo map', () => {
    const first = grid(100, 45)
    const second = grid(120, 45).map((t) => t + 45)
    const a = analyzeSignal(render([...first, ...second].map((at) => ({ at, kind: 'click' })), 90), RATE)
    const early = a.tempoMap.filter((s) => s.start < 40).map((s) => s.bpm)
    const late = a.tempoMap.filter((s) => s.start >= 50).map((s) => s.bpm)
    expect(early.every((b) => Math.abs(b - 100) < 2)).toBe(true)
    expect(late.every((b) => Math.abs(b - 120) < 2)).toBe(true)
  })

  test('compares two estimates, allowing for half/double tempo', () => {
    expect(compareTempos(128, 127.5)).toBe('agree')
    expect(compareTempos(87, 174)).toBe('octave')
    expect(compareTempos(120, 95)).toBe('differ')
    expect(compareTempos(null, 120)).toBe('n/a')
  })
})

describe('audio uploads', () => {
  test('audio files are classified as audio', async () => {
    const { classify } = await import('../src/main/services/Attachments')
    expect(classify('song.mp3', 'audio/mpeg')).toBe('audio')
    expect(classify('take.wav', '')).toBe('audio')
    expect(classify('loop.flac', 'application/octet-stream')).toBe('audio')
  })

  test('the model gets the measurements as text', async () => {
    const { describeAudio } = await import('../src/shared/audio-prompt')
    const text = describeAudio('song.mp3', {
      duration: 125.4,
      sampleRate: 44100,
      channels: 2,
      bpm: 124,
      confidence: 0.86,
      beats: [0.48, 0.964, 1.448],
      tempoMap: [
        { start: 0, bpm: 124 },
        { start: 20, bpm: 124.1 }
      ],
      peaks: [10, 50, 99],
      library: { bpm: 124, offset: 0.481 },
      agreement: 'agree'
    })
    expect(text).toContain('Duration: 2:05 (125.4 s), 44100 Hz, stereo.')
    expect(text).toContain('Tempo: 124.0 BPM, confidence 0.86')
    expect(text).toContain('web-audio-beat-detector measured 124 BPM with beat phase 0.481 s (its beats fall at 0.481 + n × 0.484 s). The two measurements agree.')
    expect(text).toContain('3 beats: 0.480, 0.964, 1.448')
    expect(text).toContain('Tempo over time: 0:00 124.0, 0:20 124.1.')
    expect(describeAudio('x.wav', null)).toContain('could not be decoded')
  })
})
