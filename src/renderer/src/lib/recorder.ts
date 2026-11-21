// Microphone capture for push-to-talk speech-to-text.

const preferredMime = () =>
  ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) =>
    MediaRecorder.isTypeSupported(m)
  ) ?? ''

export interface Recording {
  /** Stops capture and resolves with the recorded audio. */
  stop(): Promise<{ data: ArrayBuffer; mime: string }>
  cancel(): void
  /** The voice's loudness now, 0..1 (what the orb swells with). */
  level(): number
}

export const startRecording = async (): Promise<Recording> => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }
  })
  const mime = preferredMime()
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  recorder.start(250)

  // A meter beside the recorder: RMS of the latest samples, in dB, mapped onto 0..1.
  let audio: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let buf: Float32Array<ArrayBuffer> | null = null
  try {
    audio = new AudioContext()
    analyser = audio.createAnalyser()
    analyser.fftSize = 1024
    audio.createMediaStreamSource(stream).connect(analyser)
    buf = new Float32Array(analyser.fftSize)
  } catch {
    // No meter: the orb animates by its state alone.
  }

  const release = () => {
    stream.getTracks().forEach((t) => t.stop())
    void audio?.close().catch(() => {})
    audio = null
  }

  return {
    level: () => {
      if (!analyser || !buf || !audio) return 0
      analyser.getFloatTimeDomainData(buf)
      let sum = 0
      for (const v of buf) sum += v * v
      const db = 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-6)
      return Math.min(1, Math.max(0, (db + 52) / 36))
    },
    stop: () =>
      new Promise((resolve, reject) => {
        recorder.onstop = async () => {
          release()
          const blob = new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' })
          try {
            resolve({ data: await blob.arrayBuffer(), mime: blob.type })
          } catch (e) {
            reject(e)
          }
        }
        recorder.stop()
      }),
    cancel: () => {
      recorder.onstop = release
      if (recorder.state !== 'inactive') recorder.stop()
      else release()
    }
  }
}
