// Bots and jobs in chat.db: the schema change that brings them in, and the queries over them.
//
// A bot is a persistent agent; one of them is the primary (Tomo), the one the user talks to. A job
// is one piece of work handed off (to a worker, or to Tomo itself), which the user switches between
// as they did chats. A thread is a `sessions` row: a job's thread (kind 'shared') is a chat as
// before, with its branches, forks, Claude Code sessions and artifacts; each bot working on a job
// has a thread of its own on it (kind 'worker'). The primary's conversation is a session too (kind
// 'primary'): everything the user says to Tomo is a turn there, marked with `via_session_id`, and
// bots' reports and messages to the primary arrive in it as turns of their own. Before that, each
// turn the user sent landed in a job's thread (routed), marked the same way: the conversation is
// read back from all those turns, old and new, in order.
import { randomUUID } from 'node:crypto'
import type { SQLInputValue } from 'node:sqlite'
import type { Bot, BotPatch, Effort, Job, JobStatus, JobUsage, Message, MessageStatus, PathNode, Post, Role, Session } from '@shared/types'
import { AVATAR_TINTS } from '@shared/bots'
import { cleanModules, cleanRules } from '@shared/rules'
import { isTopicStart } from '../agent/history'

/** The primary bot and its conversation, as the migration makes them. */
export const PRIMARY_BOT_ID = 'tomo'
const PRIMARY_SESSION_ID = 'tomo-primary'

const NOW = `cast(strftime('%s', 'now') as integer) * 1000`

/**
 * Bots and jobs. One primary bot (Tomo); every chat becomes a finished job with one thread owned by
 * it (the job takes the chat's id); forks become child jobs of what they forked. The primary's
 * instructions, model and effort stay null here: config.json isn't readable from SQL, so they are
 * filled in from Settings when the app starts (seedPrimary). Triggers keep a job's title and time
 * in step with its thread, reopen a job the user writes in again, and sign each reply with its bot.
 */
export const BOTS_AND_JOBS_MIGRATION = `create table bots (
    id text primary key,
    name text not null,
    avatar text,
    instructions text,
    model text,
    effort text,
    modules text not null default '[]',
    rules text not null default '{}',
    playbook text,
    is_primary integer not null default 0,
    created_at integer not null,
    updated_at integer not null
  );
  create unique index bots_one_primary on bots(is_primary) where is_primary = 1;
  create table jobs (
    id text primary key,
    title text not null,
    status text not null default 'open',
    owner_bot_id text references bots(id) on delete set null,
    parent_job_id text references jobs(id) on delete set null,
    summary text,
    usage text,
    created_at integer not null,
    updated_at integer not null
  );
  create index jobs_by_time on jobs(status, updated_at);
  alter table sessions add column bot_id text references bots(id) on delete set null;
  alter table sessions add column job_id text references jobs(id) on delete cascade;
  alter table sessions add column kind text not null default 'shared';
  create index sessions_job on sessions(job_id);
  alter table messages add column author_bot_id text references bots(id) on delete set null;
  alter table messages add column via_session_id text;
  create index messages_via on messages(via_session_id);

  insert into bots (id, name, avatar, modules, rules, is_primary, created_at, updated_at)
    values ('${PRIMARY_BOT_ID}', 'Tomo', 'mascot', '["browser","computer"]', '{}', 1, ${NOW}, ${NOW});
  insert into jobs (id, title, status, owner_bot_id, created_at, updated_at, usage)
    select s.id, s.title, 'done', '${PRIMARY_BOT_ID}', s.created_at, s.updated_at,
      (select json_object('cost', coalesce(sum(json_extract(m.usage, '$.cost')), 0),
                          'tokens', coalesce(sum(json_extract(m.usage, '$.totalTokens')), 0),
                          'replies', count(*))
         from messages m where m.session_id = s.id and m.role = 'assistant' and m.usage is not null)
    from sessions s;
  update jobs set parent_job_id = (select s.forked_from_session_id from sessions s where s.id = jobs.id)
    where exists (select 1 from sessions s join sessions p on p.id = s.forked_from_session_id where s.id = jobs.id);
  update sessions set bot_id = '${PRIMARY_BOT_ID}', job_id = id, kind = 'shared';
  update messages set author_bot_id = '${PRIMARY_BOT_ID}' where role = 'assistant';
  insert into sessions (id, title, root_id, created_at, updated_at, bot_id, job_id, kind)
    values ('${PRIMARY_SESSION_ID}', 'Tomo', '${PRIMARY_SESSION_ID}-root', ${NOW}, ${NOW}, '${PRIMARY_BOT_ID}', null, 'primary');
  insert into messages (id, session_id, parent_id, role, content, status, created_at)
    values ('${PRIMARY_SESSION_ID}-root', '${PRIMARY_SESSION_ID}', null, 'root', '', 'complete', ${NOW});

  create trigger jobs_follow_title after update of title on sessions
    when new.job_id is not null and new.kind = 'shared' and new.title != old.title
    begin update jobs set title = new.title where id = new.job_id; end;
  create trigger jobs_follow_activity after update of updated_at on sessions
    when new.job_id is not null
    begin update jobs set updated_at = max(updated_at, new.updated_at) where id = new.job_id; end;
  create trigger jobs_reopen after insert on messages
    when new.role = 'user'
    begin update jobs set status = 'open' where status != 'open' and id = (select job_id from sessions where id = new.session_id); end;
  create trigger messages_author after insert on messages
    when new.role = 'assistant' and new.author_bot_id is null
    begin update messages set author_bot_id = (select bot_id from sessions where id = new.session_id) where id = new.id; end;`

/**
 * Rules replace each chat's Browser and Computer switches: the primary bot has a module if any
 * chat had it on (phase 1 gave it both, unused until now); like the switches, both start off.
 * Its rules start empty, which is every rule's default. The old columns stay.
 */
export const BOT_MODULES_MIGRATION = `update bots set modules = (
    select json_group_array(m) from (
      select 'computer' as m where exists (select 1 from sessions where computer_enabled = 1)
      union all
      select 'browser' where exists (select 1 from sessions where browser_enabled = 1)
    )
  ), updated_at = ${NOW} where is_primary = 1;`

/**
 * Workers (phase 3). Bots talk in a job's shared thread, in posts: assistant rows signed by their
 * bot (author_bot_id), with what kind of post each is and who it is for (null: everyone on the
 * job), and whether it is held for the user's OK, was declined, or was stopped from bouncing. A
 * worker's own thread is a session of kind 'worker'; the turns bots send it are user rows signed by
 * the bot that sent them. Presence reads each bot's latest reply, hence the index.
 */
export const WORKERS_MIGRATION = `alter table messages add column post_kind text;
  alter table messages add column post_to text;
  alter table messages add column post_state text;
  create index messages_author on messages(author_bot_id, seq);`

interface BotRow {
  id: string
  name: string
  avatar: string | null
  instructions: string | null
  model: string | null
  effort: string | null
  modules: string
  rules: string
  playbook: string | null
  is_primary: number
  created_at: number
  updated_at: number
}

interface JobRow {
  id: string
  title: string
  status: string
  owner_bot_id: string | null
  parent_job_id: string | null
  summary: string | null
  usage: string | null
  created_at: number
  updated_at: number
  thread_id: string | null
}

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

const json = <T>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

const toBot = (r: BotRow): Bot => ({
  id: r.id,
  name: r.name,
  avatar: r.avatar,
  instructions: r.instructions,
  model: r.model,
  effort: EFFORTS.find((e) => e === r.effort) ?? null,
  modules: cleanModules(json<unknown>(r.modules, [])),
  rules: cleanRules(json<unknown>(r.rules, {})),
  playbook: r.playbook,
  isPrimary: r.is_primary === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

const toJob = (r: JobRow): Job => ({
  id: r.id,
  title: r.title,
  status: r.status === 'done' ? 'done' : 'open',
  ownerBotId: r.owner_bot_id,
  parentJobId: r.parent_job_id,
  summary: r.summary,
  usage: json<JobUsage | null>(r.usage, null),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  threadId: r.thread_id
})

// A job's thread is its first shared one; its bots' own threads are 'worker' sessions.
const JOB_SELECT = `select j.*, (select s.id from sessions s where s.job_id = j.id and s.kind = 'shared' order by s.created_at, s.rowid limit 1) as thread_id from jobs j`

/** What makeDb lends the repository. */
export interface JobsDbDeps {
  all: <T>(sql: string, ...params: SQLInputValue[]) => T[]
  one: <T>(sql: string, ...params: SQLInputValue[]) => T | undefined
  run: (sql: string, ...params: SQLInputValue[]) => { changes: number | bigint }
  transaction: <A>(f: () => A) => A
  getSession: (id: string) => Session | undefined
  createSession: (input: { title: string; model: string | null; systemPrompt: string | null; forkedFromSessionId: string | null }) => Session
  forkSession: (sessionId: string, messageId: string) => Session
  deleteSession: (id: string) => { files: string[]; agentSessions: string[] }
  activePath: (session: Session) => PathNode[]
  insertMessage: (m: NewMessage) => Message
  getMessage: (id: string) => Message | undefined
}

/** What a new message row may carry (Db.ts insertMessage). */
export interface NewMessage {
  sessionId: string
  parentId: string
  role: Role
  content: string
  status: MessageStatus
  model?: string | null
  authorBotId?: string | null
  post?: Post | null
}

/** The primary's conversation shows this many of its latest turns. */
export const PRIMARY_TURNS = 80

export const makeJobsDb = ({ all, one, run, transaction, getSession, createSession, forkSession, deleteSession, activePath, insertMessage, getMessage }: JobsDbDeps) => {
  const primaryBot = (): Bot => {
    const row = one<BotRow>('select * from bots where is_primary = 1')
    if (row) return toBot(row)
    // Only if someone deleted it by hand: a primary is always there.
    const now = Date.now()
    run(
      `insert into bots (id, name, avatar, modules, rules, is_primary, created_at, updated_at) values (?, 'Tomo', 'mascot', '[]', '{}', 1, ?, ?)
       on conflict(id) do update set is_primary = 1`,
      PRIMARY_BOT_ID,
      now,
      now
    )
    return toBot(one<BotRow>('select * from bots where is_primary = 1')!)
  }

  const getBot = (id: string): Bot | undefined => {
    const row = one<BotRow>('select * from bots where id = ?', id)
    return row ? toBot(row) : undefined
  }

  /** The primary's conversation (made again if it went missing). */
  const primarySession = (): Session =>
    transaction(() => {
      const bot = primaryBot()
      const row = one<{ id: string }>(`select id from sessions where kind = 'primary' and bot_id = ? order by created_at limit 1`, bot.id)
      if (row) return getSession(row.id)!
      const s = createSession({ title: bot.name, model: null, systemPrompt: null, forkedFromSessionId: null })
      run(`update sessions set kind = 'primary', bot_id = ? where id = ?`, bot.id, s.id)
      return getSession(s.id)!
    })

  const getJob = (id: string): Job | undefined => {
    const row = one<JobRow>(`${JOB_SELECT} where j.id = ?`, id)
    return row ? toJob(row) : undefined
  }

  const jobOfSession = (sessionId: string): Job | undefined => {
    const row = one<{ job_id: string | null }>('select job_id from sessions where id = ?', sessionId)
    return row?.job_id ? getJob(row.job_id) : undefined
  }

  /**
   * A new job and its shared thread, owned by `botId`. The thread is answered by `threadBotId`
   * (the owner, unless said otherwise: a job handed to a worker keeps the primary on its thread).
   */
  const createJob = (input: {
    title: string
    botId: string
    parentJobId?: string | null
    threadBotId?: string
  }): { job: Job; thread: Session } =>
    transaction(() => {
      const id = randomUUID()
      const now = Date.now()
      run(
        `insert into jobs (id, title, status, owner_bot_id, parent_job_id, created_at, updated_at) values (?, ?, 'open', ?, ?, ?, ?)`,
        id,
        input.title,
        input.botId,
        input.parentJobId ?? null,
        now,
        now
      )
      const thread = createSession({ title: input.title, model: null, systemPrompt: null, forkedFromSessionId: null })
      run(`update sessions set job_id = ?, bot_id = ?, kind = 'shared' where id = ?`, id, input.threadBotId ?? input.botId, thread.id)
      return { job: getJob(id)!, thread: getSession(thread.id)! }
    })

  /** A bot's own thread on a job, made when `create` and it has none yet. */
  const workerThread = (jobId: string, botId: string, create = false): Session | undefined =>
    transaction(() => {
      const row = one<{ id: string }>(`select id from sessions where job_id = ? and bot_id = ? and kind = 'worker' order by created_at, rowid limit 1`, jobId, botId)
      if (row) return getSession(row.id)
      const job = create ? getJob(jobId) : undefined
      if (!job) return undefined
      const s = createSession({ title: job.title, model: null, systemPrompt: null, forkedFromSessionId: null })
      run(`update sessions set job_id = ?, bot_id = ?, kind = 'worker' where id = ?`, jobId, botId, s.id)
      return getSession(s.id)
    })

  /** The message the active path of a thread ends on (its root when empty). */
  const leafOf = (session: Session) => activePath(session).at(-1)?.message.id ?? session.rootId

  const seqOf = (messageId: string) => one<{ seq: number }>('select seq from messages where id = ?', messageId)?.seq ?? 0

  /**
   * A bot's post at the end of a job's shared thread. `via` puts it in the primary's conversation
   * too, as a card (a notice for the user; a report to the primary arrives there as a turn instead).
   */
  const appendPost = (input: {
    threadId: string
    authorBotId: string
    text: string
    post: Post
    via?: string | null
  }): { message: Message; seq: number } =>
    transaction(() => {
      const thread = getSession(input.threadId)!
      const message = insertMessage({
        sessionId: thread.id,
        parentId: leafOf(thread),
        role: 'assistant',
        content: input.text,
        status: 'complete',
        authorBotId: input.authorBotId,
        post: input.post
      })
      if (input.via) run('update messages set via_session_id = ? where id = ?', input.via, message.id)
      return { message, seq: seqOf(message.id) }
    })

  interface PostRow {
    id: string
    seq: number
    author_bot_id: string | null
    post_to: string | null
    post_kind: string
    content: string
  }


  /** Deletes a job and its threads; returns the files and Claude Code sessions nothing else needs. */
  const deleteJob = (id: string): { files: string[]; agentSessions: string[] } =>
    transaction(() => {
      const files: string[] = []
      const agentSessions: string[] = []
      for (const { id: thread } of all<{ id: string }>('select id from sessions where job_id = ?', id)) {
        const gone = deleteSession(thread)
        files.push(...gone.files)
        agentSessions.push(...gone.agentSessions)
      }
      run('update jobs set parent_job_id = null where parent_job_id = ?', id)
      run('delete from jobs where id = ?', id)
      return { files, agentSessions }
    })

  /**
   * Takes a user turn and everything under it (its replies, and anything after) out of its thread.
   * Returns the files and Claude Code sessions nothing else refers to.
   */
  const removeTurn = (messageId: string): { files: string[]; agentSessions: string[] } =>
    transaction(() => {
      const target = one<{ parent_id: string | null }>('select parent_id from messages where id = ?', messageId)
      if (!target?.parent_id) return { files: [], agentSessions: [] }
      const ids = all<{ id: string }>(
        `with recursive sub(id) as (select ? union all select m.id from messages m join sub on m.parent_id = sub.id) select id from sub`,
        messageId
      ).map((r) => r.id)
      const list = JSON.stringify(ids)
      const paths = all<{ path: string }>('select distinct path from attachments where message_id in (select value from json_each(?))', list).map((r) => r.path)
      const sessions = all<{ s: string }>(
        'select distinct agent_session as s from messages where id in (select value from json_each(?)) and agent_session is not null',
        list
      ).map((r) => r.s)
      run('delete from messages where id in (select value from json_each(?))', list)
      // The parent shows its newest remaining child, or none.
      run(
        `update messages set active_child_id = (select id from messages c where c.parent_id = messages.id order by c.seq desc limit 1) where id = ?`,
        target.parent_id
      )
      return {
        files: paths.filter((p) => !one('select 1 from attachments where path = ?', p)),
        agentSessions: sessions.filter((s) => !one('select 1 from messages where agent_session = ?', s))
      }
    })

  /**
   * New topic in the primary's conversation: a divider (agent/history.ts isTopicStart) after which
   * its next reply starts a fresh Claude Code session. It goes after the reply on show, running or
   * not; turns waiting at the end for a reply (held while one ran) go after it, so they open the
   * new topic. `carry` is what the fresh session is handed (nothing yet). The conversation's memory
   * is read afresh too. Returns the divider, or null when there is nothing to divide (an empty
   * conversation, or one that starts a topic already).
   */
  const newTopic = (primaryId: string, carry = ''): Message | null =>
    transaction(() => {
      const session = getSession(primaryId)
      if (!session) return null
      const path = activePath(session)
      let at = path.length
      while (at > 0 && path[at - 1]!.message.role === 'user') at--
      const before = path[at - 1]?.message
      if (!before || isTopicStart(before)) return null
      const held = path[at]?.message
      const mark = insertMessage({ sessionId: session.id, parentId: before.id, role: 'assistant', content: carry, status: 'complete', post: { kind: 'topic', to: null, state: null } })
      // Shown in the conversation, and nobody's: the trigger signs assistant rows with the thread's bot.
      run('update messages set via_session_id = ?, author_bot_id = null where id = ?', session.id, mark.id)
      if (held) {
        run('update messages set parent_id = ? where id = ?', mark.id, held.id)
        run('update messages set active_child_id = ? where id = ?', held.id, mark.id)
      }
      run('update sessions set memory_rev = null where id = ?', session.id)
      return getMessage(mark.id)!
    })

  /**
   * Tomo's own boundary (rollover.ts): between its reply `afterId` and the turn `firstId` that
   * answers it, which with everything under it moves below the boundary. Never shown in the
   * conversation (no via_session_id, so primaryPath skips it). `carry` is what the fresh session
   * is handed. The conversation's memory is read afresh, as after New topic. Null when `afterId`
   * isn't one of the conversation's replies with `firstId` under it.
   */
  const rollOver = (primaryId: string, afterId: string, firstId: string, carry: string): Message | null =>
    transaction(() => {
      const after = getMessage(afterId)
      const first = getMessage(firstId)
      if (!after || !first || after.sessionId !== primaryId || first.parentId !== after.id || after.role !== 'assistant' || after.post) return null
      const mark = insertMessage({ sessionId: primaryId, parentId: after.id, role: 'assistant', content: carry, status: 'complete', post: { kind: 'rollover', to: null, state: null } })
      run('update messages set author_bot_id = null where id = ?', mark.id)
      run('update messages set parent_id = ? where id = ?', mark.id, first.id)
      run('update messages set active_child_id = ? where id = ?', first.id, mark.id)
      run('update sessions set memory_rev = null where id = ?', primaryId)
      return getMessage(mark.id)!
    })

  /**
   * The primary's conversation: the latest turns the user sent it, each with the reply its thread
   * shows, the bots' reports to it and New topic dividers, oldest first. A turn whose thread
   * switched to another branch since drops out. The conversation's own turns keep their order in
   * it: a turn held while a reply ran opens the topic after a divider made later.
   */
  const primaryPath = (primaryId: string, limit = PRIMARY_TURNS): PathNode[] => {
    const sent = all<{ id: string; session_id: string; seq: number }>(
      `select id, session_id, seq from messages where via_session_id = ? and (role = 'user' or post_kind is not null) order by seq desc limit ?`,
      primaryId,
      limit
    )
    const order = new Map(sent.map((m) => [m.id, m.seq]))
    const out: Array<{ seq: number; nodes: PathNode[] }> = []
    for (const sessionId of new Set(sent.map((m) => m.session_id))) {
      const session = getSession(sessionId)
      if (!session) continue
      const path = activePath(session)
      let floor = 0
      path.forEach((node, i) => {
        const own = order.get(node.message.id)
        if (own === undefined) return
        const seq = session.kind === 'primary' ? (floor = Math.max(floor, own)) : own
        const next = path[i + 1]
        const answered = node.message.role === 'user' && next?.message.role === 'assistant' && !next.message.post
        // A bot's report or message here, and the primary's answer to it, are about the bot's job.
        const jobId = session.kind === 'primary' && node.message.authorBotId && node.message.post?.kind !== 'topic' ? (jobOfTurn(node.message.id)?.id ?? null) : null
        const tagged = (n: PathNode): PathNode => (jobId ? { ...n, jobId } : n)
        out.push({ seq, nodes: answered ? [tagged(node), tagged(next)] : [tagged(node)] })
      })
    }
    return out.sort((a, b) => a.seq - b.seq).flatMap((t) => t.nodes)
  }

  /**
   * The job a bot's turn in the primary's conversation is about: the job whose shared thread holds
   * the same post (a report or message is posted there, then delivered). Null for any other turn.
   */
  const jobOfTurn = (messageId: string): { id: string; title: string } | null => {
    const turn = one<{ seq: number; author_bot_id: string | null; post_kind: string | null; content: string; kind: string }>(
      `select m.seq, m.author_bot_id, m.post_kind, m.content, s.kind from messages m join sessions s on s.id = m.session_id where m.id = ?`,
      messageId
    )
    if (!turn?.author_bot_id || !turn.post_kind || turn.kind !== 'primary') return null
    const row = one<{ id: string; title: string }>(
      `select j.id, j.title from messages m join sessions s on s.id = m.session_id join jobs j on j.id = s.job_id
        where m.author_bot_id = ? and m.seq < ? and m.role = 'assistant' and m.post_kind = ? and m.content = ? and s.kind = 'shared'
        order by m.seq desc limit 1`,
      turn.author_bot_id,
      turn.seq,
      turn.post_kind,
      turn.content
    )
    return row ?? null
  }

  const listBots = (): Bot[] => all<BotRow>('select * from bots order by is_primary desc, created_at, rowid').map(toBot)

  return {
    primaryBot,
    getBot,
    listBots,
    /** A new worker: no tool modules and default rules until Settings gives it some; an initial on the next tint. */
    createBot: (patch: BotPatch): Bot =>
      transaction(() => {
        const id = randomUUID()
        const now = Date.now()
        const count = one<{ n: number }>('select count(*) as n from bots')?.n ?? 0
        const avatar = patch.avatar === undefined || patch.avatar === 'mascot' ? `tint:${AVATAR_TINTS[1 + (count % (AVATAR_TINTS.length - 1))]}` : patch.avatar
        run(
          `insert into bots (id, name, avatar, instructions, model, effort, modules, rules, is_primary, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          id,
          patch.name?.trim() || 'New bot',
          avatar,
          patch.instructions ?? null,
          patch.model ?? null,
          patch.effort ?? null,
          JSON.stringify(cleanModules(patch.modules ?? [])),
          JSON.stringify(cleanRules(patch.rules ?? {})),
          now,
          now
        )
        return getBot(id)!
      }),
    /**
     * Deletes a worker; the primary stays. Its threads and posts stay too, unsigned: what it did is
     * still the user's to read. Returns whether it went.
     */
    deleteBot: (id: string): boolean => Number(run('delete from bots where id = ? and is_primary = 0', id).changes) > 0,
    /**
     * Makes `id` the primary: it hears what is said without picking a job, and answers in the
     * primary's conversation and every job's shared thread the old primary answered in.
     */
    setPrimary: (id: string) =>
      transaction(() => {
        const old = primaryBot()
        if (old.id === id || !getBot(id)) return
        run('update bots set is_primary = 0, updated_at = ? where id = ?', Date.now(), old.id)
        run('update bots set is_primary = 1, updated_at = ? where id = ?', Date.now(), id)
        run(`update sessions set bot_id = ? where kind = 'primary' or (kind = 'shared' and bot_id = ?)`, id, old.id)
      }),
    workerThread,
    /** The bots on a job: its owner, then those with a thread of their own on it, then any that posted there. */
    botsOnJob: (jobId: string): Array<{ botId: string; threadId: string | null }> => {
      const job = getJob(jobId)
      if (!job) return []
      const out = new Map<string, string | null>()
      if (job.ownerBotId) out.set(job.ownerBotId, null)
      for (const r of all<{ id: string; bot_id: string }>(`select id, bot_id from sessions where job_id = ? and kind = 'worker' and bot_id is not null order by created_at, rowid`, jobId))
        if (!out.get(r.bot_id)) out.set(r.bot_id, r.id)
      if (job.threadId)
        for (const r of all<{ a: string }>(`select distinct author_bot_id as a from messages where session_id = ? and post_kind is not null and author_bot_id is not null`, job.threadId))
          if (!out.has(r.a)) out.set(r.a, null)
      return [...out].filter(([b]) => getBot(b)).map(([botId, threadId]) => ({ botId, threadId }))
    },
    appendPost,
    setPostState: (messageId: string, state: Post['state']) => {
      run('update messages set post_state = ? where id = ?', state, messageId)
    },
    /** The newest message's place in a thread, for reading what came after it. */
    lastSeq: (threadId: string): number => one<{ s: number | null }>('select max(seq) as s from messages where session_id = ?', threadId)?.s ?? 0,
    seqOf,
    jobOfTurn,
    /**
     * Threads that may end on turns nothing answered yet (held while a reply ran): those with a user
     * turn answered by nothing, or followed only by another turn or a post. Chat.drain checks each.
     */
    heldThreads: (): string[] =>
      all<{ id: string }>(
        `select distinct m.session_id as id from messages m left join messages c on c.id = m.active_child_id
          where m.role = 'user' and (c.id is null or c.role = 'user' or c.post_kind is not null)`
      ).map((r) => r.id),
    /**
     * Where the newest turn a bot sent a thread is (0 if none): every post addressed to the thread's
     * bot before it was delivered, as posts are handed over in order as they are made.
     */
    lastBotTurnSeq: (sessionId: string): number =>
      one<{ s: number | null }>(`select max(seq) as s from messages where session_id = ? and role = 'user' and author_bot_id is not null`, sessionId)?.s ?? 0,
    /** Where a bot last posted in a shared thread (0 if it never did). */
    lastPostSeq: (threadId: string, botId: string): number =>
      one<{ s: number | null }>('select max(seq) as s from messages where session_id = ? and author_bot_id = ? and post_kind is not null', threadId, botId)?.s ?? 0,
    /**
     * Posts in a shared thread after `afterSeq` addressed to `botId` (or to everyone) by another bot,
     * only `from` when given; held, declined and stopped ones never reached anyone.
     */
    postsFor: (threadId: string, botId: string, afterSeq: number, from?: string | null): Array<{ seq: number; message: Message }> =>
      all<{ id: string; seq: number }>(
        `select id, seq from messages where session_id = ? and seq > ? and post_kind is not null and post_state is null
           and author_bot_id is not null and author_bot_id != ? and (post_to = ? or post_to is null) and (? is null or author_bot_id = ?)
         order by seq`,
        threadId,
        afterSeq,
        botId,
        botId,
        from ?? null,
        from ?? null
      ).flatMap((r) => {
        const message = getMessage(r.id)
        return message ? [{ seq: r.seq, message }] : []
      }),
    /**
     * The latest posts between bots in a shared thread, oldest first, for spotting a request
     * bouncing: messages and reports that went through or were stopped for bouncing already.
     */
    recentPosts: (threadId: string, limit: number): Array<{ from: string; to: string | null; text: string }> =>
      all<PostRow>(
        `select id, seq, author_bot_id, post_to, post_kind, content from messages
          where session_id = ? and post_kind in ('message', 'report') and (post_state is null or post_state = 'stopped')
            and author_bot_id is not null and author_bot_id != coalesce(post_to, '') order by seq desc limit ?`,
        threadId,
        limit
      )
        .reverse()
        .map((r) => ({ from: r.author_bot_id!, to: r.post_to, text: r.content })),
    /** A bot's latest reply (never a post), for its presence. */
    latestReply: (botId: string): { status: MessageStatus; createdAt: number; sessionId: string } | null => {
      const row = one<{ status: string; created_at: number; session_id: string }>(
        `select status, created_at, session_id from messages where author_bot_id = ? and role = 'assistant' and post_kind is null order by seq desc limit 1`,
        botId
      )
      return row ? { status: row.status as MessageStatus, createdAt: row.created_at, sessionId: row.session_id } : null
    },
    updateBot: (id: string, patch: BotPatch) => {
      const now = Date.now()
      if (patch.name !== undefined) run('update bots set name = ?, updated_at = ? where id = ?', patch.name, now, id)
      if (patch.instructions !== undefined) run('update bots set instructions = ?, updated_at = ? where id = ?', patch.instructions, now, id)
      if (patch.model !== undefined) run('update bots set model = ?, updated_at = ? where id = ?', patch.model, now, id)
      if (patch.effort !== undefined) run('update bots set effort = ?, updated_at = ? where id = ?', patch.effort, now, id)
      if (patch.avatar !== undefined) run('update bots set avatar = ?, updated_at = ? where id = ?', patch.avatar, now, id)
      if (patch.modules !== undefined) run('update bots set modules = ?, updated_at = ? where id = ?', JSON.stringify(cleanModules(patch.modules)), now, id)
      if (patch.rules !== undefined) run('update bots set rules = ?, updated_at = ? where id = ?', JSON.stringify(cleanRules(patch.rules)), now, id)
    },
    /** Fills in the primary from Settings once: its instructions, model and effort start as today's. */
    seedPrimary: (from: { systemPrompt: string; defaultModel: string; effort: Effort }): boolean => {
      const bot = primaryBot()
      if (bot.instructions !== null) return false
      run(
        'update bots set instructions = ?, model = coalesce(model, ?), effort = coalesce(effort, ?), updated_at = ? where id = ?',
        from.systemPrompt,
        from.defaultModel,
        from.effort,
        Date.now(),
        bot.id
      )
      return true
    },
    /** The bot a thread belongs to; threads from before bots count as the primary's. */
    botOf: (sessionId: string): Bot => {
      const row = one<{ bot_id: string | null }>('select bot_id from sessions where id = ?', sessionId)
      return (row?.bot_id ? getBot(row.bot_id) : undefined) ?? primaryBot()
    },
    primarySession,
    listJobs: (): Job[] => all<JobRow>(`${JOB_SELECT} order by j.updated_at desc`).map(toJob),
    getJob,
    jobOfSession,
    createJob,
    deleteJob,
    setJobStatus: (id: string, status: JobStatus) => {
      run('update jobs set status = ? where id = ?', status, id)
    },
    setJobSummary: (id: string, summary: string | null) => {
      run('update jobs set summary = ? where id = ?', summary, id)
    },
    /** Renames a job and its threads. */
    renameJob: (id: string, title: string) =>
      transaction(() => {
        run('update jobs set title = ? where id = ?', title, id)
        run(`update sessions set title = ? where job_id = ? and kind != 'primary'`, title, id)
      }),
    /** Adds up what a job's replies used. */
    refreshJobUsage: (id: string): JobUsage => {
      const row = one<{ cost: number | null; tokens: number | null; replies: number }>(
        `select sum(json_extract(m.usage, '$.cost')) as cost, sum(json_extract(m.usage, '$.totalTokens')) as tokens, count(*) as replies
           from messages m join sessions s on s.id = m.session_id
          where s.job_id = ? and m.role = 'assistant' and m.usage is not null`,
        id
      )
      const usage: JobUsage = { cost: row?.cost ?? 0, tokens: row?.tokens ?? 0, replies: row?.replies ?? 0 }
      run('update jobs set usage = ? where id = ?', JSON.stringify(usage), id)
      return usage
    },
    /** Forks a job's thread from a message into a new job, a child of the first. */
    forkThread: (sessionId: string, messageId: string): Session =>
      transaction(() => {
        const source = getSession(sessionId)!
        const fork = forkSession(sessionId, messageId)
        const parent = source.jobId ? getJob(source.jobId) : undefined
        const id = randomUUID()
        const now = Date.now()
        run(
          `insert into jobs (id, title, status, owner_bot_id, parent_job_id, created_at, updated_at) values (?, ?, 'open', ?, ?, ?, ?)`,
          id,
          fork.title,
          source.botId ?? primaryBot().id,
          parent?.id ?? null,
          now,
          now
        )
        const bot = source.botId ?? primaryBot().id
        run(`update sessions set job_id = ?, bot_id = ?, kind = 'shared' where id = ?`, id, bot, fork.id)
        // The copies were made before the fork had a bot to sign them with.
        run(`update messages set author_bot_id = ? where session_id = ? and role = 'assistant' and author_bot_id is null`, bot, fork.id)
        return getSession(fork.id)!
      }),
    /** Marks a user turn as one the user sent to `viaSessionId` (the primary's conversation). */
    markVia: (messageId: string, viaSessionId: string) => {
      run('update messages set via_session_id = ? where id = ?', viaSessionId, messageId)
    },
    primaryPath,
    newTopic,
    rollOver,
    removeTurn,
    /** Jobs that lost every thread (an empty one cleared at startup). */
    pruneOrphanJobs: (): number => Number(run('delete from jobs where not exists (select 1 from sessions s where s.job_id = jobs.id)').changes)
  }
}

export type JobsDb = ReturnType<typeof makeJobsDb>
