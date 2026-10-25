import { randomUUID } from 'node:crypto'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { Context, Effect, Layer } from 'effect'
import type {
  Attachment,
  AttachmentKind,
  Message,
  MessageStatus,
  PathNode,
  Role,
  AudioAnalysis,
  MemoryFact,
  MemoryRevision,
  Session,
  Usage
} from '@shared/types'
import { DbError, NotFound, errorMessage } from '../errors'

const MIGRATIONS: string[] = [
  `create table sessions (
    id text primary key,
    title text not null,
    model text,
    system_prompt text,
    root_id text not null,
    forked_from_session_id text,
    created_at integer not null,
    updated_at integer not null
  );
  create table messages (
    seq integer primary key autoincrement,
    id text not null unique,
    session_id text not null references sessions(id) on delete cascade,
    parent_id text,
    active_child_id text,
    role text not null,
    content text not null default '',
    status text not null,
    line_count integer not null default 0,
    model text,
    error text,
    created_at integer not null
  );
  create index messages_session on messages(session_id);
  create index messages_parent on messages(parent_id);
  create table attachments (
    id text primary key,
    message_id text references messages(id) on delete cascade,
    name text not null,
    mime text not null,
    size integer not null,
    kind text not null,
    path text not null,
    created_at integer not null
  );
  create index attachments_message on attachments(message_id);`,
  // Set when a reply stopped mid-line: its last line is partial and a continuation must join it.
  `alter table messages add column tail_partial integer not null default 0;`,
  // Per-chat switch that gives the model browser tools.
  `alter table sessions add column browser_enabled integer not null default 0;`,
  // Token and credit totals per reply, as JSON.
  `alter table messages add column usage text;`,
  // Tempo/beat analysis of audio uploads, as JSON.
  `alter table attachments add column analysis text;`,
  // Hand edits to a mood board, per version (the message that wrote it) and board identifier.
  `create table boards (
    message_id text not null references messages(id) on delete cascade,
    identifier text not null,
    data text not null,
    updated_at integer not null,
    primary key (message_id, identifier)
  );`,
  // Pinned chats sit above the rest of the sidebar, in the order they were pinned.
  `alter table sessions add column pinned_at integer;`,
  // Memory: facts about the user, versioned without git. Every change is a revision; a fact
  // lives from the revision that added it until the one that removed it, so any earlier
  // profile can be read back (and restored as a new revision). Rows are never rewritten.
  `create table memory_revisions (
    rev integer primary key autoincrement,
    kind text not null,
    session_id text,
    note text,
    created_at integer not null
  );
  create table memory_facts (
    id integer primary key autoincrement,
    fact text not null,
    added_rev integer not null,
    removed_rev integer,
    created_at integer not null
  );
  create index memory_facts_added on memory_facts(added_rev);
  create index memory_facts_removed on memory_facts(removed_rev);
  alter table sessions add column memory_rev integer;`,
  // Per-chat switch that lets the model see the screen and use the mouse and keyboard.
  `alter table sessions add column computer_enabled integer not null default 0;`,
  // A reply's lines while it streams, a row each, folded into messages.content when it stops.
  // Appending to content itself rewrote the whole reply (and its overflow pages) on every line.
  `create table message_lines (
    message_id text not null references messages(id) on delete cascade,
    idx integer not null,
    text text not null,
    primary key (message_id, idx)
  ) without rowid;`,
  // Per-chat switch that researches replies on the Claude API with web search.
  `alter table sessions add column research_enabled integer not null default 0;`
]

/** At most this many facts are kept; past it, new ones are dropped until some are removed. */
export const MEMORY_LIMIT = 150

interface SessionRow {
  id: string
  title: string
  model: string | null
  system_prompt: string | null
  root_id: string
  forked_from_session_id: string | null
  browser_enabled: number
  computer_enabled: number
  research_enabled: number
  pinned_at: number | null
  created_at: number
  updated_at: number
}

interface MessageRow {
  id: string
  session_id: string
  parent_id: string | null
  active_child_id: string | null
  role: string
  content: string
  status: string
  line_count: number
  model: string | null
  error: string | null
  usage: string | null
  created_at: number
}

interface AttachmentRow {
  id: string
  message_id: string | null
  name: string
  mime: string
  size: number
  kind: string
  path: string
  created_at: number
  analysis: string | null
}

export interface StoredAttachment extends Attachment {
  path: string
}

const toSession = (r: SessionRow): Session => ({
  id: r.id,
  title: r.title,
  model: r.model,
  systemPrompt: r.system_prompt,
  rootId: r.root_id,
  forkedFromSessionId: r.forked_from_session_id,
  browserEnabled: r.browser_enabled === 1,
  computerEnabled: r.computer_enabled === 1,
  researchEnabled: r.research_enabled === 1,
  pinnedAt: r.pinned_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

const toAttachment = (r: AttachmentRow): StoredAttachment => ({
  id: r.id,
  messageId: r.message_id,
  name: r.name,
  mime: r.mime,
  size: r.size,
  kind: r.kind as AttachmentKind,
  path: r.path,
  createdAt: r.created_at,
  analysis: parseJson<AudioAnalysis>(r.analysis)
})

const publicAttachment = ({ path: _path, ...a }: StoredAttachment): Attachment => a

const parseJson = <T>(raw: string | null): T | null => {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

const parseUsageJson = (raw: string | null): Usage | null => {
  if (!raw) return null
  try {
    return JSON.parse(raw) as Usage
  } catch {
    return null
  }
}

export interface NewMessage {
  sessionId: string
  parentId: string
  role: Role
  content: string
  status: MessageStatus
  model?: string | null
}

/** Changes the memory extractor asked for; `update` and `remove` refer to fact ids. */
export interface MemoryChange {
  add: string[]
  update: Array<{ id: number; fact: string }>
  remove: number[]
}

const factKey = (fact: string) => fact.trim().toLowerCase().replace(/[.!]+$/, '')

export const makeDb = (file: string) => {
  const db = new DatabaseSync(file)
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma synchronous = normal;')
  const version = (db.prepare('pragma user_version').get() as { user_version: number }).user_version
  MIGRATIONS.slice(version).forEach((sql, i) => {
    db.exec('begin')
    db.exec(sql)
    db.exec(`pragma user_version = ${version + i + 1}`)
    db.exec('commit')
  })

  // Statements are compiled once and reused: loading a chat runs a few per message, and a
  // streaming reply one per line.
  const statements = new Map<string, StatementSync>()
  const prepare = (sql: string) => {
    let statement = statements.get(sql)
    if (!statement) {
      // `in (?, ?, …)` lists make a new statement per length; don't keep those forever.
      if (statements.size >= 256) statements.clear()
      statements.set(sql, (statement = db.prepare(sql)))
    }
    return statement
  }
  const all = <T>(sql: string, ...params: SQLInputValue[]) => prepare(sql).all(...params) as unknown as T[]
  const one = <T>(sql: string, ...params: SQLInputValue[]) => prepare(sql).get(...params) as unknown as T | undefined
  const run = (sql: string, ...params: SQLInputValue[]) => prepare(sql).run(...params)

  // Re-entrant: nested calls join the outer transaction (SQLite has no nested BEGIN).
  const transaction = <A>(f: () => A): A => {
    if (db.isTransaction) return f()
    db.exec('begin')
    try {
      const result = f()
      db.exec('commit')
      return result
    } catch (e) {
      db.exec('rollback')
      throw e
    }
  }

  const attachmentsFor = (messageIds: readonly string[]): Map<string, StoredAttachment[]> => {
    const map = new Map<string, StoredAttachment[]>()
    if (messageIds.length === 0) return map
    const rows = all<AttachmentRow>(
      `select * from attachments where message_id in (${messageIds.map(() => '?').join(',')}) order by created_at`,
      ...messageIds
    )
    for (const row of rows) {
      const a = toAttachment(row)
      const list = map.get(row.message_id!) ?? []
      list.push(a)
      map.set(row.message_id!, list)
    }
    return map
  }

  /** Lines streamed into message_lines and not yet folded into content, by message. */
  const pendingLines = (ids: string[]): Map<string, string[]> => {
    const map = new Map<string, string[]>()
    if (ids.length === 0) return map
    const rows = all<{ message_id: string; text: string }>(
      'select message_id, text from message_lines where message_id in (select value from json_each(?)) order by message_id, idx',
      JSON.stringify(ids)
    )
    for (const row of rows) {
      const list = map.get(row.message_id) ?? []
      list.push(row.text)
      map.set(row.message_id, list)
    }
    return map
  }

  /** A reply's text: what is folded into the row, then the lines streamed since. */
  const joinLines = (r: { content: string; line_count: number }, lines: string[] | undefined) => {
    if (!lines?.length) return r.content
    // Lines in the row already (a continued reply); with none, its content is empty.
    const folded = r.line_count - lines.length
    return (folded > 0 ? [r.content, ...lines] : lines).join('\n')
  }

  /** Moves a reply's streamed lines into its content, once it stops streaming. */
  const foldLines = (messageId: string) => {
    const lines = pendingLines([messageId]).get(messageId)
    if (!lines) return
    const row = one<{ content: string; line_count: number }>('select content, line_count from messages where id = ?', messageId)
    if (row) run('update messages set content = ? where id = ?', joinLines(row, lines), messageId)
    run('delete from message_lines where message_id = ?', messageId)
  }

  const toMessages = (rows: MessageRow[]): Message[] => {
    const atts = attachmentsFor(rows.map((r) => r.id))
    const lines = pendingLines(rows.filter((r) => r.role === 'assistant').map((r) => r.id))
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      parentId: r.parent_id,
      activeChildId: r.active_child_id,
      role: r.role as Role,
      content: joinLines(r, lines.get(r.id)),
      status: r.status as MessageStatus,
      lineCount: r.line_count,
      model: r.model,
      error: r.error,
      createdAt: r.created_at,
      attachments: (atts.get(r.id) ?? []).map(publicAttachment),
      usage: parseUsageJson(r.usage)
    }))
  }

  const getSession = (id: string): Session | undefined => {
    const row = one<SessionRow>('select * from sessions where id = ?', id)
    return row ? toSession(row) : undefined
  }

  const getMessage = (id: string): Message | undefined => {
    const row = one<MessageRow>('select * from messages where id = ?', id)
    return row ? toMessages([row])[0] : undefined
  }

  const childIds = (parentId: string): string[] =>
    all<{ id: string }>('select id from messages where parent_id = ? order by seq', parentId).map((r) => r.id)

  const insertMessage = (m: NewMessage): Message => {
    const id = randomUUID()
    const now = Date.now()
    run(
      `insert into messages (id, session_id, parent_id, role, content, status, line_count, model, created_at)
       values (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      id,
      m.sessionId,
      m.parentId,
      m.role,
      m.content,
      m.status,
      m.model ?? null,
      now
    )
    run('update messages set active_child_id = ? where id = ?', id, m.parentId)
    run('update sessions set updated_at = ? where id = ?', now, m.sessionId)
    return getMessage(id)!
  }

  const createSession = (input: {
    title: string
    model: string | null
    systemPrompt: string | null
    forkedFromSessionId: string | null
  }): Session =>
    transaction(() => {
      const id = randomUUID()
      const rootId = randomUUID()
      const now = Date.now()
      run(
        `insert into sessions (id, title, model, system_prompt, root_id, forked_from_session_id, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.title,
        input.model,
        input.systemPrompt,
        rootId,
        input.forkedFromSessionId,
        now,
        now
      )
      run(
        `insert into messages (id, session_id, parent_id, role, content, status, created_at)
         values (?, ?, null, 'root', '', 'complete', ?)`,
        rootId,
        id,
        now
      )
      return getSession(id)!
    })

  /** The visible conversation: follow `active_child_id` from the root, skipping the root itself. */
  const activePath = (session: Session): PathNode[] => {
    const rows: MessageRow[] = []
    let cursor = one<MessageRow>('select * from messages where id = ?', session.rootId)
    const seen = new Set<string>()
    while (cursor?.active_child_id && !seen.has(cursor.active_child_id)) {
      seen.add(cursor.active_child_id)
      cursor = one<MessageRow>('select * from messages where id = ?', cursor.active_child_id)
      if (cursor) rows.push(cursor)
    }
    return toMessages(rows).map((message) => {
      const siblingIds = message.parentId ? childIds(message.parentId) : [message.id]
      return { message, siblingIds, siblingIndex: siblingIds.indexOf(message.id) }
    })
  }

  /** Root-to-node ancestry of a message (including the node, excluding the root). */
  const lineage = (messageId: string): Message[] => {
    const rows: MessageRow[] = []
    let cursor = one<MessageRow>('select * from messages where id = ?', messageId)
    while (cursor && cursor.role !== 'root') {
      rows.unshift(cursor)
      cursor = cursor.parent_id ? one<MessageRow>('select * from messages where id = ?', cursor.parent_id) : undefined
    }
    return toMessages(rows)
  }

  /** Make `messageId` visible: point every ancestor's active child along its lineage. */
  const activate = (messageId: string) =>
    transaction(() => {
      let cursor = one<MessageRow>('select * from messages where id = ?', messageId)
      while (cursor?.parent_id) {
        run('update messages set active_child_id = ? where id = ?', cursor.id, cursor.parent_id)
        cursor = one<MessageRow>('select * from messages where id = ?', cursor.parent_id)
      }
    })

  const forkSession = (sessionId: string, messageId: string): Session =>
    transaction(() => {
      const source = getSession(sessionId)!
      const path = lineage(messageId)
      const fork = createSession({
        title: `${source.title} (fork)`,
        model: source.model,
        systemPrompt: source.systemPrompt,
        forkedFromSessionId: source.id
      })
      if (source.browserEnabled) run('update sessions set browser_enabled = 1 where id = ?', fork.id)
      if (source.computerEnabled) run('update sessions set computer_enabled = 1 where id = ?', fork.id)
      if (source.researchEnabled) run('update sessions set research_enabled = 1 where id = ?', fork.id)
      let parentId = fork.rootId
      const stored = attachmentsFor(path.map((m) => m.id))
      for (const m of path) {
        const copy = insertMessage({
          sessionId: fork.id,
          parentId,
          role: m.role,
          content: m.content,
          status: m.status === 'streaming' ? 'interrupted' : m.status,
          model: m.model
        })
        run(
          `update messages set line_count = ?, error = ?, usage = ?,
             tail_partial = (select tail_partial from messages where id = ?) where id = ?`,
          m.lineCount,
          m.error,
          m.usage ? JSON.stringify(m.usage) : null,
          m.id,
          copy.id
        )
        for (const a of stored.get(m.id) ?? []) {
          run(
            `insert into attachments (id, message_id, name, mime, size, kind, path, created_at, analysis)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            randomUUID(),
            copy.id,
            a.name,
            a.mime,
            a.size,
            a.kind,
            a.path,
            a.createdAt,
            a.analysis ? JSON.stringify(a.analysis) : null
          )
        }
        run(
          `insert into boards (message_id, identifier, data, updated_at)
           select ?, identifier, data, updated_at from boards where message_id = ?`,
          copy.id,
          m.id
        )
        parentId = copy.id
      }
      return getSession(fork.id)!
    })

  /** The profile now, or as it was at revision `rev`. */
  const liveFacts = (rev?: number): MemoryFact[] =>
    (rev === undefined
      ? all<{ id: number; fact: string; created_at: number }>(
          'select id, fact, created_at from memory_facts where removed_rev is null order by id'
        )
      : all<{ id: number; fact: string; created_at: number }>(
          `select id, fact, created_at from memory_facts
            where added_rev <= ? and (removed_rev is null or removed_rev > ?) order by id`,
          rev,
          rev
        )
    ).map((r) => ({ id: r.id, fact: r.fact, createdAt: r.created_at }))

  const memoryRev = (): number => one<{ rev: number | null }>('select max(rev) as rev from memory_revisions')?.rev ?? 0

  /**
   * Applies a change as one new revision. Adds that repeat a live fact are skipped, so the
   * extractor can be sloppy. Returns what changed, or null when nothing did (no revision).
   */
  const changeMemory = (
    change: MemoryChange,
    origin: { kind: MemoryRevision['kind']; sessionId?: string | null; note?: string | null }
  ): { rev: number; added: string[]; removed: string[] } | null =>
    transaction(() => {
      const live = liveFacts()
      const byId = new Map(live.map((f) => [f.id, f]))
      const removeIds = new Set<number>()
      const adds: string[] = []
      const seen = new Set<string>()
      for (const id of change.remove) if (byId.has(id)) removeIds.add(id)
      for (const u of change.update) {
        const old = byId.get(u.id)
        if (!old || factKey(old.fact) === factKey(u.fact)) continue
        removeIds.add(u.id)
        adds.push(u.fact)
        seen.add(factKey(u.fact))
      }
      for (const f of live) if (!removeIds.has(f.id)) seen.add(factKey(f.fact))
      for (const fact of change.add) {
        if (seen.has(factKey(fact))) continue
        seen.add(factKey(fact))
        adds.push(fact)
      }
      const room = Math.max(0, MEMORY_LIMIT - (live.length - removeIds.size))
      const added = adds.slice(0, room)
      if (added.length === 0 && removeIds.size === 0) return null
      const now = Date.now()
      const rev = Number(
        run(
          'insert into memory_revisions (kind, session_id, note, created_at) values (?, ?, ?, ?)',
          origin.kind,
          origin.sessionId ?? null,
          origin.note ?? null,
          now
        ).lastInsertRowid
      )
      for (const id of removeIds) run('update memory_facts set removed_rev = ? where id = ?', rev, id)
      for (const fact of added) run('insert into memory_facts (fact, added_rev, created_at) values (?, ?, ?)', fact, rev, now)
      return { rev, added, removed: [...removeIds].map((id) => byId.get(id)!.fact) }
    })

  const memoryHistory = (limit = 100): MemoryRevision[] => {
    const revs = all<{ rev: number; kind: string; session_id: string | null; note: string | null; created_at: number }>(
      'select * from memory_revisions order by rev desc limit ?',
      limit
    )
    if (revs.length === 0) return []
    const oldest = revs.at(-1)!.rev
    const facts = all<{ fact: string; added_rev: number; removed_rev: number | null }>(
      'select fact, added_rev, removed_rev from memory_facts where added_rev >= ? or removed_rev >= ? order by id',
      oldest,
      oldest
    )
    return revs.map((r) => ({
      rev: r.rev,
      kind: r.kind as MemoryRevision['kind'],
      sessionId: r.session_id,
      note: r.note,
      createdAt: r.created_at,
      added: facts.filter((f) => f.added_rev === r.rev).map((f) => f.fact),
      removed: facts.filter((f) => f.removed_rev === r.rev).map((f) => f.fact)
    }))
  }

  /** Brings back the profile as it was at `rev`, as a new revision, so history is kept. */
  const restoreMemory = (rev: number) =>
    transaction(() => {
      const target = liveFacts(rev)
      const live = liveFacts()
      const wanted = new Set(target.map((t) => factKey(t.fact)))
      const have = new Set(live.map((f) => factKey(f.fact)))
      return changeMemory(
        {
          add: target.filter((t) => !have.has(factKey(t.fact))).map((t) => t.fact),
          update: [],
          remove: live.filter((f) => !wanted.has(factKey(f.fact))).map((f) => f.id)
        },
        { kind: 'restored', note: `Restored version ${rev}` }
      )
    })

  /** Deletes a session and returns attachment files no other row references. */
  const deleteSession = (id: string): string[] =>
    transaction(() => {
      const paths = all<{ path: string }>(
        `select distinct a.path from attachments a join messages m on m.id = a.message_id where m.session_id = ?`,
        id
      ).map((r) => r.path)
      run('delete from sessions where id = ?', id)
      return paths.filter((p) => !one('select 1 from attachments where path = ?', p))
    })

  return {
    listSessions: () => all<SessionRow>('select * from sessions order by updated_at desc').map(toSession),
    /**
     * Deletes chats that never got a message (left over from when "New chat" saved a row
     * straight away). Returns how many went.
     */
    pruneEmptySessions: (): number =>
      Number(
        run(
          `delete from sessions where not exists (
             select 1 from messages m where m.session_id = sessions.id and m.role != 'root')`
        ).changes
      ),
    getSession,
    createSession,
    updateSession: (
      id: string,
      patch: {
        title?: string
        model?: string | null
        systemPrompt?: string | null
        browserEnabled?: boolean
        computerEnabled?: boolean
        researchEnabled?: boolean
        pinned?: boolean
      }
    ) => {
      // Neither pinning nor unpinning touches updated_at, so the chat keeps its date group.
      if (patch.pinned === true) run('update sessions set pinned_at = coalesce(pinned_at, ?) where id = ?', Date.now(), id)
      if (patch.pinned === false) run('update sessions set pinned_at = null where id = ?', id)
      if (patch.browserEnabled !== undefined)
        run('update sessions set browser_enabled = ? where id = ?', patch.browserEnabled ? 1 : 0, id)
      if (patch.computerEnabled !== undefined)
        run('update sessions set computer_enabled = ? where id = ?', patch.computerEnabled ? 1 : 0, id)
      if (patch.researchEnabled !== undefined)
        run('update sessions set research_enabled = ? where id = ?', patch.researchEnabled ? 1 : 0, id)
      if (patch.title !== undefined) run('update sessions set title = ? where id = ?', patch.title, id)
      if (patch.model !== undefined) run('update sessions set model = ? where id = ?', patch.model, id)
      if (patch.systemPrompt !== undefined)
        run('update sessions set system_prompt = ? where id = ?', patch.systemPrompt, id)
    },
    /** Sets the title only while it is still `expected`, so a rename in the meantime wins. */
    retitle: (id: string, expected: string, title: string): boolean =>
      Number(run('update sessions set title = ? where id = ? and title = ?', title, id, expected).changes) > 0,
    deleteSession,
    forkSession,
    streamingIds: (sessionId: string): string[] =>
      all<{ id: string }>(`select id from messages where session_id = ? and status = 'streaming'`, sessionId).map(
        (r) => r.id
      ),
    getMessage,
    insertMessage: (m: NewMessage) => transaction(() => insertMessage(m)),
    activePath,
    lineage,
    activate,
    /** Durable append of one complete line; returns the line's index. */
    appendLine: (messageId: string, text: string): number =>
      transaction(() => {
        const row = one<{ line_count: number }>('update messages set line_count = line_count + 1 where id = ? returning line_count', messageId)
        if (!row) return 0
        run('insert into message_lines (message_id, idx, text) values (?, ?, ?)', messageId, row.line_count - 1, text)
        return row.line_count - 1
      }),
    setStatus: (messageId: string, status: MessageStatus, error: string | null = null, tailPartial = false) =>
      transaction(() => {
        if (status !== 'streaming') foldLines(messageId)
        run(
          'update messages set status = ?, error = ?, tail_partial = ? where id = ?',
          status,
          error,
          tailPartial ? 1 : 0,
          messageId
        )
      }),
    setUsage: (messageId: string, usage: Usage) => {
      run('update messages set usage = ? where id = ?', JSON.stringify(usage), messageId)
    },
    setModel: (messageId: string, model: string) => {
      run('update messages set model = ? where id = ?', model, messageId)
    },
    /**
     * Before continuing a reply that ended mid-line, takes the partial last line back
     * out of the row so the continuation can complete it. Returns that line, or null.
     */
    reopenTail: (messageId: string): string | null =>
      transaction(() => {
        foldLines(messageId)
        const row = one<{ content: string; line_count: number; tail_partial: number }>(
          'select content, line_count, tail_partial from messages where id = ?',
          messageId
        )
        if (!row || row.tail_partial !== 1 || row.line_count === 0) return null
        const lines = row.content.split('\n')
        const tail = lines.pop() ?? ''
        run(
          'update messages set content = ?, line_count = ?, tail_partial = 0 where id = ?',
          lines.join('\n'),
          row.line_count - 1,
          messageId
        )
        return tail
      }),
    /** Crash recovery: anything still `streaming` at startup was cut off. */
    markInterrupted: (): number =>
      transaction(() => {
        for (const { message_id } of all<{ message_id: string }>('select distinct message_id from message_lines')) foldLines(message_id)
        return Number(run(`update messages set status = 'interrupted' where status = 'streaming'`).changes)
      }),
    insertAttachment: (a: Omit<StoredAttachment, 'id' | 'messageId' | 'createdAt' | 'analysis'>): StoredAttachment => {
      const id = randomUUID()
      const now = Date.now()
      run(
        `insert into attachments (id, message_id, name, mime, size, kind, path, created_at)
         values (?, null, ?, ?, ?, ?, ?, ?)`,
        id,
        a.name,
        a.mime,
        a.size,
        a.kind,
        a.path,
        now
      )
      return { ...a, id, messageId: null, createdAt: now, analysis: null }
    },
    getAttachment: (id: string): StoredAttachment | undefined => {
      const row = one<AttachmentRow>('select * from attachments where id = ?', id)
      return row ? toAttachment(row) : undefined
    },
    /** Pending uploads are bound to a message when it is sent. Edits copy rows so branches stay independent. */
    bindAttachments: (ids: readonly string[], messageId: string) =>
      transaction(() => {
        for (const id of ids) {
          const a = one<AttachmentRow>('select * from attachments where id = ?', id)
          if (!a) continue
          if (a.message_id === null) {
            run('update attachments set message_id = ? where id = ?', messageId, id)
          } else if (a.message_id !== messageId) {
            run(
              `insert into attachments (id, message_id, name, mime, size, kind, path, created_at, analysis)
               values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              randomUUID(),
              messageId,
              a.name,
              a.mime,
              a.size,
              a.kind,
              a.path,
              a.created_at,
              a.analysis
            )
          }
        }
      }),
    storedAttachmentsFor: (messageIds: readonly string[]) => attachmentsFor(messageIds),
    setAnalysis: (id: string, analysis: AudioAnalysis) => {
      run('update attachments set analysis = ? where id = ?', JSON.stringify(analysis), id)
    },
    /** Removes a pending (unsent) attachment and reports whether its file is now unreferenced. */
    discardAttachment: (id: string): string | null => {
      const a = one<AttachmentRow>('select * from attachments where id = ? and message_id is null', id)
      if (!a) return null
      run('delete from attachments where id = ?', id)
      return one('select 1 from attachments where path = ?', a.path) ? null : a.path
    },
    /** Pending uploads older than the cutoff were abandoned; returns their unreferenced files. */
    pruneOrphanAttachments: (olderThan: number): string[] =>
      transaction(() => {
        const rows = all<AttachmentRow>(
          'select * from attachments where message_id is null and created_at < ?',
          olderThan
        )
        run('delete from attachments where message_id is null and created_at < ?', olderThan)
        return rows.map((r) => r.path).filter((p) => !one('select 1 from attachments where path = ?', p))
      }),
    getBoard: (messageId: string, identifier: string): unknown =>
      parseJson<unknown>(
        one<{ data: string }>('select data from boards where message_id = ? and identifier = ?', messageId, identifier)?.data ?? null
      ),
    saveBoard: (messageId: string, identifier: string, data: unknown) => {
      run(
        `insert into boards (message_id, identifier, data, updated_at) values (?, ?, ?, ?)
         on conflict (message_id, identifier) do update set data = excluded.data, updated_at = excluded.updated_at`,
        messageId,
        identifier,
        JSON.stringify(data),
        Date.now()
      )
    },
    /** Every edited board on these messages, keyed by message id and then identifier. */
    boardsFor: (messageIds: readonly string[]): Map<string, Map<string, unknown>> => {
      const map = new Map<string, Map<string, unknown>>()
      if (messageIds.length === 0) return map
      const rows = all<{ message_id: string; identifier: string; data: string }>(
        `select message_id, identifier, data from boards where message_id in (${messageIds.map(() => '?').join(',')})`,
        ...messageIds
      )
      for (const r of rows) {
        const boards = map.get(r.message_id) ?? new Map<string, unknown>()
        boards.set(r.identifier, parseJson<unknown>(r.data))
        map.set(r.message_id, boards)
      }
      return map
    },
    liveFacts,
    memoryRev,
    changeMemory,
    memoryHistory,
    restoreMemory,
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
    },
    close: () => db.close()
  }
}

export type DbApi = ReturnType<typeof makeDb>

/**
 * Effect façade over the synchronous SQLite repository. `use` turns any thrown
 * error into a typed `DbError`; `require` turns a missing row into `NotFound`.
 */
export class Db extends Context.Service<
  Db,
  {
    readonly use: <A>(f: (db: DbApi) => A) => Effect.Effect<A, DbError>
    readonly require: <A>(what: string, f: (db: DbApi) => A | undefined) => Effect.Effect<A, DbError | NotFound>
  }
>()('chat-v2/Db') {
  static readonly layer = (file: string) =>
    Layer.effect(
      Db,
      Effect.acquireRelease(
        Effect.try({
          try: () => makeDb(file),
          catch: (cause) => new DbError({ message: `Could not open database: ${errorMessage(cause)}`, cause })
        }),
        (db) => Effect.sync(() => db.close())
      ).pipe(
        Effect.map((api) => {
          const use = <A>(f: (db: DbApi) => A) =>
            Effect.try({
              try: () => f(api),
              catch: (cause) => new DbError({ message: errorMessage(cause), cause })
            })
          return Db.of({
            use,
            require: (what, f) =>
              use(f).pipe(
                Effect.flatMap((a) =>
                  a === undefined ? Effect.fail(new NotFound({ message: `${what} not found` })) : Effect.succeed(a)
                )
              )
          })
        })
      )
    )
}
