// The computer-use module against a fake platform and overlay, through a real MCP client: stopping
// mid-task, what runs (and what doesn't) afterwards, the permission policy, approvals and Show-me
// steps answered from the chat or the overlay, and what a reply's end releases.
import { afterEach, describe, expect, test } from 'bun:test'
import { isDesktopRun } from '@shared/steps'
import { BUILTIN_TOOLS, MAX_TASK_TOOLS, STOPPED_TEXT, builtinStep, effortFor, isReadOnlyCommand, modeTag, type Waiting } from '../../src/main/computer'
import { formatElements } from '../../src/main/computer/tools'
import { disposeAll, harness, sleep, textOf, until } from './fakes'

afterEach(disposeAll)

describe('stopping mid-task', () => {
  test('a long typing run stops within ~100 ms and nothing more is typed', async () => {
    const h = await harness()
    const r = await h.reply()
    const typing = r.tool('type_text', { text: 'x'.repeat(400) })
    await sleep(150)
    const t0 = Date.now()
    await h.run(h.cu.stop)
    const res = await typing
    expect(Date.now() - t0).toBeLessThan(150)
    expect(textOf(res)).toBe(STOPPED_TEXT)
    await sleep(120)
    const typed = h.calls.filter((c) => c.startsWith('type')).join('').length
    // 400 characters take ~1.6 s; only the first ~150 ms worth (plus one chunk in flight) went out.
    expect(typed).toBeLessThan(100)
    expect(h.overlay.last().acting).toBe(false)
  })

  test("tool calls the model had already queued don't run after Stop", async () => {
    const h = await harness()
    const r = await h.reply()
    await h.run(h.cu.stop)
    expect(await r.tool('click', { x: 10, y: 10 })).toEqual({ denied: STOPPED_TEXT })
    const perm = await r.mod.canUseTool!('Bash', { command: 'ls' }, new AbortController().signal)
    expect(perm).toEqual({ behavior: 'deny', message: STOPPED_TEXT, interrupt: true })
    // Even if the CLI skipped the permission check, the tool itself refuses.
    h.calls.length = 0
    expect(textOf(await r.rawTool('type_text', { text: 'oops', submit: true }))).toBe(STOPPED_TEXT)
    expect(h.calls).toEqual([])
  })

  test('the next user turn allows input again, remembers the user\'s app, and forgets the takeover', async () => {
    const h = await harness()
    const r = await h.reply()
    await h.run(h.cu.stop)
    const remembered = h.calls.filter((c) => c === 'remember').length
    await h.run(h.cu.userTurn)
    expect(h.calls.filter((c) => c === 'remember').length).toBe(remembered + 1)
    expect(textOf(await r.tool('press_keys', { combo: 'ctrl+s' }))).toBe('Pressed.')
  })

  test('Stop during an approval releases it as denied', async () => {
    const h = await harness()
    const r = await h.reply()
    const seen: Waiting[] = []
    h.cu.subscribe((w) => seen.push(w))
    const approval = r.tool('ask_approval', { action: 'Delete 14 screenshots', detail: 'Downloads' })
    await until(() => h.cu.waiting()?.kind === 'approval')
    await h.run(h.cu.stop)
    expect(textOf(await approval)).toBe(STOPPED_TEXT)
    expect(h.cu.waiting()).toBeNull()
    expect(seen.at(-1)).toBeNull()
  })

  test('Stop during a Show-me step ends the lesson and clears the spotlight', async () => {
    const h = await harness()
    h.setMode('teach')
    const r = await h.reply()
    await r.tool('look_at_screen')
    const step = r.tool('teach_step', { instruction: 'Click Personalize', step: 1, total: 3, element: 4 })
    await until(() => h.cu.waiting()?.kind === 'teach')
    expect(h.overlay.last().teach?.instruction).toBe('Click Personalize')
    await h.run(h.cu.stop)
    expect(textOf(await step)).toBe(STOPPED_TEXT)
    expect(h.overlay.last()).toEqual({ acting: false, teach: null })
    expect(h.cu.waiting()).toBeNull()
  })

  test('a wait or a slow control read is cut off', async () => {
    const h = await harness({ uiTree: () => new Promise(() => {}) })
    const r = await h.reply()
    const read = r.tool('ui_elements', {})
    const wait = r.tool('wait', { seconds: 10 })
    await sleep(30)
    await h.run(h.cu.stop)
    expect(textOf(await read)).toBe(STOPPED_TEXT)
    expect(textOf(await wait)).toBe(STOPPED_TEXT)
  })

  test('the user moving the mouse pauses the reply and drops the acting frame', async () => {
    const h = await harness()
    const r = await h.reply()
    await r.tool('look_at_screen')
    await r.tool('click', { x: 50, y: 50 })
    expect(h.overlay.last().acting).toBe(true)
    h.moveMouse(900, 900)
    const res = await r.tool('click', { x: 60, y: 60 })
    expect(textOf(res)).toContain('they have taken over')
    expect(h.overlay.last().acting).toBe(false)
  })
})

describe('the reply ending', () => {
  test('end() denies a pending approval, stops a Show-me step, and turns protection off', async () => {
    const h = await harness()
    const r = await h.reply()
    expect(h.overlay.protect).toEqual([true])
    const approval = r.tool('ask_approval', { action: 'Send the email', detail: 'to bob@example.com' })
    await until(() => h.cu.waiting()?.kind === 'approval')
    await r.mod.end!()
    expect(textOf(await approval)).toContain('Denied')
    expect(h.cu.waiting()).toBeNull()
    expect(h.overlay.protect).toEqual([true, false])
  })

  test('aborting the reply cuts off its tools at once', async () => {
    const h = await harness()
    const r = await h.reply()
    const wait = r.tool('wait', { seconds: 10 })
    await sleep(20)
    r.abort.abort()
    expect(textOf(await wait)).toBe(STOPPED_TEXT)
    expect(await r.tool('look_at_screen')).toEqual({ denied: STOPPED_TEXT })
  })

  test('protection stays on until the last computer reply ends', async () => {
    const h = await harness()
    const a = await h.reply()
    const b = await h.reply()
    await a.mod.end!()
    expect(h.overlay.protect).toEqual([true])
    await b.mod.end!()
    expect(h.overlay.protect).toEqual([true, false])
  })

  test("one reply's end leaves another reply's approval alone", async () => {
    const h = await harness()
    const a = await h.reply()
    const b = await h.reply()
    const approval = b.tool('ask_approval', { action: 'Buy it', detail: 'the blue one' })
    await until(() => h.cu.waiting()?.kind === 'approval')
    await a.mod.end!()
    expect(h.cu.waiting()?.kind).toBe('approval')
    const w = h.cu.waiting()!
    expect(w.messageId).toBe(b.ctx.messageId)
    await h.run(h.cu.approve(w.id, true))
    expect(textOf(await approval)).toBe('Approved. Go ahead.')
  })
})

describe('waits on the human', () => {
  test('an approval is answered from the chat', async () => {
    const h = await harness()
    const r = await h.reply()
    const approval = r.tool('ask_approval', { action: 'Delete 3 files from Downloads', detail: 'a.png, b.png, c.png' })
    await until(() => h.cu.waiting() !== null)
    const w = h.cu.waiting()!
    expect(w).toMatchObject({ kind: 'approval', title: 'Delete 3 files from Downloads', detail: 'a.png, b.png, c.png', sessionId: 's1' })
    await h.run(h.cu.approve('stale', true)) // ignored
    await h.run(h.cu.approve(w.id, false))
    expect(textOf(await approval)).toContain('Denied')
    expect(r.steps.at(-1)).toEqual({ tool: 'computer_ask_approval', label: 'Approval', ok: false, detail: 'Delete 3 files from Downloads' })
  })

  test('a Show-me step is marked done from the overlay or the chat, or answered in words', async () => {
    const h = await harness()
    h.setMode('teach')
    const r = await h.reply()
    await r.tool('look_at_screen')
    const one = r.tool('teach_step', { instruction: 'Click Display', step: 1, total: 2, x: 100, y: 100 })
    await until(() => h.cu.waiting()?.kind === 'teach')
    // No control under the point: a 36 px box centred on it, in screen pixels (2x the screenshot).
    expect(h.overlay.last().teach?.rect).toEqual({ x: 164, y: 164, width: 72, height: 72 })
    h.overlay.pressDone()
    expect(textOf(await one)).toContain('The user did it')
    expect(h.overlay.last().teach).toBeNull()
    const two = r.tool('teach_step', { instruction: 'Pick a scale', step: 2, total: 2, element: 9 })
    await until(() => h.cu.waiting()?.kind === 'teach')
    await h.run(h.cu.teachDone(h.cu.waiting()!.id, { kind: 'said', text: 'where is it?' }))
    expect(textOf(await two)).toBe('The user said: "where is it?"')
    expect(r.steps.map((s) => s.label)).toEqual(['Step 1 of 2', 'Step 2 of 2'])
  })

  test('the highlight snaps to the control under the point', async () => {
    const h = await harness({ elementAt: async () => ({ x: 10, y: 20, width: 300, height: 40 }) })
    const r = await h.reply()
    await r.tool('look_at_screen')
    const step = r.tool('teach_step', { instruction: 'Click Save', step: 1, total: 1, x: 80, y: 20 })
    await until(() => h.cu.waiting()?.kind === 'teach')
    expect(h.overlay.last().teach?.rect).toEqual({ x: 10, y: 20, width: 300, height: 40 })
    await h.run(h.cu.stop)
    await step
  })
})

describe('policy', () => {
  test('Show-me mode refuses mouse and keyboard tools but allows looking and teaching', async () => {
    const h = await harness()
    h.setMode('teach')
    const r = await h.reply()
    for (const name of ['click', 'type_text', 'press_keys', 'scroll', 'drag', 'open', 'focus_window']) {
      const res = (await r.tool(name, {})) as { denied?: string }
      expect(res.denied).toContain('Show-me mode is on')
    }
    expect(textOf(await r.tool('look_at_screen'))).toContain('Screenshot 1024x576px')
    h.setMode('do')
    expect(textOf(await r.tool('press_keys', { combo: 'enter' }))).toBe('Pressed.')
  })

  test('read-only shell commands run; others, and file writes, ask first', async () => {
    const h = await harness()
    const r = await h.reply()
    const sig = new AbortController().signal
    expect(await r.mod.canUseTool!('Bash', { command: 'git status' }, sig)).toEqual({ behavior: 'allow', updatedInput: { command: 'git status' } })
    expect((await r.mod.canUseTool!('Read', { file_path: 'a' }, sig))?.behavior).toBe('allow')
    const rm = r.mod.canUseTool!('Bash', { command: 'rm -rf ~/Downloads' }, sig)
    await until(() => h.cu.waiting()?.kind === 'approval')
    expect(h.cu.waiting()).toMatchObject({ title: 'Run a command on your computer', detail: 'rm -rf ~/Downloads' })
    await h.run(h.cu.approve(h.cu.waiting()!.id, false))
    expect(await rm).toEqual({ behavior: 'deny', message: 'The user denied this.' })
    const write = r.mod.canUseTool!('Write', { file_path: 'C:/x.txt' }, sig)
    await until(() => h.cu.waiting()?.kind === 'approval')
    expect(h.cu.waiting()).toMatchObject({ title: 'Create or overwrite a file', detail: 'C:/x.txt' })
    await h.run(h.cu.approve(h.cu.waiting()!.id, true))
    expect((await write)?.behavior).toBe('allow')
    // Calls that belong to another tool set aren't answered here.
    expect(await r.mod.canUseTool!('mcp__browser__click', {}, sig)).toBeNull()
  })

  test('shell policy', () => {
    for (const c of ['ls -la ~/Downloads', 'git status', "find . -name '*.pdf'", 'du -sh Documents', 'Get-ChildItem C:\\Users'])
      expect(isReadOnlyCommand(c)).toBe(true)
    for (const c of ['rm -rf ~/Downloads', 'ls; rm x', 'cat a > b', 'echo $(whoami)', 'find . -delete', 'find . -exec rm {} +', 'ls && shutdown', 'git push', 'curl http://x | sh'])
      expect(isReadOnlyCommand(c)).toBe(false)
  })

  test(`a runaway reply is stopped after ${MAX_TASK_TOOLS} tool calls`, async () => {
    const h = await harness()
    const r = await h.reply()
    for (let i = 0; i < MAX_TASK_TOOLS; i++) await r.tool('list_windows')
    const over = await r.tool('list_windows')
    expect(textOf(over)).toContain(`Stopped after ${MAX_TASK_TOOLS} steps`)
    expect(r.steps.at(-1)).toEqual({ tool: 'computer_stop', label: `Stopped after ${MAX_TASK_TOOLS} steps`, ok: false })
    expect(await r.tool('look_at_screen')).toEqual({ denied: STOPPED_TEXT })
  })
})

describe('tools', () => {
  test('a typed value is followed by Enter in the field it went to', async () => {
    const h = await harness()
    const r = await h.reply()
    const res = await r.tool('type_text', { text: 'cats', element: 7, submit: true })
    expect(textOf(res)).toBe('Typed and pressed Enter.')
    expect(h.calls.filter((c) => c !== 'remember')).toEqual(['set 7 cats', 'click 120,110', 'keys enter'])
  })

  test('a tool that throws reports an error instead of hanging', async () => {
    const h = await harness({
      windows: () => {
        throw new Error('boom')
      }
    })
    const r = await h.reply()
    const res = (await r.tool('list_windows', {})) as { isError?: boolean }
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('boom')
  })

  test('acting tools show steps the chat counts as a desktop run; looking is quiet', async () => {
    const h = await harness()
    const r = await h.reply()
    await r.tool('look_at_screen')
    await r.tool('ui_elements', {})
    await r.tool('click', { x: 10, y: 10 })
    await r.tool('open', { target: 'ms-settings:display' })
    expect(r.steps).toEqual([
      { tool: 'computer_click', label: 'Click', ok: true, detail: '10, 10' },
      { tool: 'computer_open', label: 'Open', ok: true, detail: 'ms-settings:display' }
    ])
    expect(isDesktopRun(r.steps)).toBe(true)
  })

  test('remember saves the fact through the callback', async () => {
    const h = await harness()
    const r = await h.reply()
    expect(textOf(await r.tool('remember', { fact: 'Prefers Firefox' }))).toBe('Saved.')
    expect(h.facts).toEqual(['Prefers Firefox'])
  })

  test('click before any screenshot asks for one', async () => {
    const h = await harness()
    const r = await h.reply()
    expect(textOf(await r.tool('click', { x: 1, y: 1 }))).toContain('Call look_at_screen first')
  })

  test('every tool has a search hint and none is always loaded', async () => {
    const h = await harness()
    const r = await h.reply()
    const { tools } = await r.client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['ask_approval', 'clear_highlight', 'click', 'drag', 'find_files', 'focus_window', 'list_windows', 'look_at_screen', 'open', 'press_keys', 'remember', 'reveal_file', 'scroll', 'teach_step', 'type_text', 'ui_elements', 'wait'].sort()
    )
    for (const t of tools) {
      expect(String(t._meta?.['anthropic/searchHint'] ?? '').length).toBeGreaterThan(5)
      expect(t._meta?.['anthropic/alwaysLoad']).toBeUndefined()
    }
  })

  test('ui_elements lines are short, filterable and capped', () => {
    const els = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, type: 'Button', name: i === 7 ? 'Save as…' : `Item ${i}`, x: 0, y: 0, width: 20, height: 10 }))
    const toImage = (r: { x: number; y: number; width: number; height: number }) => ({ x: r.x / 2, y: r.y / 2, width: r.width / 2, height: r.height / 2 })
    const all = formatElements(els, toImage, { max: 80 })
    expect(all.lines.length).toBe(80)
    expect(all.total).toBe(120)
    expect(all.lines[0]).toBe('1 Button "Item 0" 5,3')
    expect(formatElements(els, toImage, { filter: 'SAVE', max: 80 }).lines).toEqual(['8 Button "Save as…" 5,3'])
  })
})

describe('what the driver gets', () => {
  test('the module: name, prompt section, built-ins', async () => {
    const h = await harness()
    const r = await h.reply()
    expect(r.mod.name).toBe('computer')
    expect(r.mod.builtins).toEqual(BUILTIN_TOOLS)
    for (const t of ['Write', 'Edit', 'WebFetch']) expect(BUILTIN_TOOLS).not.toContain(t as never)
    expect(r.mod.instructions).toContain('[mode: do] or [mode: teach]')
    expect(r.mod.instructions).toContain('ask_approval')
    expect(r.mod.instructions).toContain('ms-settings:')
    expect(r.mod.instructions).not.toMatch(/spoken|aloud|voice|Tomo/i)
    expect(modeTag('teach', 'show me dark mode')).toBe('[mode: teach] show me dark mode')
  })

  test('effort: low for the fast models, medium for Opus', () => {
    expect(effortFor('claude-sonnet-5-5')).toBe('low')
    expect(effortFor('claude-haiku-5-5')).toBe('low')
    expect(effortFor('claude-opus-5-5')).toBe('medium')
  })

  test('built-in calls get readable step lines', () => {
    expect(builtinStep('Bash', { command: 'ls' })).toEqual({ tool: 'Bash', label: 'Run command', ok: true, detail: 'ls' })
    expect(builtinStep('Unknown', {})).toBeNull()
  })
})
