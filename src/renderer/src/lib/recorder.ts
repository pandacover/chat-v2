// Microphone capture for push-to-talk speech-to-text.

const preferredMime = () =>
  ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) =>
    MediaRecorder.isTypeSupported(m)
  ) ?? ''

export interface Recording {
  /** Stops capture and resolves with the recorded audio. */
  stop(): Promise<{ data: ArrayBuffer; mime: string }>
  cancel(): void
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
  const release = () => stream.getTracks().forEach((t) => t.stop())

  return {
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
