// Export log: a thread's whole job in one zip, for a user to attach when they report a problem.
//
// log.md reads top to bottom: the job, its bots and notes, then every thread on it (every branch,
// oldest first), each reply with its error and the tool calls it made (input, result, and whether
// it failed), and the primary's own turns about the job (the reply that started it, the bots'
// reports to it and its answers). log.json is the same as data. transcripts/ holds Claude Code's
// own session files for the threads' replies, whole; of the primary's conversation, one session
// across every job, only the entries of its replies about this job. attachments/ holds the files
// sent in the threads.
//
// A reply's tool calls are read from its Claude Code session: walking back from the last entry it
// wrote (its checkpoint) along parentUuid to the prompt that started it. Parallel calls fork that
// chain (their results hang off the first call), so results are found by tool_use_id across the
// file. Only 'user' and 'assistant' entries count: 'api-request-blob' entries repeat what was sent.
import { open, readFile, rename, rm, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { promisify } from 'node:util'
import * as zlib from 'node:zlib'
import { parseStep } from '@shared/steps'
import type { Bot, Job, MemoryRecord, Session, Settings } from '@shared/types'
import type { DbApi, LoggedMessage, StoredAttachment } from './services/Db'

/** What a log is of: a job's threads (or the primary's conversation), with who is on it. */
export interface LogData {
  job: Job | null
  /** Each thread's messages, every branch, oldest first; `shown` is the branch the thread shows. */
  threads: Array<{ session: Session; messages: LoggedMessage[]; shown: string[] }>
  /** The primary's own turns about the job: the reply that started it, the bots' reports to it and its answers. */
  primary: LoggedMessage[]
  bots: Bot[]
  notes: MemoryRecord[]
}

/** The primary's turns in its own conversation that are about `job`. */
const primaryTurns = (d: DbApi, job: Job): LoggedMessage[] => {
  const conversation = d.threadLog(d.primarySession().id)
  const byId = new Map(conversation.map((m) => [m.id, m]))
  const keep = new Set<string>()
  /** A turn and the user turns it answers, back to the reply before them. */
  const withAsked = (m: LoggedMessage) => {
    keep.add(m.id)
    for (let up = m.parentId ? byId.get(m.parentId) : undefined; up?.role === 'user'; up = up.parentId ? byId.get(up.parentId) : undefined) keep.add(up.id)
  }
  // The reply that opened it: the last one started before the job was, that started a job.
  const starter = conversation.findLast((m) => m.role === 'assistant' && !m.post && m.createdAt <= job.createdAt && m.content.includes('"tool":"team_start_job"'))
  if (starter) withAsked(starter)
  // The bots' reports and messages to the primary about it, and its answers to them.
  for (const m of conversation) {
    if (!m.post || !m.authorBotId || d.jobOfTurn(m.id)?.id !== job.id) continue
    keep.add(m.id)
    for (const answer of conversation) if (answer.parentId === m.id && answer.role === 'assistant' && !answer.post) keep.add(answer.id)
  }
  return conversation.filter((m) => keep.has(m.id))
}

/** What a log of `sessionId` holds: its job's every thread, or the one thread when it has no job. */
export const collectLog = (d: DbApi, sessionId: string): LogData | undefined => {
  const session = d.getSession(sessionId)
  if (!session) return undefined
  const job = session.jobId ? (d.getJob(session.jobId) ?? null) : null
  const sessions = job ? d.jobThreads(job.id) : [session]
  return {
    job,
    threads: sessions.map((s) => ({ session: s, messages: d.threadLog(s.id), shown: d.activePath(s).map((n) => n.message.id) })),
    primary: job ? primaryTurns(d, job) : [],
    // A picture avatar is a data URL: of no use in a log.
    bots: d.listBots().map((b) => (b.avatar?.startsWith('image:') ? { ...b, avatar: 'image' } : b)),
    notes: job ? d.jobNotes(job.id) : []
  }
}

// ---- Claude Code transcripts ------------------------------------------------------------------

export interface ToolCall {
  id: string
  name: string
  input: unknown
  /** When the model asked for it (ISO time), as the transcript has it. */
  at: string | null
  /** The result's text (images as [image]); null while it has none. */
  result: string | null
  /** Its result was an error: it failed, or was refused. */
  failed: boolean
}

interface Entry {
  type?: string
  uuid?: string
  parentUuid?: string | null
  timestamp?: string
  isMeta?: boolean
  isApiErrorMessage?: boolean
  error?: unknown
  /** `id` is the model call's: every entry one call wrote has it (assistant entries only). */
  message?: { id?: string; content?: unknown }
}

export interface Transcript {
  entries: Map<string, Entry>
  calls: Map<string, ToolCall>
  /** The entry holding each call's result, by call id. */
  results: Map<string, string>
  /** Each model call's assistant entries, in the file's order, by its message id. */
  byCall: Map<string, string[]>
}

type Block = { type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean; text?: string }

const blocks = (e: Entry): Block[] => (Array.isArray(e.message?.content) ? (e.message.content as Block[]) : [])

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? (content as Block[]).map((b) => (b.type === 'text' ? (b.text ?? '') : b.type === 'image' ? '[image]' : b.type ? `[${b.type}]` : '')).join('\n')
      : content == null
        ? ''
        : JSON.stringify(content)

/** Reads a Claude Code session file: its entries by uuid, and every tool call in it with its result. */
export const readTranscript = (jsonl: string): Transcript => {
  const entries = new Map<string, Entry>()
  const calls = new Map<string, ToolCall>()
  const results = new Map<string, string>()
  const byCall = new Map<string, string[]>()
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let e: Entry
    try {
      e = JSON.parse(line) as Entry
    } catch {
      continue
    }
    // Any entry may be a link in a reply's chain ('attachment' entries are: what a hook added).
    if (e.uuid) entries.set(e.uuid, e)
    if (e.type !== 'user' && e.type !== 'assistant') continue
    const call = e.type === 'assistant' ? e.message?.id : undefined
    if (call && e.uuid) {
      const list = byCall.get(call)
      if (list) list.push(e.uuid)
      else byCall.set(call, [e.uuid])
    }
    for (const b of blocks(e)) {
      if (e.type === 'assistant' && b.type === 'tool_use' && b.id)
        calls.set(b.id, { id: b.id, name: String(b.name ?? ''), input: b.input ?? null, at: e.timestamp ?? null, result: null, failed: false })
      if (e.type === 'user' && b.type === 'tool_result' && b.tool_use_id) {
        const call = calls.get(b.tool_use_id)
        if (call) Object.assign(call, { result: textOf(b.content), failed: b.is_error === true })
        if (call && e.uuid) results.set(b.tool_use_id, e.uuid)
      }
    }
  }
  return { entries, calls, results, byCall }
}

/** The lines of a session file whose entries are in `uuids`, in the file's order. */
export const excerpt = (jsonl: string, uuids: ReadonlySet<string>): string =>
  jsonl
    .split('\n')
    .filter((line) => {
      const m = /"uuid":"([^"]+)"/.exec(line)
      if (!m) return false
      try {
        const uuid = (JSON.parse(line) as Entry).uuid
        return !!uuid && uuids.has(uuid)
      } catch {
        return false
      }
    })
    .map((line) => `${line}\n`)
    .join('')

/** Continue's prompt (agent/history.ts continueNote): the reply it continues goes on before it. */
const CONTINUE = /^Your reply (above )?was cut off/

/** A user entry that is a prompt: what started a reply, rather than a tool's result. */
const promptText = (e: Entry): string | null => {
  if (e.type !== 'user' || e.isMeta) return null
  const content = e.message?.content
  if (typeof content === 'string') return content
  const list = blocks(e)
  return list.length > 0 && !list.some((b) => b.type === 'tool_result') ? textOf(list) : null
}

export interface ReplyActivity {
  calls: ToolCall[]
  apiErrors: string[]
  /** Every entry the reply is made of: its chain back to its prompt (included), and its calls' results. */
  entries: Set<string>
}

/**
 * What a reply did in its session: its tool calls, oldest first, and the API errors it met. The
 * chain passes through only some of a model call's entries (one per content block, and parallel
 * calls fork), so every entry of each call it passes through is the reply's.
 */
export const replyActivity = (t: Transcript, checkpoint: string): ReplyActivity => {
  const apiErrors: string[] = []
  const seen = new Set<string>()
  /** The reply's model calls, newest first: each one's entries. */
  const turns: string[][] = []
  const taken = new Set<string>()
  for (let e = t.entries.get(checkpoint); e?.uuid && !seen.has(e.uuid); e = e.parentUuid ? t.entries.get(e.parentUuid) : undefined) {
    seen.add(e.uuid)
    const prompt = promptText(e)
    if (prompt !== null && !CONTINUE.test(prompt.trimStart())) break
    if (e.type !== 'assistant') continue
    if (e.isApiErrorMessage || e.error) apiErrors.unshift(textOf(e.message?.content) || String(e.error))
    const call = e.message?.id
    if (call && taken.has(call)) continue
    if (call) taken.add(call)
    turns.push(call ? (t.byCall.get(call) ?? [e.uuid]) : [e.uuid])
  }
  const ids: string[] = []
  for (const turn of turns.reverse())
    for (const uuid of turn) {
      seen.add(uuid)
      const e = t.entries.get(uuid)
      if (e) for (const b of blocks(e)) if (b.type === 'tool_use' && b.id && !ids.includes(b.id)) ids.push(b.id)
    }
  for (const id of ids) {
    const result = t.results.get(id)
    if (result) seen.add(result)
  }
  return { calls: ids.flatMap((id) => t.calls.get(id) ?? []), apiErrors, entries: seen }
}

// ---- log.md ------------------------------------------------------------------------------------

/** About the app the log came from. */
export interface LogAbout {
  version: string
  platform: string
  arch: string
  os: string
  electron: string | null
}

/** What an attachment became in the archive: its file there, or why it was left out. */
type Placed = { file: string } | { skipped: string }

const when = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z')

const size = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** A fenced block that no backtick run in the text can close early. */
const fence = (text: string, lang = '') => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length))
  const bar = '`'.repeat(Math.max(3, longest + 1))
  return `${bar}${lang}\n${text}\n${bar}`
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters; the whole of it is in the transcript)` : text)

const json = (v: unknown) => {
  try {
    return JSON.stringify(v, null, 2) ?? String(v)
  } catch {
    return String(v)
  }
}

/** A message's text with its step lines as a list: ✓ done, ✗ failed, ⊘ denied. */
const contentText = (content: string) =>
  content
    .split('\n')
    .map((line) => {
      const step = parseStep(line)
      if (!step) return line
      const mark = step.denied ? '⊘' : step.ok ? '✓' : '✗'
      return `[${mark} ${step.tool || 'step'}] ${step.label}${step.detail ? ` · ${step.detail}` : ''}`
    })
    .join('\n')

export interface RenderInput {
  data: LogData
  about: LogAbout
  settings: Settings | null
  exportedAt: number
  /** The transcripts read, by Claude Code session id; a session missing here had no file left. */
  transcripts: Map<string, Transcript>
  /** Each transcript's file in the archive, and those that are there whole (not an excerpt). */
  transcriptFile: Map<string, string>
  whole: ReadonlySet<string>
  /** What each reply did in its session, by message id. */
  activity: Map<string, ReplyActivity>
  placed: Map<string, Placed>
}

/** log.md. */
export const renderLog = (input: RenderInput): string => {
  const { data, about, settings, transcripts, placed } = input
  const out: string[] = []
  const nameOf = (id: string | null) => (id ? (data.bots.find((b) => b.id === id)?.name ?? 'a deleted bot') : null)
  const listed = new Set<string>()

  const title = data.job?.title ?? data.threads[0]?.session.title ?? 'thread'
  out.push(`# Tomo log: ${title}`, '')
  out.push(`Exported ${when(input.exportedAt)} from Tomo ${about.version} on ${about.platform} ${about.arch} (${about.os})${about.electron ? `, Electron ${about.electron}` : ''}.`, '')
  out.push(
    'This holds everything said in these threads, the files sent in them, and what each reply did on the computer and in the browser. Look through it before you share it.',
    '',
    '- `log.md`: this file. `log.json`: the same, as data.',
    "- `transcripts/`: Claude Code's own record of each reply's session, every tool call with its full input and result. The primary bot's conversation spans every job, so only its replies about this one are there (`.excerpt.jsonl`).",
    '- `attachments/`: the files sent in the threads.',
    ''
  )

  if (data.job) {
    const j = data.job
    out.push('## Job', '')
    out.push(`- Title: ${j.title}`, `- Id: \`${j.id}\``, `- Status: ${j.status}`, `- Owner: ${nameOf(j.ownerBotId) ?? 'none'}`)
    out.push(`- Started: ${when(j.createdAt)} · last activity: ${when(j.updatedAt)}`)
    if (j.parentJobId) out.push(`- Part of job \`${j.parentJobId}\``)
    if (j.usage) out.push(`- Used: $${j.usage.cost.toFixed(4)} · ${j.usage.tokens} tokens · ${j.usage.replies} replies`)
    if (j.summary) out.push(`- Summary: ${j.summary}`)
    if (j.approvesForUser) out.push(`- Tomo approves for the user: ${j.approvesForUser}`)
    out.push('')
  }

  out.push('## Bots', '')
  for (const b of data.bots) {
    out.push(`- **${b.name}**${b.isPrimary ? ' (primary)' : ''}: model ${b.model ?? 'default'}, effort ${b.effort ?? 'default'}, modules ${b.modules.length ? b.modules.join(', ') : 'none'}`)
    if (Object.keys(b.rules).length) out.push(`  - Rules: \`${JSON.stringify(b.rules)}\``)
  }
  out.push('')

  if (settings) {
    out.push('## Settings', '')
    out.push(`- Sign-in: ${settings.auth === 'apiKey' ? 'Anthropic API key' : 'Claude Code login'}`, `- Default model: ${settings.defaultModel} · effort ${settings.effort}`)
    out.push(`- Title model: ${settings.titleModel || 'off'} · memory model: ${settings.memoryModel || 'off'} · artifacts ${settings.artifactsEnabled ? 'on' : 'off'}`, '')
  }

  if (data.notes.length) {
    out.push('## Job notes', '')
    for (const n of data.notes) out.push(`- [${n.type}]${n.title ? ` ${n.title}:` : ''} ${n.body.replace(/\s*\n\s*/g, ' ')}`)
    out.push('')
  }

  const message = (m: LoggedMessage, n: number, shown: Set<string>) => {
    const who = m.role === 'user' ? (m.authorBotId ? `${nameOf(m.authorBotId)} (a bot's turn)` : 'User') : (nameOf(m.authorBotId) ?? 'Tomo')
    const what = m.post ? `${m.post.kind}${m.post.to ? ` to ${nameOf(m.post.to)}` : ''}${m.post.state ? `, ${m.post.state}` : ''}` : m.role === 'assistant' ? 'reply' : null
    const facts = [
      when(m.createdAt),
      ...(m.role === 'assistant' && !m.post ? [m.status] : []),
      ...(m.model ? [m.model] : []),
      ...(m.usage ? [`${m.usage.totalTokens} tokens`, ...(m.usage.cost != null ? [`$${m.usage.cost.toFixed(4)}`] : []), `${m.usage.requests} model calls`] : []),
      ...(shown.has(m.id) ? [] : ['not on the branch shown'])
    ]
    out.push(`### ${n}. ${who}${what ? ` · ${what}` : ''}`, '', `${facts.join(' · ')} · id \`${m.id}\``, '')
    if (m.content.trim()) out.push(fence(contentText(m.content)), '')
    if (m.error) out.push(`**${m.status === 'paused' ? 'Paused' : 'Error'}:** ${m.error}`, '')
    if (m.files.length) {
      out.push('Attachments:', '')
      for (const a of m.files) {
        const p = placed.get(a.path)
        out.push(`- ${a.name} (${a.kind}, ${a.mime || 'no type'}, ${size(a.size)}): ${!p ? 'not found' : 'file' in p ? `\`${p.file}\`` : `left out: ${p.skipped}`}`)
      }
      out.push('')
    }
    if (m.role !== 'assistant' || !m.agentSession) return
    if (!transcripts.has(m.agentSession)) return out.push(`Claude Code session \`${m.agentSession}\`: its transcript is gone.`, '')
    const activity = input.activity.get(m.id) ?? { calls: [], apiErrors: [] }
    out.push(`Claude Code session: \`${input.transcriptFile.get(m.agentSession)}\``, '')
    for (const e of activity.apiErrors) out.push(`**API error:** ${e}`, '')
    if (activity.calls.length) {
      const failed = activity.calls.filter((c) => c.failed).length
      out.push(`Tool calls: ${activity.calls.length}${failed ? `, ${failed} failed` : ''}`, '')
      for (const c of activity.calls) toolCall(c)
    }
  }

  const toolCall = (c: ToolCall) => {
    listed.add(c.id)
    const state = c.result === null ? '… no result' : c.failed ? '✗ failed' : '✓'
    out.push(`- ${state} \`${c.name}\`${c.at ? ` at ${c.at}` : ''} (\`${c.id}\`)`, '')
    out.push(indent(fence(cut(json(c.input), 4000), 'json')), '')
    if (c.result !== null) out.push(indent(fence(cut(c.result, c.failed ? 8000 : 3000))), '')
  }

  for (const { session, messages, shown } of data.threads) {
    const kind = session.kind === 'worker' ? `${nameOf(session.botId)}'s own thread` : session.kind === 'primary' ? "the primary's conversation" : `shared thread, answered by ${nameOf(session.botId) ?? 'Tomo'}`
    out.push(`## Thread: ${session.title}`, '', `${kind} · id \`${session.id}\` · ${messages.length} messages`, '')
    const onBranch = new Set(shown)
    messages.forEach((m, i) => message(m, i + 1, onBranch))
  }

  if (data.primary.length) {
    out.push(`## ${nameOf(data.bots.find((b) => b.isPrimary)?.id ?? null) ?? 'Tomo'}'s conversation, about this job`, '')
    out.push('The reply that started the job, and the reports and messages about it that came back to the primary bot, with its answers.', '')
    const shown = new Set(data.primary.map((m) => m.id))
    data.primary.forEach((m, i) => message(m, i + 1, shown))
  }

  // Tool calls in the transcripts no reply above claims (one cut off before its first checkpoint).
  // Only in transcripts that are there whole: an excerpt's other calls are other jobs'.
  for (const [id, t] of transcripts) {
    if (!input.whole.has(id)) continue
    const rest = [...t.calls.values()].filter((c) => !listed.has(c.id))
    if (!rest.length) continue
    out.push(`## Other tool calls in \`${input.transcriptFile.get(id)}\``, '')
    for (const c of rest) toolCall(c)
  }
  return out.join('\n')
}

const indent = (text: string) =>
  text
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n')

// ---- The archive ---------------------------------------------------------------------------------

/** Attachments bigger than this are listed but left out; so is any once the archive reaches MAX_TOTAL. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024
export const MAX_TOTAL_BYTES = 1024 * 1024 * 1024

export interface ZipEntry {
  name: string
  data: Uint8Array
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export const crc32 = (data: Uint8Array): number => {
  const native = (zlib as { crc32?: (d: Uint8Array) => number }).crc32
  if (typeof native === 'function') return native(data) >>> 0
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const deflate = promisify(zlib.deflateRaw)

/** Kinds of file already compressed: stored as they are. */
const PACKED = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.zip', '.gz', '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.weba', '.mp4', '.m4v', '.mov', '.qt', '.webm', '.mkv', '.avi', '.wmv', '.mpg', '.mpeg', '.3gp', '.ogv', '.flv', '.m2ts'])

/**
 * Writes a zip (deflated or stored, UTF-8 names, no zip64: MAX_TOTAL_BYTES keeps it under 4 GB),
 * an entry at a time, to `file`. It is written beside it first, so a failure leaves nothing half made.
 */
export const writeZip = async (file: string, entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>) => {
  const part = `${file}.part`
  const fh = await open(part, 'w')
  const now = new Date()
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()
  const central: Buffer[] = []
  let offset = 0
  let count = 0
  try {
    for await (const entry of entries) {
      const name = Buffer.from(entry.name, 'utf8')
      const crc = crc32(entry.data)
      const packed = PACKED.has(extname(entry.name).toLowerCase()) ? null : await deflate(entry.data)
      const method = packed && packed.length < entry.data.length ? 8 : 0
      const body = method === 8 ? packed! : entry.data
      const head = Buffer.alloc(30)
      head.writeUInt32LE(0x04034b50, 0)
      head.writeUInt16LE(20, 4)
      head.writeUInt16LE(0x0800, 6)
      head.writeUInt16LE(method, 8)
      head.writeUInt16LE(time, 10)
      head.writeUInt16LE(date, 12)
      head.writeUInt32LE(crc, 14)
      head.writeUInt32LE(body.length, 18)
      head.writeUInt32LE(entry.data.length, 22)
      head.writeUInt16LE(name.length, 26)
      head.writeUInt16LE(0, 28)
      await fh.write(head)
      await fh.write(name)
      await fh.write(body)
      const dir = Buffer.alloc(46)
      dir.writeUInt32LE(0x02014b50, 0)
      dir.writeUInt16LE(20, 4)
      dir.writeUInt16LE(20, 6)
      dir.writeUInt16LE(0x0800, 8)
      dir.writeUInt16LE(method, 10)
      dir.writeUInt16LE(time, 12)
      dir.writeUInt16LE(date, 14)
      dir.writeUInt32LE(crc, 16)
      dir.writeUInt32LE(body.length, 20)
      dir.writeUInt32LE(entry.data.length, 24)
      dir.writeUInt16LE(name.length, 28)
      dir.writeUInt32LE(offset, 42)
      central.push(dir, name)
      offset += head.length + name.length + body.length
      count++
    }
    const dirBytes = Buffer.concat(central)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(count, 8)
    end.writeUInt16LE(count, 10)
    end.writeUInt32LE(dirBytes.length, 12)
    end.writeUInt32LE(offset, 16)
    await fh.write(dirBytes)
    await fh.write(end)
    await fh.close()
    await rename(part, file)
  } catch (e) {
    await fh.close().catch(() => undefined)
    await rm(part, { force: true })
    throw e
  }
}

/** A name safe in an archive and on any disk. */
const safeName = (name: string) => name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-').replace(/^\.+/, '').slice(0, 120) || 'file'

/** The archive's name for a log of `title`. */
export const logFileName = (title: string, at: Date) =>
  `tomo-log-${safeName(title).replace(/\s+/g, '-').toLowerCase().slice(0, 40)}-${at.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`

export interface ExportDeps {
  /** A Claude Code session's files (agent/driver.ts transcripts). */
  transcripts: (id: string) => Array<{ path: string; name: string }>
  about: LogAbout
  settings: Settings | null
  now?: number
}

export interface ExportResult {
  path: string
  /** Attachments listed but left out: too big, or their file is gone. */
  skipped: number
  transcripts: number
  attachments: number
}

/** Writes the log of `data` to `file`, a zip. */
export const exportLog = async (data: LogData, file: string, deps: ExportDeps): Promise<ExportResult> => {
  const exportedAt = deps.now ?? Date.now()
  const all = [...data.threads.flatMap((t) => t.messages), ...data.primary]

  // Every Claude Code session the threads' replies ran in, whole, subagents' files included. The
  // primary's conversation is one session across every job: only its replies about this one go in.
  const sessionsOf = (list: LoggedMessage[]) => new Set(list.flatMap((m) => (m.agentSession ? [m.agentSession] : [])))
  const whole = sessionsOf(data.threads.flatMap((t) => t.messages))
  const partial = [...sessionsOf(data.primary)].filter((id) => !whole.has(id))
  const transcripts = new Map<string, Transcript>()
  const transcriptFile = new Map<string, string>()
  const activity = new Map<string, ReplyActivity>()
  const transcriptFiles: ZipEntry[] = []
  const read = (id: string, t: Transcript, name: string) => {
    transcripts.set(id, t)
    transcriptFile.set(id, name)
    for (const m of all) if (m.agentSession === id && m.agentUuid && m.role === 'assistant') activity.set(m.id, replyActivity(t, m.agentUuid))
  }
  for (const id of whole) {
    for (const f of deps.transcripts(id)) {
      const bytes = await readFile(f.path).catch(() => null)
      if (!bytes) continue
      transcriptFiles.push({ name: `transcripts/${f.name}`, data: bytes })
      if (f.name === `${id}.jsonl`) read(id, readTranscript(bytes.toString('utf8')), `transcripts/${f.name}`)
    }
  }
  for (const id of partial) {
    const own = deps.transcripts(id).find((f) => f.name === `${id}.jsonl`)
    const text = own ? await readFile(own.path, 'utf8').catch(() => null) : null
    if (text === null) continue
    const name = `transcripts/${id}.excerpt.jsonl`
    read(id, readTranscript(text), name)
    const keep = new Set<string>()
    for (const m of data.primary) if (m.agentSession === id) for (const uuid of activity.get(m.id)?.entries ?? []) keep.add(uuid)
    transcriptFiles.push({ name, data: Buffer.from(excerpt(text, keep), 'utf8') })
  }
  let total = transcriptFiles.reduce((n, e) => n + e.data.length, 0)

  // Each file once (forks and edits copy rows, not files), by the first name it was sent under.
  const placed = new Map<string, Placed>()
  const files: Array<{ path: string; entry: string; a: StoredAttachment }> = []
  const used = new Set<string>()
  for (const a of all.flatMap((m) => m.files)) {
    if (placed.has(a.path)) continue
    const info = await stat(a.path).catch(() => null)
    if (!info?.isFile()) {
      placed.set(a.path, { skipped: 'its file is gone' })
      continue
    }
    if (info.size > MAX_FILE_BYTES || total + info.size > MAX_TOTAL_BYTES) {
      placed.set(a.path, { skipped: `${size(info.size)} is too big for the log` })
      continue
    }
    total += info.size
    let entry = `attachments/${a.id.slice(0, 8)}-${safeName(a.name)}`
    while (used.has(entry)) entry = `attachments/${a.id}-${safeName(a.name)}`
    used.add(entry)
    placed.set(a.path, { file: entry })
    files.push({ path: a.path, entry, a })
  }

  const markdown = renderLog({ data, about: deps.about, settings: deps.settings, exportedAt, transcripts, transcriptFile, whole, activity, placed })
  const strip = (m: LoggedMessage) => ({
    ...m,
    files: m.files.map(({ path, ...a }) => ({ ...a, ...placed.get(path) })),
    toolCalls: activity.get(m.id)?.calls ?? [],
    apiErrors: activity.get(m.id)?.apiErrors ?? []
  })
  const record = {
    exportedAt: new Date(exportedAt).toISOString(),
    app: deps.about,
    settings: deps.settings,
    job: data.job,
    bots: data.bots,
    notes: data.notes,
    threads: data.threads.map((t) => ({ session: t.session, shown: t.shown, messages: t.messages.map(strip) })),
    primary: data.primary.map(strip),
    transcripts: transcriptFiles.map((e) => e.name)
  }

  let skipped = 0
  for (const p of placed.values()) if ('skipped' in p) skipped++
  let attachments = 0
  await writeZip(
    file,
    (async function* () {
      yield { name: 'log.md', data: Buffer.from(markdown, 'utf8') }
      yield { name: 'log.json', data: Buffer.from(JSON.stringify(record, null, 2), 'utf8') }
      yield* transcriptFiles
      for (const f of files) {
        const bytes = await readFile(f.path).catch(() => null)
        if (!bytes) continue
        attachments++
        yield { name: f.entry, data: bytes }
      }
    })()
  )
  return { path: file, skipped, transcripts: transcriptFiles.length, attachments }
}
