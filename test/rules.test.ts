import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Effect } from 'effect'
import { RULE_GROUPS, RULE_IDS, cleanModules, cleanRules, ruleValue } from '../src/shared/rules'
import { DEFAULT_ACCESS, RULED_TOOLS, commandRule, decide, exceeds, ruleOf, rulesFor, type AccessBot } from '../src/main/agent/rules'
import { BUILTIN_TOOLS } from '../src/main/computer'
import { ACT_TOOLS, SAFE_TOOLS } from '../src/main/computer/tools'
import { browserModule } from '../src/main/agent/browser'
import { noteModule } from '../src/main/agent/notes'
import { recallModule } from '../src/main/agent/recall'
import type { RunContext } from '../src/main/agent/module'
import type { BrowserApi } from '../src/main/services/Browser'
import { MIGRATIONS, makeDb } from '../src/main/services/Db'
import { BOT_MODULES_MIGRATION } from '../src/main/services/jobsDb'

const bot = (over: Partial<AccessBot> = {}): AccessBot => ({ name: 'Scout', modules: ['computer', 'browser'], rules: {}, isPrimary: false, ...over })
const v = (b: AccessBot, tool: string, input: Record<string, unknown> = {}) => decide(b, tool, input).verdict

describe('decide', () => {
  test("the defaults are computer/policy.ts's: reads run, writes and other commands ask, irreversible ones ask", () => {
    const b = bot()
    expect(v(b, 'Bash', { command: 'git status' })).toBe('allow')
    expect(v(b, 'Bash', { command: 'ls -la' })).toBe('allow')
    expect(v(b, 'Bash', { command: 'npm install' })).toBe('ask')
    expect(v(b, 'Bash', { command: 'rm -rf ~/Downloads' })).toBe('ask')
    expect(v(b, 'Read', { file_path: 'a' })).toBe('allow')
    expect(v(b, 'Glob', { pattern: '*' })).toBe('allow')
    expect(v(b, 'Write', { file_path: 'a' })).toBe('ask')
    expect(v(b, 'Edit', { file_path: 'a' })).toBe('ask')
    expect(v(b, 'WebSearch', { query: 'x' })).toBe('allow')
    expect(v(b, 'mcp__computer__look_at_screen')).toBe('allow')
    expect(v(b, 'mcp__computer__click', { x: 1, y: 1 })).toBe('allow')
    expect(v(b, 'mcp__computer__ask_approval', { action: 'Delete', detail: 'a' })).toBe('ask')
    expect(v(b, 'mcp__browser__evaluate', { code: '1' })).toBe('allow')
    expect(v(b, 'mcp__memory__recall', { query: 'x' })).toBe('allow')
    expect(v(b, 'mcp__notes__note', { kind: 'state', text: 'x' })).toBe('allow')
    expect(v(b, 'ToolSearch', { query: 'select:x' })).toBe('allow')
  })

  test('the card says what will be done and to what', () => {
    expect(decide(bot(), 'Bash', { command: 'del report.txt', description: 'Delete it' })).toMatchObject({ title: 'Run a command on your computer', detail: 'del report.txt' })
    expect(decide(bot(), 'Write', { file_path: 'C:\\a.txt', content: 'long' })).toMatchObject({ title: 'Create or overwrite a file', detail: 'C:\\a.txt' })
    expect(decide(bot(), 'mcp__browser__type', { ref: 'e2', text: 'hi' })).toMatchObject({ title: 'Act on a web page', detail: 'hi · e2' })
  })

  test('shell commands: read-only, irreversible (deleting, accounts, passwords, elevation), or other', () => {
    for (const c of ['ls', 'git log --oneline', 'cat a.txt', 'Get-ChildItem C:\\']) expect(commandRule(c)).toBe('shell.read')
    for (const c of ['rm a', 'del /q a.txt', 'Remove-Item -Recurse x', 'echo y | format D:', 'passwd', 'net user bob *', 'sudo apt update', 'git push --force', 'git reset --hard HEAD~1', 'shutdown /s', 'cd x && rmdir /s y'])
      expect([c, commandRule(c)]).toEqual([c, 'shell.irreversible'])
    for (const c of ['npm install', 'mkdir build', 'git commit -m x', 'python script.py', 'format-table']) expect([c, commandRule(c)]).toEqual([c, 'shell.run'])
  })

  test("the bot's rules decide, and a rule of a module it doesn't have blocks with why", () => {
    const b = bot({ modules: ['browser'], rules: { 'browser.act': 'block', 'browser.read': 'ask' } })
    expect(v(b, 'mcp__browser__click', { ref: 'e1' })).toBe('block')
    expect(decide(b, 'mcp__browser__click', { ref: 'e1' }).reason).toContain('block')
    expect(v(b, 'mcp__browser__navigate', { url: 'x' })).toBe('ask')
    expect(v(b, 'mcp__browser__evaluate', { code: '1' })).toBe('allow')
    const off = decide(b, 'Bash', { command: 'ls' })
    expect(off.verdict).toBe('block')
    expect(off.reason).toContain("doesn't have Computer turned on")
    expect(v(bot({ modules: [] }), 'mcp__memory__recall', { query: 'x' })).toBe('allow')
  })

  test('tools no rule covers are blocked', () => {
    expect(decide(bot(), 'WebFetch', { url: 'x' })).toMatchObject({ verdict: 'block', rule: null })
    expect(v(bot(), 'mcp__computer__format_disk')).toBe('block')
  })

  test("locked rules (always the user's) can't be set to allow: stored, sent or read", () => {
    const locked = RULE_GROUPS.flatMap((g) => g.items).filter((i) => i.locked).map((i) => i.id)
    expect(locked.sort()).toEqual(['computer.irreversible', 'shell.irreversible'])
    const all = Object.fromEntries(RULE_IDS.map((id) => [id, 'allow']))
    expect(cleanRules(all)['computer.irreversible']).toBe('ask')
    expect(cleanRules(all)['shell.irreversible']).toBe('ask')
    expect(ruleValue(all, 'shell.irreversible')).toBe('ask')
    const everything = bot({ rules: all })
    expect(v(everything, 'Bash', { command: 'rm -rf /' })).toBe('ask')
    expect(v(everything, 'mcp__computer__ask_approval', { action: 'Buy', detail: 'x' })).toBe('ask')
    expect(v(everything, 'Bash', { command: 'npm install' })).toBe('allow')
    // They can be blocked.
    expect(v(bot({ rules: { 'shell.irreversible': 'block' } }), 'Bash', { command: 'rm a' })).toBe('block')
  })

  test('stored rules and modules are cleaned: unknown ids and values go', () => {
    expect(cleanRules({ 'shell.run': 'allow', nope: 'allow', 'files.write': 'maybe', 'files.read': 'block' })).toEqual({ 'shell.run': 'allow', 'files.read': 'block' })
    expect(cleanRules(null)).toEqual({})
    expect(cleanModules(['browser', 'computer', 'browser', 'teleport'])).toEqual(['computer', 'browser'])
    expect(cleanModules('computer')).toEqual([])
  })

  test('every tool every tool set brings falls under a rule', () => {
    const ctx: RunContext = { sessionId: 's', messageId: 'm', jobId: 'j', signal: new AbortController().signal, step: async () => {}, attach: async () => {} }
    const namesOf = (server: unknown) =>
      Object.keys((server as { instance: { _registeredTools: Record<string, unknown> } }).instance._registeredTools)
    const browser = browserModule({ status: () => Effect.void, release: Effect.void } as unknown as BrowserApi)(ctx)
    const notes = noteModule(async () => ({ id: 1, rev: 1, replaced: false }) as never)(ctx)
    const recall = recallModule(async () => [] as never, () => ({ botId: null, jobId: null }))(ctx)
    const tools = [
      ...SAFE_TOOLS,
      ...ACT_TOOLS,
      ...BUILTIN_TOOLS,
      'Write',
      'Edit',
      ...[browser, notes, recall].flatMap((m) => namesOf(m.server).map((n) => `mcp__${m.name}__${n}`))
    ]
    expect(namesOf(browser.server).length).toBeGreaterThan(10)
    for (const t of tools) expect([t, RULED_TOOLS.has(t) && (t === 'Bash' || ruleOf(t, {}) !== null)]).toEqual([t, true])
  })
})

describe('rulesFor', () => {
  test('every rule, with defaults, locked ones never allow, and modules the bot lacks blocked', () => {
    const r = rulesFor(bot({ modules: ['browser'], rules: { 'browser.script': 'block', 'computer.irreversible': 'allow' as never } }))
    expect(Object.keys(r).sort()).toEqual([...RULE_IDS].sort())
    expect(r['browser.read']).toBe('allow')
    expect(r['browser.script']).toBe('block')
    expect(r['shell.read']).toBe('block')
    expect(r['computer.irreversible']).toBe('block')
    expect(r['memory.recall']).toBe('allow')
    expect(rulesFor(DEFAULT_ACCESS)['computer.irreversible']).toBe('ask')
  })
})

describe('exceeds', () => {
  const readOnly = bot({ name: 'Reader', rules: { 'files.write': 'block', 'shell.run': 'block' } })
  const writer = bot({ name: 'Writer', rules: { 'files.write': 'allow' } })
  const primary = bot({ name: 'Tomo', isPrimary: true, modules: [] })

  test('a read-only worker asking another for a write needs the user', () => {
    expect(exceeds(readOnly, writer, { calls: [{ tool: 'Write', input: { file_path: 'a' } }] })).toEqual({ exceeds: true, beyond: ['files.write'] })
    expect(exceeds(readOnly, writer, { rules: ['files.write', 'files.read'] })).toEqual({ exceeds: true, beyond: ['files.write'] })
    // Asked to do something the requester could do itself: passed on.
    expect(exceeds(readOnly, writer, { calls: [{ tool: 'Read', input: { file_path: 'a' } }, { tool: 'Bash', input: { command: 'ls' } }] })).toEqual({ exceeds: false, beyond: [] })
  })

  test('with no request named, everything the doer can do beyond the requester counts', () => {
    const r = exceeds(readOnly, writer)
    expect(r.exceeds).toBe(true)
    expect(r.beyond.sort()).toEqual(['files.write', 'shell.run'])
    // Ask where the requester is blocked is more too: the doer could do it once the user says so.
    expect(exceeds(bot({ modules: ['computer'] }), bot({ modules: ['computer', 'browser'], rules: { 'browser.act': 'ask' } }), { rules: ['browser.act'] }).exceeds).toBe(true)
    // A doer with less passes: its own rules apply as it works.
    expect(exceeds(writer, readOnly).exceeds).toBe(false)
    expect(exceeds(writer, writer).exceeds).toBe(false)
  })

  test('the primary delegates freely, even to a bot with more access than its own', () => {
    expect(exceeds(primary, writer)).toEqual({ exceeds: false, beyond: [] })
    expect(exceeds(primary, writer, { calls: [{ tool: 'Bash', input: { command: 'rm -rf build' } }] }).exceeds).toBe(false)
  })
})

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

describe('the migration to rules', () => {
  /** A chat.db as phase 1 left it, with chats that had the switches on as given. */
  const oldDb = (chats: Array<{ browser: boolean; computer: boolean }>) => {
    const dir = mkdtempSync(join(tmpdir(), 'tomo-rules-'))
    dirs.push(dir)
    const file = join(dir, 'chat.db')
    const at = MIGRATIONS.indexOf(BOT_MODULES_MIGRATION)
    expect(at).toBeGreaterThan(0)
    const raw = new DatabaseSync(file)
    raw.exec('pragma foreign_keys = on')
    for (const [i, sql] of MIGRATIONS.slice(0, at).entries()) {
      raw.exec(sql)
      raw.exec(`pragma user_version = ${i + 1}`)
    }
    chats.forEach((c, i) => {
      raw.exec(`insert into sessions (id, title, root_id, created_at, updated_at, browser_enabled, computer_enabled, bot_id, kind)
                values ('c${i}', 'Chat ${i}', 'c${i}-root', ${i}, ${i}, ${c.browser ? 1 : 0}, ${c.computer ? 1 : 0}, 'tomo', 'shared')`)
    })
    raw.close()
    return file
  }

  test('the primary gets each module some chat had on, and the old switches stay in chat.db', () => {
    const file = oldDb([
      { browser: false, computer: true },
      { browser: false, computer: false }
    ])
    const db = makeDb(file)
    expect(db.primaryBot()).toMatchObject({ modules: ['computer'], rules: {} })
    const raw = new DatabaseSync(file)
    expect(raw.prepare('select id, computer_enabled from sessions where kind = ? order by id').all('shared')).toEqual([
      { id: 'c0', computer_enabled: 1 },
      { id: 'c1', computer_enabled: 0 }
    ])
    raw.close()
  })

  test('both modules when both were used; none when neither was, as the switches started', () => {
    expect(makeDb(oldDb([{ browser: true, computer: false }, { browser: false, computer: true }])).primaryBot().modules).toEqual(['computer', 'browser'])
    expect(makeDb(oldDb([{ browser: false, computer: false }])).primaryBot().modules).toEqual([])
    expect(makeDb(oldDb([])).primaryBot().modules).toEqual([])
  })

  test('the bot keeps what Settings › Bots changes', () => {
    const db = makeDb(oldDb([]))
    db.updateBot('tomo', { modules: ['browser'], rules: { 'files.write': 'block', 'computer.irreversible': 'allow' } as never, avatar: null, name: 'Kit' })
    expect(db.primaryBot()).toMatchObject({ name: 'Kit', avatar: null, modules: ['browser'], rules: { 'files.write': 'block', 'computer.irreversible': 'ask' } })
  })
})
