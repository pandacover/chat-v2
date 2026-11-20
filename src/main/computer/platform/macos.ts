// macOS adapter, experimental: it follows the same Platform contract as Windows but hasn't run on
// a Mac yet. It uses only tools that ship with the OS: `osascript -l JavaScript` (CoreGraphics
// events, System Events), `screencapture`, `sips`, `mdfind` and `open`. Coordinates are points.
// Needs Accessibility and Screen Recording permission for chat-v2.
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import type { FileHit, Modifier, Platform, SearchQuery, UiElement, WindowInfo } from './types'

/** Called with every process the adapter starts (set by makeMacPlatform), so quitting can end them. */
let track: (p: ChildProcess) => void = () => {}

/** A command that runs longer than this is killed and fails (an Accessibility call can hang on a busy app). */
export const MAC_TIMEOUT_MS = 20_000

const run = (cmd: string, args: string[], input?: string, timeoutMs = MAC_TIMEOUT_MS): Promise<string> =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    track(p)
    let out = ''
    let err = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      p.kill('SIGKILL')
    }, timeoutMs)
    p.stdout!.setEncoding('utf8').on('data', (d: string) => (out += d))
    p.stderr!.setEncoding('utf8').on('data', (d: string) => (err += d))
    p.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut)
        return reject(new Error(`${cmd} didn't finish within ${Math.round(timeoutMs / 1000)} s (the app may be showing a dialog or not responding), so it was stopped. Look at the screen before going on.`))
      code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `${cmd} failed`))
    })
    if (input) p.stdin!.end(input)
  })

/** Run a JXA snippet; the snippet's return value is JSON-encoded back. */
const jxa = async <T>(body: string): Promise<T> => {
  const out = await run('osascript', ['-l', 'JavaScript', '-'], `function run(){ return JSON.stringify((function(){ ${body} })()) }`)
  return (out ? JSON.parse(out) : null) as T
}

/** How many ui_elements entries are kept, so ids from the last few lists still resolve. */
const MAX_KEPT = 2000

/**
 * The ui_elements id registry: ids are never reused, so an id from an older list still means the
 * same control or is reported stale. Keeps the most recent MAX_KEPT.
 */
export const makeElementIds = <E extends { id: number }>(max = MAX_KEPT) => {
  const kept = new Map<number, E>()
  let next = 1
  return {
    /** Give each element of a new list a fresh id and keep it. */
    add: (els: ReadonlyArray<Omit<E, 'id'>>): E[] =>
      els.map((e) => {
        const el = { ...e, id: next++ } as E
        kept.set(el.id, el)
        if (kept.size > max) kept.delete(kept.keys().next().value!)
        return el
      }),
    get: (id: number): E => {
      const el = kept.get(id)
      if (!el) throw new Error(`Element ${id} is stale or unknown (not in a recent control list); call ui_elements again`)
      return el
    }
  }
}

const KEY_CODES: Record<string, number> = {
  enter: 36, return: 36, tab: 48, space: 49, backspace: 51, delete: 117, del: 117, esc: 53, escape: 53,
  left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111
}
const MODIFIERS: Record<string, string> = {
  cmd: 'command down', command: 'command down', meta: 'command down', win: 'command down', super: 'command down',
  ctrl: 'control down', control: 'control down', alt: 'option down', option: 'option down', shift: 'shift down'
}

/** Punctuation keys by name, typed as their character. */
const PUNCT_NAMES: Record<string, string> = {
  plus: '+', minus: '-', comma: ',', period: '.', dot: '.', slash: '/', semicolon: ';', equal: '=', equals: '=',
  backslash: '\\', quote: "'", apostrophe: "'", backquote: '`', backtick: '`', grave: '`', bracketleft: '[', bracketright: ']'
}

/**
 * A key combo as System Events wants it: modifiers, and a key code or one character.
 * "cmd++" and "+" press plus; a word that isn't a key name is an error, not typed as text.
 */
export const macCombo = (combo: string): { mods: string[] } & ({ code: number } | { char: string }) => {
  const s = combo.toLowerCase().replace(/\s/g, '')
  const parts = s === '+' ? ['+'] : s.endsWith('++') ? [...s.slice(0, -2).split('+'), '+'] : s.split('+')
  const mods = [...new Set(parts.filter((p) => MODIFIERS[p]).map((p) => MODIFIERS[p]!))]
  const keys = parts.filter((p) => p && !MODIFIERS[p])
  if (keys.length !== 1) throw new Error(keys.length ? `Press one key at a time with its modifiers, not "${combo}"` : `No key in combo ${combo}`)
  const key = keys[0]!
  const code = KEY_CODES[key]
  if (code != null) return { mods, code }
  const char = PUNCT_NAMES[key] ?? (Array.from(key).length === 1 ? key : null)
  if (char == null) throw new Error(`Unknown key "${key}" in ${combo}`)
  return { mods, char }
}

/** CGEventFlags for click modifiers: cmd is Command (as in key combos). */
const MOUSE_FLAGS: Record<Modifier, number> = { shift: 0x20000, ctrl: 0x40000, alt: 0x80000, cmd: 0x100000 }
export const mouseFlags = (mods: ReadonlyArray<Modifier> = []) => mods.reduce((f, m) => f | (MOUSE_FLAGS[m] ?? 0), 0)

const mouse = (events: Array<[type: number, x: number, y: number, clickState?: number]>, button = 0, flags = 0) =>
  jxa<null>(`
    ObjC.import('CoreGraphics');
    const evs = ${JSON.stringify(events)};
    for (const [t, x, y, n] of evs) {
      const e = $.CGEventCreateMouseEvent(null, t, $.CGPointMake(x, y), ${button});
      if (n) $.CGEventSetIntegerValueField(e, 1, n);
      if (${flags}) $.CGEventSetFlags(e, ${flags});
      $.CGEventPost(0, e);
      delay(0.03);
    }
    return null;`)

export const buildMdfindQuery = (q: SearchQuery): string => {
  const esc = (s: string) => s.replace(/["\\*]/g, '')
  const parts: string[] = []
  for (const w of (q.name ?? '').split(/\s+/).filter(Boolean)) parts.push(`kMDItemFSName == "*${esc(w)}*"cd`)
  if (q.contains?.trim()) parts.push(`kMDItemTextContent == "*${esc(q.contains.trim())}*"cd`)
  const exts = (q.extensions ?? []).map((e) => e.replace(/^\./, ''))
  if (exts.length) parts.push(`(${exts.map((e) => `kMDItemFSName == "*.${esc(e)}"c`).join(' || ')})`)
  if (q.kind === 'folder') parts.push(`kMDItemContentType == "public.folder"`)
  if (q.kind === 'file') parts.push(`kMDItemContentType != "public.folder"`)
  if (q.modifiedWithinDays) parts.push(`kMDItemFSContentChangeDate >= $time.today(-${Math.round(q.modifiedWithinDays)})`)
  return parts.length ? parts.join(' && ') : `kMDItemFSName == "*"`
}

/** Text field roles, whose text type_text replaces. */
const MAC_FIELDS = new Set(['TextField', 'TextArea', 'ComboBox'])

/** `ownerPid` is chat-v2's main process: its windows are never targets. */
export const makeMacPlatform = (opts: { ownerPid: number; track?: (p: ChildProcess) => void }): Platform => {
  if (opts.track) track = opts.track
  let remembered = ''
  const ids = makeElementIds<UiElement>()

  const frontApp = () =>
    jxa<{ name: string; pid: number; title: string }>(`
      const se = Application('System Events');
      const p = se.processes.whose({ frontmost: true })[0];
      let title = '';
      try { title = p.windows[0].name() || '' } catch (e) {}
      return { name: p.name(), pid: p.unixId(), title };`)

  /** The app of the frontmost normal window that isn't chat-v2's: the app the user was in before. */
  const appBelow = () =>
    jxa<string | null>(`
      ObjC.import('CoreGraphics');
      const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];
      const w = list.find((w) => w.kCGWindowLayer === 0 && w.kCGWindowOwnerPID !== ${opts.ownerPid});
      return w ? w.kCGWindowOwnerName : null;`)

  const own = (f: { pid: number }) => f.pid === opts.ownerPid

  const target = async (): Promise<WindowInfo> => {
    const f = await frontApp()
    if (own(f) && remembered) return { title: '', process: remembered }
    return { title: f.title, process: f.name }
  }

  const element = ids.get

  return {
    name: 'macos',
    remember: async () => {
      const f = await frontApp()
      if (!own(f)) remembered = f.name
      else remembered = (await appBelow().catch(() => null)) ?? remembered
      return own(f) ? { title: '', process: remembered } : { title: f.title, process: f.name }
    },
    restoreFocus: async () => {
      const f = await frontApp()
      if (own(f) && remembered) await jxa(`Application(${JSON.stringify(remembered)}).activate(); return null`)
      return target()
    },
    foreground: target,
    windows: () =>
      jxa(`
        const se = Application('System Events');
        return se.processes.whose({ backgroundOnly: false })().filter(p => p.unixId() !== ${opts.ownerPid}).slice(0, 40).map(p => {
          let title = ''; try { title = p.windows[0].name() || '' } catch (e) {}
          return { title, process: p.name() };
        });`),
    focusWindow: async (title) => {
      await jxa(`
        const se = Application('System Events');
        const needle = ${JSON.stringify(title.toLowerCase())};
        const p = se.processes.whose({ backgroundOnly: false })().find(p => {
          if (p.unixId() === ${opts.ownerPid}) return false;
          if (p.name().toLowerCase() === needle) return true;
          try { return p.windows().some(w => (w.name() || '').toLowerCase().includes(needle)) } catch (e) { return false }
        });
        if (!p) throw new Error('No open window matches ' + needle);
        p.frontmost = true;
        return null;`)
      const info = await target()
      remembered = info.process
      return info
    },
    screenshot: async (maxWidth, o = {}) => {
      const dir = await mkdtemp(join(tmpdir(), 'chat-v2-shot-'))
      const file = join(dir, 'shot.jpg')
      const r = o.region
      try {
        // -C draws the pointer in. A region (-R, in points) is captured at the display's pixel density.
        const where = r ? [`-R${Math.round(r.x)},${Math.round(r.y)},${Math.max(1, Math.round(r.width))},${Math.max(1, Math.round(r.height))}`] : ['-m']
        await run('screencapture', ['-x', '-C', ...where, '-t', 'jpg', file])
        const size = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file])
        const px = Number(/pixelWidth:\s*(\d+)/.exec(size)?.[1] ?? maxWidth)
        const py = Number(/pixelHeight:\s*(\d+)/.exec(size)?.[1] ?? 0)
        const k = Math.min(1, maxWidth / px, o.maxHeight && py ? o.maxHeight / py : 1)
        if (k < 1) await run('sips', ['--resampleWidth', String(Math.max(1, Math.round(px * k))), file])
        const dims = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file])
        const imageWidth = Number(/pixelWidth:\s*(\d+)/.exec(dims)?.[1])
        const imageHeight = Number(/pixelHeight:\s*(\d+)/.exec(dims)?.[1])
        const screen = r
          ? { width: r.width, height: r.height }
          : await jxa<{ width: number; height: number }>(`
          ObjC.import('AppKit'); const f = $.NSScreen.mainScreen.frame;
          return { width: f.size.width, height: f.size.height };`)
        const data = (await readFile(file)).toString('base64')
        return { data, mime: 'image/jpeg', imageWidth, imageHeight, screen: { x: r?.x ?? 0, y: r?.y ?? 0, ...screen }, window: await target() }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    cursor: () => jxa(`ObjC.import('CoreGraphics'); const p = $.CGEventGetLocation($.CGEventCreate(null)); return { x: p.x, y: p.y };`),
    move: async (x, y) => void (await mouse([[5, x, y]])),
    click: async (x, y, button, count, modifiers = []) => {
      const [down, up, btn] = button === 'right' ? [3, 4, 1] : button === 'middle' ? [25, 26, 2] : [1, 2, 0]
      const evs: Array<[number, number, number, number?]> = [[5, x, y]]
      for (let i = 1; i <= Math.min(3, Math.max(1, count)); i++) evs.push([down, x, y, i], [up, x, y, i])
      // The modifiers ride on the mouse events' flags, so no key is ever left held.
      await mouse(evs, btn, mouseFlags(modifiers))
    },
    drag: async (x1, y1, x2, y2) => {
      const evs: Array<[number, number, number]> = [
        [5, x1, y1],
        [1, x1, y1]
      ]
      for (let s = 1; s <= 12; s++) evs.push([6, x1 + ((x2 - x1) * s) / 12, y1 + ((y2 - y1) * s) / 12])
      evs.push([2, x2, y2])
      await mouse(evs)
    },
    scroll: async (x, y, dy, dx) => {
      await mouse([[5, x, y]])
      await jxa(`
        ObjC.import('CoreGraphics');
        const e = $.CGEventCreateScrollWheelEvent(null, 1, 2, ${-Math.round(dy) * 3}, ${Math.round(dx) * 3});
        $.CGEventPost(0, e); return null;`)
    },
    type: async (text) => {
      await jxa(`Application('System Events').keystroke(${JSON.stringify(text)}); return null`)
    },
    keys: async (combo) => {
      const k = macCombo(combo)
      const using = k.mods.length ? `, { using: ${JSON.stringify(k.mods)} }` : ''
      await jxa(
        'code' in k
          ? `Application('System Events').keyCode(${k.code}${using}); return null`
          : `Application('System Events').keystroke(${JSON.stringify(k.char)}${using}); return null`
      )
    },
    otherWindows: true,
    uiTree: async (max, o = {}) => {
      const needle = (o.window ?? '').trim().toLowerCase()
      const r = await jxa<{ elements: Array<Omit<UiElement, 'id'>>; truncated: boolean; window: WindowInfo | null }>(`
        const se = Application('System Events');
        const needle = ${JSON.stringify(needle)};
        let p = null, win = null;
        if (needle) {
          // Another window, by app name or part of its title (not chat-v2's).
          for (const q of se.processes.whose({ backgroundOnly: false })()) {
            if (q.unixId() === ${opts.ownerPid}) continue;
            if (q.name().toLowerCase() === needle) { p = q; try { win = q.windows[0] } catch (e) {} break; }
            let m = null;
            try { m = q.windows().find(w => (w.name() || '').toLowerCase().includes(needle)) } catch (e) {}
            if (m) { p = q; win = m; break; }
          }
          if (!p) throw new Error('No open window matches ' + needle);
        } else {
          p = se.processes.whose({ frontmost: true })[0];
          try { win = p.windows[0] } catch (e) {}
        }
        const out = []; let truncated = false;
        const want = new Set(['AXButton','AXCheckBox','AXRadioButton','AXTextField','AXTextArea','AXPopUpButton','AXMenuItem','AXMenuButton','AXLink','AXTab','AXRow','AXCell','AXSlider','AXComboBox','AXStaticText']);
        // Roles whose AXValue is state: a field's text, a check box's 0/1/2, a radio button's or tab's 1.
        const valued = new Set(['AXCheckBox','AXRadioButton','AXTab','AXTextField','AXTextArea','AXComboBox','AXSlider','AXPopUpButton']);
        let all = [];
        try { all = win.entireContents() } catch (e) {}
        for (const el of all) {
          try {
            const role = el.role(); if (!want.has(role)) continue;
            const name = el.name() || el.description() || el.title() || '';
            const [x, y] = el.position(); const [w, h] = el.size();
            if (w < 2 || h < 2) continue;
            if (out.length >= ${max}) { truncated = true; break; }
            const e = { type: role.replace('AX',''), name: String(name).slice(0, 120), x, y, width: w, height: h };
            if (role !== 'AXStaticText') {
              try { if (el.enabled() === false) e.disabled = true } catch (x) {}
              if (valued.has(role)) {
                try {
                  const v = el.value();
                  if (role === 'AXCheckBox') e.checked = v === 1 ? true : v === 2 ? 'mixed' : false;
                  else if (role === 'AXRadioButton' || role === 'AXTab') { if (v === 1) e.selected = true }
                  else if (v != null && v !== '' && el.subrole() !== 'AXSecureTextField') e.value = String(v).replace(/\\s+/g, ' ').slice(0, 80);
                } catch (x) {}
              }
              if (role === 'AXRow') { try { if (el.selected()) e.selected = true } catch (x) {} }
            }
            out.push(e);
          } catch (e) {}
        }
        let title = '';
        try { title = win ? win.name() || '' : '' } catch (e) {}
        return { elements: out, truncated, window: needle ? { title, process: p.name() } : null };`)
      const elements = ids.add(r.elements)
      return { window: r.window ?? (await target()), elements, ...(r.truncated ? { truncated: true } : {}) }
    },
    invoke: async (id) => {
      const el = element(id)
      const cx = el.x + el.width / 2
      const cy = el.y + el.height / 2
      await mouse([
        [5, cx, cy],
        [1, cx, cy, 1],
        [2, cx, cy, 1]
      ])
      return 'clicked'
    },
    setValue: async (id, text) => {
      const el = element(id)
      const cx = el.x + el.width / 2
      const cy = el.y + el.height / 2
      await mouse([
        [5, cx, cy],
        [1, cx, cy, 1],
        [2, cx, cy, 1]
      ])
      // A field's text is replaced, as UI Automation's ValuePattern does on Windows.
      const field = MAC_FIELDS.has(el.type)
      if (field) await jxa(`Application('System Events').keystroke('a', { using: ['command down'] }); return null`)
      await jxa(`Application('System Events').keystroke(${JSON.stringify(text)}); return null`)
      return field ? 'replaced' : 'typed'
    },
    elementRect: async (id) => {
      const el = element(id)
      return { x: el.x, y: el.y, width: el.width, height: el.height }
    },
    elementAt: async () => null,
    search: async (q) => {
      const out = await run('mdfind', ['-onlyin', homedir(), buildMdfindQuery(q)]).catch(() => '')
      const limit = Math.min(q.limit ?? 25, 100)
      const paths = out
        .split('\n')
        .filter((p) => p && !/\/(node_modules|Library|\.[^/]+)\//.test(p))
        .slice(0, limit)
      const hits = await Promise.all(
        paths.map(async (path): Promise<FileHit | null> => {
          const s = await stat(path).catch(() => null)
          if (!s) return null
          const folder = s.isDirectory()
          return {
            path,
            name: basename(path),
            kind: folder ? 'folder' : 'file',
            ext: folder ? '' : extname(path).slice(1).toLowerCase(),
            modified: s.mtime.toISOString(),
            size: folder ? null : s.size
          }
        })
      )
      return hits.filter((h): h is FileHit => h !== null).sort((a, b) => (b.modified ?? '').localeCompare(a.modified ?? ''))
    },
    open: async (target) => {
      const looksLikePath = /^(\/|~|[a-z][a-z0-9+.-]*:)/i.test(target)
      await run('open', looksLikePath ? [target.replace(/^~/, homedir())] : ['-a', target])
    },
    reveal: async (path) => void (await run('open', ['-R', path])),
    dispose: () => {}
  }
}
