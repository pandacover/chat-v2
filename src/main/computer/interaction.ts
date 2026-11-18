import { Deferred, Effect } from 'effect'
import type { ScreenRect } from './platform/types'

/** The reply a wait belongs to, so the chat can show it in the right place. */
export interface Owner {
  readonly sessionId: string
  readonly messageId: string
}

/** A Show-me step: the control to spotlight (input space) and what to do with it. */
export interface TeachTarget {
  rect: ScreenRect
  instruction: string
  step: number
  total: number
}

export type TeachOutcome = { kind: 'done' } | { kind: 'said'; text: string } | { kind: 'stopped' }

/** What computer use is waiting on the human for; null when the wait is over. */
export type Waiting =
  | ({ kind: 'approval'; id: string; title: string; detail: string } & Owner)
  | ({ kind: 'teach'; id: string; instruction: string; step: number; total: number } & Owner)
  | null

/**
 * Moments where the model blocks on the human: approving a risky action, or performing a step in
 * Show-me mode. Each has at most one outstanding request; a new one releases the old.
 */
export const makeInteraction = (hooks: {
  /** Show or clear the Show-me spotlight. */
  readonly spotlight: (target: TeachTarget | null) => void
  /** The overlay frame goes while the human decides. */
  readonly notActing: () => void
}) => {
  let approval: { wait: Extract<Waiting, { kind: 'approval' }>; done: Deferred.Deferred<boolean> } | null = null
  let teach: { wait: Extract<Waiting, { kind: 'teach' }>; done: Deferred.Deferred<TeachOutcome> } | null = null
  let seq = 0
  const listeners = new Set<(w: Waiting) => void>()
  const current = (): Waiting => approval?.wait ?? teach?.wait ?? null
  const changed = () => {
    const w = current()
    for (const f of listeners) f(w)
  }

  const resolveApproval = (id: string, approved: boolean) =>
    Effect.gen(function* () {
      if (!approval || approval.wait.id !== id) return false
      const d = approval.done
      approval = null
      yield* Deferred.succeed(d, approved)
      changed()
      return true
    })

  /** Resolve the step waiting for the user; with an id, only if it is still that one. */
  const resolveTeach = (outcome: TeachOutcome, id?: string) =>
    Effect.gen(function* () {
      if (!teach || (id !== undefined && teach.wait.id !== id)) return false
      const d = teach.done
      teach = null
      yield* Deferred.succeed(d, outcome)
      changed()
      return true
    })

  const mine = (o: Owner, w: Owner) => o.sessionId === w.sessionId && o.messageId === w.messageId

  return {
    requestApproval: (owner: Owner, title: string, detail: string) =>
      Effect.gen(function* () {
        if (approval) yield* resolveApproval(approval.wait.id, false)
        const done = yield* Deferred.make<boolean>()
        const entry = { wait: { kind: 'approval' as const, id: `ap_${++seq}`, title, detail, ...owner }, done }
        approval = entry
        hooks.notActing()
        changed()
        return yield* Deferred.await(done).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              if (approval !== entry) return
              approval = null
              changed()
            })
          )
        )
      }),
    resolveApproval,
    teach: (owner: Owner, target: TeachTarget) =>
      Effect.gen(function* () {
        if (teach) yield* resolveTeach({ kind: 'stopped' })
        const done = yield* Deferred.make<TeachOutcome>()
        const { instruction, step, total } = target
        const entry = { wait: { kind: 'teach' as const, id: `t_${++seq}`, instruction, step, total, ...owner }, done }
        teach = entry
        hooks.spotlight(target)
        changed()
        return yield* Deferred.await(done).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              if (teach !== entry) return
              teach = null
              changed()
            })
          )
        )
      }),
    resolveTeach,
    teachPending: () => teach !== null,
    current,
    subscribe: (f: (w: Waiting) => void) => {
      listeners.add(f)
      return () => void listeners.delete(f)
    },
    clearTeach: () => Effect.sync(() => hooks.spotlight(null)),
    /** Deny and release everything outstanding (Stop, the reply ended); with an owner, only its waits. */
    cancelAll: (owner?: Owner) =>
      Effect.gen(function* () {
        if (approval && (!owner || mine(owner, approval.wait))) yield* resolveApproval(approval.wait.id, false)
        if (teach && (!owner || mine(owner, teach.wait))) {
          yield* resolveTeach({ kind: 'stopped' })
          hooks.spotlight(null)
        }
        if (!owner) hooks.spotlight(null)
      })
  }
}

export type Interaction = ReturnType<typeof makeInteraction>
