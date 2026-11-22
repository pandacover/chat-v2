import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { Effect } from 'effect'
import type { Step } from '@shared/steps'
import type { Control } from './control'
import type { Interaction, Owner } from './interaction'
import { ACT_TOOLS, SERVER, STOPPED_TEXT } from './tools'
import type { Mode } from './tools'

/**
 * Built-in tools computer use brings. Finding uses find_files first and these as a fallback;
 * WebSearch answers quick questions. Bash covers file chores in Do mode: read-only commands run
 * freely, anything else goes through approval. Write, Edit and WebFetch aren't needed and their
 * schemas cost tokens on every request.
 */
export const BUILTIN_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'Bash'] as const

/** Built-ins that only read files or search, which don't need the computer (the screen or the approval card). */
const NO_CLAIM = new Set<string>(['Read', 'Glob', 'Grep', 'WebSearch'])
/** Built-ins this policy answers for: the ones it brings, and file writes. */
const OWNED_BUILTINS = new Set<string>([...BUILTIN_TOOLS, 'Write', 'Edit'])
/** The model's own ask before an irreversible step: the tool shows the card itself. */
const ASK_APPROVAL = `mcp__${SERVER}__ask_approval`

/** A call's verdict under the bot's rules (agent/rules.ts `decide`, bound to the reply's bot). */
export interface PolicyDecision {
  readonly verdict: 'allow' | 'ask' | 'block'
  readonly title: string
  readonly detail: string
  readonly reason?: string
}

/** git accepts any unambiguous prefix of a long option, so `--outp=x` is `--output=x`. */
const gitOutput = (t: string) => {
  const name = t.split('=')[0] ?? ''
  return name.length > 3 && '--output'.startsWith(name)
}
const GIT_BRANCH_LIST = new Set(['-a', '-r', '-v', '-vv', '--all', '--remotes', '--verbose', '--list', '--show-current', '--no-color'])

/** Per command: true if one of its arguments makes it write files or run something. */
const UNSAFE_ARG: Record<string, (t: string) => boolean> = {
  find: (t) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(t),
  rg: (t) => /^--(pre|hostname-bin)(=|$)/.test(t),
  tree: (t) => t.startsWith('-o'),
  file: (t) => t === '-C' || t === '--compile',
  date: (t) => /^(-s|--set)/.test(t),
  hostname: () => true,
  'git branch': (t) => !GIT_BRANCH_LIST.has(t),
  'git diff': gitOutput,
  'git log': gitOutput,
  'git show': gitOutput
}

/** Shell commands that only read. Anything else goes through Approve / Deny. */
export const isReadOnlyCommand = (cmd: string): boolean => {
  const c = cmd.trim()
  // One command, one line: no chaining, redirection, substitution, subshells or line breaks, and no
  // expansion (${X:=--pre=sh}, {--pre=sh,}) that could become a flag after the check below.
  if (/[;&|><`(){}\r\n\0]|\$[^A-Za-z_]/.test(c)) return false
  const m = /^(ls|dir|pwd|cat|type|head|tail|wc|stat|file|du|df|which|where|whoami|hostname|date|echo|find|grep|rg|tree|Get-ChildItem|Get-Content|Get-Item|git (?:status|log|diff|show|branch))(?:[ \t]|$)/i.exec(c)
  if (!m) return false
  const unsafe = UNSAFE_ARG[(m[1] ?? '').toLowerCase().replace(/[ \t]+/, ' ')]
  if (!unsafe) return true
  // Quotes and backslashes are stripped as the shell would before the command sees the flag.
  const args = c.slice(m[0].length).split(/[ \t]+/).map((t) => t.replace(/['"\\]/g, '')).filter(Boolean)
  return !args.some(unsafe)
}

const BUILTIN_LABELS: Record<string, (i: Record<string, unknown>) => [string, string]> = {
  Read: (i) => ['Read file', String(i.file_path ?? '')],
  Glob: (i) => ['Search files', String(i.pattern ?? '')],
  Grep: (i) => ['Search text', String(i.pattern ?? '')],
  Bash: (i) => ['Run command', String(i.command ?? '')],
  Write: (i) => ['Write file', String(i.file_path ?? '')],
  Edit: (i) => ['Edit file', String(i.file_path ?? '')],
  WebSearch: (i) => ['Search the web', String(i.query ?? '')],
  WebFetch: (i) => ['Read web page', String(i.url ?? '')]
}

/**
 * The step line for a built-in tool call, for the driver to add when it sees the tool_use block
 * (the SDK runs built-ins itself, so this module never sees them finish).
 */
export const builtinStep = (name: string, input: Record<string, unknown>): Step | null => {
  const label = BUILTIN_LABELS[name]?.(input)
  if (!label) return null
  return { tool: name, label: label[0], ok: true, ...(label[1] ? { detail: label[1] } : {}) }
}

export interface PolicyDeps {
  readonly control: Control
  readonly interaction: Interaction
  readonly owner: Owner
  readonly mode: () => Mode
  /** True once the reply has ended. */
  readonly ended: () => boolean
  /** Counts a tool call; false once the reply has made too many. */
  readonly count: () => boolean
  /** Takes the computer for this reply; the refusal to give the model if another chat has it. */
  readonly claim: () => string | null
  /** The bot's rules for a call: allow, ask, or block. */
  readonly decide: (name: string, input: Record<string, unknown>) => PolicyDecision
}

const allow = (input: Record<string, unknown>): PermissionResult => ({ behavior: 'allow', updatedInput: input })

/**
 * One permission policy for every computer-use call. The bot's rules decide each call (by default:
 * look and search tools run freely, shell commands only if they are read-only, file writes ask, and
 * irreversible steps always ask); mouse and keyboard tools are refused in Show-me mode whatever the
 * rules say. Null for calls that belong to another tool set.
 */
export const makePolicy =
  (d: PolicyDeps) =>
  async (name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult | null> => {
    if (!name.startsWith(`mcp__${SERVER}__`) && !OWNED_BUILTINS.has(name)) return null
    if (d.ended()) return { behavior: 'deny', message: STOPPED_TEXT, interrupt: true }
    const rule = d.decide(name, input)
    if (rule.verdict === 'block') return { behavior: 'deny', message: rule.reason ?? "That tool isn't available." }
    // Reading and searching files don't touch the screen or the approval card unless they ask; the rest needs the computer.
    const busy = NO_CLAIM.has(name) && rule.verdict === 'allow' ? null : d.claim()
    if (busy) return { behavior: 'deny', message: busy }
    if (d.control.stopped()) return { behavior: 'deny', message: STOPPED_TEXT, interrupt: true }
    // MCP tool calls are counted when they run; built-ins only pass through here.
    if (!name.startsWith('mcp__') && !d.count()) return { behavior: 'deny', message: STOPPED_TEXT, interrupt: true }
    if (ACT_TOOLS.has(name) && d.mode() === 'teach')
      return { behavior: 'deny', message: "The user wants to learn this (teach mode): don't act for them. Guide them with teach_step instead." }
    if (rule.verdict === 'allow' || name === ASK_APPROVAL) return allow(input)
    return Effect.runPromise(d.interaction.requestApproval(d.owner, rule.title, rule.detail), { signal })
      .then(
        (ok): PermissionResult => (ok ? allow(input) : { behavior: 'deny', message: 'The user denied this.' }),
        (): PermissionResult => ({ behavior: 'deny', message: 'The user denied this.' })
      )
      // The user moved the mouse to answer; that isn't taking over.
      .finally(() => d.control.resetTakeover())
  }
