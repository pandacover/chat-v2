// Voice input, from the composer's mic. Hold the mic to talk, or click once to start and again
// to stop; Ctrl+M (Cmd+M) toggles it, Esc cancels. ElevenLabs Scribe
// transcribes it, and the text goes into the composer.
//
// On a new chat, talking opens the voice stage (`home`): the composer docks, the rest fades, and
// the mascot takes the centre as the visualiser. In a chat the mascot takes the mic button's place.
// Either way the mascot swells with `level` and sends out a ring on each spike (`spikes`).
import { app } from './store.svelte'
import { startRecording, type Recording } from './recorder'

class Voice {
  phase = $state<'idle' | 'starting' | 'recording' | 'transcribing'>('idle')
  /** The mic is held down: release transcribes. */
  held = $state(false)
  elapsed = $state(0)
  /** The voice's loudness, smoothed, 0..1. */
  level = $state(0)
  /** Bumped on each spike in the voice, for the mascot's ring. */
  spikes = $state(0)
  /** The voice stage on a new chat: listening (or transcribing), then ready to send. */
  home = $state<'off' | 'on' | 'ready'>('off')

  /** The composer takes each transcript, and clears its draft when the voice stage starts over. */
  onTranscript: ((text: string) => void) | null = null
  onClear: (() => void) | null = null
  /** Whether the composer holds any text (the voice stage stays "ready" while it does). */
  hasText: () => boolean = () => false

  private rec: Recording | null = null
  private startedAt = 0
  private raf = 0
  private slow = 0
  private lastSpike = 0
  /** Cancelled while the mic was still opening. */
  private aborted = false

  get recording() {
    return this.phase === 'recording'
  }
  get busy() {
    return this.phase !== 'idle'
  }

  async start() {
    if (this.phase !== 'idle') return
    if (!app.settings?.hasElevenLabsKey) {
      app.toast('Add an ElevenLabs key in Settings to use voice input.')
      app.settingsOpen = true
      return
    }
    // On a new chat, the voice stage opens at once; the mic (and any permission prompt) follows.
    if (!app.view) this.home = 'on'
    this.phase = 'starting'
    this.aborted = false
    try {
      if (!(await window.api.stt.microphone())) {
        app.toast('Microphone access is off for Tomo. Turn it on in System Settings → Privacy & Security → Microphone.')
        this.phase = 'idle'
        this.leaveHomeIfEmpty()
        return
      }
      const rec = await startRecording()
      if (this.aborted) {
        rec.cancel()
        this.phase = 'idle'
        this.leaveHomeIfEmpty()
        return
      }
      this.rec = rec
      this.phase = 'recording'
      this.startedAt = Date.now()
      this.elapsed = 0
      this.slow = 0
      this.level = 0
      this.raf = requestAnimationFrame(this.loop)
    } catch (e) {
      app.toast(`Microphone unavailable: ${e instanceof Error ? e.message : e}`)
      this.phase = 'idle'
      this.leaveHomeIfEmpty()
    }
  }

  private loop = () => {
    const r = this.rec
    if (!r) return
    const lvl = r.level()
    this.level += (lvl - this.level) * 0.35
    this.slow += (lvl - this.slow) * 0.04
    const now = performance.now()
    if (lvl - this.slow > 0.16 && lvl > 0.28 && now - this.lastSpike > 200) {
      this.lastSpike = now
      this.spikes++
    }
    const s = Math.floor((Date.now() - this.startedAt) / 1000)
    if (s !== this.elapsed) this.elapsed = s
    this.raf = requestAnimationFrame(this.loop)
  }

  private endLoop() {
    cancelAnimationFrame(this.raf)
    this.level = 0
    this.held = false
  }

  async finish() {
    const r = this.rec
    if (!r || this.phase !== 'recording') return
    this.rec = null
    this.endLoop()
    this.phase = 'transcribing'
    try {
      const audio = await r.stop()
      const transcript = await app.attempt(() => window.api.stt.transcribe(audio.data, audio.mime))
      if (transcript) this.onTranscript?.(transcript)
      else if (transcript === '') app.toast('No speech detected.', 'info')
    } finally {
      this.phase = 'idle'
      if (this.home !== 'off') {
        if (this.hasText()) this.home = 'ready'
        else this.home = 'off'
      }
    }
  }

  cancel() {
    if (this.phase === 'starting') {
      this.aborted = true
      return
    }
    this.rec?.cancel()
    this.rec = null
    this.endLoop()
    if (this.phase === 'recording') this.phase = 'idle'
    this.leaveHomeIfEmpty()
  }

  toggle() {
    if (this.phase === 'recording') void this.finish()
    else void this.start()
  }

  /** Esc on the stage once it's ready: the draft goes, and Home comes back. */
  startOver() {
    this.onClear?.()
    this.home = 'off'
  }

  /** The chat changed (or the first message went): the stage is over. */
  leaveHome() {
    if (this.phase === 'recording' || this.phase === 'starting') this.cancel()
    this.home = 'off'
  }

  private leaveHomeIfEmpty() {
    if (this.home === 'off') return
    this.home = this.hasText() ? 'ready' : 'off'
  }
}

export const voice = new Voice()

export const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
