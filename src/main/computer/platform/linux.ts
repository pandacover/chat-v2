// Linux adapter (X11). It follows the same Platform contract as Windows and macOS using common
// command-line tools: xdotool (input), xprop and wmctrl (windows), ImageMagick `import`
// (screenshots), find and grep (file search) and xdg-open. Coordinates are X screen pixels.
// Wayland sessions aren't supported: X11 tools can't see or drive other apps there.
//
// Reading controls (ui_elements) isn't implemented yet: those calls fail with a message that
// tells the model to use the screenshot and pixel clicks instead.
//
// Debian/Ubuntu packages: xdotool x11-utils wmctrl imagemagick xdg-utils
import { type ChildProcess, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname } from 'node:path'
import type { FileHit, Platform, SearchQuery, WindowInfo } from './types'

/** Computer use needs an X11 display; Wayland sessions are not supported. */
export const linuxSupported = (env: NodeJS.ProcessEnv = process.env) =>
  !!env['DISPLAY'] && env['XDG_SESSION_TYPE'] !== 'wayland'

const NO_CONTROLS =
  "Reading controls isn't available on Linux yet. Use look_at_screen and click by pixel coordinates instead."

/** Characters per xdotool call when typing: cancel() takes effect between chunks. */
const TYPE_CHUNK = 24

const cancelledError = () => Object.assign(new Error('Cancelled'), { name: 'Cancelled' })

// ---------------------------------------------------------------- parsers (exported for tests)

export interface XWindow {
  id: string
  title: string
  pid: number | null
  wmClass: string
  hidden: boolean
}

/** Unescape the text between the quotes of an xprop string value. */
const xpropString = (raw: string) => {
  const m = /^"(.*)"$/s.exec(raw.trim())
  return m ? m[1]!.replace(/\\(["\\])/g, '$1') : ''
}

/** Parse `xprop -id <id> _NET_WM_NAME WM_NAME WM_CLASS _NET_WM_PID _NET_WM_STATE`. */
export const parseXprop = (id: string, out: string): XWindow => {
  const props = new Map<string, string>()
  for (const line of out.split('\n')) {
    const m = /^([A-Z_]+)\([^)]*\)\s*=\s*(.*)$/.exec(line)
    if (m) props.set(m[1]!, m[2]!)
  }
  const title = xpropString(props.get('_NET_WM_NAME') ?? props.get('WM_NAME') ?? '')
  // WM_CLASS = "instance", "Class": the class names the app.
  const classes = [...(props.get('WM_CLASS') ?? '').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((c) => c[1]!)
  const pid = Number(props.get('_NET_WM_PID'))
  return {
    id,
    title,
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    wmClass: classes[1] ?? classes[0] ?? '',
    hidden: /_NET_WM_STATE_HIDDEN/.test(props.get('_NET_WM_STATE') ?? '')
  }
}

/** Window ids from `xprop -root _NET_ACTIVE_WINDOW` or `_NET_CLIENT_LIST_STACKING` (bottom to top). */
export const parseWindowIds = (out: string): string[] =>
  [...out.matchAll(/0x[0-9a-f]+/gi)].map((m) => m[0].toLowerCase()).filter((id) => !/^0x0+$/.test(id))

/** Parse `xdotool getmouselocation --shell`. */
export const parseMouse = (out: string) => {
  const x = Number(/^X=(-?\d+)/m.exec(out)?.[1])
  const y = Number(/^Y=(-?\d+)/m.exec(out)?.[1])
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Could not read the mouse position')
  return { x, y }
}

/** Width and height of a JPEG, read from its start-of-frame marker. */
export const jpegSize = (buf: Buffer): { width: number; height: number } => {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('Screenshot is not a JPEG')
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++
      continue
    }
    const marker = buf[i + 1]!
    // Markers without a length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      i += marker === 0xff ? 1 : 2
      continue
    }
    const len = buf.readUInt16BE(i + 2)
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    }
    i += 2 + len
  }
  throw new Error('Could not read the screenshot size')
}

const KEYSYMS: Record<string, string> = {
  enter: 'Return', return: 'Return', tab: 'Tab', space: 'space', backspace: 'BackSpace', delete: 'Delete', del: 'Delete',
  esc: 'Escape', escape: 'Escape', insert: 'Insert', ins: 'Insert', home: 'Home', end: 'End',
  pageup: 'Page_Up', pgup: 'Page_Up', pagedown: 'Page_Down', pgdn: 'Page_Down',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', menu: 'Menu', printscreen: 'Print', prtsc: 'Print',
  capslock: 'Caps_Lock', plus: 'plus', minus: 'minus', comma: 'comma', period: 'period', slash: 'slash'
}
const MODS: Record<string, string> = {
  ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift',
  win: 'super', super: 'super', cmd: 'super', command: 'super', meta: 'super'
}

/** "ctrl+shift+t" → "ctrl+shift+t", "win+d" → "super+d", "enter" → "Return": an xdotool key chord. */
export const toXdotoolChord = (combo: string): string => {
  const parts = combo.trim().split(/\s*\+\s*/).filter(Boolean)
  if (!parts.length) throw new Error('No key given')
  const keys = parts.map((p, i) => {
    const k = p.toLowerCase()
    if (i < parts.length - 1 && MODS[k]) return MODS[k]!
    if (KEYSYMS[k]) return KEYSYMS[k]!
    if (/^f([1-9]|1[0-9]|2[0-4])$/.test(k)) return k.toUpperCase()
    if (MODS[k]) return MODS[k]! // a lone modifier press, e.g. "super"
    // Single characters stay as typed; other words are passed as X keysym names.
    return p.length === 1 ? k : p
  })
  return keys.join('+')
}

/** Escape glob characters so find's -iname matches the words literally. */
/** The user's home folder: $HOME when set, as on any Linux login. */
const home = () => process.env['HOME'] || homedir()

const globWord = (s: string) => s.replace(/[[\]*?\\]/g, '\\$&')

/**
 * Arguments for GNU find: matching files and folders under `home`, skipping dot-folders and
 * dependency caches. Prints "<type>\t<mtime>\t<size>\t<path>" per hit.
 */
export const buildFindArgs = (q: SearchQuery, root = home()): string[] => {
  const args = [root, '-xdev', '-mindepth', '1']
  args.push('(', '-name', '.*', '-o', '-name', 'node_modules', '-o', '-name', '__pycache__', ')', '-prune', '-o')
  const kind = q.contains?.trim() ? 'file' : (q.kind ?? 'any')
  if (kind === 'file') args.push('-type', 'f')
  else if (kind === 'folder') args.push('-type', 'd')
  else args.push('(', '-type', 'f', '-o', '-type', 'd', ')')
  for (const word of (q.name ?? '').split(/\s+/).filter(Boolean)) args.push('-iname', `*${globWord(word)}*`)
  const exts = (q.extensions ?? []).map((e) => e.replace(/^\./, '')).filter(Boolean)
  if (exts.length) {
    args.push('(')
    exts.forEach((e, i) => args.push(...(i ? ['-o'] : []), '-iname', `*.${globWord(e)}`))
    args.push(')')
  }
  if (q.modifiedWithinDays && q.modifiedWithinDays > 0) args.push('-mtime', `-${Math.ceil(q.modifiedWithinDays)}`)
  args.push('-printf', '%y\\t%T@\\t%s\\t%p\\n')
  return args
}

export const parseFindLine = (line: string): FileHit | null => {
  const [type, mtime, size, ...rest] = line.split('\t')
  const path = rest.join('\t')
  if (!path) return null
  const folder = type === 'd'
  const t = Number(mtime)
  return {
    path,
    name: basename(path),
    kind: folder ? 'folder' : 'file',
    ext: folder ? '' : extname(path).slice(1).toLowerCase(),
    modified: Number.isFinite(t) ? new Date(t * 1000).toISOString() : null,
    size: folder ? null : Number(size) || 0
  }
}

// ---------------------------------------------------------------- process helpers

interface RunOpts {
  input?: string
  /** Kill after this many ms and resolve with what was printed so far. */
  timeoutMs?: number
  /** Exit codes that still count as success (grep exits 1 for "no match"). */
  okCodes?: number[]
}

/** `ownerPid` is chat-v2's main process: its windows are never targets. */
export const makeLinuxPlatform = (opts: { ownerPid: number; track?: (p: ChildProcess) => void }): Platform => {
  const track = opts.track ?? (() => {})
  const running = new Set<ChildProcess>()
  /** Input actions in flight that cancel() kills (drags and scrolls). */
  const acting = new Set<ChildProcess>()
  let cancelGen = 0

  const runBuf = (cmd: string, args: string[], o: RunOpts & { act?: boolean } = {}): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const gen = cancelGen
      let p: ChildProcess
      try {
        p = spawn(cmd, args, { stdio: [o.input ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
      } catch (e) {
        reject(e as Error)
        return
      }
      track(p)
      running.add(p)
      if (o.act) acting.add(p)
      const out: Buffer[] = []
      let err = ''
      let timedOut = false
      const timer = o.timeoutMs
        ? setTimeout(() => {
            timedOut = true
            p.kill('SIGTERM')
          }, o.timeoutMs)
        : null
      p.stdout!.on('data', (d: Buffer) => out.push(d))
      p.stderr!.setEncoding('utf8').on('data', (d: string) => (err += d))
      p.on('error', (e: NodeJS.ErrnoException) => {
        if (timer) clearTimeout(timer)
        running.delete(p)
        acting.delete(p)
        reject(e.code === 'ENOENT' ? new Error(`${cmd} is not installed (needed for computer use on Linux)`) : e)
      })
      p.on('close', (code) => {
        if (timer) clearTimeout(timer)
        running.delete(p)
        acting.delete(p)
        if (gen !== cancelGen) return reject(cancelledError())
        if (timedOut || code === 0 || (code !== null && o.okCodes?.includes(code))) return resolve(Buffer.concat(out))
        reject(new Error(err.trim() || `${cmd} exited with ${code}`))
      })
      if (o.input) p.stdin!.end(o.input)
    })

  const run = async (cmd: string, args: string[], o: RunOpts & { act?: boolean } = {}) =>
    (await runBuf(cmd, args, o)).toString('utf8').trim()

  /**
   * xdotool commands that move the pointer and let apps see it arrive. (Not `mousemove --sync`:
   * it waits for the pointer to move, so it never returns when the pointer is already there.)
   */
  const moveTo = (x: number, y: number) => ['mousemove', String(Math.round(x)), String(Math.round(y)), 'sleep', '0.05']

  /**
   * An input action. It rejects with "Cancelled" if cancel() runs meanwhile. `killable` actions
   * (drags, scrolls) are also stopped at once; key presses aren't, because killing xdotool between
   * a key's press and release leaves that key held down.
   */
  const act = (args: string[], killable = false) => run('xdotool', args, { act: killable })

  // ---------------------------------------------------------------- windows

  const describe = async (id: string): Promise<XWindow> =>
    parseXprop(id, await run('xprop', ['-id', id, '_NET_WM_NAME', 'WM_NAME', 'WM_CLASS', '_NET_WM_PID', '_NET_WM_STATE']))

  const processName = async (w: XWindow) => {
    if (w.pid) {
      const comm = await readFile(`/proc/${w.pid}/comm`, 'utf8').catch(() => '')
      if (comm.trim()) return comm.trim()
    }
    return w.wmClass || 'unknown'
  }

  const info = async (w: XWindow | null): Promise<WindowInfo> =>
    w ? { title: w.title, process: await processName(w) } : { title: '', process: '' }

  const own = (w: XWindow) => w.pid === opts.ownerPid

  const activeId = async () => parseWindowIds(await run('xprop', ['-root', '_NET_ACTIVE_WINDOW']).catch(() => ''))[0] ?? null

  /** Top-level app windows, bottom to top. */
  const stacking = async () => parseWindowIds(await run('xprop', ['-root', '_NET_CLIENT_LIST_STACKING']).catch(() => ''))

  const active = async () => {
    const id = await activeId()
    return id ? describe(id).catch(() => null) : null
  }

  /** The topmost window that isn't chat-v2's: the app the user was in before. */
  const appBelow = async () => {
    for (const id of (await stacking()).reverse()) {
      const w = await describe(id).catch(() => null)
      if (w && !own(w) && !w.hidden) return w
    }
    return null
  }

  let remembered: XWindow | null = null

  const target = async (): Promise<WindowInfo> => {
    const w = await active()
    if (w && own(w) && remembered) return info(remembered)
    return info(w)
  }

  const activate = async (id: string) => {
    await run('wmctrl', ['-i', '-a', id])
    // Give the window manager a moment to move focus before the next input.
    for (let i = 0; i < 10; i++) {
      if ((await activeId()) === id) return
      await new Promise((r) => setTimeout(r, 30))
    }
  }

  // ---------------------------------------------------------------- screenshot

  const screenSize = async () => {
    const [w, h] = (await run('xdotool', ['getdisplaygeometry'])).split(/\s+/).map(Number)
    if (!w || !h) throw new Error('Could not read the screen size')
    return { width: w, height: h }
  }

  const capture = async (maxWidth: number): Promise<Buffer> => {
    const args = ['-silent', '-window', 'root', '-resize', `${Math.round(maxWidth)}x>`, '-quality', '80', 'jpg:-']
    try {
      return await runBuf('import', args)
    } catch (e) {
      // ImageMagick 7 without the legacy commands.
      if (/not installed/.test((e as Error).message)) return runBuf('magick', ['import', ...args])
      throw e
    }
  }

  // ---------------------------------------------------------------- files

  const grepFiles = async (paths: string[], text: string) => {
    const hits = new Set<string>()
    for (let i = 0; i < paths.length; i += 200) {
      const out = await run('grep', ['-l', '-i', '-F', '-I', '-s', '--', text, ...paths.slice(i, i + 200)], {
        okCodes: [1, 2],
        timeoutMs: 10_000
      })
      for (const p of out.split('\n')) if (p) hits.add(p)
    }
    return hits
  }

  const detached = (cmd: string, args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const p = spawn(cmd, args, { detached: true, stdio: 'ignore' })
      p.once('error', (e: NodeJS.ErrnoException) =>
        reject(e.code === 'ENOENT' ? new Error(`Nothing called "${cmd}" is installed`) : e)
      )
      p.once('spawn', () => {
        p.unref()
        resolve()
      })
    })

  return {
    name: 'linux',
    remember: async () => {
      const w = await active()
      if (w && !own(w)) remembered = w
      else remembered = (await appBelow()) ?? remembered
      return w && !own(w) ? info(w) : info(remembered)
    },
    restoreFocus: async () => {
      const w = await active()
      if ((!w || own(w)) && remembered) await activate(remembered.id).catch(() => undefined)
      return target()
    },
    foreground: target,
    windows: async () => {
      const ws = await Promise.all((await stacking()).reverse().map((id) => describe(id).catch(() => null)))
      const apps = ws.filter((w): w is XWindow => !!w && !own(w)).slice(0, 40)
      return Promise.all(apps.map(async (w) => ({ ...(await info(w)), ...(w.hidden ? { minimized: true } : {}) })))
    },
    focusWindow: async (title) => {
      const needle = title.toLowerCase()
      for (const id of (await stacking()).reverse()) {
        const w = await describe(id).catch(() => null)
        if (!w || own(w)) continue
        const proc = (await processName(w)).toLowerCase()
        if (proc === needle || w.title.toLowerCase().includes(needle) || w.wmClass.toLowerCase() === needle) {
          await activate(w.id)
          remembered = w
          return info(w)
        }
      }
      throw new Error(`No open window matches ${title}`)
    },
    screenshot: async (maxWidth) => {
      const [screen, data] = await Promise.all([screenSize(), capture(maxWidth)])
      const { width: imageWidth, height: imageHeight } = jpegSize(data)
      return {
        data: data.toString('base64'),
        mime: 'image/jpeg',
        imageWidth,
        imageHeight,
        screen: { x: 0, y: 0, ...screen },
        window: await target()
      }
    },
    cursor: async () => parseMouse(await run('xdotool', ['getmouselocation', '--shell'])),
    click: async (x, y, button, count) => {
      const b = button === 'right' ? '3' : button === 'middle' ? '2' : '1'
      const n = String(Math.max(1, Math.round(count)))
      await act([...moveTo(x, y), 'click', '--repeat', n, '--delay', '80', b])
    },
    drag: async (x1, y1, x2, y2) => {
      const args = [...moveTo(x1, y1), 'mousedown', '1']
      for (let s = 1; s <= 12; s++) {
        args.push('sleep', '0.02', 'mousemove', String(Math.round(x1 + ((x2 - x1) * s) / 12)), String(Math.round(y1 + ((y2 - y1) * s) / 12)))
      }
      args.push('sleep', '0.05', 'mouseup', '1')
      try {
        await act(args, true)
      } catch (e) {
        // Never leave the button held down.
        await run('xdotool', ['mouseup', '1']).catch(() => undefined)
        throw e
      }
    },
    scroll: async (x, y, dy, dx) => {
      const args = moveTo(x, y)
      // X11 wheel buttons: 4 up, 5 down, 6 left, 7 right. One notch per unit, like Windows.
      const v = Math.round(dy)
      const h = Math.round(dx)
      if (v) args.push('click', '--repeat', String(Math.abs(v)), '--delay', '30', v > 0 ? '5' : '4')
      if (h) args.push('click', '--repeat', String(Math.abs(h)), '--delay', '30', h > 0 ? '7' : '6')
      await act(args, true)
    },
    type: async (text) => {
      // In short chunks, so cancel() takes effect between them without cutting a key press short.
      const chars = Array.from(text)
      for (let i = 0; i < chars.length; i += TYPE_CHUNK) {
        await act(['type', '--clearmodifiers', '--delay', '12', '--', chars.slice(i, i + TYPE_CHUNK).join('')])
      }
    },
    keys: async (combo) => void (await act(['key', '--clearmodifiers', toXdotoolChord(combo)])),
    uiTree: async () => {
      throw new Error(NO_CONTROLS)
    },
    invoke: async () => {
      throw new Error(NO_CONTROLS)
    },
    setValue: async () => {
      throw new Error(NO_CONTROLS)
    },
    elementRect: async () => {
      throw new Error(NO_CONTROLS)
    },
    elementAt: async () => null,
    search: async (q) => {
      const limit = Math.min(Math.max(q.limit ?? 25, 1), 100)
      const out = await run('find', buildFindArgs(q), { timeoutMs: 8_000, okCodes: [1] })
      let hits = out
        .split('\n')
        .map(parseFindLine)
        .filter((h): h is FileHit => h !== null)
        .sort((a, b) => (b.modified ?? '').localeCompare(a.modified ?? ''))
      const contains = q.contains?.trim()
      if (contains) {
        const matched = await grepFiles(hits.slice(0, 2000).map((h) => h.path), contains)
        hits = hits.filter((h) => matched.has(h.path))
      }
      return hits.slice(0, limit)
    },
    open: async (target) => {
      const t = target.trim()
      if (/^(\/|~|\.{1,2}\/|[a-z][a-z0-9+.-]*:)/i.test(t)) return detached('xdg-open', [t.replace(/^~(?=\/|$)/, home())])
      // An app: run it by its command name, e.g. "firefox" or "gnome-calculator".
      const cmd = t.split(/\s+/)[0]!
      return detached(cmd, t.split(/\s+/).slice(1))
    },
    reveal: async (path) => detached('xdg-open', [dirname(path.replace(/^~(?=\/|$)/, home()))]),
    cancel: async () => {
      cancelGen++
      for (const p of acting) p.kill('SIGTERM')
      // Never leave the mouse button held down after an interrupted drag.
      await run('xdotool', ['mouseup', '1']).catch(() => undefined)
    },
    dispose: () => {
      for (const p of running) p.kill('SIGTERM')
      running.clear()
      acting.clear()
    }
  }
}
