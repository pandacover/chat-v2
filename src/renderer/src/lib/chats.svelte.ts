// The chat list, as the sidebar and the search modal both show it: saved chats, and the new chat
// while it has a draft, grouped as unsent drafts first, then pinned, then by day.
import type { Session } from '@shared/types'
import { app, draftTitle } from './store.svelte'

export { draftTitle }

const DAY = 24 * 60 * 60 * 1000

/** A row: a saved chat, or (session null) the new chat while it has a draft. */
export interface Entry {
  key: string
  title: string
  session: Session | null
  draft: boolean
}

export type Group = 'Drafts' | 'Pinned' | 'Today' | 'Yesterday' | 'This week' | 'Earlier'
export const GROUPS: Group[] = ['Drafts', 'Pinned', 'Today', 'Yesterday', 'This week', 'Earlier']

export const entries = (): Entry[] => {
  const list: Entry[] = app.sessions.map((s) => ({ key: s.id, title: s.title, session: s, draft: app.hasDraft(s.id) }))
  if (app.hasDraft('')) list.push({ key: '', title: draftTitle(app.draftText('')), session: null, draft: true })
  return list
}

export const groupOf = (e: Entry, today = new Date().setHours(0, 0, 0, 0)): Group => {
  if (e.draft || !e.session) return 'Drafts'
  if (e.session.pinnedAt != null) return 'Pinned'
  const at = e.session.updatedAt
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

/** Opens a row: a saved chat, or the new chat. */
export const openEntry = (e: Entry) => (e.session ? app.open(e.session.id) : app.newSession())
