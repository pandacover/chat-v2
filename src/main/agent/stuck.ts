// Notices a reply going round in circles, from what it does: the tool calls it makes, what they
// return, and the text it streams. Pure: no SDK, no clock, no I/O, so every signal is tested on
// its own (test/stuck.test.ts). watch.ts feeds it during a reply and acts on what it finds.
//
// The counted signals and their starting thresholds come from Gemini CLI's loopDetectionService
// and OpenHands' StuckDetector. They are starting values: every pause is recorded (Db
// stuck_pauses) so they can be tuned.
//   - the same call (tool and input) with the same result, 4 in a row
//   - the same call with any result, 5 in a row
//   - the same error from the same call: a nudge to the model at 3, a pause at 4
//   - two calls alternating (A, B, A, B), each with the same result every time, over 6 calls
//   - the same 50 characters of text 10 times close together
// Anything subtler (no change, churn) is judged at checkpoints, on the schedule below.

export interface Thresholds {
  /** The same call with the same result, this many times in a row: pause. */
  sameResult: number
  /** The same call with any result, this many times in a row: pause. */
  sameCall: number
  /** The same call failing with the same error this many times in a row: nudge the model. */
  errorNudge: number
  /** …and this many: pause. */
  errorPause: number
  /** Two calls alternating, each with its own unchanging result, over this many calls: pause. */
  alternating: number
  /** Text is compared in chunks of this many characters… */
  textChunk: number
  /** …and a chunk seen this many times, close together, is a loop. */
  textRepeats: number
}

export const THRESHOLDS: Thresholds = {
  sameResult: 4,
  sameCall: 5,
  errorNudge: 3,
  errorPause: 4,
  alternating: 6,
  textChunk: 50,
  textRepeats: 10
}

export type Signal = 'same_result' | 'same_call' | 'same_error' | 'alternating' | 'repeated_text' | 'no_progress'

/** What the detector found: a word to the model, or a reason to pause (told to the user). */
export type Finding = { kind: 'nudge'; signal: Signal; message: string } | { kind: 'pause'; signal: Signal; reason: string }

export interface ToolOutcome {
  name: string
  input: unknown
  /** What the tool returned (any shape; compared by fingerprint), or the error's text. */
  output: unknown
  isError: boolean
}

/** JSON with object keys sorted, so inputs that differ only in key order are the same call. */
export const stableJson = (value: unknown): string => {
  const seen = new WeakSet<object>()
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v)) return '[circular]'
    seen.add(v)
    if (Array.isArray(v)) return v.map(walk)
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, walk((v as Record<string, unknown>)[k])])
    )
  }
  return JSON.stringify(walk(value)) ?? 'undefined'
}

/** A short hash of a string (cyrb53): results can be screenshots, so they are compared by this. */
export const hash = (s: string): string => {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** An error's text, as compared: whitespace folded, cut short. */
const errorKey = (output: unknown) => (typeof output === 'string' ? output : stableJson(output)).replace(/\s+/g, ' ').trim().slice(0, 500)

/** A tool's name as the user reads it: `mcp__computer__look_at_screen` → "look at screen". */
export const toolWords = (name: string) => (/^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(name)?.[1] ?? name).replace(/_/g, ' ')

/** An error quoted in a pause message: its first line, cut short. */
const quote = (error: string) => {
  const line = error.split('\n').find((l) => l.trim())?.trim() ?? error
  return line.length > 140 ? `${line.slice(0, 137).trimEnd()}…` : line
}

interface Call {
  key: string
  name: string
  result: string
  error: string | null
}

/** How many calls at the end of `calls` satisfy `same` with the last one. */
const run = (calls: readonly Call[], same: (a: Call, b: Call) => boolean) => {
  const last = calls.at(-1)
  if (!last) return 0
  let n = 0
  for (let i = calls.length - 1; i >= 0 && same(calls[i]!, last); i--) n++
  return n
}

// Markdown whose lines repeat by nature (tables, lists, headings, quotes, rules): Gemini CLI
// starts counting afresh at these rather than calling them a loop.
const STRUCTURE = /(^|\n)\s*(?:\|.*\||[|+-]{3,}|[-*+] |\d+[.)] |#{1,6} |> |[-*_=]{3,}\s*(?:\n|$))/
const FENCE = /```|<\/?artifact\b/gi

export const makeDetector = (t: Thresholds = THRESHOLDS) => {
  const calls: Call[] = []

  // Text: every chunk of `textChunk` characters, at every offset, with where it was seen.
  // Only the last WINDOW characters are kept.
  const WINDOW = 5000
  let text = ''
  /** The absolute offset of text[0]. */
  let base = 0
  /** The absolute offset of the next chunk to look at. */
  let next = 0
  let seen = new Map<string, number[]>()
  /** Inside a code block or an artifact: code repeats by nature, so it isn't counted. */
  let inCode = false

  const resetText = () => {
    base += text.length
    next = base
    text = ''
    seen = new Map()
  }

  const toolCall = (o: ToolOutcome): Finding | null => {
    // A tool call breaks up the text: repeated text is a loop within one stretch of writing.
    resetText()
    const error = o.isError ? errorKey(o.output) : null
    const call: Call = {
      key: `${o.name}\u0000${stableJson(o.input ?? {})}`,
      name: o.name,
      result: error !== null ? `error:${hash(error)}` : hash(stableJson(o.output ?? null)),
      error
    }
    calls.push(call)
    // Only the tail matters; keep enough for the longest pattern.
    if (calls.length > 64) calls.splice(0, calls.length - 64)
    const what = toolWords(o.name)

    if (error !== null) {
      const failed = run(calls, (a, b) => a.key === b.key && a.error === b.error)
      if (failed >= t.errorPause)
        return { kind: 'pause', signal: 'same_error', reason: `It kept getting the same error from ${what}: “${quote(typeof o.output === 'string' ? o.output : error)}”` }
      if (failed === t.errorNudge)
        return {
          kind: 'nudge',
          signal: 'same_error',
          message: `This exact ${o.name} call has now failed ${failed} times in a row with the same error. Don't make it again: change the input, try a different way, or tell the user what is blocking you.`
        }
    }
    const same = run(calls, (a, b) => a.key === b.key && a.result === b.result)
    if (same >= t.sameResult) return { kind: 'pause', signal: 'same_result', reason: `It made the same ${what} call ${same} times in a row and got the same result each time.` }
    const repeated = run(calls, (a, b) => a.key === b.key)
    if (repeated >= t.sameCall) return { kind: 'pause', signal: 'same_call', reason: `It made the same ${what} call ${repeated} times in a row.` }

    // A, B, A, B…: two different calls taking turns, and neither result changing. (Paging through
    // something, a press then a look, alternates too, but its looks differ.)
    const n = t.alternating
    if (calls.length >= n) {
      const tail = calls.slice(-n)
      const [a, b] = [tail[0]!, tail[1]!]
      const alternates = a.key !== b.key && tail.every((c, i) => { const like = i % 2 === 0 ? a : b; return c.key === like.key && c.result === like.result })
      if (alternates) {
        const [x, y] = [toolWords(a.name), toolWords(b.name)]
        return { kind: 'pause', signal: 'alternating', reason: x === y ? `It kept going back and forth between the same two ${x} calls, with the same results each time.` : `It kept going back and forth between ${x} and ${y}, with the same results each time.` }
      }
    }
    return null
  }

  const streamed = (delta: string): Finding | null => {
    if (!delta) return null
    const fences = delta.match(FENCE)?.length ?? 0
    if (fences > 0 || STRUCTURE.test(delta)) {
      resetText()
      // An odd number of fences flips in or out of a code block.
      if (fences % 2 === 1) inCode = !inCode
      if (fences > 0) return null
    }
    if (inCode) {
      base += delta.length
      next = base
      return null
    }
    text += delta
    const size = t.textChunk
    for (; next + size <= base + text.length; next++) {
      const chunk = text.slice(next - base, next - base + size)
      // A run of one character (a rule, padding) isn't a loop of text.
      if (/^(.)\1*$/s.test(chunk)) continue
      let at = seen.get(chunk)
      if (!at) seen.set(chunk, (at = []))
      at.push(next)
      if (at.length < t.textRepeats) continue
      // Close together: the last repeats average no more than 1.5 chunks apart (Gemini CLI's rule).
      const recent = at.slice(-t.textRepeats)
      const spread = (recent.at(-1)! - recent[0]!) / (t.textRepeats - 1)
      if (spread <= size * 1.5) {
        resetText()
        return { kind: 'pause', signal: 'repeated_text', reason: 'It started writing the same text over and over.' }
      }
    }
    // Keep only the window: forget older text and the chunks seen in it.
    if (text.length > WINDOW * 2) {
      const cut = text.length - WINDOW
      text = text.slice(cut)
      base += cut
      for (const [chunk, at] of seen) {
        const kept = at.filter((p) => p >= base)
        if (kept.length === 0) seen.delete(chunk)
        else seen.set(chunk, kept)
      }
    }
    return null
  }

  return { toolCall, text: streamed }
}

export type Detector = ReturnType<typeof makeDetector>

// Checkpoints: a progress note and a judge's look at it. The first comes after 30 model calls,
// then every 10; 5 after an unclear look, 15 while the work is clearly moving.

export interface CheckpointSchedule {
  first: number
  every: number
  afterUnclear: number
  whileProgressing: number
  /** A judge must be at least this sure to pause (or to count as clearly progressing). */
  confidence: number
}

export const CHECKPOINTS: CheckpointSchedule = { first: 30, every: 10, afterUnclear: 5, whileProgressing: 15, confidence: 0.9 }

export type Verdict = 'progressing' | 'unclear' | 'stuck'

export interface Judgement {
  verdict: Verdict
  /** How sure the judge is, 0 to 1. */
  confidence: number
  /** For the user, when stuck: why, in a sentence. */
  why?: string | undefined
  /** For the model, when unclear: what to change. */
  nudge?: string | undefined
}

export type Decision = { action: 'carry_on' | 'nudge' | 'pause'; gap: number }

/**
 * What a checkpoint's judgement means: stuck pauses only at the schedule's confidence (a less
 * sure "stuck" is treated as unclear); unclear steps in with a nudge and looks again soon;
 * progressing carries on silently. No judgement (the judge failed) carries on.
 */
export const decide = (j: Judgement | null, s: CheckpointSchedule = CHECKPOINTS): Decision => {
  if (!j) return { action: 'carry_on', gap: s.every }
  if (j.verdict === 'stuck' && j.confidence >= s.confidence) return { action: 'pause', gap: s.every }
  if (j.verdict === 'progressing') return { action: 'carry_on', gap: j.confidence >= s.confidence ? s.whileProgressing : s.every }
  return { action: 'nudge', gap: s.afterUnclear }
}

/** The step a reply's checkpoints come at, given the judgements so far (for tests and docs). */
export const checkpointAfter = (step: number | null, j: Judgement | null, s: CheckpointSchedule = CHECKPOINTS) =>
  step === null ? s.first : step + decide(j, s).gap
