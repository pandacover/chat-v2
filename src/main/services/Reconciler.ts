// The daily reconciler as a service: a run end to end (read the jobs, ask the memory model, save
// the plan as one revision, log the run), the idle check that starts one at most once a day, and
// Run now from Settings. The planning is pure, in reconciler.ts; the model sits behind
// ReconcilerModel so tests can use a fake.
import { Cause, Context, Effect, Layer } from 'effect'
import type { ReconcilerRun, Settings } from '@shared/types'
import { type DbError, InvalidInput, errorMessage } from '../errors'
import { Agent, type Auth } from '../agent/driver'
import { JOBS_PER_RUN, RECONCILER_INSTRUCTIONS, dueToRun, parseReconcileReply, reconcilePrompt } from '../reconciler'
import { Broadcaster } from './Chat'
import { Db, type DbApi } from './Db'
import { SettingsStore } from './SettingsStore'

/** The memory model, asked once: the reconciler's instructions and prompt in, its reply out. */
export type ReconcilerModel = (req: { system: string; prompt: string }) => Promise<string>

/** How long the model may take over one run. */
const MODEL_TIMEOUT_MS = 120_000
/** How often the app looks whether a run is due. */
const TICK = '5 minutes'

type RunDb = Pick<
  DbApi,
  'jobsToReconcile' | 'profile' | 'playbooks' | 'playbookBots' | 'reconcile' | 'startReconcilerRun' | 'finishReconcilerRun' | 'lastReconcilerRun'
>

/**
 * One run: the finished jobs it hasn't read (newest first, JOBS_PER_RUN at most), the profile and
 * every playbook, to the model; its reply checked (parseReconcileReply) and saved as one revision.
 * Jobs are marked read only when the reply could be used, so a failed run reads them again.
 */
export const reconcileOnce = async (deps: {
  db: RunDb
  model: ReconcilerModel
  modelName: string
  trigger: 'idle' | 'manual'
  now?: () => number
}): Promise<{ run: ReconcilerRun; added: string[]; removed: string[] }> => {
  const now = deps.now ?? Date.now
  const { db } = deps
  const id = db.startReconcilerRun(deps.trigger, deps.modelName, now())
  const jobs = db.jobsToReconcile(JOBS_PER_RUN)
  const read = jobs.map((j) => ({ id: j.id, updatedAt: j.updatedAt }))
  const end = (e: Omit<Parameters<RunDb['finishReconcilerRun']>[1], 'jobs'>, added: string[] = [], removed: string[] = []) => {
    db.finishReconcilerRun(id, { ...e, jobs: read }, now())
    return { run: db.lastReconcilerRun()!, added, removed }
  }
  if (jobs.length === 0) return end({ outcome: 'nothing', rev: null, read: true, changes: [], dropped: 0, detail: null })
  const playbooks = db.playbooks()
  const input = {
    now: now(),
    jobs,
    profile: db.profile(),
    playbooks: db.playbookBots().map((b) => ({ botId: b.id, botName: b.name, records: playbooks.get(b.id) ?? [] }))
  }
  let reply: string
  try {
    reply = await deps.model({ system: RECONCILER_INSTRUCTIONS, prompt: reconcilePrompt(input) })
  } catch (e) {
    return end({ outcome: 'error', rev: null, read: false, changes: [], dropped: 0, detail: errorMessage(e) })
  }
  const reading = parseReconcileReply(reply, input)
  // Not the reply itself: it may quote the user.
  if (!reading) return end({ outcome: 'unreadable', rev: null, read: false, changes: [], dropped: 0, detail: "The reply wasn't the JSON the review needs." })
  const note = `${deps.trigger === 'manual' ? 'Review run from Settings' : 'Daily review'} of ${jobs.length} finished job${jobs.length === 1 ? '' : 's'}`
  const saved = reading.plan.changes.length ? db.reconcile(reading.plan, note) : null
  return end(
    {
      outcome: saved?.rev != null ? 'changed' : 'nothing',
      rev: saved?.rev ?? null,
      read: true,
      changes: saved?.applied ?? [],
      dropped: reading.dropped.length + (saved?.skipped ?? 0),
      detail: null
    },
    saved?.added,
    saved?.removed
  )
}

export class Reconciler extends Context.Service<
  Reconciler,
  {
    /** Runs now, whenever the last run was. Fails while memory is off or a run is under way. */
    readonly runNow: Effect.Effect<ReconcilerRun, DbError | InvalidInput>
    readonly running: Effect.Effect<boolean>
  }
>()('chat-v2/Reconciler') {
  static readonly layer = Layer.effect(
    Reconciler,
    Effect.gen(function* () {
      const db = yield* Db
      const settingsStore = yield* SettingsStore
      const agent = yield* Agent
      const broadcaster = yield* Broadcaster
      const startedAt = Date.now()
      let running = false

      yield* db.use((d) => d.endStaleReconcilerRuns()).pipe(Effect.ignore)

      const authFor = (settings: Settings) =>
        settings.auth === 'apiKey'
          ? settingsStore.apiKey('anthropic').pipe(Effect.map((key): Auth => ({ kind: 'apiKey', key })))
          : Effect.succeed<Auth>({ kind: 'login' })

      const run = (trigger: 'idle' | 'manual') =>
        Effect.gen(function* () {
          const settings = yield* settingsStore.get.pipe(Effect.orElseSucceed(() => null))
          if (!settings?.memoryModel) return yield* new InvalidInput({ message: 'Memory is off in Settings, so there is nothing to review.' })
          if (running) return yield* new InvalidInput({ message: 'The review is already running.' })
          running = true
          const model = settings.memoryModel
          return yield* Effect.gen(function* () {
            const auth = yield* authFor(settings).pipe(Effect.orElseSucceed((): Auth => ({ kind: 'login' })))
            const api = yield* db.use((d) => d)
            const result = yield* Effect.tryPromise({
              try: (signal) =>
                reconcileOnce({
                  db: api,
                  modelName: model,
                  trigger,
                  model: (req) => agent.ask({ model, system: req.system, prompt: req.prompt, auth }, AbortSignal.any([signal, AbortSignal.timeout(MODEL_TIMEOUT_MS)]))
                }),
              catch: (e) => new InvalidInput({ message: `The review failed: ${errorMessage(e)}` })
            })
            // Open windows reload memory; a review says nothing unasked, so no toast.
            broadcaster.send({ type: 'memory', sessionId: '', added: [], removed: [] })
            return result.run
          }).pipe(Effect.ensuring(Effect.sync(() => void (running = false))))
        })

      /** The daily run, when the app has been idle a while and something new has finished. */
      const tick = Effect.gen(function* () {
        const settings = yield* settingsStore.get.pipe(Effect.orElseSucceed(() => null))
        const s = yield* db.use((d) => ({
          lastRun: d.lastReconcilerRun(),
          lastActivityAt: d.lastActivityAt(),
          busy: running || d.anyStreaming(),
          pending: d.pendingReconcileCount()
        }))
        const due = dueToRun({ now: Date.now(), startedAt, memoryOn: !!settings?.memoryModel, ...s })
        if (due.due) yield* run('idle')
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning(`Memory review failed: ${errorMessage(Cause.squash(cause))}`)
        )
      )
      yield* Effect.forkScoped(Effect.forever(Effect.sleep(TICK).pipe(Effect.andThen(tick))))

      return Reconciler.of({
        runNow: run('manual'),
        running: Effect.sync(() => running)
      })
    })
  )
}
