import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { Effect } from 'effect'
import type { Step } from '@shared/steps'
import type { Control } from './control'
import type { Interaction, Owner } from './interaction'
import { ACT_TOOLS, SAFE_TOOLS, SERVER, STOPPED_TEXT } from './tools'
import type { Mode } from './tools'

/**
 * Built-in tools computer use brings. Finding uses find_files first and these as a fallback;
 * WebSearch answers quick questions. Bash covers file chores in Do mode: read-only commands run
 * freely, anything else goes through approval. Write, Edit and WebFetch aren't needed and their
 * schemas cost tokens on every request.
 */
export const BUILTIN_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'Bash'] as const

/** Allowed without asking. */
const AUTO_ALLOW = new Set<string>([...SAFE_TOOLS, 'Read', 'Glob', 'Grep', 'WebSearch'])
/** Built-ins this policy answers for: the ones it brings, and file writes, which always need approval. */
const OWNED_BUILTINS = new Set<string>([...BUILTIN_TOOLS, 'Write', 'Edit'])

/** Shell commands that only read. Anything else goes through Approve / Deny. */
export const isReadOnlyCommand = (cmd: string): boolean => {
  const c = cmd.trim()
  if (/[;&|><`]|\$\(/.test(c)) return false
  if (/\s-(delete|exec|execdir|ok)\b/.test(c)) return false
  return /^(ls|dir|pwd|cat|type|head|tail|wc|stat|file|du|df|which|where|whoami|hostname|date|echo|find|grep|rg|tree|Get-ChildItem|Get-Content|Get-Item|git (status|log|diff|show|branch))(\s|$)/i.test(
    c
  )
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
}

const allow = (input: Record<string, unknown>): PermissionResult => ({ behavior: 'allow', updatedInput: input })

/**
 * One permission policy for every computer-use call: look and search tools run freely, mouse and
 * keyboard tools are refused in Show-me mode, shell commands run only if they are read-only, and
 * file writes need approval. Null for calls that belong to another tool set.
 */
export const makePolicy =
  (d: PolicyDeps) =>
  async (name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult | null> => {
    if (!name.startsWith(`mcp__${SERVER}__`) && !OWNED_BUILTINS.has(name)) return null
    if (d.control.stopped() || d.ended()) return { behavior: 'deny', message: STOPPED_TEXT, interrupt: true }
    // MCP tool calls are counted when they run; built-ins only pass through here.
    if (!name.startsWith('mcp__') && !d.count()) return { behavior: 'deny', message: STOPPED_TEXT, interrupt: true }
    const ask = (title: string, detail: string) =>
      Effect.runPromise(d.interaction.requestApproval(d.owner, title, detail), { signal }).then(
        (ok): PermissionResult => (ok ? allow(input) : { behavior: 'deny', message: 'The user denied this.' }),
        (): PermissionResult => ({ behavior: 'deny', message: 'The user denied this.' })
      )
    if (AUTO_ALLOW.has(name)) return allow(input)
    if (ACT_TOOLS.has(name)) {
      if (d.mode() === 'teach') return { behavior: 'deny', message: "The user wants to learn this (teach mode): don't act for them. Guide them with teach_step instead." }
      return allow(input)
    }
    switch (name) {
      case 'Bash': {
        const cmd = String(input.command ?? '')
        return isReadOnlyCommand(cmd) ? allow(input) : ask('Run a command on your computer', cmd)
      }
      case 'Write':
        return ask('Create or overwrite a file', String(input.file_path ?? ''))
      case 'Edit':
        return ask('Change a file', String(input.file_path ?? ''))
      default:
        return { behavior: 'deny', message: "That tool isn't available." }
    }
  }
