// What a bot may do: the tool modules it has, and a rule (allow, ask or block) for every kind of
// tool call. The main process decides each call from these (src/main/agent/rules.ts); Settings ›
// Bots edits them. The defaults are computer/policy.ts's: looking, reading and read-only commands
// run freely, file writes and other commands ask, and irreversible actions always ask.

export type Verdict = 'allow' | 'ask' | 'block'

export const VERDICTS: readonly Verdict[] = ['allow', 'ask', 'block']

/** Tool modules a bot can have. Computer brings the shell, files and web search with it. */
export type ModuleId = 'computer' | 'browser'

export const MODULES: ReadonlyArray<{ id: ModuleId; label: string; hint: string }> = [
  { id: 'computer', label: 'Computer', hint: 'See your screen, use your apps, run commands and work with your files' },
  { id: 'browser', label: 'Browser', hint: 'Search and use web pages in the side panel, where you can watch' }
]

export type RuleId =
  | 'computer.look'
  | 'computer.act'
  | 'computer.irreversible'
  | 'shell.read'
  | 'shell.run'
  | 'shell.irreversible'
  | 'files.read'
  | 'files.write'
  | 'web.search'
  | 'browser.read'
  | 'browser.act'
  | 'browser.script'
  | 'memory.recall'
  | 'memory.save'
  | 'jobs.notes'

export interface RuleItem {
  id: RuleId
  label: string
  hint: string
  default: Verdict
  /** Always the user's: it can be ask or block, never allow. */
  locked?: true
}

export interface RuleGroup {
  id: string
  label: string
  /** The module these tools come with; null for tools every bot has. */
  needs: ModuleId | null
  items: RuleItem[]
}

export const RULE_GROUPS: readonly RuleGroup[] = [
  {
    id: 'computer',
    label: 'Computer',
    needs: 'computer',
    items: [
      { id: 'computer.look', label: 'See the screen', hint: 'Screenshots, reading apps and windows, Show-me steps', default: 'allow' },
      { id: 'computer.act', label: 'Click and type', hint: 'Use the mouse and keyboard, open and switch apps', default: 'allow' },
      {
        id: 'computer.irreversible',
        label: 'Irreversible actions',
        hint: 'Deleting, sending, buying, installing, changing passwords or security settings',
        default: 'ask',
        locked: true
      }
    ]
  },
  {
    id: 'shell',
    label: 'Shell',
    needs: 'computer',
    items: [
      { id: 'shell.read', label: 'Read-only commands', hint: 'ls, cat, find, git status and others that only read', default: 'allow' },
      { id: 'shell.run', label: 'Other commands', hint: 'Anything that changes files or runs programs', default: 'ask' },
      { id: 'shell.irreversible', label: 'Deleting and account commands', hint: 'rm, del, format, passwd, net user and the like', default: 'ask', locked: true }
    ]
  },
  {
    id: 'files',
    label: 'Files',
    needs: 'computer',
    items: [
      { id: 'files.read', label: 'Find and read files', hint: 'Search your files and read them', default: 'allow' },
      { id: 'files.write', label: 'Create and change files', hint: 'Write new files or edit existing ones', default: 'ask' }
    ]
  },
  {
    id: 'web',
    label: 'Web',
    needs: 'computer',
    items: [{ id: 'web.search', label: 'Quick web searches', hint: 'Look up a fact without opening a page', default: 'allow' }]
  },
  {
    id: 'browser',
    label: 'Browser',
    needs: 'browser',
    items: [
      { id: 'browser.read', label: 'Open and read pages', hint: 'Search, open, scroll, screenshot and record', default: 'allow' },
      { id: 'browser.act', label: 'Click and type on pages', hint: 'Fill in forms, press buttons and keys', default: 'allow' },
      { id: 'browser.script', label: 'Run scripts in pages', hint: 'JavaScript in the open page', default: 'allow' }
    ]
  },
  {
    id: 'memory',
    label: 'Memory',
    needs: null,
    items: [
      { id: 'memory.recall', label: 'Look things up', hint: 'Search what it knows about you and past jobs', default: 'allow' },
      { id: 'memory.save', label: 'Save to memory', hint: 'Keep a fact you asked it to remember', default: 'allow' }
    ]
  },
  {
    id: 'jobs',
    label: 'Jobs',
    needs: null,
    items: [{ id: 'jobs.notes', label: 'Write job notes', hint: 'Notes on where a job stands, for later replies', default: 'allow' }]
  }
]

export const RULE_ITEMS: ReadonlyMap<RuleId, RuleItem & { group: RuleGroup }> = new Map(
  RULE_GROUPS.flatMap((g) => g.items.map((i) => [i.id, { ...i, group: g }] as const))
)

export const RULE_IDS: readonly RuleId[] = [...RULE_ITEMS.keys()]

/** A bot's own choices; a rule it hasn't set has its default. */
export type Rules = Partial<Record<RuleId, Verdict>>

const isVerdict = (v: unknown): v is Verdict => v === 'allow' || v === 'ask' || v === 'block'

/** A rule's value: the bot's choice or the default. A locked rule set to allow asks. */
export const ruleValue = (rules: Rules, id: RuleId): Verdict => {
  const item = RULE_ITEMS.get(id)
  const v = rules[id] ?? item?.default ?? 'block'
  return item?.locked && v === 'allow' ? 'ask' : v
}

/** Rules as stored or sent: unknown ids and values dropped, a locked rule never allow. */
export const cleanRules = (raw: unknown): Rules => {
  const out: Rules = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const item = RULE_ITEMS.get(k as RuleId)
    if (!item || !isVerdict(v)) continue
    out[item.id] = item.locked && v === 'allow' ? 'ask' : v
  }
  return out
}

/** Modules as stored or sent: known ones, once each, in catalogue order. */
export const cleanModules = (raw: unknown): ModuleId[] => {
  const list = Array.isArray(raw) ? raw : []
  return MODULES.map((m) => m.id).filter((id) => list.includes(id))
}
