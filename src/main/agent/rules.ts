// A bot's access: which rule each tool call falls under, and whether it may run (allow), needs the
// user's OK first (ask), or may not run at all (block). Every reply's tool calls go through
// `decide` (computer/policy.ts for computer use, `ruled` below for the other tool sets), and
// approvals use the same card as computer use's. Pure, apart from `ruled`'s ask.
//
// Across bots (phase 3, workers): the primary hands its work to any worker without asking, and
// the worker's own rules apply to what it does. When a worker asks another worker for something
// beyond its own access, `exceeds` says so, and the primary asks the user before passing it on.
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { MODULES, RULE_IDS, RULE_ITEMS, type ModuleId, type RuleId, type Rules, type Verdict, ruleValue } from '@shared/rules'
import type { Bot } from '@shared/types'
import { isReadOnlyCommand } from '../computer/policy'
import type { RunContext, ToolModuleFactory } from './module'

/** What access is worked out from. */
export type AccessBot = Pick<Bot, 'name' | 'modules' | 'rules' | 'isPrimary'>

export interface Decision {
  verdict: Verdict
  /** The rule the call falls under; null for a tool no rule covers (always blocked). */
  rule: RuleId | null
  /** For the approval card: what will be done, and to what. */
  title: string
  detail: string
  /** For the model, when blocked. */
  reason?: string
}

const mcp = (server: string, names: readonly string[], rule: RuleId) => names.map((n) => [`mcp__${server}__${n}`, rule] as const)

/** Every tool a tool set brings, by its full name, and the rule it falls under. Bash is decided by its command. */
const TOOL_RULES: ReadonlyMap<string, RuleId> = new Map<string, RuleId>([
  ...mcp('computer', ['look_at_screen', 'ui_elements', 'list_windows', 'wait', 'teach_step', 'clear_highlight'], 'computer.look'),
  ...mcp('computer', ['click', 'type_text', 'press_keys', 'scroll', 'drag', 'move_mouse', 'open', 'focus_window'], 'computer.act'),
  ...mcp('computer', ['ask_approval'], 'computer.irreversible'),
  ...mcp('computer', ['find_files', 'reveal_file'], 'files.read'),
  ...mcp('computer', ['remember'], 'memory.save'),
  ['Read', 'files.read'],
  ['Glob', 'files.read'],
  ['Grep', 'files.read'],
  ['Write', 'files.write'],
  ['Edit', 'files.write'],
  ['WebSearch', 'web.search'],
  ...mcp('browser', ['search', 'read', 'navigate', 'snapshot', 'scroll', 'history', 'screenshot', 'record', 'wait'], 'browser.read'),
  ...mcp('browser', ['click', 'type', 'press'], 'browser.act'),
  ...mcp('browser', ['evaluate'], 'browser.script'),
  ...mcp('memory', ['recall'], 'memory.recall'),
  ...mcp('notes', ['note'], 'jobs.notes')
])

/** Tool names `TOOL_RULES` knows, for tests that check every tool set's tools are covered. */
export const RULED_TOOLS: ReadonlySet<string> = new Set([...TOOL_RULES.keys(), 'Bash'])

/**
 * Commands that can't easily be undone or that touch accounts and security: deleting, formatting,
 * passwords and users, shutting down, elevation, force-pushing. Matched anywhere in the command
 * (chained ones too), so a mention in an argument errs towards asking.
 */
const IRREVERSIBLE_COMMAND =
  /(?:^|[\s;&|(`'"])(?:rm|rmdir|rd|del|erase|unlink|shred|format|mkfs(?:\.\w+)?|diskpart|dd|remove-item|ri|clear-recyclebin|clear-content|passwd|chpasswd|useradd|userdel|usermod|dscl|cmdkey|set-localuser|new-localuser|remove-localuser|shutdown|reboot|halt|poweroff|stop-computer|restart-computer|sudo|runas|net\s+user|reg\s+delete|remove-itemproperty|git\s+(?:push|reset\s+--hard|clean))(?=$|[\s;&|)`'"])/i

/** The rule a shell command falls under. */
export const commandRule = (cmd: string): RuleId =>
  isReadOnlyCommand(cmd) ? 'shell.read' : IRREVERSIBLE_COMMAND.test(cmd) ? 'shell.irreversible' : 'shell.run'

/** The rule a tool call falls under; null for a tool no rule covers. */
export const ruleOf = (tool: string, input: Record<string, unknown>): RuleId | null =>
  tool === 'Bash' ? commandRule(String(input.command ?? '')) : (TOOL_RULES.get(tool) ?? null)

/** The module a rule's tools come with, if it needs one. */
const needs = (id: RuleId): ModuleId | null => RULE_ITEMS.get(id)?.group.needs ?? null

/**
 * The bot's verdict for every rule: its own choice or the default, a locked rule never allow, and
 * every rule of a module it doesn't have blocked.
 */
export const rulesFor = (bot: Pick<AccessBot, 'modules' | 'rules'>): Record<RuleId, Verdict> => {
  const modules = new Set(bot.modules)
  return Object.fromEntries(
    RULE_IDS.map((id) => {
      const m = needs(id)
      return [id, m && !modules.has(m) ? 'block' : ruleValue(bot.rules as Rules, id)]
    })
  ) as Record<RuleId, Verdict>
}

const ASK_TITLES: Record<RuleId, string> = {
  'computer.look': 'Look at your screen',
  'computer.act': 'Use your mouse and keyboard',
  'computer.irreversible': 'Do something that can’t be undone',
  'shell.read': 'Run a command on your computer',
  'shell.run': 'Run a command on your computer',
  'shell.irreversible': 'Run a command on your computer',
  'files.read': 'Read your files',
  'files.write': 'Change a file',
  'web.search': 'Search the web',
  'browser.read': 'Open a web page',
  'browser.act': 'Act on a web page',
  'browser.script': 'Run a script in a web page',
  'memory.recall': 'Look in your memory',
  'memory.save': 'Save to your memory',
  'jobs.notes': 'Write a job note'
}

const TOOL_TITLES: Record<string, string> = {
  Write: 'Create or overwrite a file',
  Edit: 'Change a file'
}

const DETAIL_KEYS = ['command', 'file_path', 'url', 'query', 'pattern', 'text', 'fact', 'keys', 'action', 'detail', 'target', 'ref', 'path', 'code', 'title']

/** What the call will act on, for the card: its main arguments. */
export const callDetail = (input: Record<string, unknown>): string =>
  DETAIL_KEYS.flatMap((k) => {
    const v = input[k]
    return typeof v === 'string' && v.trim() ? [v.trim()] : typeof v === 'number' ? [`${k} ${v}`] : []
  })
    .join(' · ')
    .slice(0, 400)

const MODULE_LABELS = new Map(MODULES.map((m) => [m.id, m.label]))

/** Whether `bot` may make this call: allow, ask (the user's OK first) or block. ToolSearch always runs. */
export const decide = (bot: AccessBot, tool: string, input: Record<string, unknown>): Decision => {
  if (tool === 'ToolSearch') return { verdict: 'allow', rule: null, title: '', detail: '' }
  const rule = ruleOf(tool, input)
  const detail = callDetail(input)
  if (!rule) return { verdict: 'block', rule: null, title: tool, detail, reason: `${tool} isn't available to ${bot.name}.` }
  const verdict = rulesFor(bot)[rule]
  const title = TOOL_TITLES[tool] ?? ASK_TITLES[rule]
  if (verdict !== 'block') return { verdict, rule, title, detail }
  const m = needs(rule)
  const label = RULE_ITEMS.get(rule)!.label.toLowerCase()
  const reason =
    m && !bot.modules.includes(m)
      ? `${bot.name} doesn't have ${MODULE_LABELS.get(m)} turned on, so this tool can't run. Tell the user they can turn it on in Settings › Bots.`
      : `The user's rules for ${bot.name} block this (${label}). Don't try to do it another way: tell the user it's blocked, and that they can change it in Settings › Bots.`
  return { verdict, rule, title, detail, reason }
}

const RANK: Record<Verdict, number> = { block: 0, ask: 1, allow: 2 }

/** What a request across bots needs: its rules, or the tool calls it will make. Neither: everything the doer can do. */
export interface AccessRequest {
  rules?: readonly RuleId[]
  calls?: ReadonlyArray<{ tool: string; input: Record<string, unknown> }>
}

/**
 * Whether `doer` doing `request` for `requester` goes beyond what the requester could do itself,
 * so the user must approve it before it is passed on. The primary delegates freely, so a request
 * from it never does. `beyond` lists the rules where the doer has more: allow where the requester
 * would ask, or ask or allow where it is blocked. The doer's own rules still apply as it works.
 */
export const exceeds = (requester: AccessBot, doer: AccessBot, request: AccessRequest = {}): { exceeds: boolean; beyond: RuleId[] } => {
  if (requester.isPrimary) return { exceeds: false, beyond: [] }
  const ids = request.rules ?? (request.calls ? request.calls.flatMap((c) => ruleOf(c.tool, c.input) ?? []) : RULE_IDS)
  const mine = rulesFor(requester)
  const theirs = rulesFor(doer)
  const beyond = [...new Set(ids)].filter((id) => RANK[theirs[id]] > RANK[mine[id]])
  return { exceeds: beyond.length > 0, beyond }
}

/** How a reply asks the user and decides its calls (built per reply in services/Chat.ts). */
export interface Gate {
  readonly decide: (tool: string, input: Record<string, unknown>) => Decision
  /** Shows the approval card in the reply's chat; true if the user approved. */
  readonly ask: (ctx: RunContext, title: string, detail: string, signal: AbortSignal) => Promise<boolean>
}

const DENIED = 'The user denied this.'

/**
 * A tool set whose own tools go through the bot's rules first: blocked calls are refused, asked
 * ones wait for the user's OK. Its own permission rule (if any) runs after.
 */
export const ruled =
  (make: ToolModuleFactory, gate: Gate): ToolModuleFactory =>
  (ctx) => {
    const m = make(ctx)
    const own = (name: string) => name.startsWith(`mcp__${m.name}__`) || (m.builtins?.includes(name) ?? false)
    const canUseTool = async (name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult | null> => {
      if (!own(name)) return m.canUseTool ? m.canUseTool(name, input, signal) : null
      const d = gate.decide(name, input)
      if (d.verdict === 'block') return { behavior: 'deny', message: d.reason ?? DENIED }
      if (d.verdict === 'ask' && !(await gate.ask(ctx, d.title, d.detail, signal).catch(() => false))) return { behavior: 'deny', message: DENIED }
      return (m.canUseTool ? await m.canUseTool(name, input, signal) : null) ?? { behavior: 'allow', updatedInput: input }
    }
    return { ...m, canUseTool }
  }

/** A bot with Tomo's defaults: both modules, no rules of its own. What a reply without a bot runs under. */
export const DEFAULT_ACCESS: AccessBot = { name: 'Tomo', modules: ['computer', 'browser'], rules: {}, isPrimary: true }
