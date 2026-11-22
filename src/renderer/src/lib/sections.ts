// The sidebar's sections, worked out from the jobs and their threads alone (no app state), so they
// can be tested: pinned jobs; the main section, of jobs that need the user; jobs where a reply
// runs (Working); and the rest (Settled), newest first.
import type { Job, ListedSession } from '@shared/types'

export type Section = 'pinned' | 'main' | 'working' | 'settled'

/** Why a job needs the user, most pressing first. */
export type Need = 'waiting' | 'draft' | 'paused' | 'failed' | 'unread'

/** A job and its thread, as the sidebar lists it. */
export interface SectionEntry {
  /** The thread's id. */
  key: string
  job: Job
  session: ListedSession
  draft: boolean
}

export interface SectionInput<E extends SectionEntry> {
  entries: readonly E[]
  /** Every thread, a job's own one and its bots' threads on it. */
  threads: readonly ListedSession[]
  /** The thread open now: the user is looking at it, so it is never unread. */
  openId: string | null
  /** The thread an approval or a Show-me step waits in, if any. */
  waitingIn: string | null
  /** When each draft was last edited. */
  draftAt?: (key: string) => number | undefined
}

export interface Sections<E> {
  pinned: E[]
  main: E[]
  working: E[]
  settled: E[]
}

/** A reply ended, or a bot reported back, in a thread since the user last opened it. */
export const unread = (s: ListedSession, openId: string | null = null) =>
  s.id !== openId && s.state.activityAt != null && s.state.activityAt > (s.state.readAt ?? 0)

/**
 * Why a job needs the user, or null. A finished job needs them only for a draft or an approval:
 * marking it finished deals with the rest.
 */
export const needOf = (e: SectionEntry, threads: readonly ListedSession[], openId: string | null, waitingJob: string | null): Need | null => {
  if (waitingJob === e.job.id) return 'waiting'
  if (e.draft) return 'draft'
  if (e.job.status !== 'open') return null
  if (threads.some((t) => t.state.lastReply === 'paused' || t.state.limitPaused)) return 'paused'
  if (threads.some((t) => t.state.lastReply === 'error')) return 'failed'
  return unread(e.session, openId) ? 'unread' : null
}

export const sectionsOf = <E extends SectionEntry>(input: SectionInput<E>): Sections<E> & { needs: Map<string, Need> } => {
  const byJob = new Map<string, ListedSession[]>()
  for (const t of input.threads) {
    if (!t.jobId) continue
    const list = byJob.get(t.jobId)
    if (list) list.push(t)
    else byJob.set(t.jobId, [t])
  }
  const waitingJob = input.waitingIn ? (input.threads.find((t) => t.id === input.waitingIn)?.jobId ?? null) : null
  const out: Sections<E> = { pinned: [], main: [], working: [], settled: [] }
  const needs = new Map<string, Need>()
  for (const e of input.entries) {
    const threads = byJob.get(e.job.id) ?? [e.session]
    const need = needOf(e, threads, input.openId, waitingJob)
    if (need) needs.set(e.key, need)
    if (e.session.pinnedAt != null) out.pinned.push(e)
    // A pinned job waiting on the user shows in the main section too: Pinned starts shut.
    if (need) out.main.push(e)
    else if (e.session.pinnedAt != null) continue
    else if (threads.some((t) => t.state.streaming)) out.working.push(e)
    else out.settled.push(e)
  }
  const at = (e: E) => Math.max(e.job.updatedAt, e.session.state.activityAt ?? 0, (e.draft && input.draftAt?.(e.key)) || 0)
  out.pinned.sort((a, b) => a.session.pinnedAt! - b.session.pinnedAt!)
  // Approvals first: something is held up until the user answers.
  out.main.sort((a, b) => Number(needs.get(b.key) === 'waiting') - Number(needs.get(a.key) === 'waiting') || at(b) - at(a))
  out.working.sort((a, b) => b.job.updatedAt - a.job.updatedAt)
  out.settled.sort((a, b) => b.job.updatedAt - a.job.updatedAt)
  return { ...out, needs }
}
