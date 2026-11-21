// The job list, as the sidebar and the search modal both show it: jobs with an unsent draft first,
// then pinned ones, then open jobs, then finished ones by day. (Jobs replace chats; a job opens on
// its thread, which is the chat it was.)
import type { Job, Session } from '@shared/types'
import { app, draftTitle } from './store.svelte'

export { draftTitle }

const DAY = 24 * 60 * 60 * 1000

/** A row: a job and its thread. */
export interface Entry {
  /** The thread's id, which drafts are kept under. */
  key: string
  title: string
  session: Session | null
  job: Job
  draft: boolean
}

export type Group = 'Drafts' | 'Pinned' | 'Open' | 'Today' | 'Yesterday' | 'This week' | 'Earlier'
export const GROUPS: Group[] = ['Drafts', 'Pinned', 'Open', 'Today', 'Yesterday', 'This week', 'Earlier']

export const entries = (): Entry[] => {
  const threads = new Map(app.sessions.map((s) => [s.id, s]))
  return app.jobs.flatMap((job) => {
    const session = job.threadId ? threads.get(job.threadId) : undefined
    return session ? [{ key: session.id, title: job.title, session, job, draft: app.hasDraft(session.id) }] : []
  })
}

export const groupOf = (e: Entry, today = new Date().setHours(0, 0, 0, 0)): Group => {
  if (e.draft) return 'Drafts'
  if (e.session?.pinnedAt != null) return 'Pinned'
  if (e.job.status === 'open') return 'Open'
  const at = e.job.updatedAt
  return at >= today ? 'Today' : at >= today - DAY ? 'Yesterday' : at >= today - 7 * DAY ? 'This week' : 'Earlier'
}

/** Every group with its rows, in order; empty groups left out. */
export const grouped = (list: Entry[]): Array<[Group, Entry[]]> => {
  const today = new Date().setHours(0, 0, 0, 0)
  const by = new Map<Group, Entry[]>(GROUPS.map((g) => [g, []]))
  for (const e of list) by.get(groupOf(e, today))!.push(e)
  const draftAt = (e: Entry) => app.drafts.get(e.key)?.at ?? Number.MAX_SAFE_INTEGER
  by.get('Drafts')!.sort((a, b) => draftAt(b) - draftAt(a))
  by.get('Pinned')!.sort((a, b) => a.session!.pinnedAt! - b.session!.pinnedAt!)
  return GROUPS.map((g) => [g, by.get(g)!] as [Group, Entry[]]).filter(([, rows]) => rows.length > 0)
}

/** Opens a row: its job's thread. */
export const openEntry = (e: Entry) => app.openJob(e.job)
