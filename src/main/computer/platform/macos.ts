// macOS adapter, experimental: it follows the same Platform contract as Windows but hasn't run on
// a Mac yet. It uses only tools that ship with the OS: `osascript -l JavaScript` (CoreGraphics
// events, System Events), `screencapture`, `sips`, `mdfind` and `open`. Coordinates are points.
// Needs Accessibility and Screen Recording permission for chat-v2.
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import type { FileHit, Platform, SearchQuery, UiElement, WindowInfo } from './types'

const run = (cmd: string, args: string[], input?: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout!.setEncoding('utf8').on('data', (d: string) => (out += d))
    p.stderr!.setEncoding('utf8').on('data', (d: string) => (err += d))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `${cmd} failed`))))
    if (input) p.stdin!.end(input)
  })

/** Run a JXA snippet; the snippet's return value is JSON-encoded back. */
const jxa = async <T>(body: string): Promise<T> => {
  const out = await run('osascript', ['-l', 'JavaScript', '-'], `function run(){ return JSON.stringify((function(){ ${body} })()) }`)
  return (out ? JSON.parse(out) : null) as T
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

const mouse = (events: Array<[type: number, x: number, y: number, clickState?: number]>, button = 0) =>
  jxa<null>(`
    ObjC.import('CoreGraphics');
    const evs = ${JSON.stringify(events)};
    for (const [t, x, y, n] of evs) {
      const e = $.CGEventCreateMouseEvent(null, t, $.CGPointMake(x, y), ${button});
      if (n) $.CGEventSetIntegerValueField(e, 1, n);
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

/** `ownerPid` is chat-v2's main process: its windows are never targets. */
export const makeMacPlatform = (opts: { ownerPid: number }): Platform => {
  let remembered = ''
  let lastTree: UiElement[] = []

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

  const element = (id: number) => {
    const el = lastTree.find((e) => e.id === id)
    if (!el) throw new Error(`Element ${id} is stale; call ui_elements again`)
    return el
  }

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
    screenshot: async (maxWidth) => {
      const dir = await mkdtemp(join(tmpdir(), 'chat-v2-shot-'))
      const file = join(dir, 'shot.jpg')
      try {
        await run('screencapture', ['-x', '-m', '-t', 'jpg', file])
        const size = await run('sips', ['-g', 'pixelWidth', file])
        const px = Number(/pixelWidth:\s*(\d+)/.exec(size)?.[1] ?? maxWidth)
        if (px > maxWidth) await run('sips', ['--resampleWidth', String(maxWidth), file])
        const dims = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file])
        const imageWidth = Number(/pixelWidth:\s*(\d+)/.exec(dims)?.[1])
        const imageHeight = Number(/pixelHeight:\s*(\d+)/.exec(dims)?.[1])
        const screen = await jxa<{ width: number; height: number }>(`
          ObjC.import('AppKit'); const f = $.NSScreen.mainScreen.frame;
          return { width: f.size.width, height: f.size.height };`)
        const data = (await readFile(file)).toString('base64')
        return { data, mime: 'image/jpeg', imageWidth, imageHeight, screen: { x: 0, y: 0, ...screen }, window: await target() }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    cursor: () => jxa(`ObjC.import('CoreGraphics'); const p = $.CGEventGetLocation($.CGEventCreate(null)); return { x: p.x, y: p.y };`),
    click: async (x, y, button, count) => {
      const [down, up, btn] = button === 'right' ? [3, 4, 1] : button === 'middle' ? [25, 26, 2] : [1, 2, 0]
      const evs: Array<[number, number, number, number?]> = [[5, x, y]]
      for (let i = 1; i <= Math.max(1, count); i++) evs.push([down, x, y, i], [up, x, y, i])
      await mouse(evs, btn)
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
      const parts = combo.toLowerCase().replace(/\s/g, '').split('+').filter(Boolean)
      const mods = parts.filter((p) => MODIFIERS[p]).map((p) => MODIFIERS[p]!)
      const key = parts.find((p) => !MODIFIERS[p])
      if (!key) throw new Error(`No key in combo ${combo}`)
      const using = mods.length ? `, { using: ${JSON.stringify(mods)} }` : ''
      const code = KEY_CODES[key]
      await jxa(
        code != null
          ? `Application('System Events').keyCode(${code}${using}); return null`
          : `Application('System Events').keystroke(${JSON.stringify(key)}${using}); return null`
      )
    },
    uiTree: async (max) => {
      const elements = await jxa<UiElement[]>(`
        const se = Application('System Events');
        const p = se.processes.whose({ frontmost: true })[0];
        const out = []; let id = 1;
        const want = new Set(['AXButton','AXCheckBox','AXRadioButton','AXTextField','AXTextArea','AXPopUpButton','AXMenuItem','AXMenuButton','AXLink','AXTab','AXRow','AXCell','AXSlider','AXComboBox','AXStaticText']);
        let all = [];
        try { all = p.windows[0].entireContents() } catch (e) {}
        for (const el of all) {
          if (out.length >= ${max}) break;
          try {
            const role = el.role(); if (!want.has(role)) continue;
            const name = el.name() || el.description() || el.title() || '';
            const [x, y] = el.position(); const [w, h] = el.size();
            if (w < 2 || h < 2) continue;
            out.push({ id: id++, type: role.replace('AX',''), name: String(name).slice(0, 120), x, y, width: w, height: h });
          } catch (e) {}
        }
        return out;`)
      lastTree = elements
      return { window: await target(), elements }
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
      await jxa(`Application('System Events').keystroke(${JSON.stringify(text)}); return null`)
      return 'typed'
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
