import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildFindArgs,
  jpegSize,
  linuxSupported,
  makeLinuxPlatform,
  parseFindLine,
  parseMouse,
  parseWindowIds,
  parseXprop,
  toXdotoolChord
} from '../../src/main/computer/platform/linux'

describe('linux parsers', () => {
  test('xprop window properties', () => {
    const w = parseXprop(
      '0x1e00003',
      [
        '_NET_WM_NAME(UTF8_STRING) = "Report \\"Q3\\" — draft"',
        'WM_NAME(STRING) = "ignored when _NET_WM_NAME is set"',
        'WM_CLASS(STRING) = "libreoffice", "libreoffice-writer"',
        '_NET_WM_PID(CARDINAL) = 4242',
        '_NET_WM_STATE(ATOM) = _NET_WM_STATE_HIDDEN, _NET_WM_STATE_SKIP_TASKBAR'
      ].join('\n')
    )
    expect(w).toEqual({ id: '0x1e00003', title: 'Report "Q3" — draft', pid: 4242, wmClass: 'libreoffice-writer', hidden: true })
  })

  test('xprop with missing properties', () => {
    const w = parseXprop('0x2', ['_NET_WM_NAME:  not found.', 'WM_NAME(STRING) = "xterm"', '_NET_WM_PID:  not found.'].join('\n'))
    expect(w).toEqual({ id: '0x2', title: 'xterm', pid: null, wmClass: '', hidden: false })
  })

  test('window id lists skip the empty window', () => {
    expect(parseWindowIds('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0')).toEqual([])
    expect(parseWindowIds('_NET_CLIENT_LIST_STACKING(WINDOW): window id # 0x1A00003, 0x1c00009')).toEqual(['0x1a00003', '0x1c00009'])
  })

  test('mouse location', () => {
    expect(parseMouse('X=120\nY=45\nSCREEN=0\nWINDOW=123')).toEqual({ x: 120, y: 45 })
    expect(() => parseMouse('nope')).toThrow()
  })

  test('key chords', () => {
    expect(toXdotoolChord('ctrl+shift+t')).toBe('ctrl+shift+t')
    expect(toXdotoolChord('Ctrl + S')).toBe('ctrl+s')
    expect(toXdotoolChord('enter')).toBe('Return')
    expect(toXdotoolChord('win+d')).toBe('super+d')
    expect(toXdotoolChord('cmd+c')).toBe('super+c')
    expect(toXdotoolChord('alt+F4')).toBe('alt+F4')
    expect(toXdotoolChord('esc')).toBe('Escape')
    expect(toXdotoolChord('pageDown')).toBe('Page_Down')
    expect(toXdotoolChord('super')).toBe('super')
    expect(() => toXdotoolChord('  ')).toThrow()
  })

  test('jpeg size comes from the frame header', () => {
    // SOI, an APP0 segment, then SOF0 with height 600 and width 1024.
    const app0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]
    const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x04, 0x00, 0x03]
    const buf = Buffer.from([0xff, 0xd8, ...app0, ...sof0, ...new Array(16).fill(0)])
    expect(jpegSize(buf)).toEqual({ width: 1024, height: 600 })
    expect(() => jpegSize(Buffer.from('not a jpeg'))).toThrow()
  })

  test('find arguments', () => {
    const args = buildFindArgs({ name: 'tax 2024', extensions: ['pdf', '.DOCX'], kind: 'file', modifiedWithinDays: 7 }, '/home/me')
    expect(args.slice(0, 4)).toEqual(['/home/me', '-xdev', '-mindepth', '1'])
    expect(args).toContain('-prune')
    expect(args.join(' ')).toContain('-type f -iname *tax* -iname *2024* ( -iname *.pdf -o -iname *.DOCX ) -mtime -7')
    // Glob characters in the user's words match literally.
    expect(buildFindArgs({ name: 'a*b[1]' }, '/h')).toContain('*a\\*b\\[1\\]*')
    // Content search only looks at files.
    expect(buildFindArgs({ contains: 'invoice', kind: 'folder' }, '/h')).toContain('f')
  })

  test('find output lines', () => {
    expect(parseFindLine('f\t1700000000.5\t2048\t/home/me/Tax Return.PDF')).toEqual({
      path: '/home/me/Tax Return.PDF',
      name: 'Tax Return.PDF',
      kind: 'file',
      ext: 'pdf',
      modified: new Date(1700000000500).toISOString(),
      size: 2048
    })
    expect(parseFindLine('d\t1700000000\t4096\t/home/me/Projects')?.kind).toBe('folder')
    expect(parseFindLine('')).toBeNull()
  })

  test('supported needs an X11 display', () => {
    expect(linuxSupported({ DISPLAY: ':0' })).toBe(true)
    expect(linuxSupported({ DISPLAY: ':0', XDG_SESSION_TYPE: 'wayland' })).toBe(false)
    expect(linuxSupported({})).toBe(false)
  })
})

// The real tools against a live X display. Needs DISPLAY, a window manager, xdotool, xprop,
// wmctrl, ImageMagick and xterm, e.g. the agent VM: DISPLAY=:99 bun test test/computer/linux.test.ts
const has = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0
const live =
  process.platform === 'linux' &&
  linuxSupported() &&
  ['xdotool', 'xprop', 'wmctrl', 'import', 'xterm'].every(has) &&
  spawnSync('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK']).stdout?.toString().includes('window id')

describe.skipIf(!live)('linux platform on a live display', () => {
  const procs: ChildProcess[] = []
  const dir = mkdtempSync(join(tmpdir(), 'cu-linux-'))
  const xterm = (title: string) => {
    const p = spawn('xterm', ['-T', title, '-geometry', '80x20+40+40', '-e', 'bash', '--norc', '--noprofile'], { stdio: 'ignore' })
    procs.push(p)
    return p
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const waitFor = async (check: () => Promise<boolean> | boolean, ms = 5000) => {
    for (let t = 0; t < ms; t += 100) {
      if (await check()) return
      await sleep(100)
    }
    throw new Error('timed out')
  }

  let owner: ChildProcess
  const p = () => makeLinuxPlatform({ ownerPid: owner.pid! })

  beforeAll(async () => {
    xterm('cu-test-a')
    xterm('cu-test-b')
    // Stands in for chat-v2's own window: its pid is the owner pid.
    owner = xterm('cu-owner')
    await waitFor(async () => (await p().windows()).filter((w) => w.title.startsWith('cu-test-')).length === 2)
  })

  afterAll(() => {
    for (const pr of procs) pr.kill()
    rmSync(dir, { recursive: true, force: true })
  })

  test('lists app windows but not chat-v2 own', async () => {
    const ws = await p().windows()
    const titles = ws.map((w) => w.title)
    expect(titles).toContain('cu-test-a')
    expect(titles).toContain('cu-test-b')
    expect(titles).not.toContain('cu-owner')
    expect(ws.find((w) => w.title === 'cu-test-a')?.process).toBe('xterm')
  })

  test('focuses a window by title', async () => {
    const plat = p()
    expect((await plat.focusWindow('cu-test-a')).title).toBe('cu-test-a')
    expect((await plat.foreground()).title).toBe('cu-test-a')
    await expect(plat.focusWindow('no-such-window')).rejects.toThrow('No open window matches')
  })

  test('remember skips chat-v2 and restoreFocus brings the app back', async () => {
    const plat = p()
    await plat.focusWindow('cu-test-b')
    // chat-v2 comes to the front.
    spawnSync('wmctrl', ['-a', 'cu-owner'])
    await sleep(200)
    expect((await plat.remember()).title).toBe('cu-test-b')
    // While chat-v2 is in front, the target is still the remembered app.
    expect((await plat.foreground()).title).toBe('cu-test-b')
    expect((await plat.restoreFocus()).title).toBe('cu-test-b')
    const active = spawnSync('xdotool', ['getactivewindow', 'getwindowname']).stdout.toString().trim()
    expect(active).toBe('cu-test-b')
  })

  test('screenshot is a scaled JPEG of the whole screen', async () => {
    const s = await p().screenshot(800)
    const [w, h] = spawnSync('xdotool', ['getdisplaygeometry']).stdout.toString().trim().split(' ').map(Number)
    expect(s.mime).toBe('image/jpeg')
    expect(s.screen).toEqual({ x: 0, y: 0, width: w!, height: h! })
    expect(s.imageWidth).toBe(Math.min(800, w!))
    expect(Math.abs(s.imageHeight - Math.round((h! * s.imageWidth) / w!))).toBeLessThanOrEqual(1)
    expect(Buffer.from(s.data, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
  })

  test('click moves the mouse; type and keys reach the focused app', async () => {
    const plat = p()
    await plat.click(300, 200, 'left', 1)
    expect(await plat.cursor()).toEqual({ x: 300, y: 200 })
    // Clicking where the pointer already is must not hang.
    await plat.click(300, 200, 'left', 2)
    await plat.focusWindow('cu-test-a')
    const out = join(dir, 'typed.txt')
    await plat.type(`echo "hi there" > ${out}`)
    await plat.keys('enter')
    await waitFor(() => existsSync(out))
    expect(readFileSync(out, 'utf8').trim()).toBe('hi there')
  })

  test('drag and scroll run', async () => {
    const plat = p()
    await plat.drag(100, 100, 200, 150)
    expect(await plat.cursor()).toEqual({ x: 200, y: 150 })
    await plat.scroll(150, 150, 3, 0)
    await plat.scroll(150, 150, -2, 1)
  })

  test('cancel stops typing in progress without leaving a key held down', async () => {
    const plat = p()
    await plat.focusWindow('cu-test-b')
    // Catch at once: the call rejects while cancel() is still running.
    const typing = plat.type('x'.repeat(400)).then(
      () => null,
      (e: Error) => e
    )
    await sleep(150)
    await plat.cancel!()
    const err = await typing
    expect(err?.name).toBe('Cancelled')
    await plat.keys('ctrl+u')
    // Later calls run normally, and every character arrives (a held key would eat the next "x").
    const out = join(dir, 'after-cancel.txt')
    await plat.type(`echo xxx > ${out}`)
    await plat.keys('enter')
    await waitFor(() => existsSync(out))
    expect(readFileSync(out, 'utf8').trim()).toBe('xxx')
  })

  test('controls are not available yet and say so', async () => {
    await expect(p().uiTree(10)).rejects.toThrow('look_at_screen')
    expect(await p().elementAt(1, 1)).toBeNull()
  })

  test('file search by name, extension, content and age', async () => {
    const home = join(dir, 'home')
    mkdirSync(join(home, 'Docs'), { recursive: true })
    mkdirSync(join(home, '.cache'), { recursive: true })
    mkdirSync(join(home, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(home, 'Docs', 'Tax 2024.txt'), 'total due: 120')
    writeFileSync(join(home, 'Docs', 'notes.md'), 'call the bank')
    writeFileSync(join(home, '.cache', 'tax-cache.txt'), 'hidden')
    writeFileSync(join(home, 'node_modules', 'x', 'tax.txt'), 'dep')
    const old = join(home, 'Docs', 'old tax.txt')
    writeFileSync(old, 'old')
    const longAgo = new Date(Date.now() - 90 * 86_400_000)
    utimesSync(old, longAgo, longAgo)

    const prevHome = process.env['HOME']
    process.env['HOME'] = home
    try {
      const plat = p()
      const byName = await plat.search({ name: 'tax' })
      expect(byName.map((h) => h.name).sort()).toEqual(['Tax 2024.txt', 'old tax.txt'])
      expect((await plat.search({ name: 'tax', modifiedWithinDays: 30 })).map((h) => h.name)).toEqual(['Tax 2024.txt'])
      expect((await plat.search({ extensions: ['md'] })).map((h) => h.name)).toEqual(['notes.md'])
      expect((await plat.search({ contains: 'BANK' })).map((h) => h.name)).toEqual(['notes.md'])
      expect((await plat.search({ name: 'docs', kind: 'folder' })).map((h) => h.kind)).toEqual(['folder'])
    } finally {
      process.env['HOME'] = prevHome
    }
  })

  test('opening an app that does not exist fails clearly', async () => {
    await expect(p().open('no-such-app-xyz')).rejects.toThrow('Nothing called "no-such-app-xyz" is installed')
  })
})
