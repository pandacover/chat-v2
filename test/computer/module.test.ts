// The computer-use module against a fake platform and overlay, through a real MCP client: stopping
// mid-task, what runs (and what doesn't) afterwards, the permission policy, approvals and Show-me
// steps answered from the chat or the overlay, and what a reply's end releases.
import { afterEach, describe, expect, test } from 'bun:test'
import { type Step, isDesktopRun } from '@shared/steps'
import {
  BUILTIN_TOOLS,
  CLICK_SETTLE_MS,
  CLICK_STEP,
  MAX_TASK_READS,
  MAX_TASK_TOOLS,
  POINT_GRACE_MS,
  STOPPED_TEXT,
  builtinStep,
  decideMode,
  effortFor,
  handsOver,
  isReadOnlyCommand,
  modeTag,
  teachAnswer,
  type Waiting
} from '../../src/main/computer'
import { cameraHousing } from '../../src/main/computer/port'
import { FOLLOW_MS, MODE_SWITCHED, formatElements } from '../../src/main/computer/tools'
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
    expect(textOf(await r.tool('press_keys', { combo: 'ctrl+s' }))).toStartWith('Pressed.')
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
    expect(h.overlay.last()).toMatchObject({ acting: false, teach: null })
    expect(h.cu.waiting()).toBeNull()
  })

  test('the notch says what a running reply is doing, and goes when it ends', async () => {
    const h = await harness()
    h.setMode('teach')
    const r = await h.reply()
    expect(h.overlay.last().activity).toEqual({ text: 'Working', waiting: false })
    await r.tool('look_at_screen')
    const step = r.tool('teach_step', { instruction: 'Click Personalize', step: 1, total: 3, element: 4 })
    await until(() => h.cu.waiting()?.kind === 'teach')
    expect(h.overlay.last().activity).toEqual({ text: 'Your turn · Step 1 of 3 · Click Personalize', waiting: true })
    h.overlay.pressDone()
    await step
    expect(h.overlay.last().activity).toEqual({ text: 'Working · Step 1 of 3 · Click Personalize', waiting: false })
    // What a step did and to what, cut to fit.
    h.setMode('do')
    await r.tool('scroll', { x: 10, y: 10, amount: -3, horizontal: true })
    expect(h.overlay.last().activity?.text).toBe('Working · Scroll · left 3')
    await r.tool('type_text', { text: 'a fairly long sentence typed into the field, longer than fits' })
    expect(h.overlay.last().activity?.text).toBe('Working · Type · a fairly long sentence typed into the field, lon…')
    await r.mod.end!()
    expect(h.overlay.last().activity).toBeNull()
  })

  test('the notch wraps a MacBook camera housing only on a notched built-in screen', () => {
    const screen = (width: number, height: number, bar: number, internal = true) => ({ internal, bounds: { x: 0, y: 0, width, height }, workArea: { x: 0, y: bar, width, height: height - bar } })
    // 14" and 16" MacBook Pro, 13" Air (M2): a 37-38 pt menu bar, about 1.54:1.
    expect(cameraHousing(screen(1512, 982, 38), 'darwin')).toEqual({ width: 200, height: 38 })
    expect(cameraHousing(screen(1728, 1117, 37), 'darwin')).toEqual({ width: 200, height: 37 })
    // The menu bar hidden: told by the shape.
    expect(cameraHousing(screen(1470, 956, 0), 'darwin')).toEqual({ width: 200, height: 32 })
    // A 13" Air (M1) has no notch: a 24 pt menu bar on a 1.6:1 screen.
    expect(cameraHousing(screen(1440, 900, 24), 'darwin')).toBeNull()
    expect(cameraHousing(screen(2560, 1440, 25, false), 'darwin')).toBeNull()
    expect(cameraHousing(screen(1920, 1080, 0), 'win32')).toBeNull()
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

  test('moving the mouse to answer an approval is not a takeover', async () => {
    const h = await harness()
    const r = await h.reply()
    await r.tool('look_at_screen')
    await r.tool('click', { x: 50, y: 50 })
    for (const approved of [true, false]) {
      const approval = r.tool('ask_approval', { action: 'Send it', detail: 'to Bob' })
      await until(() => h.cu.waiting()?.kind === 'approval')
      h.moveMouse(900, 900)
      await h.run(h.cu.approve(h.cu.waiting()!.id, approved))
      await approval
      expect(textOf(await r.tool('click', { x: 60, y: 60 }))).not.toContain('taken over')
    }
    // The same for a command's approval.
    const cmd = r.mod.canUseTool!('Bash', { command: 'rm x' }, new AbortController().signal)
    await until(() => h.cu.waiting()?.kind === 'approval')
    h.moveMouse(10, 900)
    await h.run(h.cu.approve(h.cu.waiting()!.id, true))
    expect((await cmd)?.behavior).toBe('allow')
    expect(textOf(await r.tool('click', { x: 60, y: 60 }))).not.toContain('taken over')
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

describe('one chat at a time', () => {
  test("while one chat's reply uses the computer, another chat's computer tools are refused", async () => {
    const h = await harness()
    const a = await h.reply()
    const b = await h.reply()
    const approval = a.tool('ask_approval', { action: 'Delete it', detail: 'a.png' })
    await until(() => h.cu.waiting()?.kind === 'approval')
    const busy = (await b.tool('click', { x: 1, y: 1 })) as { denied?: string }
    expect(busy.denied).toContain('in use by another chat')
    expect(textOf(await b.rawTool('ask_approval', { action: 'Mine', detail: 'x' }))).toContain('in use by another chat')
    const sig = new AbortController().signal
    expect((await b.mod.canUseTool!('Bash', { command: 'rm y' }, sig)) as { message?: string }).toMatchObject({ behavior: 'deny' })
    // Reading files doesn't need the computer.
    expect((await b.mod.canUseTool!('Read', { file_path: 'a' }, sig))?.behavior).toBe('allow')
    // The first chat's approval is still waiting, and the other chat's Stop leaves it alone.
    expect(h.cu.waiting()?.messageId).toBe(a.ctx.messageId)
    await h.run(h.cu.stopReply(b.ctx.messageId))
    expect(h.cu.waiting()?.messageId).toBe(a.ctx.messageId)
    await h.run(h.cu.approve(h.cu.waiting()!.id, true))
    expect(textOf(await approval)).toBe('Approved. Go ahead.')
    // Once the first reply ends, the other may use the computer.
    await a.mod.end!()
    expect(textOf(await b.tool('press_keys', { combo: 'ctrl+s' }))).toStartWith('Pressed.')
  })

  test("a Stop of the holder's reply doesn't keep the next holder stopped", async () => {
    const h = await harness()
    const a = await h.reply()
    const b = await h.reply()
    expect(textOf(await a.tool('press_keys', { combo: 'a' }))).toStartWith('Pressed.')
    await h.run(h.cu.stopReply(a.ctx.messageId))
    expect(await a.tool('press_keys', { combo: 'a' })).toEqual({ denied: STOPPED_TEXT })
    await a.mod.end!()
    expect(textOf(await b.tool('press_keys', { combo: 'b' }))).toStartWith('Pressed.')
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
    // A denial is neutral, not a failed step.
    expect(r.steps.at(-1)).toEqual({ tool: 'computer_ask_approval', label: 'Denied', ok: true, denied: true, detail: 'Delete 3 files from Downloads' })
    const yes = r.tool('ask_approval', { action: 'Empty the bin', detail: 'Recycle Bin' })
    await until(() => h.cu.waiting() !== null)
    await h.run(h.cu.approve(h.cu.waiting()!.id, true))
    expect(textOf(await yes)).toContain('Approved')
    expect(r.steps.at(-1)).toEqual({ tool: 'computer_ask_approval', label: 'Approval', ok: true, detail: 'Empty the bin' })
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

  test('a Show-me step brings the target app back in front of the chat before the spotlight', async () => {
    // Whether a spotlight was already up each time focus was handed back.
    const focused: boolean[] = []
    const h = await harness({ restoreFocus: async () => (focused.push(!!h.overlay.last().teach), { title: 'Settings', process: 'systemsettings' }) })
    h.setMode('teach')
    const r = await h.reply()
    await r.tool('look_at_screen')
    focused.length = 0
    const step = r.tool('teach_step', { instruction: 'Click Display', step: 1, total: 1, element: 4 })
    await until(() => h.cu.waiting()?.kind === 'teach')
    expect(focused).toEqual([false])
    expect(h.overlay.last().teach?.instruction).toBe('Click Display')
    h.overlay.pressDone()
    await step
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
    for (const name of ['click', 'type_text', 'press_keys', 'scroll', 'drag', 'move_mouse', 'open', 'focus_window']) {
      const res = (await r.tool(name, {})) as { denied?: string }
      expect(res.denied).toContain('The user wants to learn this')
    }
    expect(textOf(await r.tool('look_at_screen'))).toContain('Screenshot 1024x576px')
    // Switched mid-reply: the next result tells the model, once.
    h.setMode('do')
    const switched = textOf(await r.tool('press_keys', { combo: 'enter' }))
    expect(switched).toStartWith('Pressed.')
    expect(switched).toEndWith(MODE_SWITCHED.do)
    const after = textOf(await r.tool('press_keys', { combo: 'enter' }))
    expect(after).toStartWith('Pressed.')
    expect(after).not.toContain(MODE_SWITCHED.do)
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

  test('shell policy: line breaks and flags that write or run things ask first', () => {
    for (const c of ['git branch', 'git branch -a', 'git branch --show-current', 'rg -n foo src', 'find . -name a -print', 'git diff --stat', 'git log --oneline -5', 'date', 'hostname', 'tree -L 2', 'ls $HOME'])
      expect(isReadOnlyCommand(c)).toBe(true)
    for (const c of [
      'ls\nrm -rf x',
      'ls\rrm -rf x',
      'ls\r\nrm -rf x',
      'git branch -D main',
      'git branch -d old',
      'git branch -m a b',
      'git branch new-branch',
      'git branch --delete x',
      'rg --pre sh foo',
      'rg --pre=./evil foo',
      'rg "--pre=sh" foo',
      'rg --hostname-bin=./evil foo',
      'find . -fprint out.txt',
      'find . -fprintf out.txt %p',
      'find . -fprint0 out',
      'find . -fls out',
      'find . -okdir rm {} ;',
      'git diff --output=x.patch',
      'git log --output x.txt',
      'git show --outp=x',
      'tree -o out.txt',
      'date -s 2020-01-01',
      'hostname evil',
      'ls (rm x)',
      'rg ${X:=--pre=sh} foo',
      'rg {--pre=sh,} foo'
    ])
      expect(isReadOnlyCommand(c)).toBe(false)
  })

  test(`a runaway reply is stopped after ${MAX_TASK_TOOLS} tool calls`, async () => {
    const h = await harness()
    const r = await h.reply()
    for (let i = 0; i < MAX_TASK_TOOLS; i++) await r.tool('press_keys', { combo: 'tab', screenshot: false })
    const over = await r.tool('press_keys', { combo: 'tab', screenshot: false })
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
    expect(textOf(res)).toStartWith("Replaced the field's text and pressed Enter.")
    expect(h.calls.filter((c) => c !== 'remember')).toEqual(['set 7 cats', 'click 120,110', 'keys enter'])
  })

  test('type_text says whether it replaced a field or typed at the cursor', async () => {
    const h = await harness({ setValue: async () => 'typed' })
    const r = await h.reply()
    expect(textOf(await r.tool('type_text', { text: 'x', element: 3, screenshot: false }))).toBe('Typed.')
    expect(textOf(await r.tool('type_text', { text: 'x', screenshot: false }))).toBe('Typed.')
    const { tools } = await r.client.listTools()
    expect(tools.find((t) => t.name === 'type_text')?.description).toContain("the field's text is replaced")
  })

  test('ui_elements tells the model when the list was cut short, with a real count', async () => {
    const els = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, type: 'Button', name: `Item ${i}`, x: 0, y: 0, width: 20, height: 10 }))
    let asked = 0
    const h = await harness({
      uiTree: async (max) => {
        asked = max
        return { window: { title: 'Big', process: 'big' }, elements: els, truncated: true }
      }
    })
    const r = await h.reply()
    const all = textOf(await r.tool('ui_elements', {}))
    expect(asked).toBeGreaterThan(80) // reads more than it shows, so it can count
    expect(all).toContain('(first 80 of 100+; pass name to narrow)')
    expect(all).toContain('The list was cut short')
    const none = textOf(await r.tool('ui_elements', { name: 'save' }))
    expect(none).toBe('Window "Big" (big): no control named like "save" among those read. The list was cut short (time or size limit), so more controls may exist: narrow by name or call again.')
  })

  test('ui_elements without truncation: plain count and plain miss', async () => {
    const els = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, type: 'Button', name: `Item ${i}`, x: 0, y: 0, width: 20, height: 10 }))
    const h = await harness({ uiTree: async () => ({ window: { title: 'W', process: 'w' }, elements: els }) })
    const r = await h.reply()
    const all = textOf(await r.tool('ui_elements', {}))
    expect(all).toContain('(first 80 of 100; pass name to narrow)')
    expect(all).not.toContain('cut short')
    expect(textOf(await r.tool('ui_elements', { name: 'save' }))).toBe('Window "W" (w): no control named like "save".')
  })

  test('a step label names an element from an older list', async () => {
    let n = 0
    const h = await harness({
      uiTree: async () => {
        n++
        return { window: { title: 'W', process: 'w' }, elements: [{ id: n * 10, type: 'Button', name: `Button ${n}`, x: 0, y: 0, width: 20, height: 10 }] }
      }
    })
    const r = await h.reply()
    await r.tool('ui_elements', {})
    await r.tool('ui_elements', {})
    await r.tool('click', { element: 10 })
    expect(r.steps.at(-1)?.detail).toBe('“Button 1”')
  })

  test("a new reply doesn't use the last reply's screenshot for coordinates", async () => {
    const h = await harness()
    const r1 = await h.reply()
    await r1.tool('look_at_screen')
    expect(textOf(await r1.tool('click', { x: 1, y: 1, screenshot: false }))).toBe('Clicked.')
    r1.abort.abort()
    const r2 = await h.reply()
    expect(textOf(await r2.tool('click', { x: 1, y: 1 }))).toContain('Call look_at_screen first')
  })

  test("where controls can't be read, ui_elements isn't offered or named in the prompt", async () => {
    const h = await harness({ name: 'linux', controls: false })
    const r = await h.reply()
    const { tools } = await r.client.listTools()
    expect(tools.map((t) => t.name)).not.toContain('ui_elements')
    expect(tools.map((t) => t.name)).toContain('click')
    expect(r.mod.instructions).not.toContain('mcp__computer__ui_elements')
    expect(r.mod.instructions).not.toContain('call ui_elements')
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
      ['ask_approval', 'clear_highlight', 'click', 'drag', 'find_files', 'focus_window', 'list_windows', 'look_at_screen', 'move_mouse', 'open', 'press_keys', 'remember', 'reveal_file', 'scroll', 'teach_step', 'type_text', 'ui_elements', 'wait'].sort()
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

  test('the mode is read from each message', () => {
    const cases: Array<[string, 'do' | 'teach', 'do' | 'teach']> = [
      ['Show me how to draw a cat in excalidraw', 'do', 'teach'],
      ['draw me a cat in excalidraw', 'teach', 'do'],
      ['How do I turn on night light?', 'do', 'teach'],
      ['how to change my wallpaper', 'do', 'teach'],
      ['Can you show me where the Bluetooth setting is?', 'do', 'teach'],
      ['Walk me through setting up a printer', 'do', 'teach'],
      ['Teach me to use layers in Paint', 'do', 'teach'],
      ['Show me the files in Downloads', 'teach', 'do'],
      ['Can you turn on dark mode', 'teach', 'do'],
      ['Open Spotify and play my liked songs please', 'teach', 'do'],
      ['Just do it', 'teach', 'do'],
      ['Show me how, then just do it for me', 'do', 'do'],
      ['next', 'teach', 'teach'],
      ['ok what now?', 'teach', 'teach'],
      ['Where is the ellipse tool?', 'teach', 'teach'],
      ['Where is the ellipse tool?', 'do', 'do'],
      ['and then the tail', 'teach', 'teach'],
      ['Delete the old screenshots', 'teach', 'do']
    ]
    for (const [text, previous, mode] of cases) expect([text, decideMode(text, previous)]).toEqual([text, mode])
    expect(handsOver('just do it for me')).toBe(true)
    expect(handsOver("There's no Night light in my menu")).toBe(false)
  })

  test('effort: low for the fast models, medium for Opus', () => {
    expect(effortFor('claude-sonnet-5-5')).toBe('low')
    expect(effortFor('claude-haiku-5-5')).toBe('low')
    expect(effortFor('claude-opus-5-5')).toBe('medium')
  })

  test('built-in calls get readable step lines', () => {
    expect(builtinStep('Bash', { command: 'ls' })).toEqual({ tool: 'Bash', label: 'Run command', ok: true, detail: 'ls' })
    expect(builtinStep('Unknown', {})).toBeNull()
    // A run of only built-in calls is still the computer's, not the browser's.
    expect(isDesktopRun([builtinStep('Glob', { pattern: '*.pdf' })!])).toBe(true)
    expect(isDesktopRun([{ tool: 'browser_click', label: 'Click', ok: true }])).toBe(false)
  })

  test('a message typed during a Show-me step: "done" and the like finish it, anything else is passed on', () => {
    for (const t of ['done', 'Done!', 'ok', 'OK.', 'okay', 'next', 'got it', ' yes ', 'yep', 'did it']) expect(teachAnswer(t)).toEqual({ kind: 'done' })
    expect(teachAnswer(' I can’t find it ')).toEqual({ kind: 'said', text: 'I can’t find it' })
    // Starting like an acknowledgement isn't one: the rest reaches the model.
    for (const t of ['ok, but I can’t find it', 'yes but where is it?', 'next to what?', 'done? nothing happened', 'okay what now'])
      expect(teachAnswer(t)).toEqual({ kind: 'said', text: t })
    // Handing the task over is passed on too, so the model hears it and carries on itself.
    expect(teachAnswer('ok just do it')).toEqual({ kind: 'said', text: 'ok just do it' })
    expect(teachAnswer('just do it')).toEqual({ kind: 'said', text: 'just do it' })
  })

  test('the Stop shortcut is held while a computer reply runs, and pressing it stops every running reply', async () => {
    const h = await harness()
    const stopped: string[] = []
    const one = await h.reply()
    const mod = h.cu.module({ ...one.ctx, messageId: 'other' }, { mode: () => 'do', stop: () => void stopped.push('other') })
    expect(h.overlay.stopKey).toEqual([true])
    h.overlay.pressStopKey()
    expect(stopped).toEqual(['other'])
    await one.mod.end!()
    expect(h.overlay.stopKey).toEqual([true])
    await mod.end!()
    expect(h.overlay.stopKey).toEqual([true, false])
  })
})

describe('user controls', () => {
  test('each tool shows live while it runs, quiet looks plainly; the live line goes after the finished step lands', async () => {
    const h = await harness()
    const r = await h.reply()
    const log: string[] = []
    h.cu.onDoing((e) => log.push(e.doing ? `doing ${e.doing.label}${e.doing.detail ? ` · ${e.doing.detail}` : ''}${e.doing.quiet ? ' (quiet)' : ''}` : 'doing none'))
    const steps = r.steps
    // A slow save: the live line must wait for it.
    ;(r.ctx as { step: (s: Step) => Promise<void> }).step = async (s) => {
      await sleep(20)
      steps.push(s)
      log.push(`step ${s.label}`)
    }
    await r.tool('look_at_screen')
    await until(() => log.length === 2)
    await r.tool('click', { x: 10, y: 10 })
    await until(() => log.length === 5)
    expect(log).toEqual(['doing Looking at the screen (quiet)', 'doing none', 'doing Click · 10, 10', 'step Click', 'doing none'])
    // The notch says the action under way too.
    const typing = r.tool('type_text', { text: 'x'.repeat(200) })
    await until(() => h.overlay.last().activity?.text.startsWith('Working · Type') ?? false)
    await typing
  })

  test("the callout's Can't find it and Do it for me answer the step they show, and Do it for me switches the reply to do", async () => {
    const h = await harness()
    h.setMode('teach')
    const r = await h.reply()
    await r.tool('look_at_screen')
    const one = r.tool('teach_step', { instruction: 'Click Display', step: 1, total: 2, element: 4 })
    await until(() => h.cu.waiting()?.kind === 'teach')
    const id = h.overlay.last().teach!.id!
    expect(id).toBe(h.cu.waiting()!.id)
    h.overlay.press('done', 'stale')
    await sleep(20)
    expect(h.cu.waiting()?.id).toBe(id)
    h.overlay.press('cant_find')
    expect(textOf(await one)).toContain("Can't find it")
    expect(r.steps.at(-1)?.detail).toBe("Click Display · Couldn't find it")
    const two = r.tool('teach_step', { instruction: 'Click Display', step: 1, total: 2, element: 4 })
    await until(() => h.cu.waiting()?.kind === 'teach')
    h.overlay.press('hand_over')
    expect(textOf(await two)).toContain('the mode is do from now on')
    expect(h.mode()).toBe('do')
    expect(r.steps.at(-1)?.detail).toBe('Click Display · Handed over')
    // The hand-over said it: no second note on the next result.
    const next = textOf(await r.tool('press_keys', { combo: 'enter' }))
    expect(next).toStartWith('Pressed.')
    expect(next).not.toContain(MODE_SWITCHED.do)
  })

  test('the notch asks a waiting approval; Approve only counts once armed, through the same path as the chat', async () => {
    const h = await harness()
    const r = await h.reply()
    const seen: Waiting[] = []
    h.cu.subscribe((w) => seen.push(w))
    const ask = r.tool('ask_approval', { action: 'Delete 3 files', detail: 'a.txt' })
    await until(() => h.cu.waiting()?.kind === 'approval')
    const id = h.cu.waiting()!.id
    expect(h.overlay.last().activity).toEqual({ text: 'Needs your OK', waiting: true, approval: { id, title: 'Delete 3 files', detail: 'a.txt' } })
    h.overlay.answerApproval(true)
    await sleep(50)
    expect(h.cu.waiting()?.id).toBe(id)
    h.overlay.answerApproval(true, 'stale')
    await sleep(700)
    h.overlay.answerApproval(true)
    expect(textOf(await ask)).toContain('Approved')
    expect(seen.at(-1)).toBeNull()
    // Deny needs no arming.
    const no = r.tool('ask_approval', { action: 'Empty the bin', detail: '' })
    await until(() => h.cu.waiting()?.kind === 'approval')
    h.overlay.answerApproval(false)
    expect(textOf(await no)).toContain('Denied')
    expect(h.overlay.last().activity?.approval).toBeUndefined()
  })

  test("moving the mouse to the notch's Approve is not a takeover, for ask_approval and a command's approval", async () => {
    const h = await harness()
    const r = await h.reply()
    await r.tool('look_at_screen')
    await r.tool('click', { x: 50, y: 50 })
    const ask = r.tool('ask_approval', { action: 'Send it', detail: 'to Bob' })
    await until(() => h.cu.waiting()?.kind === 'approval')
    h.moveMouse(900, 20)
    await sleep(750)
    h.overlay.answerApproval(true)
    expect(textOf(await ask)).toContain('Approved')
    expect(textOf(await r.tool('click', { x: 60, y: 60 }))).not.toContain('taken over')
    const cmd = r.mod.canUseTool!('Bash', { command: 'rm x' }, new AbortController().signal)
    await until(() => h.cu.waiting()?.kind === 'approval')
    h.moveMouse(950, 20)
    await sleep(750)
    h.overlay.answerApproval(true)
    expect((await cmd)?.behavior).toBe('allow')
    expect(textOf(await r.tool('click', { x: 60, y: 60 }))).not.toContain('taken over')
  })

  test("the notch shows and answers only the holder's approval while another chat is refused", async () => {
    const h = await harness()
    const a = await h.reply()
    const b = await h.reply()
    const ask = a.tool('ask_approval', { action: 'Send it', detail: 'to Bob' })
    await until(() => h.cu.waiting()?.kind === 'approval')
    // b's approval request is refused while a holds the computer; a's stays the one in the notch.
    expect(textOf(await b.rawTool('ask_approval', { action: 'Other', detail: '' }))).toContain('in use by another chat')
    expect(h.overlay.last().activity?.approval?.title).toBe('Send it')
    await sleep(750)
    h.overlay.answerApproval(true)
    expect(textOf(await ask)).toContain('Approved')
  })

  test('a click inside the spotlight ends a click step after a short settle; elsewhere, on the callout, or on a typing step it does not', async () => {
    let down = false
    const h = await harness({
      pressed: async () => {
        const v = down
        down = false
        return v
      }
    })
    h.setMode('teach')
    const r = await h.reply()
    await r.tool('look_at_screen')
    // The fake's element 4 is at 100,100 40x20 (input space).
    const step = r.tool('teach_step', { instruction: 'Click Display', step: 1, total: 1, element: 4 })
    await until(() => h.cu.waiting()?.kind === 'teach')
    await sleep(150)
    h.moveMouse(400, 400)
    down = true
    await sleep(250)
    expect(h.cu.waiting()?.kind).toBe('teach')
    h.moveMouse(110, 105)
    h.overlay.setOnControl(true)
    down = true
    await sleep(250)
    expect(h.cu.waiting()?.kind).toBe('teach')
    h.overlay.setOnControl(false)
    down = true
    const t0 = Date.now()
    expect(textOf(await step)).toContain('The user clicked the highlighted control')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(CLICK_SETTLE_MS - 50)
    // A typing step isn't ended by a click into its field.
    const typing = r.tool('teach_step', { instruction: 'Type your name', step: 1, total: 1, element: 4 })
    await until(() => h.cu.waiting()?.kind === 'teach')
    down = true
    await sleep(CLICK_SETTLE_MS + 300)
    expect(h.cu.waiting()?.kind).toBe('teach')
    h.overlay.pressDone()
    await typing
    expect(['Click Display', 'Select Dark', 'Turn on Night light', 'Open the File menu'].every((s) => CLICK_STEP.test(s))).toBe(true)
    expect(['Type your name', 'Drag the slider', 'Press Ctrl+S', 'Scroll down'].some((s) => CLICK_STEP.test(s))).toBe(false)
  })

  test("while the user points (Point), input stops as a takeover and presses aren't spotlight clicks", async () => {
    let down = false
    let typed = 0
    const h = await harness({
      pressed: async () => {
        const v = down
        down = false
        return v
      },
      type: async () => {
        typed++
        await sleep(20)
      }
    })
    const r = await h.reply()
    await r.tool('look_at_screen')
    expect(textOf(await r.tool('click', { x: 50, y: 50 }))).not.toContain('taken over')
    h.cu.pointing(true)
    expect(textOf(await r.tool('click', { x: 60, y: 60 }))).toContain('they have taken over')
    // A typing run under way stops at its next chunk.
    h.cu.pointing(false)
    const typing = r.tool('type_text', { text: 'x'.repeat(2000) })
    await until(() => typed > 0)
    h.cu.pointing(true)
    expect(textOf(await typing)).toContain('they have taken over')
    expect(typed).toBeLessThan(5)
    h.cu.pointing(false)
    await r.mod.end!()
    // Show-me: a press while pointing, or the finishing click read just after, doesn't end a click step.
    h.setMode('teach')
    const t = await h.reply()
    await t.tool('look_at_screen')
    const step = t.tool('teach_step', { instruction: 'Click Display', step: 1, total: 1, element: 4 })
    await until(() => h.cu.waiting()?.kind === 'teach')
    await sleep(150)
    h.moveMouse(110, 105)
    h.cu.pointing(true)
    down = true
    await sleep(250)
    expect(h.cu.waiting()?.kind).toBe('teach')
    h.cu.pointing(false)
    down = true
    await sleep(250)
    expect(h.cu.waiting()?.kind).toBe('teach')
    await sleep(POINT_GRACE_MS)
    down = true
    expect(textOf(await step)).toContain('The user clicked the highlighted control')
  })

  test('the spotlight follows its control while the step waits', async () => {
    let rect = { x: 100, y: 100, width: 40, height: 20 }
    const h = await harness({ elementRect: async () => rect })
    h.setMode('teach')
    const r = await h.reply()
    await r.tool('look_at_screen')
    const step = r.tool('teach_step', { instruction: 'Click Display', step: 1, total: 1, element: 4 })
    await until(() => h.cu.waiting()?.kind === 'teach')
    rect = { x: 300, y: 250, width: 40, height: 20 }
    await until(() => h.overlay.last().teach?.rect.x === 300, FOLLOW_MS + 800)
    expect(h.overlay.last().teach).toMatchObject({ rect, instruction: 'Click Display', id: h.cu.waiting()!.id })
    h.overlay.pressDone()
    await step
    // Once the step is over the spotlight stays down.
    rect = { x: 500, y: 500, width: 40, height: 20 }
    await sleep(FOLLOW_MS + 200)
    expect(h.overlay.last().teach).toBeNull()
  })

  test('a snapped control is followed by what is at its middle, if about the same size; a bare pixel box stays', async () => {
    let at: { x: number; y: number; width: number; height: number } | null = { x: 10, y: 20, width: 300, height: 40 }
    const h = await harness({ elementAt: async () => at })
    h.setMode('teach')
    const r = await h.reply()
    await r.tool('look_at_screen')
    const step = r.tool('teach_step', { instruction: 'Click Save', step: 1, total: 1, x: 80, y: 20 })
    await until(() => h.cu.waiting()?.kind === 'teach')
    at = { x: 40, y: 30, width: 300, height: 40 }
    await until(() => h.overlay.last().teach?.rect.x === 40, FOLLOW_MS + 800)
    // Something much bigger there now (the window behind): not followed.
    at = { x: 0, y: 0, width: 1600, height: 900 }
    await sleep(FOLLOW_MS + 200)
    expect(h.overlay.last().teach?.rect.x).toBe(40)
    h.overlay.pressDone()
    await step
  })
})

type Content = Array<{ type: string; text?: string; data?: string }>
const content = (r: unknown) => (r as { content: Content }).content
const plain = { data: '', mime: 'image/jpeg' as const, imageWidth: 1024, imageHeight: 576, screen: { x: 0, y: 0, width: 2048, height: 1152 }, window: { title: 'W', process: 'w' } }

describe('acting with feedback', () => {

  test('an action answers with a fresh screenshot after a settle, which becomes the frame', async () => {
    let n = 0
    let shotAt = 0
    let clickedAt = 0
    const h = await harness(
      {
        // The first shot covers a 2048-wide monitor, the next ones a 1024-wide one at x 3000.
        screenshot: async () => {
          shotAt = Date.now()
          n++
          return {
            data: Buffer.from(`shot${n}`).toString('base64'),
            mime: 'image/jpeg',
            imageWidth: 1024,
            imageHeight: 576,
            screen: n === 1 ? { x: 0, y: 0, width: 2048, height: 1152 } : { x: 3000, y: 0, width: 1024, height: 576 },
            window: n === 1 ? { title: 'Inbox', process: 'mail' } : { title: 'New message', process: 'mail' },
            cursor: { x: 3100, y: 50 }
          }
        },
        click: async () => void (clickedAt = Date.now()),
        // Where the click left the pointer (10,10 in the first frame).
        cursor: async () => ({ x: 20, y: 20 })
      },
      { settleMs: 60 }
    )
    const r = await h.reply()
    await r.tool('look_at_screen')
    const res = content(await r.tool('click', { x: 10, y: 10 }))
    expect(shotAt - clickedAt).toBeGreaterThanOrEqual(50)
    expect(res[0]).toEqual({ type: 'text', text: 'Clicked.' })
    expect(res[1]).toMatchObject({ type: 'image', data: Buffer.from('shot2').toString('base64') })
    expect(res[2]!.text).toBe(
      'Screenshot 1024x576px. Active window: "New message" (mail), changed from "Inbox" (mail). Pointer at 100,50. This is now the frame for coordinates.'
    )
    // The next pixel action maps through the new frame.
    h.calls.length = 0
    expect(textOf(await r.tool('move_mouse', { x: 100, y: 100, screenshot: false }))).toBe('Moved the pointer.')
    expect(h.calls).toEqual(['move 3100,100'])
  })

  test('screenshot: false answers with text only and takes no screenshot', async () => {
    let shots = 0
    const h = await harness({
      screenshot: async () => {
        shots++
        return plain
      }
    })
    const r = await h.reply()
    await r.tool('look_at_screen')
    const calls: Array<[string, Record<string, unknown>]> = [
      ['click', { x: 1, y: 1 }],
      ['scroll', { x: 1, y: 1, amount: 3 }],
      ['drag', { from_x: 1, from_y: 1, to_x: 5, to_y: 5 }],
      ['press_keys', { combo: 'tab' }],
      ['type_text', { text: 'hi' }],
      ['move_mouse', { x: 3, y: 3 }]
    ]
    for (const [name, args] of calls) {
      const res = content(await r.tool(name, { ...args, screenshot: false }))
      expect([name, res.map((c) => c.type)]).toEqual([name, ['text']])
    }
    expect(shots).toBe(1)
    for (const [name, args] of calls) expect([name, content(await r.tool(name, args)).map((c) => c.type)]).toEqual([name, ['text', 'image', 'text']])
    expect(shots).toBe(1 + calls.length)
  })

  test('typing and keys say which control has focus; a failed follow-up shot is a note, not an error', async () => {
    let fail = false
    const h = await harness({
      focused: async () => ({ type: 'Edit', name: 'Search', value: 'cats' }),
      screenshot: async () => {
        if (fail) throw new Error('Capture failed.')
        return plain
      }
    })
    const r = await h.reply()
    await r.tool('look_at_screen')
    expect(content(await r.tool('type_text', { text: 'cats' }))[0]!.text).toBe('Typed. Focus: Edit "Search" value="cats".')
    expect(content(await r.tool('scroll', { x: 1, y: 1, amount: 1 }))[0]!.text).toBe('Scrolled.')
    fail = true
    const res = (await r.tool('press_keys', { combo: 'tab' })) as { isError?: boolean }
    expect(res.isError).toBeUndefined()
    expect(textOf(res)).toBe('Pressed. Focus: Edit "Search" value="cats". (No screenshot after it: Capture failed. Call look_at_screen.)')
  })

  test('Stop during the settle cuts the action short', async () => {
    const h = await harness({}, { settleMs: 5000 })
    const r = await h.reply()
    await r.tool('look_at_screen')
    const click = r.tool('click', { x: 1, y: 1 })
    await sleep(50)
    const t0 = Date.now()
    await h.run(h.cu.stop)
    expect(textOf(await click)).toBe(STOPPED_TEXT)
    expect(Date.now() - t0).toBeLessThan(500)
  })
})

describe('zoom', () => {
  test('a region is captured from screen space at higher resolution and does not become the frame', async () => {
    const asked: Array<{ maxWidth: number; region?: unknown; maxHeight?: number | undefined }> = []
    const h = await harness({
      screenshot: async (maxWidth, o) => {
        asked.push({ maxWidth, ...(o?.region ? { region: o.region, maxHeight: o.maxHeight } : {}) })
        // A 3840x2160 monitor at 1024 wide; a region is captured 1:1 up to 1024x768.
        if (!o?.region) return { data: 'ZnVsbA==', mime: 'image/jpeg', imageWidth: 1024, imageHeight: 576, screen: { x: 0, y: 0, width: 3840, height: 2160 }, window: { title: 'W', process: 'w' } }
        const k = Math.min(1, 1024 / o.region.width, 768 / o.region.height)
        return { data: 'em9vbQ==', mime: 'image/jpeg', imageWidth: Math.round(o.region.width * k), imageHeight: Math.round(o.region.height * k), screen: o.region, window: { title: 'W', process: 'w' } }
      }
    })
    const r = await h.reply()
    expect(textOf(await r.tool('look_at_screen', { region: { x: 0, y: 0, width: 100, height: 100 } }))).toContain('Call look_at_screen first')
    await r.tool('look_at_screen')
    const z = content(await r.tool('look_at_screen', { region: { x: 200, y: 100, width: 200, height: 100 } }))
    expect(asked.at(-1)).toEqual({ maxWidth: 1024, region: { x: 750, y: 375, width: 750, height: 375 }, maxHeight: 768 })
    expect(z[0]).toMatchObject({ type: 'image', data: 'em9vbQ==' })
    expect(z[1]!.text).toBe(
      "Zoom of the screenshot's region x 200–400, y 100–200, at 3.75x (750x375px). Only for looking: coordinates you pass to tools stay in the full screenshot. A point (u, v) here is (200 + u/3.75, 100 + v/3.75) there; e.g. this image's centre 375,188 is 300,150."
    )
    // Clicks still map through the full screenshot.
    await r.tool('click', { x: 512, y: 288, screenshot: false })
    expect(h.calls.at(-1)).toBe('click 1920,1080')
    // A region past the edge is clipped; one too small is refused.
    await r.tool('look_at_screen', { region: { x: 1000, y: 500, width: 300, height: 300 } })
    expect(asked.at(-1)!.region).toEqual({ x: 3750, y: 1875, width: 90, height: 285 })
    const tiny = (await r.tool('look_at_screen', { region: { x: 1020, y: 10, width: 50, height: 50 } })) as { isError?: boolean }
    expect(tiny.isError).toBe(true)
    expect(textOf(tiny)).toContain('at least 8x8')
  })
})

describe('more input', () => {
  test('modifiers, double and triple clicks go to the platform; by element they click its centre', async () => {
    const h = await harness()
    const r = await h.reply()
    await r.tool('look_at_screen')
    h.calls.length = 0
    await r.tool('click', { x: 10, y: 10, modifiers: ['ctrl', 'shift', 'ctrl'], screenshot: false })
    await r.tool('click', { x: 10, y: 10, triple: true, screenshot: false })
    await r.tool('click', { element: 5, modifiers: ['shift'], screenshot: false })
    await r.tool('click', { element: 5, screenshot: false })
    expect(h.calls).toEqual(['click 20,20 ctrl+shift', 'click 20,20 x3', 'click 120,110 shift'])
    expect(r.steps.map((s) => s.label)).toEqual(['Ctrl+Shift+click', 'Triple-click', 'Shift+click', 'Click'])
  })

  test('move_mouse hovers over an element or a point without clicking, and counts as acting', async () => {
    const h = await harness()
    const r = await h.reply()
    await r.tool('look_at_screen')
    h.calls.length = 0
    await r.tool('move_mouse', { element: 3, screenshot: false })
    await r.tool('move_mouse', { x: 50, y: 60, screenshot: false })
    expect(h.calls).toEqual(['move 120,110', 'move 100,120'])
    expect(r.steps.map((s) => s.label)).toEqual(['Hover', 'Hover'])
    // The user moving the mouse afterwards is a takeover, as after a click.
    h.moveMouse(900, 900)
    expect(textOf(await r.tool('move_mouse', { x: 1, y: 1 }))).toContain('they have taken over')
  })

  test('press_keys lists the key names for the platform', async () => {
    const h = await harness()
    const r = await h.reply()
    const { tools } = await r.client.listTools()
    const desc = tools.find((t) => t.name === 'press_keys')?.description ?? ''
    expect(desc).toContain('"ctrl+/"')
    expect(desc).toContain('pagedown')
    expect(desc).toContain('Modifiers: ctrl, shift, alt, win')
  })
})

describe('control state and other windows', () => {
  test('ui_elements lines carry value, checked, selected, expanded and disabled', () => {
    const el = (o: object) => ({ id: 1, type: 'Edit', name: 'Search', x: 0, y: 0, width: 20, height: 10, ...o })
    const f = (o: object) => formatElements([el(o)], () => null, { max: 5 }).lines[0]
    expect(f({ value: 'cats' })).toBe('1 Edit "Search" value="cats"')
    expect(f({ value: 'Search' })).toBe('1 Edit "Search"') // the same as the name: left out
    expect(f({ value: 'x'.repeat(50) })).toBe(`1 Edit "Search" value="${'x'.repeat(40)}…"`)
    expect(f({ type: 'CheckBox', checked: true, disabled: true })).toBe('1 CheckBox "Search" checked disabled')
    expect(f({ type: 'CheckBox', checked: false })).toBe('1 CheckBox "Search" unchecked')
    expect(f({ type: 'CheckBox', checked: 'mixed' })).toBe('1 CheckBox "Search" mixed')
    expect(f({ type: 'TabItem', selected: true })).toBe('1 TabItem "Search" selected')
    expect(f({ type: 'ComboBox', value: 'Arial', expanded: false })).toBe('1 ComboBox "Search" value="Arial" collapsed')
  })

  test('ui_elements can read another window where the platform supports it', async () => {
    const asked: Array<string | undefined> = []
    const h = await harness({
      otherWindows: true,
      uiTree: async (_max, o) => {
        asked.push(o?.window)
        return { window: { title: o?.window ? 'Calculator' : 'Notepad', process: o?.window ? 'calc' : 'notepad' }, elements: [{ id: 1, type: 'Button', name: 'Seven', x: 0, y: 0, width: 10, height: 10 }] }
      }
    })
    const r = await h.reply()
    const { tools } = await r.client.listTools()
    expect(Object.keys(tools.find((t) => t.name === 'ui_elements')?.inputSchema.properties ?? {})).toContain('window')
    expect(textOf(await r.tool('ui_elements', { window: 'calc' }))).toStartWith('Window "Calculator" (calc), which may not be in front: call focus_window before you click in it')
    expect(textOf(await r.tool('ui_elements', {}))).toStartWith('Window "Notepad" (notepad):')
    expect(asked).toEqual(['calc', undefined])
  })

  test("where only the active window can be read, there's no window option", async () => {
    const h = await harness()
    const r = await h.reply()
    const { tools } = await r.client.listTools()
    expect(Object.keys(tools.find((t) => t.name === 'ui_elements')?.inputSchema.properties ?? {})).not.toContain('window')
  })
})

describe('the step cap', () => {
  test('reads count separately from actions, at a higher cap', async () => {
    const h = await harness()
    const r = await h.reply()
    for (let i = 0; i < 120; i++) await r.tool('list_windows')
    // 120 reads haven't used up any of the acting budget.
    for (let i = 0; i < MAX_TASK_TOOLS; i++) expect(textOf(await r.tool('press_keys', { combo: 'tab', screenshot: false }))).toBe('Pressed.')
    expect(textOf(await r.tool('press_keys', { combo: 'tab', screenshot: false }))).toContain(`Stopped after ${MAX_TASK_TOOLS} steps`)
  })

  test(`a reply that only looks is stopped after ${MAX_TASK_READS} reads`, async () => {
    const h = await harness()
    const r = await h.reply()
    for (let i = 0; i < MAX_TASK_READS; i++) await r.tool('list_windows')
    const over = await r.tool('look_at_screen')
    expect(textOf(over)).toContain(`Stopped after ${MAX_TASK_READS} looks`)
    expect(r.steps.at(-1)).toEqual({ tool: 'computer_stop', label: `Stopped after ${MAX_TASK_READS} looks`, ok: false })
    expect(await r.tool('click', { x: 1, y: 1 })).toEqual({ denied: STOPPED_TEXT })
  })
})
