// Memory records, versioned in SQLite: append-only, not git.
//
// A record (memory_records) has a stable id, a type, a title, aliases and a scope: the user's
// profile, one bot's playbook, one job's notes, or the archive. What it says lives in its versions
// (memory_versions): a version is current from the revision that added it until the one that
// replaced or hid it, so any earlier profile can be read back and restored, under the same ids.
// Each version says who wrote it and the job or chat it came from. Rows are never rewritten,
// except by purge, which deletes a record and all its versions for good.
//
// memory_search is an FTS5 index over each record's title, aliases and current version, kept in
// step by triggers, which `recall` searches. Hidden records (no current version) aren't in it.
import type { SQLInputValue, StatementSync } from 'node:sqlite'
import type { JobNoteKind, MemoryRecord, MemoryRecordType, MemoryRevision, MemoryScope, MemoryVersion, MemoryWriter } from '@shared/types'
import type { ReconcilePlan } from '../reconciler'

/** At most this many profile records are live; past it, new ones are dropped until some go. */
export const MEMORY_LIMIT = 150
/** Notes one job may keep; a bot that writes more is told to fold them into fewer. */
export const JOB_NOTE_LIMIT = 200

/**
 * Turns memory_facts into records. Every fact, live or not, becomes a profile record with one
 * version under the fact's own id, so the history and every earlier profile read back as before.
 * Appended to Db's MIGRATIONS: never edit it once released, add a migration instead.
 */
export const MEMORY_RECORDS_MIGRATION = `
  alter table memory_revisions add column writer text not null default 'user';
  update memory_revisions set writer = 'extractor' where kind = 'learned';
  create table memory_records (
    id integer primary key autoincrement,
    type text not null,
    title text not null default '',
    aliases text not null default '[]',
    scope text not null,
    scope_id text,
    created_at integer not null
  );
  create index memory_records_scope on memory_records(scope, scope_id);
  create table memory_versions (
    id integer primary key autoincrement,
    record_id integer not null references memory_records(id) on delete cascade,
    body text not null,
    added_rev integer not null,
    removed_rev integer,
    writer text not null,
    source_job_id text,
    source_session_id text,
    created_at integer not null
  );
  create index memory_versions_record on memory_versions(record_id);
  create index memory_versions_added on memory_versions(added_rev);
  create index memory_versions_removed on memory_versions(removed_rev);
  create table memory_links (
    from_record integer not null references memory_records(id) on delete cascade,
    to_record integer not null references memory_records(id) on delete cascade,
    primary key (from_record, to_record)
  ) without rowid;
  create index memory_links_to on memory_links(to_record);
  create view memory_current as
    select r.id, r.type, r.title, r.aliases, r.scope, r.scope_id, r.created_at,
           v.id as version_id, v.body, v.writer, v.source_job_id, v.source_session_id, v.created_at as updated_at
      from memory_records r join memory_versions v on v.record_id = r.id and v.removed_rev is null;
  create virtual table memory_search using fts5(title, aliases, body, tokenize = 'unicode61 remove_diacritics 2');
  create trigger memory_versions_added after insert on memory_versions begin
    delete from memory_search where rowid = new.record_id;
    insert into memory_search (rowid, title, aliases, body)
      select id, title, (select group_concat(value, ' ') from json_each(memory_current.aliases)), body from memory_current where id = new.record_id;
  end;
  create trigger memory_versions_closed after update of removed_rev on memory_versions begin
    delete from memory_search where rowid = new.record_id;
    insert into memory_search (rowid, title, aliases, body)
      select id, title, (select group_concat(value, ' ') from json_each(memory_current.aliases)), body from memory_current where id = new.record_id;
  end;
  create trigger memory_records_renamed after update of title, aliases on memory_records begin
    delete from memory_search where rowid = new.id;
    insert into memory_search (rowid, title, aliases, body)
      select id, title, (select group_concat(value, ' ') from json_each(memory_current.aliases)), body from memory_current where id = new.id;
  end;
  create trigger memory_records_deleted after delete on memory_records begin
    delete from memory_search where rowid = old.id;
  end;
  insert into memory_records (id, type, title, aliases, scope, scope_id, created_at)
    select id, 'person', '', '[]', 'profile', null, created_at from memory_facts;
  insert into memory_versions (record_id, body, added_rev, removed_rev, writer, source_job_id, source_session_id, created_at)
    select f.id, f.fact, f.added_rev, f.removed_rev, coalesce(r.writer, 'user'), null, r.session_id, f.created_at
      from memory_facts f left join memory_revisions r on r.rev = f.added_rev order by f.id;
  drop table memory_facts;`

/** A fact for the profile; a plain string is a fact with no title. */
export type NewFact = string | { fact: string; type?: MemoryRecordType; title?: string; aliases?: string[] }

/** Changes to the profile; `update` and `remove` refer to record ids. */
export interface MemoryChange {
  add: NewFact[]
  update: Array<{ id: number; fact: string }>
  remove: number[]
}

/** Where a change came from. The writer defaults to the extractor for 'learned', else the user. */
export interface MemoryOrigin {
  kind: MemoryRevision['kind']
  writer?: MemoryWriter
  sessionId?: string | null
  jobId?: string | null
  note?: string | null
}

/** A record `recall` found. */
export interface RecallHit {
  id: number
  scope: MemoryScope
  scopeId: string | null
  type: string
  title: string
  aliases: string[]
  body: string
  updatedAt: number
  sourceSessionId: string | null
}

export interface RecallScope {
  /** Also search this bot's playbook. */
  botId?: string | null
  /** Also search this job's notes. */
  jobId?: string | null
  limit?: number
}

/** Kinds of job note there is one of per job, rewritten in place; the others pile up. */
export const SINGLE_NOTES: readonly JobNoteKind[] = ['state', 'left', 'files']
export const NOTE_KINDS: readonly JobNoteKind[] = ['decision', 'state', 'left', 'files', 'progress']

export interface SqlHelpers {
  all: <T>(sql: string, ...params: SQLInputValue[]) => T[]
  one: <T>(sql: string, ...params: SQLInputValue[]) => T | undefined
  run: (sql: string, ...params: SQLInputValue[]) => ReturnType<StatementSync['run']>
  transaction: <A>(f: () => A) => A
  exec: (sql: string) => void
}

const FOREVER = Number.MAX_SAFE_INTEGER

/** Two texts that differ only in case or a final full stop say the same thing. */
export const sameText = (a: string, b: string) => textKey(a) === textKey(b)
const textKey = (text: string) => text.trim().toLowerCase().replace(/[.!]+$/, '')

const LINK = /\[\[([^[\]\n]{1,80})\]\]/g
/** The names a body links to, written [[like this]]. */
export const linkNames = (body: string) => [...body.matchAll(LINK)].map((m) => m[1]!.trim()).filter(Boolean)

/**
 * The FTS5 query for what an agent asked: each word as a quoted term (so nothing it writes is
 * read as query syntax), words of three letters or more as prefixes too ("cat" finds "cats"),
 * any of them matching; bm25 ranks records that match more of them first. Null for no words.
 */
export const ftsQuery = (text: string): string | null => {
  const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 16)
  if (words.length === 0) return null
  return words.map((w) => (w.length >= 3 ? `"${w}"*` : `"${w}"`)).join(' OR ')
}

interface CurrentRow {
  id: number
  type: string
  title: string
  aliases: string
  scope: string
  scope_id: string | null
  created_at: number
  body: string
  writer: string
  source_job_id: string | null
  source_session_id: string | null
  updated_at: number
  versions: number
}

const COLUMNS = `r.id, r.type, r.title, r.aliases, r.scope, r.scope_id, r.created_at, v.body, v.writer,
  v.source_job_id, v.source_session_id, v.created_at as updated_at,
  (select count(*) from memory_versions w where w.record_id = r.id) as versions`

const parseAliases = (raw: string): string[] => {
  try {
    const list = JSON.parse(raw) as unknown
    return Array.isArray(list) ? list.filter((a): a is string => typeof a === 'string') : []
  } catch {
    return []
  }
}

/** One record to write: a new version of `id`, or a new record without one. */
interface Put {
  id?: number
  body: string
  type?: string
  title?: string
  aliases?: string[]
  scope?: MemoryScope
  scopeId?: string | null
  /** The source to record instead of the change's (a restore keeps the original's). */
  source?: { jobId: string | null; sessionId: string | null }
}

export const makeMemoryStore = ({ all, one, run, transaction, exec }: SqlHelpers) => {
  const toRecords = (rows: CurrentRow[]): MemoryRecord[] => {
    const links = new Map<number, Array<{ id: number; title: string }>>()
    if (rows.length > 0) {
      for (const l of all<{ from_record: number; to_record: number; title: string; body: string | null }>(
        `select l.from_record, l.to_record, r.title, c.body from memory_links l
           join memory_records r on r.id = l.to_record left join memory_current c on c.id = l.to_record
          where l.from_record in (select value from json_each(?))`,
        JSON.stringify(rows.map((r) => r.id))
      )) {
        const list = links.get(l.from_record) ?? []
        list.push({ id: l.to_record, title: l.title || (l.body ?? '') })
        links.set(l.from_record, list)
      }
    }
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      aliases: parseAliases(r.aliases),
      scope: r.scope as MemoryScope,
      scopeId: r.scope_id,
      body: r.body,
      links: links.get(r.id) ?? [],
      versions: r.versions,
      writer: r.writer as MemoryWriter,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }))
  }

  const rowsAt = (scope: MemoryScope, scopeId: string | null, rev: number) =>
    all<CurrentRow>(
      `select ${COLUMNS} from memory_records r join memory_versions v on v.record_id = r.id
        where r.scope = ? and r.scope_id is ? and v.added_rev <= ? and (v.removed_rev is null or v.removed_rev > ?)
        order by r.id`,
      scope,
      scopeId,
      rev,
      rev
    )

  /** The records in a scope now, or as they were at revision `rev`. */
  const records = (scope: MemoryScope = 'profile', scopeId: string | null = null, rev = FOREVER): MemoryRecord[] =>
    toRecords(rowsAt(scope, scopeId, rev))

  /** The profile now, or as it was at revision `rev`. */
  const profile = (rev?: number) => records('profile', null, rev)

  /** One record as it is now; undefined when it is hidden or gone. */
  const getRecord = (id: number): MemoryRecord | undefined => {
    const row = one<CurrentRow>(`select ${COLUMNS} from memory_records r join memory_versions v on v.record_id = r.id and v.removed_rev is null where r.id = ?`, id)
    return row ? toRecords([row])[0] : undefined
  }

  const memoryRev = (): number => one<{ rev: number | null }>('select max(rev) as rev from memory_revisions')?.rev ?? 0

  const writerOf = (o: MemoryOrigin): MemoryWriter => o.writer ?? (o.kind === 'learned' ? 'extractor' : 'user')

  const revision = (o: MemoryOrigin) =>
    Number(
      run(
        'insert into memory_revisions (kind, writer, session_id, note, created_at) values (?, ?, ?, ?, ?)',
        o.kind,
        writerOf(o),
        o.sessionId ?? null,
        o.note ?? null,
        Date.now()
      ).lastInsertRowid
    )

  const close = (recordId: number, rev: number) =>
    run('update memory_versions set removed_rev = ? where record_id = ? and removed_rev is null', rev, recordId)

  /** Points a record's [[links]] at the records they name: in its own scope, or the profile. */
  const relink = (recordId: number) => {
    run('delete from memory_links where from_record = ?', recordId)
    const r = one<{ scope: string; scope_id: string | null; body: string }>('select scope, scope_id, body from memory_current where id = ?', recordId)
    const names = new Set(linkNames(r?.body ?? '').map((n) => n.toLowerCase()))
    if (!r || names.size === 0) return
    const candidates = all<{ id: number; title: string; aliases: string; scope: string }>(
      `select id, title, aliases, scope from memory_records
        where id != ? and ((scope = ? and scope_id is ?) or scope = 'profile') order by scope = 'profile', id`,
      recordId,
      r.scope,
      r.scope_id
    )
    for (const name of names) {
      const target = candidates.find((c) => c.title.toLowerCase() === name || parseAliases(c.aliases).some((a) => a.toLowerCase() === name))
      if (target) run('insert or ignore into memory_links (from_record, to_record) values (?, ?)', recordId, target.id)
    }
  }

  /** After a record gets a new name, links elsewhere that name it can now find it. */
  const relinkNamed = () => {
    for (const { id } of all<{ id: number }>(`select id from memory_current where body like '%[[%'`)) relink(id)
  }

  /** Writes puts and hides closes as one revision. */
  const apply = (puts: Put[], closes: number[], origin: MemoryOrigin): { rev: number; ids: number[] } => {
    const rev = revision(origin)
    const now = Date.now()
    for (const id of closes) close(id, rev)
    let renamed = false
    const ids = puts.map((p) => {
      let id = p.id
      if (id === undefined) {
        id = Number(
          run(
            'insert into memory_records (type, title, aliases, scope, scope_id, created_at) values (?, ?, ?, ?, ?, ?)',
            p.type ?? 'person',
            p.title ?? '',
            JSON.stringify(p.aliases ?? []),
            p.scope ?? 'profile',
            p.scopeId ?? null,
            now
          ).lastInsertRowid
        )
        renamed ||= !!p.title || (p.aliases?.length ?? 0) > 0
      } else if (p.title !== undefined || p.aliases !== undefined) {
        const changed = run(
          `update memory_records set title = coalesce(?, title), aliases = coalesce(?, aliases)
            where id = ? and (title != coalesce(?, title) or aliases != coalesce(?, aliases))`,
          p.title ?? null,
          p.aliases ? JSON.stringify(p.aliases) : null,
          id,
          p.title ?? null,
          p.aliases ? JSON.stringify(p.aliases) : null
        ).changes
        renamed ||= Number(changed) > 0
      }
      close(id, rev)
      run(
        `insert into memory_versions (record_id, body, added_rev, writer, source_job_id, source_session_id, created_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
        id,
        p.body,
        rev,
        writerOf(origin),
        p.source ? p.source.jobId : (origin.jobId ?? null),
        p.source ? p.source.sessionId : (origin.sessionId ?? null),
        now
      )
      return id
    })
    if (renamed) relinkNamed()
    else for (const id of ids) relink(id)
    return { rev, ids }
  }

  /**
   * Applies a change to the profile as one new revision. An update is a new version of the same
   * record. Adds that repeat a live record are skipped, so the extractor can be sloppy; one that
   * repeats a hidden record brings it back under its old id. Returns what changed, or null when
   * nothing did (no revision).
   */
  const changeMemory = (change: MemoryChange, origin: MemoryOrigin): { rev: number; added: string[]; removed: string[] } | null =>
    transaction(() => {
      const live = profile()
      const byId = new Map(live.map((r) => [r.id, r]))
      const closes = new Set<number>()
      for (const id of change.remove) if (byId.has(id)) closes.add(id)
      const updates: Put[] = []
      const touched = new Set(closes)
      const seen = new Set<string>()
      for (const u of change.update) {
        const old = byId.get(u.id)
        if (!old || touched.has(u.id) || sameText(old.body, u.fact)) continue
        touched.add(u.id)
        updates.push({ id: u.id, body: u.fact })
        seen.add(textKey(u.fact))
      }
      for (const r of live) if (!touched.has(r.id)) seen.add(textKey(r.body))
      // Hidden records by their last text: a fact learned again comes back under its old id.
      const hidden = new Map(
        all<{ id: number; body: string }>(
          `select r.id, v.body from memory_records r join memory_versions v on v.record_id = r.id
            where r.scope = 'profile' and v.id = (select max(w.id) from memory_versions w where w.record_id = r.id)
              and v.removed_rev is not null`
        ).map((h) => [textKey(h.body), h.id])
      )
      const adds: Put[] = []
      for (const a of change.add) {
        const fact = typeof a === 'string' ? a : a.fact
        if (seen.has(textKey(fact))) continue
        seen.add(textKey(fact))
        const back = hidden.get(textKey(fact))
        if (back !== undefined) adds.push({ id: back, body: fact })
        else if (typeof a === 'string') adds.push({ body: fact })
        else adds.push({ body: fact, type: a.type ?? 'person', title: a.title ?? '', aliases: a.aliases ?? [] })
      }
      const room = Math.max(0, MEMORY_LIMIT - (live.length - closes.size))
      const added = adds.slice(0, room)
      if (added.length === 0 && updates.length === 0 && closes.size === 0) return null
      const { rev } = apply([...updates, ...added], [...closes], origin)
      return {
        rev,
        added: [...updates, ...added].map((p) => p.body),
        removed: [...[...closes, ...updates.map((u) => u.id!)].map((id) => byId.get(id)!.body)]
      }
    })

  /** Hides every profile record, as one revision that can be restored from. */
  const clearMemory = () => changeMemory({ add: [], update: [], remove: profile().map((r) => r.id) }, { kind: 'cleared' })

  /** Every bot's playbook as it is now, or was at `rev`: long-term memory's other scope besides the profile. */
  const playbookRowsAt = (rev: number) =>
    all<CurrentRow>(
      `select ${COLUMNS} from memory_records r join memory_versions v on v.record_id = r.id
        where r.scope = 'bot' and v.added_rev <= ? and (v.removed_rev is null or v.removed_rev > ?)
        order by r.id`,
      rev,
      rev
    )

  /**
   * Brings back the profile and the playbooks as they were at `rev`, as a new revision under the
   * same ids, so history is kept. Purged records are gone, so they never come back.
   */
  const restoreMemory = (rev: number) =>
    transaction(() => {
      const target = [...rowsAt('profile', null, rev), ...playbookRowsAt(rev)]
      const live = new Map([...profile(), ...toRecords(playbookRowsAt(FOREVER))].map((r) => [r.id, r]))
      const wanted = new Set(target.map((t) => t.id))
      const closes = [...live.keys()].filter((id) => !wanted.has(id))
      const puts: Put[] = target
        .filter((t) => !live.has(t.id) || !sameText(live.get(t.id)!.body, t.body))
        .map((t) => ({ id: t.id, body: t.body, source: { jobId: t.source_job_id, sessionId: t.source_session_id } }))
      if (closes.length === 0 && puts.length === 0) return null
      const saved = apply(puts, closes, { kind: 'restored', writer: 'user', note: `Restored version ${rev}` })
      return {
        rev: saved.rev,
        added: puts.map((p) => p.body),
        removed: [...closes, ...puts.flatMap((p) => (live.has(p.id!) ? [p.id!] : []))].map((id) => live.get(id)!.body)
      }
    })

  /** Squeezes deleted text out of the search index, the freed pages and the write-ahead log. */
  const scrub = () => {
    exec(`insert into memory_search (memory_search) values ('optimize')`)
    exec('pragma wal_checkpoint(truncate)')
  }

  /**
   * Deletes records outright, then scrubs. Db opens the file with secure_delete on, so the
   * deleted rows (and every earlier copy of them that an update or a merge freed) are zeroed.
   */
  const destroy = <A>(f: () => A): A => {
    const result = transaction(f)
    scrub()
    return result
  }

  /**
   * Deletes a record and every version of it, for good: for "forget this" and anything
   * sensitive, where hiding isn't enough. A profile record's purge is a revision (with no text),
   * so the history says something went. Returns whether there was such a record.
   */
  const purgeRecord = (id: number): boolean =>
    destroy(() => {
      const r = one<{ scope: string }>('select scope from memory_records where id = ?', id)
      if (!r) return false
      run('delete from memory_records where id = ?', id)
      if (r.scope === 'profile' || r.scope === 'bot') revision({ kind: 'purged', writer: 'user', note: 'Deleted a record and its history' })
      return true
    })

  /** A record's versions, newest first, with the chat each came from. */
  const recordVersions = (id: number): MemoryVersion[] =>
    all<{
      id: number
      record_id: number
      body: string
      added_rev: number
      removed_rev: number | null
      writer: string
      source_job_id: string | null
      source_session_id: string | null
      source_title: string | null
      created_at: number
    }>(
      `select v.*, s.title as source_title from memory_versions v left join sessions s on s.id = v.source_session_id
        where v.record_id = ? order by v.id desc`,
      id
    ).map((v) => ({
      id: v.id,
      recordId: v.record_id,
      body: v.body,
      addedRev: v.added_rev,
      removedRev: v.removed_rev,
      writer: v.writer as MemoryWriter,
      sourceJobId: v.source_job_id,
      sourceSessionId: v.source_session_id,
      sourceTitle: v.source_title,
      createdAt: v.created_at
    }))

  /**
   * Changes to the profile and the playbooks, newest first; a playbook's lines say whose it is.
   * Job notes and the archive have their own records.
   */
  const memoryHistory = (limit = 100): MemoryRevision[] => {
    const revs = all<{ rev: number; kind: string; writer: string; session_id: string | null; note: string | null; created_at: number }>(
      `select * from memory_revisions where kind not in ('noted', 'archived') order by rev desc limit ?`,
      limit
    )
    if (revs.length === 0) return []
    const oldest = revs.at(-1)!.rev
    const versions = all<{ body: string; added_rev: number; removed_rev: number | null; scope: string; bot: string | null }>(
      `select v.body, v.added_rev, v.removed_rev, r.scope, b.name as bot from memory_versions v join memory_records r on r.id = v.record_id
         left join bots b on r.scope = 'bot' and b.id = r.scope_id
        where r.scope in ('profile', 'bot') and (v.added_rev >= ? or v.removed_rev >= ?) order by r.scope = 'bot', v.record_id, v.id`,
      oldest,
      oldest
    ).map((v) => (v.scope === 'bot' ? { ...v, body: `${v.bot ?? 'A bot'}’s playbook: ${v.body}` } : v))
    return revs.map((r) => ({
      rev: r.rev,
      kind: r.kind as MemoryRevision['kind'],
      writer: r.writer as MemoryWriter,
      sessionId: r.session_id,
      note: r.note,
      createdAt: r.created_at,
      added: versions.filter((v) => v.added_rev === r.rev).map((v) => v.body),
      removed: versions.filter((v) => v.removed_rev === r.rev).map((v) => v.body)
    }))
  }

  /**
   * Saves a note a bot wrote on a job. There is one note of each SINGLE_NOTES kind per job (a new
   * one is its next version); decisions and progress notes pile up, a record each. Returns the
   * record's id, and null for `rev` when the note said what the current one already does.
   */
  const writeNote = (
    jobId: string,
    note: { kind: JobNoteKind; text: string; title?: string },
    origin: { sessionId?: string | null; writer?: MemoryWriter } = {}
  ): { id: number; rev: number | null; replaced: boolean } =>
    transaction(() => {
      const existing = SINGLE_NOTES.includes(note.kind)
        ? one<{ id: number; body: string }>(`select id, body from memory_current where scope = 'job' and scope_id = ? and type = ?`, jobId, note.kind)
        : undefined
      if (existing && existing.body === note.text) return { id: existing.id, rev: null, replaced: false }
      if (!existing) {
        const count = one<{ n: number }>(`select count(*) as n from memory_current where scope = 'job' and scope_id = ?`, jobId)?.n ?? 0
        if (count >= JOB_NOTE_LIMIT) throw new Error(`This job already has ${JOB_NOTE_LIMIT} notes. Fold some into the state note instead.`)
      }
      const put: Put = existing
        ? { id: existing.id, body: note.text, ...(note.title !== undefined ? { title: note.title } : {}) }
        : { body: note.text, type: note.kind, title: note.title ?? '', scope: 'job', scopeId: jobId }
      const saved = apply([put], [], { kind: 'noted', writer: origin.writer ?? 'bot', sessionId: origin.sessionId ?? null, jobId })
      return { id: saved.ids[0]!, rev: saved.rev, replaced: !!existing }
    })

  /**
   * Saves a progress note a checkpoint wrote (agent/watch.ts), titled `title` (which starts with
   * `prefix`), and hides all but the latest `keep` of the job's notes titled so, in one revision:
   * checkpoints come every 10 or so steps, and only the latest few are worth a place in every
   * prompt. The hidden ones stay in the history.
   */
  const writeCheckpointNote = (
    jobId: string,
    note: { title: string; text: string },
    origin: { sessionId: string | null; note: string | null },
    opts: { prefix: string; keep: number }
  ): { id: number; rev: number } =>
    transaction(() => {
      const older = all<{ id: number }>(
        `select id from memory_current where scope = 'job' and scope_id = ? and type = 'progress' and substr(title, 1, ?) = ? order by id desc`,
        jobId,
        opts.prefix.length,
        opts.prefix
      ).map((r) => r.id)
      const closes = older.slice(Math.max(0, opts.keep - 1))
      const count = one<{ n: number }>(`select count(*) as n from memory_current where scope = 'job' and scope_id = ?`, jobId)?.n ?? 0
      if (count - closes.length >= JOB_NOTE_LIMIT) throw new Error(`This job already has ${JOB_NOTE_LIMIT} notes.`)
      const saved = apply([{ body: note.text, type: 'progress', title: note.title, scope: 'job', scopeId: jobId }], closes, {
        kind: 'noted',
        writer: 'bot',
        sessionId: origin.sessionId,
        jobId,
        note: origin.note
      })
      return { id: saved.ids[0]!, rev: saved.rev }
    })

  /** A job's notes, oldest first. */
  const jobNotes = (jobId: string) => records('job', jobId)

  const archive = (
    type: 'job' | 'conversation',
    scopeId: string,
    summary: string,
    opts: { title: string; aliases?: string[]; sessionId?: string | null; jobId?: string | null; writer?: MemoryWriter }
  ): { id: number; rev: number | null } =>
    transaction(() => {
      const existing = one<{ id: number }>(`select id from memory_records where scope = 'archive' and type = ? and scope_id = ?`, type, scopeId)
      const now = existing ? getRecord(existing.id) : undefined
      if (now && now.body === summary && now.title === opts.title && (!opts.aliases || JSON.stringify(now.aliases) === JSON.stringify(opts.aliases)))
        return { id: now.id, rev: null }
      const saved = apply(
        [{ ...(existing ? { id: existing.id } : {}), body: summary, type, title: opts.title, aliases: opts.aliases ?? [], scope: 'archive', scopeId }],
        [],
        { kind: 'archived', writer: opts.writer ?? 'archiver', sessionId: opts.sessionId ?? null, jobId: type === 'job' ? scopeId : (opts.jobId ?? null) }
      )
      return { id: saved.ids[0]!, rev: saved.rev }
    })

  /**
   * Files a finished job in the archive: its summary, searched with `recall`, never in a prompt.
   * Archiving the same job again writes a new version of its record. `sessionId` is the thread
   * the summary was written from.
   */
  const archiveJob = (jobId: string, summary: string, opts: { title: string; aliases?: string[]; sessionId?: string | null; writer?: MemoryWriter }) =>
    archive('job', jobId, summary, opts)

  /** Files an old conversation in the archive, as archiveJob does a job. */
  const archiveConversation = (sessionId: string, summary: string, opts: { title: string; aliases?: string[]; jobId?: string | null; writer?: MemoryWriter }) =>
    archive('conversation', sessionId, summary, { ...opts, sessionId })

  /** Deletes a job's notes and its archive record for good (when the job itself is deleted). */
  const forgetJob = (jobId: string): number =>
    destroy(() =>
      Number(
        run(`delete from memory_records where (scope = 'job' and scope_id = ?) or (scope = 'archive' and type = 'job' and scope_id = ?)`, jobId, jobId).changes
      )
    )

  /**
   * Full-text search over the titles, aliases and current versions of the profile and the
   * archive, plus the playbook of `botId` and the notes of `jobId` when given. Best match first.
   */
  const recall = (query: string, scope: RecallScope = {}): RecallHit[] => {
    const match = ftsQuery(query)
    if (!match) return []
    return all<{
      id: number
      scope: string
      scope_id: string | null
      type: string
      title: string
      aliases: string
      body: string
      updated_at: number
      source_session_id: string | null
    }>(
      `select c.id, c.scope, c.scope_id, c.type, c.title, c.aliases, c.body, c.updated_at, c.source_session_id
         from memory_search join memory_current c on c.id = memory_search.rowid
        where memory_search match ?
          and (c.scope in ('profile', 'archive') or (c.scope = 'bot' and c.scope_id = ?) or (c.scope = 'job' and c.scope_id = ?))
        order by bm25(memory_search, 4.0, 4.0, 1.0) limit ?`,
      match,
      scope.botId ?? null,
      scope.jobId ?? null,
      Math.max(1, Math.min(50, scope.limit ?? 8))
    ).map((r) => ({
      id: r.id,
      scope: r.scope as MemoryScope,
      scopeId: r.scope_id,
      type: r.type,
      title: r.title,
      aliases: parseAliases(r.aliases),
      body: r.body,
      updatedAt: r.updated_at,
      sourceSessionId: r.source_session_id
    }))
  }

  /**
   * Saves what the daily reconciler planned (reconciler.ts) as one revision written by
   * 'reconciler', each version with the job it came from. A change is skipped when its record is no
   * longer live as the plan saw it: purged, hidden, edited, or outside the profile and playbooks.
   * New records past the profile's limit are dropped. `rev` is null when nothing was left to change.
   */
  const reconcile = (plan: ReconcilePlan, note: string): { rev: number | null; added: string[]; removed: string[]; applied: string[]; skipped: number } =>
    transaction(() => {
      const current = (id: number) => one<{ scope: string; body: string }>(`select scope, body from memory_current where id = ?`, id)
      const unchanged = (id: number, base: string) => {
        const r = current(id)
        return !!r && (r.scope === 'profile' || r.scope === 'bot') && r.body === base
      }
      let skipped = 0
      let room = Math.max(0, MEMORY_LIMIT - profile().length)
      const puts: Put[] = []
      const closes: number[] = []
      const removed: string[] = []
      const applied: string[] = []
      for (const change of plan.changes) {
        const adds = change.puts.filter((p) => p.id === undefined && p.scope === 'profile').length
        const fresh =
          change.puts.every((p) => p.id === undefined || unchanged(p.id, p.base ?? '')) && change.closes.every((c) => unchanged(c.id, c.base))
        if (!fresh || adds > room) {
          skipped++
          continue
        }
        room -= adds
        applied.push(change.what)
        for (const p of change.puts) {
          if (p.base !== undefined) removed.push(p.base)
          puts.push({
            ...(p.id !== undefined ? { id: p.id } : { type: p.type ?? 'person', title: p.title ?? '', aliases: [], scope: p.scope, scopeId: p.scopeId }),
            body: p.body,
            source: { jobId: p.jobId, sessionId: p.sessionId }
          })
        }
        for (const c of change.closes) {
          closes.push(c.id)
          removed.push(c.base)
        }
      }
      if (puts.length === 0 && closes.length === 0) return { rev: null, added: [], removed: [], applied: [], skipped }
      const saved = apply(puts, closes, { kind: 'reconciled', writer: 'reconciler', note })
      return { rev: saved.rev, added: puts.map((p) => p.body), removed, applied, skipped }
    })

  /** Each bot's playbook now, by bot id. */
  const playbooks = (): Map<string, MemoryRecord[]> => {
    const out = new Map<string, MemoryRecord[]>()
    for (const r of toRecords(playbookRowsAt(FOREVER))) {
      const list = out.get(r.scopeId ?? '') ?? []
      list.push(r)
      out.set(r.scopeId ?? '', list)
    }
    return out
  }

  return {
    records,
    profile,
    reconcile,
    playbooks,
    getRecord,
    memoryRev,
    changeMemory,
    clearMemory,
    restoreMemory,
    purgeRecord,
    recordVersions,
    memoryHistory,
    writeNote,
    writeCheckpointNote,
    jobNotes,
    archiveJob,
    archiveConversation,
    forgetJob,
    recall,
    /**
     * The memory revision a chat sees. It is fixed the first time the chat asks, so the
     * profile reaches the model once per chat and the system prompt stays the same after.
     */
    sessionMemoryRev: (sessionId: string): number => {
      const row = one<{ memory_rev: number | null }>('select memory_rev from sessions where id = ?', sessionId)
      if (row?.memory_rev != null) return row.memory_rev
      const rev = memoryRev()
      run('update sessions set memory_rev = ? where id = ?', rev, sessionId)
      return rev
    }
  }
}
