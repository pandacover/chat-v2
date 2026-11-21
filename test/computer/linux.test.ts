import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildFindArgs,
  clickArgs,
  completeLines,
  importArgs,
  jpegSize,
  linuxSupported,
  makeLinuxPlatform,
  parseDesktopEntry,
  parseExec,
  parseFindLine,
  parseMouse,
  parseWindowIds,
  parseXprop,
  toolEnv,
  toXdotoolKeys,
  typeSegments,
  xpropString
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
        '_NET_WM_STATE(ATOM) = _NET_WM_STATE_HIDDEN',
        '_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_NORMAL'
      ].join('\n')
    )
    expect(w).toEqual({ id: '0x1e00003', title: 'Report "Q3" — draft', pid: 4242, wmClass: 'libreoffice-writer', hidden: true, app: true })
  })

  test('xprop with missing properties', () => {
    const w = parseXprop('0x2', ['_NET_WM_NAME:  not found.', 'WM_NAME(STRING) = "xterm"', '_NET_WM_PID:  not found.'].join('\n'))
    expect(w).toEqual({ id: '0x2', title: 'xterm', pid: null, wmClass: '', hidden: false, app: true })
  })

  test('panels, docks, desktops and skip-taskbar windows are not app windows', () => {
    expect(parseXprop('0x3', '_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_DOCK').app).toBe(false)
    expect(parseXprop('0x3', '_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_DESKTOP').app).toBe(false)
    expect(parseXprop('0x3', '_NET_WM_STATE(ATOM) = _NET_WM_STATE_SKIP_TASKBAR').app).toBe(false)
    expect(parseXprop('0x3', '_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_DIALOG').app).toBe(true)
  })

  test('xprop strings: escapes and octal bytes from a non-UTF-8 locale', () => {
    expect(xpropString('"caf\\303\\251 \\342\\200\\224 ok"')).toBe('café — ok')
    expect(xpropString('"a \\"b\\" c\\\\d"')).toBe('a "b" c\\d')
    expect(xpropString('not quoted')).toBe('')
  })

  test('window id lists skip the empty window', () => {
    expect(parseWindowIds('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0')).toEqual([])
    expect(parseWindowIds('_NET_CLIENT_LIST_STACKING(WINDOW): window id # 0x1A00003, 0x1c00009')).toEqual(['0x1a00003', '0x1c00009'])
  })

  test('mouse location', () => {
    expect(parseMouse('X=120\nY=45\nSCREEN=0\nWINDOW=123')).toEqual({ x: 120, y: 45 })
    expect(() => parseMouse('nope')).toThrow()
  })

  test('key combinations', () => {
    expect(toXdotoolKeys('ctrl+shift+t')).toEqual(['ctrl+shift+t'])
    expect(toXdotoolKeys('Ctrl + S')).toEqual(['ctrl+s'])
    expect(toXdotoolKeys('enter')).toEqual(['Return'])
    expect(toXdotoolKeys('win+d')).toEqual(['super+d'])
    expect(toXdotoolKeys('cmd+c')).toEqual(['super+c'])
    expect(toXdotoolKeys('alt+F4')).toEqual(['alt+F4'])
    expect(toXdotoolKeys('esc')).toEqual(['Escape'])
    expect(toXdotoolKeys('super')).toEqual(['super'])
    // Aliases and punctuation that xdotool would otherwise ignore.
    expect(toXdotoolKeys('ctrl+ArrowUp')).toEqual(['ctrl+Up'])
    expect(toXdotoolKeys('pgdown')).toEqual(['Page_Down'])
    expect(toXdotoolKeys('Page Down')).toEqual(['Page_Down'])
    expect(toXdotoolKeys('ctrl+/')).toEqual(['ctrl+slash'])
    expect(toXdotoolKeys('ctrl+=')).toEqual(['ctrl+equal'])
    expect(toXdotoolKeys('ctrl+,')).toEqual(['ctrl+comma'])
    expect(toXdotoolKeys('ctrl+[')).toEqual(['ctrl+bracketleft'])
    expect(toXdotoolKeys('ctrl+-')).toEqual(['ctrl+minus'])
    expect(toXdotoolKeys('ctrl++')).toEqual(['ctrl+plus'])
    expect(toXdotoolKeys('ctrl+é')).toEqual(['ctrl+U00E9'])
    // A sequence of chords.
    expect(toXdotoolKeys('ctrl+k ctrl+s')).toEqual(['ctrl+k', 'ctrl+s'])
    // Unknown names pass through for xdotool to reject (the platform treats that as an error).
    expect(toXdotoolKeys('XF86AudioPlay')).toEqual(['XF86AudioPlay'])
    expect(() => toXdotoolKeys('  ')).toThrow()
  })

  test('screenshot arguments: the whole screen or a region, fitted, never enlarged', () => {
    expect(importArgs(1024)).toEqual(['-silent', '-window', 'root', '-resize', '1024x>', '-quality', '80', 'jpg:-'])
    expect(importArgs(1024, { region: { x: 10.4, y: 20, width: 300, height: 200.6 }, maxHeight: 768 })).toEqual([
      '-silent', '-window', 'root', '-crop', '300x201+10+20', '+repage', '-resize', '1024x768>', '-quality', '80', 'jpg:-'
    ])
  })

  test('click arguments: modifiers are pressed around the clicks and released after, triple at most', () => {
    expect(clickArgs(5, 6, 'left', 1)).toEqual(['click', '--repeat', '1', '--delay', '80', '1'])
    expect(clickArgs(5, 6, 'right', 9, ['ctrl', 'shift', 'ctrl'])).toEqual(['keydown', 'ctrl', 'shift', 'click', '--repeat', '3', '--delay', '80', '3', 'keyup', 'shift', 'ctrl'])
    expect(clickArgs(5, 6, 'left', 2, ['cmd', 'alt'])).toEqual(['keydown', 'super', 'alt', 'click', '--repeat', '2', '--delay', '80', '1', 'keyup', 'alt', 'super'])
  })

  test('typing: ASCII runs as text, non-ASCII runs as keys, capitals with Shift', () => {
    expect(typeSegments('Über café')).toEqual([{ keys: ['shift+U00DC'] }, { text: 'ber caf' }, { keys: ['U00E9'] }])
    expect(typeSegments('a'.repeat(30))).toEqual([{ text: 'a'.repeat(24) }, { text: 'a'.repeat(6) }])
    expect(typeSegments('ÉΔ!')).toEqual([{ keys: ['shift+U00C9', 'shift+U0394'] }, { text: '!' }])
    // Characters outside the BMP stay whole, and long runs are chunked.
    expect(typeSegments('你😀')).toEqual([{ keys: ['U4F60', 'U1F600'] }])
    expect(typeSegments('é'.repeat(30)).map((s) => ('keys' in s ? s.keys.length : 0))).toEqual([24, 6])
    expect(typeSegments('')).toEqual([])
  })

  test('the tools get a UTF-8 locale', () => {
    expect(toolEnv({ PATH: '/bin' })['LC_ALL']).toBe('C.UTF-8')
    expect(toolEnv({ LANG: 'C' })['LC_ALL']).toBe('C.UTF-8')
    const env = { LANG: 'en_US.UTF-8' }
    expect(toolEnv(env)).toBe(env)
    expect(toolEnv({ LC_ALL: 'POSIX', LANG: 'en_US.UTF-8' })['LC_ALL']).toBe('C.UTF-8')
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
    // A cut-off last line (find was stopped mid-write) is dropped.
    expect(completeLines('f\t1\t1\t/a\nf\t1\t1\t/b\nf\t1\t1\t/ha')).toEqual(['f\t1\t1\t/a', 'f\t1\t1\t/b'])
    expect(completeLines('f\t1\t1\t/a\n')).toEqual(['f\t1\t1\t/a'])
  })

  test('desktop entries', () => {
    expect(parseExec('firefox-esr %u')).toEqual(['firefox-esr'])
    expect(parseExec('"/opt/My App/app" --flag %F 100%%')).toEqual(['/opt/My App/app', '--flag', '100%'])
    const entry = '[Desktop Entry]\nType=Application\nName=Text Editor\nName[de]=Texteditor\nExec=gnome-text-editor %U\n[Desktop Action new]\nExec=other'
    expect(parseDesktopEntry('org.gnome.TextEditor', entry)).toEqual({ id: 'org.gnome.TextEditor', name: 'Text Editor', exec: ['gnome-text-editor'] })
    expect(parseDesktopEntry('x', '[Desktop Entry]\nType=Application\nName=X\nExec=x\nNoDisplay=true')).toBeNull()
    expect(parseDesktopEntry('x', '[Desktop Entry]\nType=Link\nName=X\nURL=http://x')).toBeNull()
  })

  test('supported needs an X11 display', () => {
    expect(linuxSupported({ DISPLAY: ':0' })).toBe(true)
    expect(linuxSupported({ DISPLAY: ':0', XDG_SESSION_TYPE: 'wayland' })).toBe(false)
    // XWayland: a DISPLAY inside a Wayland session.
    expect(linuxSupported({ DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'tty' })).toBe(false)
    expect(linuxSupported({ DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'x11' })).toBe(true)
    expect(linuxSupported({})).toBe(false)
  })

  test("says it can't read controls, so ui_elements isn't offered", () => {
    const p = makeLinuxPlatform({ ownerPid: 1 })
    expect(p.controls).toBe(false)
    p.dispose()
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
  let dir = ''
  const utf8 = { ...process.env, LC_ALL: 'C.UTF-8' }
  const xterm = (title: string) => {
    const p = spawn('xterm', ['-u8', '-T', title, '-geometry', '80x20+40+40', '-e', 'bash', '--norc', '--noprofile'], { stdio: 'ignore', env: utf8 })
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
  const activeTitle = () => spawnSync('xdotool', ['getactivewindow', 'getwindowname'], { env: utf8 }).stdout.toString().trim()
  /** Bring a window forward the way a person would, outside the platform. */
  const raise = async (title: string) => {
    spawnSync('wmctrl', ['-a', title])
    await waitFor(() => activeTitle() === title)
  }
  /** Runs `f` with PATH limited to the given tools, to see how a missing one is reported. */
  const withOnly = async (tools: string[], f: () => Promise<void>) => {
    const bin = join(dir, `bin-${tools.join('-')}`)
    mkdirSync(bin, { recursive: true })
    for (const t of tools) {
      const real = spawnSync('sh', ['-c', `command -v ${t}`]).stdout.toString().trim()
      if (!existsSync(join(bin, t))) symlinkSync(real, join(bin, t))
    }
    const prev = process.env['PATH']
    process.env['PATH'] = bin
    try {
      await f()
    } finally {
      process.env['PATH'] = prev
    }
  }

  let owner: ChildProcess
  const p = () => makeLinuxPlatform({ ownerPid: owner.pid! })

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cu-linux-'))
    xterm('cu-test-a')
    xterm('cu-test-b')
    xterm('cu-café — ✓')
    // Stands in for Tomo's own window: its pid is the owner pid.
    owner = xterm('cu-owner')
    await waitFor(async () => (await p().windows()).filter((w) => w.title.startsWith('cu-')).length === 3)
    await waitFor(() => spawnSync('wmctrl', ['-l']).stdout.toString().includes('cu-owner'))
  })

  afterAll(() => {
    for (const pr of procs) pr.kill()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test("lists app windows but not Tomo's own, with non-ASCII titles intact", async () => {
    const ws = await p().windows()
    const titles = ws.map((w) => w.title)
    expect(titles).toContain('cu-test-a')
    expect(titles).toContain('cu-test-b')
    expect(titles).toContain('cu-café — ✓')
    expect(titles).not.toContain('cu-owner')
    expect(ws.find((w) => w.title === 'cu-test-a')?.process).toBe('xterm')
  })

  test('focuses a window by title, including non-ASCII ones', async () => {
    const plat = p()
    expect((await plat.focusWindow('cu-test-a')).title).toBe('cu-test-a')
    expect((await plat.foreground()).title).toBe('cu-test-a')
    expect((await plat.focusWindow('café')).title).toBe('cu-café — ✓')
    await expect(plat.focusWindow('no-such-window')).rejects.toThrow('No open window matches')
    await expect(plat.focusWindow('  ')).rejects.toThrow('Give the window title')
  })

  test('remember skips Tomo and restoreFocus brings the app back', async () => {
    const plat = p()
    await plat.focusWindow('cu-test-b')
    await raise('cu-owner') // Tomo comes to the front
    expect((await plat.remember()).title).toBe('cu-test-b')
    // While Tomo is in front, the target is still the remembered app.
    expect((await plat.foreground()).title).toBe('cu-test-b')
    expect((await plat.restoreFocus()).title).toBe('cu-test-b')
    expect(activeTitle()).toBe('cu-test-b')
  })

  test('restoreFocus falls back to the next app when the remembered one closed', async () => {
    const plat = p()
    const gone = xterm('cu-gone')
    await waitFor(() => spawnSync('wmctrl', ['-l']).stdout.toString().includes('cu-gone'))
    await plat.focusWindow('cu-gone')
    await raise('cu-owner')
    expect((await plat.remember()).title).toBe('cu-gone')
    gone.kill()
    await waitFor(() => !spawnSync('wmctrl', ['-l']).stdout.toString().includes('cu-gone'))
    await raise('cu-owner')
    const back = await plat.restoreFocus()
    expect(back.title).not.toBe('cu-gone')
    expect(back.title).not.toBe('cu-owner')
    expect(activeTitle()).toBe(back.title)
  })

  test('a screenshot taken while Tomo is in front shows the app instead', async () => {
    const plat = p()
    await plat.focusWindow('cu-test-a')
    await raise('cu-owner')
    const s = await plat.screenshot(800)
    expect(s.window.title).toBe('cu-test-a')
    expect(activeTitle()).toBe('cu-test-a')
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

  test('non-ASCII text arrives exactly, capitals included', async () => {
    const plat = p()
    await plat.focusWindow('cu-test-a')
    const out = join(dir, 'unicode.txt')
    const text = 'Ünï café — ÉΔÜÖ 你好 ✓ ñ€😀'
    await plat.type(`printf '%s' '${text}' > ${out}`)
    await plat.keys('enter')
    await waitFor(() => existsSync(out))
    expect(readFileSync(out, 'utf8')).toBe(text)
  })

  test('unknown key names fail instead of pressing only the modifier', async () => {
    const plat = p()
    await plat.focusWindow('cu-test-a')
    await expect(plat.keys('ctrl+nosuchkey')).rejects.toThrow('No such key name')
    await plat.keys('ctrl+/')
    await plat.keys('ctrl+u')
  })

  test('drag and scroll run', async () => {
    const plat = p()
    await plat.drag(100, 100, 200, 150)
    expect(await plat.cursor()).toEqual({ x: 200, y: 150 })
    await plat.scroll(150, 150, 3, 0)
    await plat.scroll(150, 150, -2, 1)
    // Negative coordinates are clamped to the screen instead of read as an option.
    await plat.click(-5, 10, 'left', 1)
    expect(await plat.cursor()).toEqual({ x: 0, y: 10 })
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

  test('cancel stops a drag', async () => {
    const plat = p()
    const drag = plat.drag(100, 300, 400, 300).then(
      () => null,
      (e: Error) => e
    )
    await sleep(100)
    await plat.cancel!()
    expect((await drag)?.name).toBe('Cancelled')
    // Input works normally afterwards.
    await plat.click(320, 220, 'left', 1)
    expect(await plat.cursor()).toEqual({ x: 320, y: 220 })
  })

  test('controls are not available yet and say so', async () => {
    await expect(p().uiTree(10)).rejects.toThrow('look_at_screen')
    expect(await p().elementAt(1, 1)).toBeNull()
  })

  test('a missing tool is reported, not read as "no windows" or ignored', async () => {
    await withOnly(['xdotool', 'wmctrl', 'import'], async () => {
      await expect(p().windows()).rejects.toThrow('xprop is not installed')
    })
    await p().focusWindow('cu-test-b')
    await raise('cu-owner')
    // The platform reads PATH when it's made, so make it inside.
    await withOnly(['xdotool', 'xprop', 'import'], async () => {
      const plat = p()
      expect((await plat.remember()).title).toBe('cu-test-b')
      await expect(plat.restoreFocus()).rejects.toThrow('wmctrl is not installed')
    })
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
      if (prevHome === undefined) delete process.env['HOME']
      else process.env['HOME'] = prevHome
    }
  })

  test('open takes an app name only, never a command line', async () => {
    const plat = p()
    const pwned = join(dir, 'pwned')
    await expect(plat.open(`touch ${pwned}`)).rejects.toThrow('app by its name or command name only')
    await expect(plat.open(`bash -c {touch,${pwned}}`)).rejects.toThrow('app by its name or command name only')
    await expect(plat.open('-rf')).rejects.toThrow()
    await sleep(300)
    expect(existsSync(pwned)).toBe(false)
    await expect(plat.open('no-such-app-xyz')).rejects.toThrow('No app called "no-such-app-xyz" is installed')
  })

  test('open and reveal fail for paths that do not exist', async () => {
    await expect(p().open('/nonexistent/zzz.pdf')).rejects.toThrow("There's no file or folder")
    await expect(p().open('file:///nonexistent/zzz.pdf')).rejects.toThrow("There's no file or folder")
    await expect(p().reveal('/nonexistent/zzz.pdf')).rejects.toThrow("There's no file or folder")
  })

  test('an app opens by its command name, in any case', async () => {
    const ids = () => new Set(parseWindowIds(spawnSync('xprop', ['-root', '_NET_CLIENT_LIST']).stdout.toString()))
    const before = ids()
    await p().open('XTerm')
    await waitFor(() => [...ids()].some((id) => !before.has(id)))
    // Close the terminal it opened.
    for (const id of ids()) if (!before.has(id)) spawnSync('wmctrl', ['-i', '-c', id])
    await waitFor(() => [...ids()].every((id) => before.has(id)))
  })
})
