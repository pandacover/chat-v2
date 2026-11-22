// The job list, as the sidebar and the search modal both show it: pinned jobs, the jobs that need
// the user, the ones a reply runs in (Working), and the rest (Settled). See sections.ts. (Jobs
// replace chats; a job opens on its thread, which is the chat it was.)
import type { Job, ListedSession } from '@shared/types'
import { sectionsOf, type Need, type Sections } from './sections'
import { app, draftTitle } from './store.svelte'

export { draftTitle }
export type { Need }

/** A row: a job and its thread. */
export interface Entry {
  /** The thread's id, which drafts are kept under. */
  key: string
  title: string
  session: ListedSession
  job: Job
  draft: boolean
}

export const entries = (): Entry[] => {
  const threads = new Map(app.sessions.map((s) => [s.id, s]))
  return app.jobs.flatMap((job) => {
    const session = job.threadId ? threads.get(job.threadId) : undefined
    return session ? [{ key: session.id, title: job.title, session, job, draft: app.hasDraft(session.id) }] : []
  })
}

/** The list in its sections, with why each job in the main section needs the user. */
export const sections = (list: Entry[] = entries()): Sections<Entry> & { needs: Map<string, Need> } =>
  sectionsOf({
    entries: list,
    threads: app.sessions,
    openId: app.view?.session.id ?? null,
    waitingIn: app.computerWait?.sessionId ?? null,
    draftAt: (key) => app.drafts.get(key)?.at
  })

/** What a need reads as, for a row's badge and the search modal. */
export const NEED_LABELS: Record<Need, string> = {
  waiting: 'Needs your OK',
  draft: 'Unsent draft',
  paused: 'Paused',
  failed: 'Failed',
  unread: 'New'
}

/** Opens a row: its job's thread. */
export const openEntry = (e: Entry) => app.openJob(e.job)
