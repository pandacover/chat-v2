// The daily reconciler: long-term memory's second writer, beside the per-message extractor.
//
// When the app is idle, at most once a day, it reads the jobs finished since it last looked (each
// one's archive summary, its notes, and the user's side of its thread, where corrections show) with
// the profile and the bots' playbooks, and asks the memory model for changes: condense records,
// turn repeated examples into one trait, write dated corrections, add lessons to a bot's playbook,
// and prune what is stale, duplicated or superseded. Everything here is pure: the prompt, reading
// and checking the reply (every change must cite the jobs it came from and be grounded in them),
// the conflict rule, and when a run is due. services/Reconciler.ts calls the model and saves the plan
// through memoryStore.reconcile, as one revision written by 'reconciler'.
import type { MemoryRecord, MemoryRecordType, MemoryScope } from '@shared/types'
import { grounded, isSensitive, plainBody } from './memory'
import { MEMORY_LIMIT, sameText } from './services/memoryStore'

/** Live lessons one bot's playbook may hold. */
export const PLAYBOOK_LIMIT = 40
/** Jobs one run reads, newest first; the rest wait for the next run. */
export const JOBS_PER_RUN = 8
/** Changes one run may make; more means the model is rewriting, not reconciling. */
export const MAX_CHANGES = 30
const TEXT_CHARS = 240
const NAME_CHARS = 60

/** How long the app must have had no messages before a run. */
export const IDLE_MS = 10 * 60_000
/** At most one run a day. */
export const DAY_MS = 24 * 60 * 60_000
/** After a failed run, how long until the next try. */
export const RETRY_MS = 2 * 60 * 60_000
/** No run this soon after the app starts: startup is busy, and the user is likely about to type. */
export const STARTUP_GRACE_MS = 3 * 60_000

/** One finished job, as the reconciler reads it. */
export interface ReconcileJob {
  id: string
  title: string
  /** The bot that owns it, whose playbook its lessons go in. */
  botId: string | null
  botName: string
  /** The job's thread, which versions it gives rise to point at. */
  threadId: string | null
  finishedAt: number
  /** Its archive record, or its one-line summary. */
  summary: string | null
  notes: Array<{ kind: string; title: string; body: string }>
  /** The end of its thread: what the user said (in full) and the start of each reply. */
  turns: Array<{ role: 'user' | 'assistant'; text: string }>
}

export interface ReconcileInput {
  now: number
  jobs: ReconcileJob[]
  /** The profile now. */
  profile: MemoryRecord[]
  /** Each bot's playbook now. */
  playbooks: Array<{ botId: string; botName: string; records: MemoryRecord[] }>
}

/** A record to write: a new version of `id` (when its body is still `base`), or a new record. */
export interface PlanPut {
  id?: number
  /** The body the plan was made from; the write is skipped if the record changed meanwhile. */
  base?: string
  body: string
  type?: MemoryRecordType
  title?: string
  scope: Extract<MemoryScope, 'profile' | 'bot'>
  scopeId: string | null
  /** The job the version comes from, and that job's thread. */
  jobId: string
  sessionId: string | null
}

export interface PlanClose {
  id: number
  base: string
}

/** One change, saved whole or not at all (a merge's hidden records go only with its new version). */
export interface PlanChange {
  puts: PlanPut[]
  closes: PlanClose[]
  /** What it does, in a few words. */
  what: string
}

export interface ReconcilePlan {
  changes: PlanChange[]
}

export interface ReconcileReading {
  plan: ReconcilePlan
  /** Changes left out, and why (never their text: some may be sensitive). */
  dropped: string[]
}

export const RECONCILER_INSTRUCTIONS = `You tidy the long-term memory of a desktop assistant app once a day. You get the user's profile (facts every bot knows about the user), each bot's playbook (lessons for that bot and the user's corrections of it), every record with its number, and the jobs the user finished since the last review, each with its number, its bot, its summary, its notes and the end of its thread.

Make memory more useful from what those jobs show:
- condense: merge records that say the same thing, or several examples of one habit, into one record that states the trait ("merge").
- correct: when a job shows a record is wrong or out of date (most often the user correcting the bot), rewrite it ("update" with "correction": true).
- learn: add a lesson to the playbook of the job's bot when the user corrected how it works or a way of working clearly paid off; add a fact to the profile when a job shows something lasting about the user ("add").
- prune: remove records that are stale, duplicated or superseded ("remove").
- conflicts: when a profile fact and a playbook lesson disagree, say which is more useful to keep ("conflict", "keep"); when they contradict outright, say so ("contradiction": true) and give the corrected text for the older one.

Every change must name the jobs (by number) it comes from in "jobs", and say only what those jobs or the records you change say. Never guess or fill in details. Never record passwords, keys, account or card numbers. Most days only a few changes are worth making; when nothing is, reply {"changes": []}.

Reply with JSON only, in this shape:
{"changes": [
  {"op": "add", "to": "profile" or "playbook", "text": "<one short sentence>", "type": "preference" | "person" | "project" | "procedure", "title": "<name, only for a named person, pet or project>", "jobs": [<job numbers>]},
  {"op": "update", "id": <record number>, "text": "<the record rewritten>", "correction": true or false, "jobs": [...]},
  {"op": "merge", "ids": [<record numbers in one list>], "text": "<the one record they become>", "jobs": [...]},
  {"op": "remove", "id": <record number>, "reason": "stale" | "duplicate" | "superseded", "of": <the record it duplicates, for "duplicate">, "jobs": [...]},
  {"op": "conflict", "profile": <profile record number>, "playbook": <playbook record number>, "contradiction": true or false, "keep": "profile" or "playbook", "correction": "<the older one, corrected>", "jobs": [...]}
]}
Write profile facts as a sentence about the user that starts with a verb ("Prefers", "Works", "Has"), never with "The user". Write playbook lessons as an instruction to the bot ("Ask before…", "Use…").`

/** The local date of `at`, as YYYY-MM-DD: the day the user would say it happened. */
const day = (at: number) => {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text)
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** The reconciler's user turn. Records keep their own ids; jobs are numbered from 1. */
export const reconcilePrompt = (input: ReconcileInput): string => {
  const record = (r: MemoryRecord) => `${r.id}. [${r.type}] ${r.title ? `${r.title}: ` : ''}${oneLine(plainBody(r.body))} (${day(r.updatedAt)})`
  const profile = input.profile.length ? input.profile.map(record).join('\n') : '(empty)'
  const playbooks = input.playbooks.map((p) => `Playbook of ${p.botName}:\n${p.records.length ? p.records.map(record).join('\n') : '(empty)'}`).join('\n\n')
  const jobs = input.jobs
    .map((j, i) => {
      const parts = [`<job n="${i + 1}" bot="${j.botName}" finished="${day(j.finishedAt)}">`, `Title: ${oneLine(j.title)}`]
      if (j.summary) parts.push(`Summary: ${oneLine(j.summary)}`)
      if (j.notes.length) parts.push(`Notes:\n${j.notes.map((n) => `- ${n.kind}${n.title ? ` (${oneLine(n.title)})` : ''}: ${oneLine(n.body)}`).join('\n')}`)
      if (j.turns.length) parts.push(`Thread (end):\n${j.turns.map((t) => `${t.role === 'user' ? 'User' : j.botName}: ${t.text}`).join('\n')}`)
      parts.push('</job>')
      return parts.join('\n')
    })
    .join('\n\n')
  return `Today is ${day(input.now)}.\n\nProfile:\n${profile}\n\n${playbooks}\n\nFinished jobs:\n${jobs}`
}

/** All a job says, which a change citing it may draw on. */
export const jobText = (j: ReconcileJob) =>
  [j.title, j.summary ?? '', ...j.notes.flatMap((n) => [n.title, n.body]), ...j.turns.map((t) => t.text), j.botName].join('\n')

/** A record's text with the day it was corrected: the old one stays in its history. */
export const datedCorrection = (text: string, now: number) => `${text.replace(/[.!]+$/, '')} (corrected ${day(now)}).`

/** Strips a date an earlier correction added, so a record corrected twice has one. */
const undated = (text: string) => text.replace(/\s*\(corrected \d{4}-\d{2}-\d{2}\)\.?$/, '')

const cleanText = (raw: unknown, scope: 'profile' | 'bot'): string | null => {
  if (typeof raw !== 'string') return null
  let text = undated(oneLine(raw))
  if (scope === 'profile') text = text.replace(/^(?:the\s+)?user(?:['’]s)?\s+/i, '')
  text = text.charAt(0).toUpperCase() + text.slice(1)
  if (text.length < 3) return null
  text = clip(text, TEXT_CHARS)
  return /[.!?…]$/.test(text) ? text : `${text}.`
}

/**
 * Which of two disagreeing records stays, and what happens to the other. A plain disagreement
 * keeps the more useful one (the model's call) and prunes the other; an outright contradiction is
 * settled by time: the newer wins and the older gets a dated correction.
 */
export const resolveConflict = <R extends { id: number; updatedAt: number }>(
  a: R,
  b: R,
  how: { contradiction: boolean; keep: 'a' | 'b' | null }
): { winner: R; loser: R; action: 'correct' | 'prune' } | null => {
  if (how.contradiction) {
    // Same moment: the higher id was written later.
    const aNewer = a.updatedAt > b.updatedAt || (a.updatedAt === b.updatedAt && a.id > b.id)
    return aNewer ? { winner: a, loser: b, action: 'correct' } : { winner: b, loser: a, action: 'correct' }
  }
  if (how.keep === 'a') return { winner: a, loser: b, action: 'prune' }
  if (how.keep === 'b') return { winner: b, loser: a, action: 'prune' }
  return null
}

const TYPES: readonly MemoryRecordType[] = ['preference', 'person', 'project', 'procedure']

/**
 * Reads the reconciler's reply into a plan, keeping only changes it can stand behind: each must
 * cite at least one job it was shown, touch only profile and playbook records it was shown (and each
 * only once), say nothing secret, and name nothing (people, places, numbers) that isn't in the jobs
 * it cites or the records it changes. A playbook lesson goes to the bot whose jobs it cites. Returns
 * null when the reply has no JSON.
 */
export const parseReconcileReply = (reply: string, input: ReconcileInput): ReconcileReading | null => {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let data: { changes?: unknown }
  try {
    const parsed = JSON.parse(reply.slice(start, end + 1)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    data = parsed as { changes?: unknown }
  } catch {
    return null
  }
  const proposed: unknown[] = Array.isArray(data.changes) ? data.changes.slice(0, MAX_CHANGES * 2) : []
  const records = new Map<number, MemoryRecord>()
  for (const r of input.profile) records.set(r.id, r)
  for (const p of input.playbooks) for (const r of p.records) records.set(r.id, r)
  const botNames = new Map(input.playbooks.map((p) => [p.botId, p.botName]))
  for (const j of input.jobs) if (j.botId && !botNames.has(j.botId)) botNames.set(j.botId, j.botName)

  const changes: PlanChange[] = []
  const keep = (what: string, puts: PlanPut[], closes: PlanClose[] = []) => void changes.push({ puts, closes, what })
  const dropped: string[] = []
  const touched = new Set<number>()
  const live = (scope: 'profile' | 'bot', scopeId: string | null) =>
    [...records.values()].filter((r) => r.scope === scope && r.scopeId === scopeId && !touched.has(r.id))
  const added = { profile: 0, bot: new Map<string, number>() }

  const num = (v: unknown) => {
    const n = typeof v === 'string' ? Number(v.replace(/^[A-Za-z#]+/, '')) : v
    return typeof n === 'number' && Number.isInteger(n) ? n : null
  }
  const recordOf = (v: unknown) => {
    const id = num(v)
    const r = id === null ? undefined : records.get(id)
    return r && !touched.has(r.id) ? r : undefined
  }
  const scopeOf = (r: MemoryRecord): 'profile' | 'bot' => (r.scope === 'bot' ? 'bot' : 'profile')
  const describe = (r: MemoryRecord) => (r.scope === 'bot' ? `${botNames.get(r.scopeId ?? '') ?? 'a bot'}'s playbook` : 'the profile')

  for (const raw of proposed) {
    if (changes.length >= MAX_CHANGES) {
      dropped.push('Past the most changes one review may make')
      break
    }
    if (!raw || typeof raw !== 'object') continue
    const c = raw as Record<string, unknown>
    const op = typeof c.op === 'string' ? c.op : ''
    const cited = [...new Set((Array.isArray(c.jobs) ? c.jobs : [c.jobs]).map(num).filter((n): n is number => n !== null))]
      .map((n) => input.jobs[n - 1])
      .filter((j): j is ReconcileJob => !!j)
    if (cited.length === 0) {
      dropped.push(`A change (${op || 'unknown'}) that names no job it was shown`)
      continue
    }
    const source = cited.map(jobText).join('\n')
    const from = { jobId: cited[0]!.id, sessionId: cited[0]!.threadId }
    /** Text for `scope`, grounded in the cited jobs and `also` (the records it rewrites); null with why dropped. */
    const text = (rawText: unknown, scope: 'profile' | 'bot', also: string[] = []): string | null => {
      const t = cleanText(rawText, scope)
      const why =
        typeof rawText === 'string' && isSensitive(rawText)
          ? 'A change that looked like a password, key or account number'
          : !t
            ? `A change (${op}) with no text`
            : !grounded(t, [source, ...also].join('\n'))
              ? `A change (${op}) naming things its jobs don't mention`
              : null
      if (why) dropped.push(why)
      return why ? null : t
    }

    if (op === 'add') {
      const scope: 'profile' | 'bot' = c.to === 'playbook' || c.to === 'bot' ? 'bot' : 'profile'
      let scopeId: string | null = null
      if (scope === 'bot') {
        const bots = new Set(cited.map((j) => j.botId))
        if (bots.size !== 1 || !cited[0]!.botId) {
          dropped.push('A playbook lesson citing jobs of more than one bot, or of none')
          continue
        }
        scopeId = cited[0]!.botId
      }
      const t = text(c.text, scope)
      if (!t) continue
      if (live(scope, scopeId).some((r) => sameText(r.body, t)) || changes.some((x) => x.puts.some((p) => p.scope === scope && p.scopeId === scopeId && sameText(p.body, t)))) {
        dropped.push('An addition memory already has')
        continue
      }
      const count = scope === 'profile' ? added.profile : (added.bot.get(scopeId!) ?? 0)
      const limit = scope === 'profile' ? MEMORY_LIMIT : PLAYBOOK_LIMIT
      if (live(scope, scopeId).length + count >= limit) {
        dropped.push(`An addition past the limit of ${limit} records`)
        continue
      }
      if (scope === 'profile') added.profile++
      else added.bot.set(scopeId!, count + 1)
      const title = typeof c.title === 'string' ? oneLine(c.title).replace(/[.!?]+$/, '') : ''
      const named = title && title.length <= NAME_CHARS && !isSensitive(title) && source.toLowerCase().includes(title.toLowerCase()) ? title : ''
      const type = TYPES.find((x) => x === c.type) ?? (scope === 'bot' ? 'procedure' : 'person')
      keep(`Added to ${scope === 'bot' ? `${botNames.get(scopeId!) ?? 'a bot'}'s playbook` : 'the profile'}`, [{ body: t, type, ...(named ? { title: named } : {}), scope, scopeId, ...from }])
      continue
    }

    if (op === 'update') {
      const r = recordOf(c.id)
      if (!r) {
        dropped.push('An update of a record it was not shown, or one already changed')
        continue
      }
      const t = text(c.text, scopeOf(r), [r.body, r.title])
      if (!t) continue
      const body = c.correction === true ? datedCorrection(t, input.now) : t
      if (sameText(undated(r.body), t)) {
        dropped.push('An update that changes nothing')
        continue
      }
      touched.add(r.id)
      keep(`${c.correction === true ? 'Corrected' : 'Rewrote'} a record in ${describe(r)}`, [{ id: r.id, base: r.body, body, scope: scopeOf(r), scopeId: r.scopeId, ...from }])
      continue
    }

    if (op === 'merge') {
      const ids = [...new Set((Array.isArray(c.ids) ? c.ids : []).map(num).filter((n): n is number => n !== null))]
      const list = ids.map((id) => records.get(id))
      if (list.length < 2 || list.some((r) => !r || touched.has(r.id))) {
        dropped.push('A merge of fewer than two records it was shown, or of one already changed')
        continue
      }
      const rs = list as MemoryRecord[]
      if (new Set(rs.map((r) => `${r.scope}:${r.scopeId}`)).size !== 1) {
        dropped.push('A merge across the profile and a playbook (that is a conflict)')
        continue
      }
      const t = text(c.text, scopeOf(rs[0]!), rs.flatMap((r) => [r.body, r.title]))
      if (!t) continue
      // The oldest record carries on under its id, so its history reads through; the rest are hidden.
      const [first, ...rest] = [...rs].sort((a, b) => a.id - b.id)
      for (const r of rs) touched.add(r.id)
      keep(
        `Merged ${rs.length} records in ${describe(first!)} into one`,
        [{ id: first!.id, base: first!.body, body: t, scope: scopeOf(first!), scopeId: first!.scopeId, ...from }],
        rest.map((r) => ({ id: r.id, base: r.body }))
      )
      continue
    }

    if (op === 'remove') {
      const r = recordOf(c.id)
      const reason = c.reason === 'stale' || c.reason === 'duplicate' || c.reason === 'superseded' ? c.reason : null
      if (!r || !reason) {
        dropped.push('A removal of a record it was not shown, or without a reason')
        continue
      }
      if (reason === 'duplicate') {
        const of = recordOf(c.of)
        if (!of || of.id === r.id || of.scope !== r.scope || of.scopeId !== r.scopeId) {
          dropped.push('A duplicate removal that names no live record in the same list')
          continue
        }
      }
      touched.add(r.id)
      keep(`Removed a ${reason} record from ${describe(r)}`, [], [{ id: r.id, base: r.body }])
      continue
    }

    if (op === 'conflict') {
      const p = recordOf(c.profile)
      const b = recordOf(c.playbook)
      if (!p || !b || p.scope !== 'profile' || b.scope !== 'bot') {
        dropped.push('A conflict that is not between a profile record and a playbook record it was shown')
        continue
      }
      const which = c.keep === 'profile' ? 'a' : c.keep === 'playbook' ? 'b' : null
      const outcome = resolveConflict(p, b, { contradiction: c.contradiction === true, keep: which })
      if (!outcome) {
        dropped.push('A conflict that says neither which to keep nor that they contradict')
        continue
      }
      const { winner, loser, action } = outcome
      if (action === 'prune') {
        touched.add(loser.id)
        keep('Kept the more useful of a profile fact and a playbook lesson', [], [{ id: loser.id, base: loser.body }])
        continue
      }
      // The older one is corrected, dated, to agree with the newer; without a usable correction it says what the newer does.
      const offered = typeof c.correction === 'string' && c.correction.trim() !== ''
      const given = offered ? text(c.correction, scopeOf(loser), [winner.body, loser.body]) : null
      if (offered && given === null) continue
      const t = given ?? cleanText(plainBody(winner.body), scopeOf(loser))
      if (!t) continue
      touched.add(winner.id)
      touched.add(loser.id)
      // The newer one stays as it is, but this run settles it: nothing else may change it.
      keep('Corrected the older of a profile fact and a playbook lesson that contradicted', [
        { id: loser.id, base: loser.body, body: datedCorrection(t, input.now), scope: scopeOf(loser), scopeId: loser.scopeId, ...from }
      ])
      continue
    }

    dropped.push(`A change of an unknown kind (${op || 'none'})`)
  }
  return { plan: { changes }, dropped }
}

export interface Schedule {
  now: number
  /** When the app started. */
  startedAt: number
  memoryOn: boolean
  /** A reply is streaming, or a run is under way. */
  busy: boolean
  /** When the last message (from anyone) was written; null for none. */
  lastActivityAt: number | null
  /** The last run, scheduled or not. */
  lastRun: { startedAt: number; outcome: string } | null
  /** Finished jobs it hasn't read. */
  pending: number
}

/**
 * Whether a scheduled run is due: memory on, nothing running, the app idle for IDLE_MS (and not just
 * started), something new to read, and no run in the last day (or, after a failure, RETRY_MS).
 */
export const dueToRun = (s: Schedule): { due: true } | { due: false; why: string } => {
  if (!s.memoryOn) return { due: false, why: 'memory is off' }
  if (s.busy) return { due: false, why: 'busy' }
  if (s.now - s.startedAt < STARTUP_GRACE_MS) return { due: false, why: 'just started' }
  if (s.lastActivityAt !== null && s.now - s.lastActivityAt < IDLE_MS) return { due: false, why: 'not idle' }
  if (s.lastRun) {
    const failed = s.lastRun.outcome === 'error' || s.lastRun.outcome === 'unreadable'
    const wait = failed ? RETRY_MS : DAY_MS
    if (s.now - s.lastRun.startedAt < wait) return { due: false, why: failed ? 'retrying later' : 'ran today' }
  }
  if (s.pending === 0) return { due: false, why: 'nothing new' }
  return { due: true }
}

/** A bot's playbook for its prompt, after the profile. Loaded when a job's thread starts, like the profile. */
export const playbookBlock = (records: readonly Pick<MemoryRecord, 'body' | 'title'>[]) =>
  records.length === 0
    ? ''
    : `Your playbook: lessons from your earlier jobs and the user's corrections of how you work. Follow them unless the user asks otherwise now:\n${records
        .map((r) => `- ${r.title ? `${r.title}: ` : ''}${plainBody(r.body)}`)
        .join('\n')}`
