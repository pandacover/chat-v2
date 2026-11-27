// The custom MCP servers the user connects in Settings › Connections, kept in mcp.json in the
// app's data folder. Env and header values (tokens, mostly) are encrypted with the same cipher as
// API keys and never leave the main process: Settings sees their keys only. A value typed into
// the file by hand (not starting enc: or b64:) is read as plain text and encrypted at the next save.
// The file is re-read on every access, like config.json, so a hand edit applies from the next reply.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { Context, Effect, Layer } from 'effect'
import {
  ENV_KEY,
  HEADER_KEY,
  MCP_LIMITS,
  type McpCheck,
  type McpImportResult,
  type McpPairInput,
  type McpServerInput,
  type McpServerView,
  type McpToolInfo,
  type McpTransport,
  mcpConnectionProblem,
  mcpNameProblem,
  parseMcpImport,
  slugMcpName
} from '@shared/mcp'
import type { Verdict } from '@shared/rules'
import { ConfigError, InvalidInput, errorMessage } from '../errors'
import { AppPaths } from './AppPaths'
import type { SecretCipher } from './SettingsStore'

/** A server as stored: pairs' values encrypted. */
export interface StoredServer extends Omit<McpServerView, 'env' | 'headers'> {
  env: Record<string, string>
  headers: Record<string, string>
}

/** A server as replies use it: pairs' values in plain text. */
export interface McpServer extends Omit<McpServerView, 'env' | 'headers'> {
  env: Record<string, string>
  headers: Record<string, string>
}

const VERDICTS: readonly Verdict[] = ['allow', 'ask', 'block']
const TRANSPORTS: readonly McpTransport[] = ['stdio', 'http', 'sse']
const verdictOf = (v: unknown, fallback: Verdict): Verdict => VERDICTS.find((x) => x === v) ?? fallback
const str = (v: unknown, max: number = MCP_LIMITS.value) => (typeof v === 'string' ? v.slice(0, max) : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

const ENCRYPTED = /^(?:enc|b64):/

/** A stored value in plain text: decrypted, or as typed by hand. Null when it can't be decrypted. */
const reveal = (cipher: SecretCipher, value: string): string | null => {
  if (!ENCRYPTED.test(value)) return value
  try {
    return cipher.decrypt(value)
  } catch {
    return null
  }
}

const pairsOf = (raw: unknown, key: RegExp): Record<string, string> => {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return Object.fromEntries(
    Object.entries(o)
      .filter(([k, v]) => key.test(k) && typeof v === 'string')
      .slice(0, MCP_LIMITS.pairs)
  ) as Record<string, string>
}

const toolsOf = (raw: unknown): McpToolInfo[] | null =>
  Array.isArray(raw)
    ? raw.flatMap((t): McpToolInfo[] => {
        const o = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>
        if (typeof o.name !== 'string' || !o.name) return []
        return [
          {
            name: o.name.slice(0, 128),
            description: typeof o.description === 'string' ? o.description.slice(0, 1000) : null,
            ...(o.readOnly === true ? { readOnly: true } : {}),
            ...(o.destructive === true ? { destructive: true } : {})
          }
        ]
      })
    : null

const checkOf = (raw: unknown): McpCheck | null => {
  const o = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null
  const status = o?.status
  if (!o || (status !== 'connected' && status !== 'failed' && status !== 'needs-auth' && status !== 'timeout')) return null
  const server = o.server && typeof o.server === 'object' ? (o.server as Record<string, unknown>) : null
  return {
    status,
    error: typeof o.error === 'string' ? o.error.slice(0, 2000) : null,
    at: num(o.at) ?? 0,
    server: server && typeof server.name === 'string' ? { name: server.name, version: typeof server.version === 'string' ? server.version : '' } : null
  }
}

/**
 * What mcp.json holds, made safe to use: unknown keys dropped, wrong types back to defaults, and
 * entries without a usable name (or with one taken by an entry before them) left out.
 */
export const normalizeServers = (raw: unknown): StoredServer[] => {
  const list = Array.isArray((raw as { servers?: unknown } | null)?.servers) ? ((raw as { servers: unknown[] }).servers as unknown[]) : []
  const out: StoredServer[] = []
  for (const item of list.slice(0, MCP_LIMITS.servers)) {
    const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const name = typeof o.name === 'string' ? o.name : ''
    if (mcpNameProblem(name, out.map((s) => s.name))) continue
    const transport = TRANSPORTS.find((t) => t === o.transport) ?? (typeof o.url === 'string' && !o.command ? 'http' : 'stdio')
    const toolAccess = Object.fromEntries(
      Object.entries((o.toolAccess && typeof o.toolAccess === 'object' ? o.toolAccess : {}) as Record<string, unknown>).flatMap(([k, v]) =>
        VERDICTS.includes(v as Verdict) ? [[k, v as Verdict]] : []
      )
    )
    const bots = Array.isArray(o.bots) ? o.bots.filter((b): b is string => typeof b === 'string') : 'all'
    out.push({
      // One written by hand has none: named after it, so it stays the same until a save writes it down.
      id: typeof o.id === 'string' && o.id ? o.id : `hand-${name}`,
      name,
      note: str(o.note, MCP_LIMITS.note),
      enabled: o.enabled !== false,
      transport,
      command: str(o.command),
      args: Array.isArray(o.args) ? o.args.filter((a): a is string => typeof a === 'string').slice(0, MCP_LIMITS.args) : [],
      url: str(o.url),
      env: pairsOf(o.env, ENV_KEY),
      headers: pairsOf(o.headers, HEADER_KEY),
      access: verdictOf(o.access, 'ask'),
      toolAccess,
      bots,
      tools: toolsOf(o.tools),
      lastCheck: checkOf(o.lastCheck),
      createdAt: num(o.createdAt) ?? Date.now(),
      updatedAt: num(o.updatedAt) ?? Date.now()
    })
  }
  return out
}

/** A server for Settings: its pairs' keys, and whether each has a value. */
export const viewOf = (s: StoredServer): McpServerView => ({
  ...s,
  env: Object.entries(s.env).map(([key, v]) => ({ key, set: v !== '' })),
  headers: Object.entries(s.headers).map(([key, v]) => ({ key, set: v !== '' }))
})

/** A server for a reply: pairs decrypted. One that can't be decrypted (another machine's keychain) is left out. */
export const revealServer = (cipher: SecretCipher, s: StoredServer): McpServer | null => {
  const open = (pairs: Record<string, string>) => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(pairs)) {
      const plain = reveal(cipher, v)
      if (plain === null) return null
      out[k] = plain
    }
    return out
  }
  const env = open(s.env)
  const headers = open(s.headers)
  return env && headers ? { ...s, env, headers } : null
}

/** A list of pairs from Settings over what is stored: a key without a value keeps the stored one. */
const mergePairs = (cipher: SecretCipher, stored: Record<string, string>, input: readonly McpPairInput[], key: RegExp, what: string): Record<string, string> => {
  if (input.length > MCP_LIMITS.pairs) throw new InvalidInput({ message: `At most ${MCP_LIMITS.pairs} ${what}.` })
  const out: Record<string, string> = {}
  for (const p of input) {
    const k = typeof p?.key === 'string' ? p.key.trim() : ''
    if (!k) continue
    if (!key.test(k)) throw new InvalidInput({ message: `“${k.slice(0, 60)}” can't be the name of ${what === 'variables' ? 'an environment variable' : 'a header'}.` })
    if (typeof p.value === 'string') {
      if (p.value.length > MCP_LIMITS.value) throw new InvalidInput({ message: `The value of ${k} is too long.` })
      // Pasted values often carry a newline at the end; a header can't hold one at all.
      const value = what === 'headers' ? p.value.trim() : p.value.replace(/[\r\n]+$/, '')
      if (what === 'headers' && /[\r\n]/.test(value)) throw new InvalidInput({ message: `The ${k} header can't contain line breaks.` })
      out[k] = value === '' ? '' : cipher.encrypt(value)
    } else out[k] = stored[k] ?? ''
  }
  return out
}

/**
 * A server with a change from Settings applied, checked: a name no other server has, a command or
 * URL to reach it, valid pair keys. Changing how it is reached forgets the last check and its tools.
 */
export const applyInput = (cipher: SecretCipher, base: StoredServer, input: McpServerInput, others: readonly StoredServer[], now = Date.now()): StoredServer => {
  const next: StoredServer = { ...base, env: { ...base.env }, headers: { ...base.headers }, toolAccess: { ...base.toolAccess } }
  if (input.name !== undefined) next.name = String(input.name).trim()
  if (input.note !== undefined) next.note = str(input.note, MCP_LIMITS.note).trim()
  if (input.enabled !== undefined) next.enabled = input.enabled === true
  if (input.transport !== undefined) {
    const t = TRANSPORTS.find((x) => x === input.transport)
    if (!t) throw new InvalidInput({ message: 'Unknown kind of server.' })
    next.transport = t
  }
  if (input.command !== undefined) next.command = str(input.command).trim()
  if (input.args !== undefined) {
    if (!Array.isArray(input.args) || input.args.length > MCP_LIMITS.args) throw new InvalidInput({ message: `At most ${MCP_LIMITS.args} arguments.` })
    next.args = input.args.map((a) => str(a))
  }
  if (input.url !== undefined) next.url = str(input.url).trim()
  if (input.env !== undefined) next.env = mergePairs(cipher, base.env, Array.isArray(input.env) ? input.env : [], ENV_KEY, 'variables')
  if (input.headers !== undefined) next.headers = mergePairs(cipher, base.headers, Array.isArray(input.headers) ? input.headers : [], HEADER_KEY, 'headers')
  if (input.access !== undefined) next.access = verdictOf(input.access, next.access)
  if (input.toolAccess !== undefined && input.toolAccess && typeof input.toolAccess === 'object')
    next.toolAccess = Object.fromEntries(
      Object.entries(input.toolAccess).flatMap(([k, v]) => (typeof k === 'string' && k.length <= 128 && VERDICTS.includes(v) ? [[k, v]] : []))
    )
  if (input.bots !== undefined) next.bots = input.bots === 'all' ? 'all' : Array.isArray(input.bots) ? [...new Set(input.bots.filter((b) => typeof b === 'string'))] : next.bots

  const nameProblem = mcpNameProblem(next.name, others.filter((o) => o.id !== base.id).map((o) => o.name))
  if (nameProblem) throw new InvalidInput({ message: nameProblem })
  const connection = mcpConnectionProblem(next)
  if (connection) throw new InvalidInput({ message: connection })
  // What isn't used by its kind is dropped, so a URL server keeps no stale command (or the other way).
  if (next.transport === 'stdio') {
    next.url = ''
    next.headers = {}
  } else {
    next.command = ''
    next.args = []
    next.env = {}
  }
  const reached = (s: StoredServer) => JSON.stringify([s.transport, s.command, s.args, s.url, s.env, s.headers])
  if (reached(next) !== reached(base)) {
    next.lastCheck = null
    if (next.transport !== base.transport || next.command !== base.command || next.url !== base.url || JSON.stringify(next.args) !== JSON.stringify(base.args)) next.tools = null
  }
  next.updatedAt = now
  return next
}

/** A new server: what the input gives, over the defaults (on, asks before each call, every bot). */
export const blankServer = (now = Date.now()): StoredServer => ({
  id: randomUUID(),
  name: '',
  note: '',
  enabled: true,
  transport: 'stdio',
  command: '',
  args: [],
  url: '',
  env: {},
  headers: {},
  access: 'ask',
  toolAccess: {},
  bots: 'all',
  tools: null,
  lastCheck: null,
  createdAt: now,
  updatedAt: now
})

/** Whether the bot may use the server. */
export const serverForBot = (s: Pick<McpServerView, 'enabled' | 'bots'>, botId: string) => s.enabled && (s.bots === 'all' || s.bots.includes(botId))

const writeAtomic = (file: string, data: string) => {
  writeFileSync(`${file}.tmp`, data, 'utf8')
  renameSync(`${file}.tmp`, file)
}

type StoreError = ConfigError | InvalidInput

export class McpStore extends Context.Service<
  McpStore,
  {
    readonly list: Effect.Effect<McpServerView[], ConfigError>
    /** The servers with their values decrypted, for replies and checks. */
    readonly servers: Effect.Effect<McpServer[], ConfigError>
    readonly server: (id: string) => Effect.Effect<McpServer, StoreError>
    readonly create: (input: McpServerInput) => Effect.Effect<{ servers: McpServerView[]; id: string }, StoreError>
    readonly update: (id: string, input: McpServerInput) => Effect.Effect<McpServerView[], StoreError>
    readonly remove: (id: string) => Effect.Effect<McpServerView[], ConfigError>
    /** Turns one bot's use of a server on or off; `bots`: every bot's id, for a server every bot had. */
    readonly setBot: (id: string, botId: string, on: boolean, bots: readonly string[]) => Effect.Effect<McpServerView[], StoreError>
    /** Keeps how a check went, and the tools it found when it connected. */
    readonly record: (id: string, check: McpCheck, tools: McpToolInfo[] | null) => Effect.Effect<McpServerView[], ConfigError>
    /** Adds the servers in pasted JSON; names taken are given a number. */
    readonly importJson: (text: string) => Effect.Effect<McpImportResult, StoreError>
    readonly file: string
  }
>()('chat-v2/McpStore') {
  static readonly layer = (cipher: SecretCipher) =>
    Layer.effect(
      McpStore,
      Effect.gen(function* () {
        const paths = yield* AppPaths
        const file = paths.mcpFile
        const attempt = <A>(what: string, f: () => A) =>
          Effect.try({ try: f, catch: (cause) => (cause instanceof InvalidInput ? cause : new ConfigError({ message: `${what}: ${errorMessage(cause)}`, cause })) })

        const read = Effect.try({
          try: () => (existsSync(file) ? normalizeServers(JSON.parse(readFileSync(file, 'utf8'))) : []),
          catch: (cause) => new ConfigError({ message: `Could not read mcp.json: ${errorMessage(cause)}`, cause })
        })
        /** Values typed into the file by hand, encrypted. */
        const seal = (pairs: Record<string, string>) =>
          Object.fromEntries(Object.entries(pairs).map(([k, v]) => [k, v === '' || ENCRYPTED.test(v) ? v : cipher.encrypt(v)]))
        const write = (servers: readonly StoredServer[]) =>
          Effect.try({
            try: () => writeAtomic(file, JSON.stringify({ servers: servers.map((s) => ({ ...s, env: seal(s.env), headers: seal(s.headers) })) }, null, 2) + '\n'),
            catch: (cause) => new ConfigError({ message: `Could not write mcp.json: ${errorMessage(cause)}`, cause })
          })
        /** Reads, changes and writes the list, and returns what Settings shows. */
        const change = <E>(f: (servers: StoredServer[]) => Effect.Effect<StoredServer[], E>) =>
          Effect.gen(function* () {
            const next = yield* f(yield* read)
            yield* write(next)
            return next.map(viewOf)
          })
        const find = (servers: readonly StoredServer[], id: string) =>
          Effect.suspend(() => {
            const s = servers.find((x) => x.id === id)
            return s ? Effect.succeed(s) : Effect.fail(new InvalidInput({ message: 'That server is gone; it may have been deleted.' }))
          })

        const list = read.pipe(Effect.map((s) => s.map(viewOf)))
        const servers = read.pipe(Effect.map((list) => list.flatMap((s) => revealServer(cipher, s) ?? [])))
        const server = (id: string) =>
          Effect.gen(function* () {
            const s = yield* find(yield* read, id)
            const open = revealServer(cipher, s)
            if (!open) return yield* new InvalidInput({ message: `The saved values of ${s.name} can't be decrypted on this device. Enter them again.` })
            return open
          })

        const create = (input: McpServerInput) =>
          Effect.gen(function* () {
            const current = yield* read
            if (current.length >= MCP_LIMITS.servers) return yield* new InvalidInput({ message: `At most ${MCP_LIMITS.servers} servers.` })
            const made = yield* attempt('Could not add the server', () => applyInput(cipher, blankServer(), input, current))
            const next = [...current, made]
            yield* write(next)
            return { servers: next.map(viewOf), id: made.id }
          })

        const update = (id: string, input: McpServerInput) =>
          change((current) =>
            Effect.gen(function* () {
              const s = yield* find(current, id)
              const next = yield* attempt('Could not save the server', () => applyInput(cipher, s, input, current))
              return current.map((x) => (x.id === id ? next : x))
            })
          )

        const remove = (id: string) => change((current) => Effect.succeed(current.filter((s) => s.id !== id)))

        const setBot = (id: string, botId: string, on: boolean, bots: readonly string[]) =>
          change((current) =>
            Effect.gen(function* () {
              const s = yield* find(current, id)
              const had = s.bots === 'all' ? [...bots] : s.bots.filter((b) => bots.includes(b))
              const want = on ? [...new Set([...had, botId])] : had.filter((b) => b !== botId)
              // Every bot again is "every bot", which takes in bots made later too.
              const all = bots.every((b) => want.includes(b))
              return current.map((x) => (x.id === id ? { ...x, bots: all ? ('all' as const) : want, updatedAt: Date.now() } : x))
            })
          )

        const record = (id: string, check: McpCheck, tools: McpToolInfo[] | null) =>
          change((current) => Effect.succeed(current.map((x) => (x.id === id ? { ...x, lastCheck: check, ...(tools ? { tools } : {}) } : x))))

        const importJson = (text: string) =>
          Effect.gen(function* () {
            const parsed = parseMcpImport(String(text ?? ''))
            if ('error' in parsed) return yield* new InvalidInput({ message: parsed.error })
            const current = yield* read
            const added: string[] = []
            const skipped: McpImportResult['skipped'] = []
            const next = [...current]
            for (const entry of parsed) {
              if ('error' in entry) {
                skipped.push({ name: entry.name, reason: entry.error })
                continue
              }
              if (next.length >= MCP_LIMITS.servers) {
                skipped.push({ name: entry.name, reason: `At most ${MCP_LIMITS.servers} servers.` })
                continue
              }
              const base = slugMcpName(entry.name) || 'server'
              const taken = new Set(next.map((s) => s.name))
              const stem = mcpNameProblem(base, []) ? `mcp-${base}`.slice(0, 32) : base
              let name = stem
              for (let i = 2; taken.has(name); i++) name = `${stem.slice(0, 28)}-${i}`
              try {
                const made = applyInput(cipher, blankServer(), { ...entry.input, name }, next)
                next.push(made)
                added.push(made.name)
              } catch (e) {
                skipped.push({ name: entry.name, reason: errorMessage(e) })
              }
            }
            if (added.length > 0) yield* write(next)
            return { servers: next.map(viewOf), added, skipped }
          })

        return McpStore.of({ list, servers, server, create, update, remove, setBot, record, importJson, file })
      })
    )
}
