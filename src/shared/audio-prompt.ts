// How an analysed audio upload is described to the model. The audio itself is not
// sent; the measurements are, which costs a few hundred tokens instead of megabytes.
import type { AudioAnalysis } from './types'

const MAX_BEATS = 1500

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export const describeAudio = (name: string, a: AudioAnalysis | null): string => {
  const head = `<audio-analysis file="${name.replace(/"/g, "'")}">`
  if (!a) return `${head}\nThe file could not be decoded or analysed, so only its name is known.\n</audio-analysis>`
  const lines = [
    head,
    `Duration: ${clock(a.duration)} (${a.duration.toFixed(1)} s), ${a.sampleRate} Hz, ${a.channels === 1 ? 'mono' : a.channels === 2 ? 'stereo' : `${a.channels} channels`}.`
  ]
  if (a.bpm === null) {
    lines.push('Tempo: no steady beat was found (onset autocorrelation found no repeating pulse).')
  } else {
    lines.push(
      `Tempo: ${a.bpm.toFixed(1)} BPM, confidence ${a.confidence.toFixed(2)} of 1. Measured on this device by onset-strength autocorrelation and dynamic-programming beat tracking.`
    )
  }
  if (a.library) {
    const verdict =
      a.agreement === 'agree'
        ? 'The two measurements agree.'
        : a.agreement === 'octave'
          ? 'The two measurements are a factor of two apart (half or double time); either may be the felt tempo.'
          : a.agreement === 'differ'
            ? 'The two measurements disagree; the tempo is uncertain.'
            : ''
    const period = 60 / a.library.bpm
    lines.push(
      `Second opinion: web-audio-beat-detector measured ${a.library.bpm} BPM with beat phase ${a.library.offset.toFixed(3)} s (its beats fall at ${a.library.offset.toFixed(3)} + n × ${period.toFixed(3)} s). ${verdict}`.trim()
    )
  }
  if (a.tempoMap.length > 1) {
    lines.push(`Tempo over time: ${a.tempoMap.map((s) => `${clock(s.start)} ${s.bpm.toFixed(1)}`).join(', ')}.`)
  }
  if (a.beats.length > 0) {
    const shown = a.beats.slice(0, MAX_BEATS).map((b) => b.toFixed(3))
    const more = a.beats.length > MAX_BEATS ? ` (first ${MAX_BEATS} shown)` : ''
    lines.push(`Beat times in seconds, ${a.beats.length} beats${more}: ${shown.join(', ')}`)
  }
  lines.push(`Waveform peaks, ${a.peaks.length} points spread evenly over the track, scaled 0 to 99: ${a.peaks.join(',')}`)
  lines.push('</audio-analysis>')
  return lines.join('\n')
}
