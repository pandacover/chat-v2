// Where the time goes in a reply: each model call, each tool call, and a summary per reply,
// as JSON lines in timing.jsonl under the app's data folder. Measurement only: nothing here
// changes what a reply does. CHAT_V2_TIMING=1 also prints a table per reply to the console.
import { appendFileSync, renameSync, statSync } from 'node:fs'
import { Cause, Context, Effect, Exit } from 'effect'
import type { Usage } from '@shared/types'

/** Past this the log starts over, keeping one old file beside it. */
const MAX_LOG_BYTES = 5 * 1024 * 1024

const round = (ms: number) => Math.round(ms * 10) / 10

/** Times one piece of work: a model call or a tool call. */
export class Stopwatch {
  readonly started = performance.now()
  /** Milliseconds from the start to a moment, set the first time only (headers, first delta). */
  readonly marks: Record<string, number> = {}
  /** Milliseconds spent in each phase; a phase that happens more than once adds up. */
  readonly phases: Record<string, number> = {}
  /** Facts about the work: request size, tokens, who answered. */
  readonly notes: Record<string, unknown> = {}

  elapsed() {
    return performance.now() - this.started
  }
  mark(name: string) {
    this.marks[name] ??= this.elapsed()
  }
  add(phase: string, ms: number) {
    this.phases[phase] = (this.phases[phase] ?? 0) + ms
  }
  note(name: string, value: unknown) {
    this.notes[name] = value
  }
}

/** The stopwatch for the work in progress. Without one (the default) nothing is recorded. */
export const CurrentStopwatch = Context.Reference<Stopwatch | null>('chat-v2/CurrentStopwatch', { defaultValue: () => null })

/** Adds how long `effect` took to `phase` of the current stopwatch, however it ends. */
export const timed =
  (phase: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(Effect.service(CurrentStopwatch), (sw) => {
      if (!sw) return effect
      const t = performance.now()
      return Effect.ensuring(effect, Effect.sync(() => sw.add(phase, performance.now() - t)))
    })

type Status = 'ok' | 'error' | 'interrupted'

const statusOf = (exit: Exit.Exit<unknown, unknown>): Status =>
  Exit.isSuccess(exit) ? 'ok' : Cause.hasInterruptsOnly(exit.cause) ? 'interrupted' : 'error'

/**
 * One model call. Times are milliseconds from just before the request was built: `headersMs`
 * when the response headers came, `firstDeltaMs` the first streamed chunk of any kind (thinking
 * included), `firstContentMs` the first text or tool-call fragment. `totalMs` runs to the end of
 * the stream, which includes the reply writing each line to the database as it arrives.
 */
export interface CallRecord {
  kind: 'call'
  at: string
  reply: string
  step: number
  model: string
  status: Status
  totalMs: number
  headersMs?: number
  firstDeltaMs?: number
  firstContentMs?: number
  /** The JSON request body, and how many images it carries. */
  bytes?: number
  images?: number
  /** Who answered, as OpenRouter reports it. */
  answeredModel?: string
  provider?: string
  promptTokens?: number
  completionTokens?: number
  reasoningTokens?: number
  cachedTokens?: number
}

/** One tool call. `phases` are the parts Computer.ts times; whatever they leave over is bookkeeping. */
export interface ActionRecord {
  kind: 'action'
  at: string
  reply: string
  step: number
  tool: string
  status: Status
  totalMs: number
  phases: Record<string, number>
}

/** A whole reply: where its wall time went, and what it used. */
export interface ReplyRecord {
  kind: 'reply'
  at: string
  reply: string
  model: string | null
  status: Status
  wallMs: number
  /** From the start of the reply to the first text or tool call from the model. */
  firstTokenMs: number | null
  calls: number
  actions: number
  /** Waiting on the model, acting locally, and the rest (building requests, saving lines). */
  modelMs: number
  actionMs: number
  otherMs: number
  modelShare: number
  bytes: number
  images: number
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  cachedTokens: number
}

export type TimingRecord = CallRecord | ActionRecord | ReplyRecord

export interface TimingLog {
  readonly write: (record: TimingRecord) => void
  /** Whether replies print their table to the console (CHAT_V2_TIMING=1). */
  readonly echo: boolean
}

/** Appends records to `file`. Failing to write never fails a reply. */
export const timingLog = (file: string, echo: boolean): TimingLog => {
  try {
    if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, file.replace(/\.jsonl$/, '.old.jsonl'))
  } catch {
    // No log yet.
  }
  return {
    echo,
    write: (record) => {
      try {
        appendFileSync(file, JSON.stringify(record) + '\n', 'utf8')
      } catch {
        // Timing is a diagnostic; losing a line is fine.
      }
    }
  }
}

const callRecord = (reply: string, step: number, model: string, sw: Stopwatch, status: Status): CallRecord => {
  const usage = sw.notes.usage as Omit<Usage, 'requests'> | undefined
  const at = (name: string) => (sw.marks[name] === undefined ? {} : { [`${name}Ms`]: round(sw.marks[name]) })
  return {
    kind: 'call',
    at: new Date().toISOString(),
    reply,
    step,
    model,
    status,
    totalMs: round(sw.elapsed()),
    ...at('headers'),
    ...at('firstDelta'),
    ...at('firstContent'),
    ...(typeof sw.notes.bytes === 'number' ? { bytes: sw.notes.bytes } : {}),
    ...(typeof sw.notes.images === 'number' ? { images: sw.notes.images } : {}),
    ...(typeof sw.notes.model === 'string' ? { answeredModel: sw.notes.model } : {}),
    ...(typeof sw.notes.provider === 'string' ? { provider: sw.notes.provider } : {}),
    ...(usage
      ? {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          reasoningTokens: usage.reasoningTokens,
          cachedTokens: usage.cachedTokens
        }
      : {})
  }
}

/**
 * Times one reply: wrap each model call with `call` and each tool call with `action`, and run
 * `finish` when the reply ends. Every call and action is logged as it ends, failed or not.
 */
export const replyTimer = (reply: string, log: TimingLog) => {
  const started = performance.now()
  const records: Array<CallRecord | ActionRecord> = []
  let firstTokenMs: number | null = null

  const keep = (record: CallRecord | ActionRecord) =>
    Effect.suspend(() => {
      records.push(record)
      log.write(record)
      return Effect.logDebug('timing', record)
    })

  const call =
    (step: number, model: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        const sw = new Stopwatch()
        return effect.pipe(
          Effect.provideService(CurrentStopwatch, sw),
          Effect.onExit((exit) => {
            if (firstTokenMs === null && sw.marks.firstContent !== undefined) firstTokenMs = sw.started - started + sw.marks.firstContent
            return keep(callRecord(reply, step, model, sw, statusOf(exit)))
          })
        )
      })

  const action =
    (step: number, tool: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        const sw = new Stopwatch()
        return effect.pipe(
          Effect.provideService(CurrentStopwatch, sw),
          Effect.onExit((exit) =>
            keep({
              kind: 'action',
              at: new Date().toISOString(),
              reply,
              step,
              tool,
              status: statusOf(exit),
              totalMs: round(sw.elapsed()),
              phases: Object.fromEntries(Object.entries(sw.phases).map(([k, v]) => [k, round(v)]))
            })
          )
        )
      })

  const finish = (model: string | null, exit: Exit.Exit<unknown, unknown>) =>
    Effect.suspend(() => {
      const calls = records.filter((r): r is CallRecord => r.kind === 'call')
      const actions = records.filter((r): r is ActionRecord => r.kind === 'action')
      const sum = <T>(rs: T[], f: (r: T) => number | undefined) => rs.reduce((n, r) => n + (f(r) ?? 0), 0)
      const wallMs = performance.now() - started
      const modelMs = sum(calls, (c) => c.totalMs)
      const actionMs = sum(actions, (a) => a.totalMs)
      const summary: ReplyRecord = {
        kind: 'reply',
        at: new Date().toISOString(),
        reply,
        model,
        status: statusOf(exit),
        wallMs: round(wallMs),
        firstTokenMs: firstTokenMs === null ? null : round(firstTokenMs),
        calls: calls.length,
        actions: actions.length,
        modelMs: round(modelMs),
        actionMs: round(actionMs),
        otherMs: round(Math.max(0, wallMs - modelMs - actionMs)),
        modelShare: wallMs > 0 ? Math.round((modelMs / wallMs) * 100) / 100 : 0,
        bytes: sum(calls, (c) => c.bytes),
        images: sum(calls, (c) => c.images),
        promptTokens: sum(calls, (c) => c.promptTokens),
        completionTokens: sum(calls, (c) => c.completionTokens),
        reasoningTokens: sum(calls, (c) => c.reasoningTokens),
        cachedTokens: sum(calls, (c) => c.cachedTokens)
      }
      log.write(summary)
      if (log.echo) console.log(timingTable([...records, summary]))
      return Effect.logDebug('timing', summary)
    })

  return { call, action, finish, records: records as ReadonlyArray<CallRecord | ActionRecord> }
}

const ms = (n: number | undefined | null) => (n === undefined || n === null ? '' : String(Math.round(n)))
const kb = (n: number | undefined) => (n === undefined ? '' : `${Math.round(n / 1024)}k`)

/** The capture parts get their own column; the rest are listed by name. */
const phaseList = (phases: Record<string, number>) =>
  Object.entries(phases)
    .filter(([k]) => !k.startsWith('capture.'))
    .map(([k, v]) => `${k} ${Math.round(v)}`)
    .join(', ')

const captureParts = (phases: Record<string, number>) =>
  Object.entries(phases)
    .filter(([k]) => k.startsWith('capture.'))
    .map(([k, v]) => `${k.slice(8)} ${Math.round(v)}`)
    .join(', ')

/** A plain-text table of a reply's steps and its summary, for the console. */
export const timingTable = (records: TimingRecord[]): string => {
  const head = ['step', 'what', 'ms', 'headers', '1st delta', '1st content', 'body', 'imgs', 'tokens in/out/reason/cached', 'phases', 'capture parts']
  const rows: string[][] = []
  let summary: ReplyRecord | null = null
  for (const r of records) {
    if (r.kind === 'reply') summary = r
    else if (r.kind === 'call')
      rows.push([
        String(r.step),
        `model ${r.answeredModel ?? r.model}${r.provider ? ` (${r.provider})` : ''}${r.status === 'ok' ? '' : ` [${r.status}]`}`,
        ms(r.totalMs),
        ms(r.headersMs),
        ms(r.firstDeltaMs),
        ms(r.firstContentMs),
        kb(r.bytes),
        r.images === undefined ? '' : String(r.images),
        r.promptTokens === undefined ? '' : `${r.promptTokens}/${r.completionTokens}/${r.reasoningTokens}/${r.cachedTokens}`,
        '',
        ''
      ])
    else rows.push([String(r.step), `${r.tool}${r.status === 'ok' ? '' : ` [${r.status}]`}`, ms(r.totalMs), '', '', '', '', '', '', phaseList(r.phases), captureParts(r.phases)])
  }
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)))
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd()
  const out = [line(head), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)]
  if (summary) {
    const s = summary
    out.push(
      `reply ${s.reply} ${s.status}: ${ms(s.wallMs)} ms wall, first token ${s.firstTokenMs === null ? '-' : `${ms(s.firstTokenMs)} ms`}, ` +
        `${s.calls} model calls ${ms(s.modelMs)} ms (${Math.round(s.modelShare * 100)}%), ${s.actions} actions ${ms(s.actionMs)} ms, other ${ms(s.otherMs)} ms, ` +
        `${kb(s.bytes)} sent with ${s.images} images, tokens ${s.promptTokens} in (${s.cachedTokens} cached) / ${s.completionTokens} out (${s.reasoningTokens} reasoning)`
    )
  }
  return out.join('\n')
}
