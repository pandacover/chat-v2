// Watches one reply for being stuck, so a reply can run as long as it makes progress instead of
// stopping at a fixed number of steps. The driver tells it each model call, tool call and result,
// and the text as it streams; it answers with what to do: a nudge for the model (sent with the
// next tool result) or a pause. A pause keeps all the work; Continue resumes the reply.
//
// Counted signals come from stuck.ts. Past them, checkpoints: after 30 model calls (then on
// stuck.ts's schedule) a judge reads what the reply has done lately, writes a progress note, and
// says whether it is progressing, unclear (nudge) or stuck (pause, at 90% confidence).
//
// Swappable for later phases: the judge (a small model now, the primary bot later), where notes
// go (a table keyed by chat now, job notes later), and where pauses are recorded.
import { CHECKPOINTS, type CheckpointSchedule, type Finding, type Judgement, type Signal, THRESHOLDS, type Thresholds, decide, makeDetector, stableJson } from './stuck'

/** Whether the work is getting closer to done, as a progress note says. */
export type Closer = 'closer' | 'same' | 'further'

export interface ProgressNote {
  /** The chat (Tomo session) and the reply the note is about. */
  sessionId: string
  messageId: string
  /** Model calls the reply had made when the note was written. */
  step: number
  done: string
  left: string
  closer: Closer
  verdict: Judgement['verdict']
  confidence: number
  createdAt: number
}

/** Where progress notes are kept. A later phase points this at job notes. */
export interface ProgressNotes {
  add(note: ProgressNote): void
  /** The chat's latest notes, oldest first. */
  recent(sessionId: string, limit: number): ProgressNote[]
}

export interface JudgeInput {
  /** What the user asked for, as the reply got it. */
  task: string
  step: number
  /** The reply's recent steps, a line each, oldest first. */
  trail: string[]
  /** Earlier notes on this chat, oldest first. */
  notes: ProgressNote[]
}

export interface JudgeReply extends Judgement {
  done: string
  left: string
  closer: Closer
}

/** Reads a checkpoint and judges it. A small model now (judge.ts); a later phase swaps in the primary bot. */
export interface ProgressJudge {
  judge(input: JudgeInput, signal: AbortSignal): Promise<JudgeReply | null>
}

export interface Pause {
  signal: Signal
  /** For the user, in plain words: what was noticed. */
  reason: string
  /** The model call the reply was on. */
  step: number
}

/** Records each pause, so the thresholds can be tuned (with whether the user resumed right away). */
export interface PauseLog {
  record(p: Pause & { sessionId: string; messageId: string }): void
}

export interface WatchDeps {
  judge: ProgressJudge | null
  notes: ProgressNotes
  pauses: PauseLog
  thresholds?: Thresholds
  schedule?: CheckpointSchedule
  now?: () => number
}

/** What the reply being watched is. */
export interface WatchTarget {
  sessionId: string
  messageId: string
  task: string
}

/** How the watch stops a reply that isn't at a tool call (the driver interrupts the query). */
export interface WatchControl {
  stop(p: Pause): void
}

/** The answer to a tool result reported from a PostToolUse hook: words for the model, and whether to stop. */
export interface HookAnswer {
  context: string | null
  stop: Pause | null
}

export interface Watch {
  /** A model call: one per assistant message id. */
  step(id: string): void
  /** A tool call the model made (from its assistant message). */
  call(id: string, name: string, input: unknown): void
  /** A tool's result from a hook, which can answer with a nudge or stop the reply. */
  hook(id: string, name: string, input: unknown, output: unknown, isError: boolean): HookAnswer
  /** A tool's result from the message stream; ignored when its hook already reported it. */
  result(id: string, output: unknown, isError: boolean): void
  text(delta: string): void
  /** The pause, once there is one. */
  readonly paused: Pause | null
  /** The reply ended: a judge still reading is cancelled. */
  end(): void
}

/** Recent steps kept for the judge. */
const TRAIL = 40
const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/** A tool result as a line of text: text blocks joined, images as [image]. */
export const outputText = (output: unknown): string => {
  if (typeof output === 'string') return output
  const blocks = Array.isArray(output)
    ? output
    : output && typeof output === 'object' && Array.isArray((output as { content?: unknown }).content)
      ? (output as { content: unknown[] }).content
      : null
  if (!blocks) return stableJson(output)
  return blocks
    .map((b) => {
      const block = b as { type?: string; text?: string }
      return block.type === 'text' ? (block.text ?? '') : block.type ? `[${block.type}]` : stableJson(b)
    })
    .join(' ')
}

const DEFAULT_NUDGE = 'Check in with yourself: the last steps may not be getting closer to what the user asked for. If an approach keeps failing, try a different one, or tell the user what is blocking you.'

export const makeWatch = (deps: WatchDeps, target: WatchTarget, control: WatchControl): Watch => {
  const detector = makeDetector(deps.thresholds ?? THRESHOLDS)
  const schedule = deps.schedule ?? CHECKPOINTS
  const now = deps.now ?? Date.now
  const steps = new Set<string>()
  const calls = new Map<string, { name: string; input: unknown }>()
  const reported = new Set<string>()
  const trail: string[] = []
  const nudges: string[] = []
  let paused: Pause | null = null
  /** A pause decided off a tool call (by the judge), for the next hook to carry out. */
  let pending: Pause | null = null
  /** A hook said stop; a model call after it means Claude Code went on anyway. */
  let stopSent = false
  let nextCheckpoint = schedule.first
  let judging: AbortController | null = null
  let ended = false
  let textLine = ''

  const note = (line: string) => {
    trail.push(`[${steps.size}] ${line}`)
    if (trail.length > TRAIL) trail.splice(0, trail.length - TRAIL)
  }
  const flushText = () => {
    if (textLine.trim()) note(`wrote: ${clip(textLine, 240)}`)
    textLine = ''
  }

  const pauseWith = (signal: Signal, reason: string): Pause => {
    if (paused) return paused
    paused = { signal, reason, step: steps.size }
    try {
      deps.pauses.record({ ...paused, sessionId: target.sessionId, messageId: target.messageId })
    } catch {}
    return paused
  }

  const checkpoint = () => {
    const judge = deps.judge
    if (!judge || judging || ended) return
    const at = steps.size
    const abort = (judging = new AbortController())
    flushText()
    const input: JudgeInput = { task: target.task, step: at, trail: [...trail], notes: safe(() => deps.notes.recent(target.sessionId, 3), []) }
    void judge
      .judge(input, abort.signal)
      .catch(() => null)
      .then((j) => {
        if (judging === abort) judging = null
        if (abort.signal.aborted || ended || paused) return
        const d = decide(j, schedule)
        nextCheckpoint = at + d.gap
        if (j)
          safe(() =>
            deps.notes.add({ sessionId: target.sessionId, messageId: target.messageId, step: at, done: j.done, left: j.left, closer: j.closer, verdict: j.verdict, confidence: j.confidence, createdAt: now() }),
            undefined
          )
        if (d.action === 'nudge') nudges.push(j?.nudge?.trim() || DEFAULT_NUDGE)
        else if (d.action === 'pause') pending = { signal: 'no_progress', reason: j?.why?.trim() || "It doesn't seem to be getting any closer to done.", step: at }
      })
  }

  /** A finding from a tool result: nudges wait for the next hook; a pause is returned. */
  const act = (f: Finding | null): Pause | null => {
    if (!f) return null
    if (f.kind === 'nudge') {
      nudges.push(f.message)
      return null
    }
    return pauseWith(f.signal, f.reason)
  }

  const tool = (id: string, name: string, input: unknown, output: unknown, isError: boolean) => {
    reported.add(id)
    flushText()
    const said = clip(outputText(output), 160)
    note(`${name} ${clip(stableJson(input ?? {}), 160)} → ${isError ? 'error: ' : ''}${said || '(nothing)'}`)
    return act(detector.toolCall({ name, input, output, isError }))
  }

  return {
    step: (id) => {
      if (paused || steps.has(id)) {
        // Told to stop at a hook, yet another model call: stop it the hard way.
        if (paused && stopSent && !steps.has(id)) control.stop(paused)
        return
      }
      steps.add(id)
      if (steps.size >= nextCheckpoint) checkpoint()
    },
    call: (id, name, input) => {
      if (!calls.has(id)) calls.set(id, { name, input })
    },
    hook: (id, name, input, output, isError) => {
      if (!calls.has(id)) calls.set(id, { name, input })
      if (!reported.has(id)) tool(id, name, input, output, isError)
      // A pause the judge decided is carried out here, at the first tool call after it.
      if (!paused && pending) pauseWith(pending.signal, pending.reason)
      pending = null
      if (paused) {
        stopSent = true
        return { context: null, stop: paused }
      }
      return { context: nudges.splice(0).join('\n\n') || null, stop: null }
    },
    result: (id, output, isError) => {
      if (reported.has(id)) return
      const call = calls.get(id)
      if (!call) return
      const p = tool(id, call.name, call.input, output, isError)
      // No hook to answer through (a refused call): stop the reply directly.
      if (p) control.stop(p)
    },
    text: (delta) => {
      if (paused || !delta) return
      textLine += delta
      if (textLine.length > 4000) textLine = textLine.slice(-4000)
      const f = detector.text(delta)
      if (f?.kind === 'pause') control.stop(pauseWith(f.signal, f.reason))
    },
    get paused() {
      return paused
    },
    end: () => {
      ended = true
      judging?.abort()
      judging = null
    }
  }
}

const safe = <A>(f: () => A, fallback: A): A => {
  try {
    return f()
  } catch {
    return fallback
  }
}

/**
 * Added to the prompt when a paused reply is continued: why it was paused, so it doesn't walk
 * straight back into the same loop.
 */
export const pauseNote = (reason: string) =>
  `You were paused because you seemed stuck: ${reason.replace(/\s+/g, ' ').trim()} The user has asked you to go on. Don't repeat what got you stuck: try a different approach, or tell the user what is in the way.`
