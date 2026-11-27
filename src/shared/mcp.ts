// Custom MCP servers (Settings › Connections): what the user connects, how it is checked, and the
// pure rules both processes share. A server is kept in mcp.json in the app's data folder, its env
// and header values encrypted (main/services/McpStore.ts); the renderer only ever learns which
// keys have a value. Replies get each server a bot may use as a tool set of its own
// (main/agent/mcp.ts), and every call of its tools goes through the server's allow, ask or block.
import type { Verdict } from './rules'

/** How Claude Code reaches the server: a program it starts (stdio), or a URL. */
export type McpTransport = 'stdio' | 'http' | 'sse'

export const MCP_TRANSPORTS: ReadonlyArray<{ id: McpTransport; label: string; hint: string }> = [
  { id: 'stdio', label: 'Command', hint: 'A program on this computer, started for each reply' },
  { id: 'http', label: 'URL', hint: 'A remote server over streamable HTTP' },
  { id: 'sse', label: 'SSE', hint: 'A remote server over server-sent events (older servers)' }
]

/** A tool a server listed when it was last checked. */
export interface McpToolInfo {
  name: string
  description: string | null
  /** What the server says about the tool; its own claim, so only shown, never trusted. */
  readOnly?: boolean
  destructive?: boolean
}

export type McpStatus = 'connected' | 'failed' | 'needs-auth' | 'timeout'

/** How the last check went. */
export interface McpCheck {
  status: McpStatus
  /** Why it failed, in words for the user. */
  error: string | null
  at: number
  /** The server's own name and version, when it connected. */
  server: { name: string; version: string } | null
}

/** A server as the renderer sees it: no env or header values, only their keys. */
export interface McpServerView {
  id: string
  /** The name tools are known by (mcp__<name>__<tool>): lowercase letters, digits, - and _. */
  name: string
  /** What it is for, told to the model beside its tools. */
  note: string
  enabled: boolean
  transport: McpTransport
  command: string
  args: string[]
  url: string
  env: Array<{ key: string; set: boolean }>
  headers: Array<{ key: string; set: boolean }>
  /** What a call of one of its tools does unless the tool has its own: allow, ask or block. */
  access: Verdict
  /** Tools with a verdict of their own, by the tool's name as the server lists it. */
  toolAccess: Record<string, Verdict>
  /** The bots that may use it: every bot, or these. */
  bots: 'all' | string[]
  /** Its tools when it last connected; null before it ever has. */
  tools: McpToolInfo[] | null
  lastCheck: McpCheck | null
  createdAt: number
  updatedAt: number
}

/** A pair as sent from Settings. `value` undefined keeps the value saved for that key; '' is an empty value. */
export interface McpPairInput {
  key: string
  value?: string
}

/** A new server or a change to one. Pairs replace the list: keys left out are removed. */
export interface McpServerInput {
  name?: string
  note?: string
  enabled?: boolean
  transport?: McpTransport
  command?: string
  args?: string[]
  url?: string
  env?: McpPairInput[]
  headers?: McpPairInput[]
  access?: Verdict
  toolAccess?: Record<string, Verdict>
  bots?: 'all' | string[]
}

/** What importing pasted JSON did. */
export interface McpImportResult {
  servers: McpServerView[]
  added: string[]
  /** Entries left out, each with why. */
  skipped: Array<{ name: string; reason: string }>
}

/** How many servers, pairs and tools may be kept. */
export const MCP_LIMITS = { servers: 50, pairs: 50, note: 400, value: 8000, args: 100 } as const

/** Names the app's own tool sets use, and Claude Code's. */
export const RESERVED_MCP_NAMES: ReadonlySet<string> = new Set(['browser', 'computer', 'memory', 'notes', 'team', 'video', 'claude', 'ide', 'tomo', 'mcp'])

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/

/** A name made from what was typed or imported: lowercase, spaces and other characters as -. */
export const slugMcpName = (raw: string): string =>
  raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/_{2,}/g, '_')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 32)
    .replace(/[-_]+$/, '')

/** Why a name can't be used, or null when it can. `taken`: other servers' names. */
export const mcpNameProblem = (name: string, taken: readonly string[]): string | null => {
  if (!name) return 'Give it a name.'
  if (!NAME.test(name)) return 'Use lowercase letters, digits, - and _ (up to 32), starting with a letter or digit.'
  if (name.includes('__')) return 'Two underscores in a row are not allowed.'
  if (RESERVED_MCP_NAMES.has(name)) return `“${name}” is taken by Tomo's own tools.`
  if (taken.includes(name)) return `There is already a server called “${name}”.`
  return null
}

/** A tool's name as Claude Code puts it in mcp__<server>__<tool>. */
export const mcpToolKey = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_')

/** The verdict for a call of `tool` (its name after mcp__<server>__) on `server`. */
export const mcpVerdict = (server: Pick<McpServerView, 'access' | 'toolAccess'>, tool: string): Verdict => {
  for (const [name, v] of Object.entries(server.toolAccess)) if (name === tool || mcpToolKey(name) === tool) return v
  return server.access
}

export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
export const HEADER_KEY = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/

/**
 * A command line split into words, as a shell would: spaces separate them, quotes keep spaces in
 * one. Backslashes are kept as typed (Windows paths), except before a quote inside quotes.
 */
export const splitCommandLine = (line: string): string[] => {
  const out: string[] = []
  let word = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quote) {
      if (c === '\\' && quote === '"' && line[i + 1] === '"') {
        word += '"'
        i++
      } else if (c === quote) quote = null
      else word += c
    } else if (c === '"' || c === "'") {
      quote = c
      started = true
    } else if (/\s/.test(c)) {
      if (started) out.push(word)
      word = ''
      started = false
    } else {
      word += c
      started = true
    }
  }
  if (started) out.push(word)
  return out
}

/** Words back into a line that splitCommandLine reads the same. */
export const joinCommandLine = (words: readonly string[]): string =>
  words.map((w) => (w === '' ? '""' : /[\s"']/.test(w) ? `"${w.replace(/"/g, '\\"')}"` : w)).join(' ')

const isUrl = (v: string) => {
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Why a server's connection details can't be saved, or null. */
export const mcpConnectionProblem = (s: { transport: McpTransport; command: string; url: string }): string | null => {
  if (s.transport === 'stdio') return s.command.trim() ? null : 'Give the command that starts the server.'
  if (!s.url.trim()) return 'Give the server’s URL.'
  return isUrl(s.url.trim()) ? null : 'The URL must start with http:// or https://.'
}

type Raw = Record<string, unknown>
const obj = (v: unknown): Raw | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null)
const strings = (v: unknown): Record<string, string> | null => {
  const o = obj(v)
  if (!o) return null
  return Object.fromEntries(Object.entries(o).flatMap(([k, x]) => (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean' ? [[k, String(x)]] : [])))
}

/** One entry of pasted JSON, as a server to add. */
export type ImportEntry = { name: string; input: McpServerInput } | { name: string; error: string }

const entryOf = (name: string, raw: unknown): ImportEntry => {
  const o = obj(raw)
  if (!o) return { name, error: 'Not a server definition.' }
  const type = typeof o.type === 'string' ? o.type.toLowerCase() : null
  const url = typeof o.url === 'string' ? o.url : typeof o.serverUrl === 'string' ? o.serverUrl : null
  const pairs = (r: Record<string, string> | null) => (r ? Object.entries(r).map(([key, value]) => ({ key, value })) : undefined)
  const note = typeof o.description === 'string' ? o.description.slice(0, MCP_LIMITS.note) : undefined
  if (typeof o.command === 'string' && (!type || type === 'stdio')) {
    const args = Array.isArray(o.args) ? o.args.filter((a): a is string | number => typeof a === 'string' || typeof a === 'number').map(String) : []
    // A whole command line in "command" (some READMEs do that) is split into its words.
    const words = args.length === 0 && /\s/.test(o.command.trim()) ? splitCommandLine(o.command) : [o.command.trim(), ...args]
    const env = pairs(strings(o.env))
    return {
      name,
      input: {
        transport: 'stdio',
        command: words[0] ?? '',
        args: words.slice(1),
        ...(env ? { env } : {}),
        ...(note ? { note } : {})
      }
    }
  }
  if (url) {
    if (type && !['sse', 'http', 'streamable-http', 'streamablehttp'].includes(type)) return { name, error: `Unknown type “${type}”.` }
    const transport: McpTransport = type === 'sse' ? 'sse' : 'http'
    const headers = pairs(strings(o.headers))
    return { name, input: { transport, url, ...(headers ? { headers } : {}), ...(note ? { note } : {}) } }
  }
  if (type === 'ws' || type === 'websocket') return { name, error: 'WebSocket servers are not supported.' }
  return { name, error: 'It has neither a command nor a url.' }
}

/**
 * Servers from JSON pasted in Settings, as MCP READMEs give them: {"mcpServers": {name: {...}}}
 * (Claude Desktop's and Claude Code's form), {"servers": {...}} (VS Code's), {name: {...}}, or one
 * server's {command, args, env} / {type, url, headers}, named `fallbackName`.
 */
export const parseMcpImport = (text: string, fallbackName = 'server'): ImportEntry[] | { error: string } => {
  let raw: unknown
  const trimmed = text.trim()
  if (!trimmed) return { error: 'Paste the JSON from the server’s instructions.' }
  try {
    raw = JSON.parse(trimmed)
  } catch {
    // A snippet copied without its outer braces: "github": { ... }
    try {
      raw = JSON.parse(`{${trimmed.replace(/,\s*$/, '')}}`)
    } catch {
      return { error: 'That isn’t valid JSON.' }
    }
  }
  const root = obj(raw)
  if (!root) return { error: 'Expected a JSON object.' }
  const map = obj(root.mcpServers) ?? obj(root.servers) ?? obj(obj(root.mcp)?.servers)
  if (map) return Object.entries(map).map(([name, v]) => entryOf(name, v))
  if (typeof root.command === 'string' || typeof root.url === 'string') return [entryOf(typeof root.name === 'string' ? root.name : fallbackName, root)]
  const entries = Object.entries(root).filter(([, v]) => obj(v))
  if (entries.length === 0) return { error: 'No servers found in it.' }
  return entries.map(([name, v]) => entryOf(name, v))
}
