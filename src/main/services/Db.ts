import { randomUUID } from 'node:crypto'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { Context, Effect, Layer } from 'effect'
import type {
  Attachment,
  AttachmentKind,
  Message,
  MessageStatus,
  PathNode,
  Role,
  AudioAnalysis,
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
  );`
]

interface SessionRow {
  id: string
  title: string
  model: string | null
  system_prompt: string | null
  root_id: string
  forked_from_session_id: string | null
  browser_enabled: number
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

  const all = <T>(sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as unknown as T[]
  const one = <T>(sql: string, ...params: SQLInputValue[]) =>
    db.prepare(sql).get(...params) as unknown as T | undefined
  const run = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).run(...params)

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

  const toMessages = (rows: MessageRow[]): Message[] => {
    const atts = attachmentsFor(rows.map((r) => r.id))
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      parentId: r.parent_id,
      activeChildId: r.active_child_id,
      role: r.role as Role,
      content: r.content,
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
    getSession,
    createSession,
    updateSession: (
      id: string,
      patch: { title?: string; model?: string | null; systemPrompt?: string | null; browserEnabled?: boolean }
    ) => {
      if (patch.browserEnabled !== undefined)
        run('update sessions set browser_enabled = ? where id = ?', patch.browserEnabled ? 1 : 0, id)
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
    appendLine: (messageId: string, text: string): number => {
      const row = one<{ line_count: number }>(
        `update messages
           set content = case when line_count = 0 then ? else content || char(10) || ? end,
               line_count = line_count + 1
         where id = ? returning line_count`,
        text,
        text,
        messageId
      )
      return (row?.line_count ?? 1) - 1
    },
    setStatus: (messageId: string, status: MessageStatus, error: string | null = null, tailPartial = false) => {
      run(
        'update messages set status = ?, error = ?, tail_partial = ? where id = ?',
        status,
        error,
        tailPartial ? 1 : 0,
        messageId
      )
    },
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
      Number(run(`update messages set status = 'interrupted' where status = 'streaming'`).changes),
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
