import { describe, expect, test } from 'bun:test'
import type { Job, ListedSession, ThreadState } from '../src/shared/types'
import { SETTLE_AFTER_MS, lastActive, sectionsOf, unread, type SectionEntry } from '../src/renderer/src/lib/sections'

const thread = (id: string, jobId: string, state: Partial<ThreadState> = {}, over: Partial<ListedSession> = {}): ListedSession => ({
  id,
  title: id,
  model: null,
  systemPrompt: null,
  rootId: `${id}-root`,
  forkedFromSessionId: null,
  computerMode: 'do',
  pinnedAt: null,
  createdAt: 0,
  updatedAt: 0,
  botId: 'tomo',
  jobId,
  kind: 'shared',
  state: { readAt: 100, activityAt: null, streaming: false, lastReply: 'complete', limitPaused: false, ...state },
  ...over
})

const job = (id: string, over: Partial<Job> = {}): Job => ({
  id,
  title: id,
  status: 'open',
  ownerBotId: 'tomo',
  parentJobId: null,
  summary: null,
  usage: null,
  createdAt: 0,
  updatedAt: 0,
  threadId: `t-${id}`,
  ...over
})

const entry = (j: Job, s: ListedSession, draft = false): SectionEntry => ({ key: s.id, job: j, session: s, draft })

/** The section of each job, by id, for a set of jobs and threads. */
const place = (rows: Array<[Job, ListedSession, boolean?]>, extra: ListedSession[] = [], opts: { openId?: string; waitingIn?: string } = {}) => {
  const threads = [...rows.map(([, s]) => s), ...extra]
  const out = sectionsOf({ entries: rows.map(([j, s, d]) => entry(j, s, d)), threads, openId: opts.openId ?? null, waitingIn: opts.waitingIn ?? null })
  const ids = (list: SectionEntry[]) => list.map((e) => e.job.id)
  return { pinned: ids(out.pinned), main: ids(out.main), working: ids(out.working), settled: ids(out.settled), needs: Object.fromEntries(out.needs) }
}

describe('sidebar sections', () => {
  test('a quiet job is settled, newest first, finished or not', () => {
    const a = job('a', { updatedAt: 1 })
    const b = job('b', { updatedAt: 3, status: 'done' })
    const c = job('c', { updatedAt: 2 })
    const out = place([
      [a, thread('t-a', 'a')],
      [b, thread('t-b', 'b')],
      [c, thread('t-c', 'c')]
    ])
    expect(out.settled).toEqual(['b', 'c', 'a'])
    expect(out.main).toEqual([])
    expect(out.working).toEqual([])
  })

  test("a reply running in the job's thread, or in one of its bots' threads, makes it working", () => {
    const a = job('a')
    const b = job('b')
    const out = place(
      [
        [a, thread('t-a', 'a', { streaming: true, lastReply: 'streaming' })],
        [b, thread('t-b', 'b')]
      ],
      [thread('w-b', 'b', { streaming: true, lastReply: 'streaming' }, { kind: 'worker', botId: 'scout' })]
    )
    expect(out.working).toEqual(['a', 'b'])
    expect(out.settled).toEqual([])
  })

  test('a reply that ended since the user last looked makes it unread, unless the thread is open', () => {
    const s = thread('t-a', 'a', { readAt: 100, activityAt: 200 })
    expect(unread(s)).toBe(true)
    expect(unread(s, 't-a')).toBe(false)
    expect(unread(thread('t-b', 'b', { readAt: 300, activityAt: 200 }))).toBe(false)
    expect(unread(thread('t-c', 'c', { readAt: null, activityAt: null }))).toBe(false)
    expect(place([[job('a'), s]]).main).toEqual(['a'])
    expect(place([[job('a'), s]], [], { openId: 't-a' }).settled).toEqual(['a'])
  })

  test('each need puts a job in the main section, and says which', () => {
    const out = place(
      [
        [job('wait'), thread('t-wait', 'wait')],
        [job('draft'), thread('t-draft', 'draft'), true],
        [job('paused'), thread('t-paused', 'paused', { lastReply: 'paused' })],
        [job('limit'), thread('t-limit', 'limit', { lastReply: 'stopped', limitPaused: true })],
        [job('failed'), thread('t-failed', 'failed', { lastReply: 'error' })],
        [job('stuck-worker'), thread('t-sw', 'stuck-worker')],
        [job('new'), thread('t-new', 'new', { activityAt: 500 })],
        [job('quiet'), thread('t-quiet', 'quiet', { lastReply: 'stopped' })]
      ],
      [thread('w-sw', 'stuck-worker', { lastReply: 'paused' }, { kind: 'worker' })],
      { waitingIn: 't-wait' }
    )
    expect(out.needs).toEqual({
      't-wait': 'waiting',
      't-draft': 'draft',
      't-paused': 'paused',
      't-limit': 'paused',
      't-failed': 'failed',
      't-sw': 'paused',
      't-new': 'unread'
    })
    expect(out.main[0]).toBe('wait')
    expect(out.settled).toEqual(['quiet'])
  })

  test('an approval waiting in a bot’s own thread puts its job in the main section', () => {
    const out = place([[job('a'), thread('t-a', 'a', { streaming: true })]], [thread('w-a', 'a', { streaming: true }, { kind: 'worker' })], { waitingIn: 'w-a' })
    expect(out.main).toEqual(['a'])
    expect(out.working).toEqual([])
  })

  test('a finished job needs the user only for a draft or an approval', () => {
    const done = { status: 'done' as const }
    const out = place([
      [job('a', done), thread('t-a', 'a', { lastReply: 'error', activityAt: 900 })],
      [job('b', done), thread('t-b', 'b'), true]
    ])
    expect(out.settled).toEqual(['a'])
    expect(out.main).toEqual(['b'])
  })

  test('pinned jobs are in order of pinning, and one that needs the user shows in the main section too', () => {
    const out = place([
      [job('p2'), thread('t-p2', 'p2', {}, { pinnedAt: 20 })],
      [job('p1'), thread('t-p1', 'p1', { activityAt: 500 }, { pinnedAt: 10 })],
      [job('p3'), thread('t-p3', 'p3', { streaming: true }, { pinnedAt: 30 })]
    ])
    expect(out.pinned).toEqual(['p1', 'p2', 'p3'])
    expect(out.main).toEqual(['p1'])
    expect(out.working).toEqual([])
    expect(out.settled).toEqual([])
  })

  test('once handled, a job moves on by itself: to Working while a reply runs, else to Settled', () => {
    const j = job('a')
    expect(place([[j, thread('t-a', 'a', { lastReply: 'paused' })]]).main).toEqual(['a'])
    expect(place([[j, thread('t-a', 'a', { lastReply: 'streaming', streaming: true })]]).working).toEqual(['a'])
    expect(place([[j, thread('t-a', 'a', { lastReply: 'complete', activityAt: 300, readAt: 400 })]]).settled).toEqual(['a'])
  })

  test('the main section has the newest first', () => {
    const out = place([
      [job('old', { updatedAt: 10 }), thread('t-old', 'old', { activityAt: 150 })],
      [job('fresh', { updatedAt: 10 }), thread('t-fresh', 'fresh', { activityAt: 400 })]
    ])
    expect(out.main).toEqual(['fresh', 'old'])
  })

  test('an open job stays in the main section until it has been quiet for an hour', () => {
    const now = 10 * SETTLE_AFTER_MS
    const at = (j: string, quiet: number, over: Partial<Job> = {}) => job(j, { updatedAt: now - quiet, ...over })
    const sectionsAt = (rows: Array<[Job, ListedSession]>, extra: ListedSession[] = []) => {
      const out = sectionsOf({ entries: rows.map(([j, s]) => entry(j, s)), threads: [...rows.map(([, s]) => s), ...extra], openId: null, waitingIn: null, now })
      return { main: out.main.map((e) => e.job.id), settled: out.settled.map((e) => e.job.id), needs: out.needs }
    }
    const out = sectionsAt(
      [
        [at('recent', 59 * 60_000), thread('t-recent', 'recent')],
        [at('quiet', SETTLE_AFTER_MS), thread('t-quiet', 'quiet')],
        // Finished by the user: settled at once.
        [at('finished', 60_000, { status: 'done' }), thread('t-finished', 'finished')],
        // Quiet itself, but one of its bots' threads was busy a minute ago.
        [at('helped', 3 * SETTLE_AFTER_MS), thread('t-helped', 'helped')]
      ],
      [thread('w-helped', 'helped', { readAt: now, activityAt: now - 60_000 }, { kind: 'worker', botId: 'scout' })]
    )
    expect(out.main).toEqual(['recent', 'helped'])
    expect(out.settled).toEqual(['finished', 'quiet'])
    // In the main section for being recent, not for needing anything: no badge.
    expect(out.needs.size).toBe(0)
    expect(lastActive(at('x', 5), [thread('t-x', 'x', {}, { updatedAt: now })])).toBe(now)
  })
})
