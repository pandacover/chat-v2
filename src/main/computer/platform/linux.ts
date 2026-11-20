// Linux adapter (X11). It follows the same Platform contract as Windows and macOS using common
// command-line tools: xdotool (input), xprop and wmctrl (windows), ImageMagick `import`
// (screenshots), find and grep (file search) and xdg-open. Coordinates are X screen pixels.
// Wayland sessions aren't supported: X11 tools can't see or drive other apps there.
//
// Reading controls isn't implemented yet (`controls: false`), so ui_elements isn't offered; the
// element calls fail with a message that tells the model to use pixel clicks instead.
//
// Linux can't hide windows from screen capture, so chat-v2's windows can appear in screenshots.
// When chat-v2 is in front, a screenshot first brings the app the user was in back to the front.
//
// Debian/Ubuntu packages: xdotool x11-utils wmctrl imagemagick xdg-utils
import { type ChildProcess, spawn } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { readFile, readlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, extname, join, resolve as resolvePath } from 'node:path'
import type { FileHit, Platform, SearchQuery, WindowInfo } from './types'

/** Computer use needs an X11 display; Wayland sessions (even with XWayland's DISPLAY) are not supported. */
export const linuxSupported = (env: NodeJS.ProcessEnv = process.env) => {
  if (!env['DISPLAY']) return false
  const session = env['XDG_SESSION_TYPE']
  if (session === 'wayland') return false
  return !(env['WAYLAND_DISPLAY'] && session !== 'x11')
}

const NO_CONTROLS =
  "Reading controls isn't available on Linux yet. Use look_at_screen and click by pixel coordinates instead."

/** Characters per xdotool call when typing: cancel() takes effect between chunks. */
const TYPE_CHUNK = 24
/** Any tool call that runs longer than this is stopped and fails (searches have their own limits). */
const DEFAULT_TIMEOUT_MS = 15_000

const cancelledError = () => Object.assign(new Error('Cancelled'), { name: 'Cancelled' })
/** Errors that must surface instead of reading as "nothing found": a missing tool, or Stop. */
const isFatal = (e: unknown) => e instanceof Error && (e.name === 'Cancelled' || /is not installed/.test(e.message))
/** For lookups where a vanished window just means "skip it". */
const soft = (e: unknown): null => {
  if (isFatal(e)) throw e
  return null
}

/**
 * The environment for the tools. xdotool and xprop need a UTF-8 locale to handle non-ASCII text,
 * and a VM started from a service or a bare shell often has none.
 */
export const toolEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const locale = env['LC_ALL'] || env['LC_CTYPE'] || env['LANG'] || ''
  return /utf-?8/i.test(locale) ? env : { ...env, LC_ALL: 'C.UTF-8' }
}

// ---------------------------------------------------------------- parsers (exported for tests)

export interface XWindow {
  id: string
  title: string
  pid: number | null
  wmClass: string
  hidden: boolean
  /** A normal app window: not a panel, dock, desktop, splash, notification, or skip-taskbar window. */
  app: boolean
}

/** The text between the quotes of an xprop string value, with \" \\ and \ooo (octal bytes) decoded. */
export const xpropString = (raw: string) => {
  const m = /^"(.*)"$/s.exec(raw.trim())
  if (!m) return ''
  const bytes: number[] = []
  const s = m[1]!
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (c === '\\' && /^[0-7]{3}$/.test(s.slice(i + 1, i + 4))) {
      bytes.push(parseInt(s.slice(i + 1, i + 4), 8))
      i += 3
    } else if (c === '\\' && (s[i + 1] === '"' || s[i + 1] === '\\')) {
      bytes.push(s.charCodeAt(++i))
    } else {
      bytes.push(...Buffer.from(c, 'utf8'))
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

const NOT_APP_TYPES = /_NET_WM_WINDOW_TYPE_(DOCK|DESKTOP|SPLASH|NOTIFICATION|TOOLBAR|MENU|DROPDOWN_MENU|POPUP_MENU|TOOLTIP|COMBO|DND|UTILITY)\b/

/** Parse `xprop -id <id> _NET_WM_NAME WM_NAME WM_CLASS _NET_WM_PID _NET_WM_STATE _NET_WM_WINDOW_TYPE`. */
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
  const state = props.get('_NET_WM_STATE') ?? ''
  return {
    id,
    title,
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    wmClass: classes[1] ?? classes[0] ?? '',
    hidden: /_NET_WM_STATE_HIDDEN/.test(state),
    app: !NOT_APP_TYPES.test(props.get('_NET_WM_WINDOW_TYPE') ?? '') && !/_NET_WM_STATE_SKIP_TASKBAR/.test(state)
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
  enter: 'Return', return: 'Return', tab: 'Tab', space: 'space', spacebar: 'space',
  backspace: 'BackSpace', bksp: 'BackSpace', delete: 'Delete', del: 'Delete',
  esc: 'Escape', escape: 'Escape', insert: 'Insert', ins: 'Insert', home: 'Home', end: 'End',
  pageup: 'Page_Up', pgup: 'Page_Up', page_up: 'Page_Up', prior: 'Page_Up',
  pagedown: 'Page_Down', pgdn: 'Page_Down', pgdown: 'Page_Down', page_down: 'Page_Down', next: 'Page_Down',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right',
  menu: 'Menu', contextmenu: 'Menu', apps: 'Menu', printscreen: 'Print', prtsc: 'Print', print: 'Print',
  capslock: 'Caps_Lock', numlock: 'Num_Lock', scrolllock: 'Scroll_Lock', pause: 'Pause', break: 'Pause',
  plus: 'plus', minus: 'minus', comma: 'comma', period: 'period', dot: 'period', slash: 'slash',
  backslash: 'backslash', semicolon: 'semicolon', equal: 'equal', equals: 'equal', quote: 'apostrophe',
  apostrophe: 'apostrophe', backquote: 'grave', backtick: 'grave', grave: 'grave',
  bracketleft: 'bracketleft', bracketright: 'bracketright'
}
/** Single punctuation characters as X keysym names (xdotool can't take most of them literally). */
const PUNCT: Record<string, string> = {
  '/': 'slash', ',': 'comma', ';': 'semicolon', '=': 'equal', '[': 'bracketleft', ']': 'bracketright', '-': 'minus',
  '.': 'period', "'": 'apostrophe', '`': 'grave', '\\': 'backslash', '+': 'plus', '*': 'asterisk', '!': 'exclam',
  '@': 'at', '#': 'numbersign', $: 'dollar', '%': 'percent', '^': 'asciicircum', '&': 'ampersand',
  '(': 'parenleft', ')': 'parenright', _: 'underscore', '{': 'braceleft', '}': 'braceright', '|': 'bar',
  ':': 'colon', '"': 'quotedbl', '<': 'less', '>': 'greater', '?': 'question', '~': 'asciitilde'
}
const MODS: Record<string, string> = {
  ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', opt: 'alt', shift: 'shift',
  win: 'super', windows: 'super', super: 'super', cmd: 'super', command: 'super', meta: 'super'
}

const unicodeKey = (c: string) => `U${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`

/** One key of a chord as an xdotool name. `strict`: unknown words are an error instead of passed through. */
const keyName = (k: string, last: boolean, strict: boolean): string => {
  const lower = k.toLowerCase()
  if (!last && MODS[lower]) return MODS[lower]!
  if (KEYSYMS[lower]) return KEYSYMS[lower]!
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase()
  if (MODS[lower]) return MODS[lower]! // a lone modifier press, e.g. "super"
  const chars = Array.from(k)
  if (chars.length === 1) {
    if (PUNCT[k]) return PUNCT[k]!
    if (/^[a-z0-9]$/i.test(k)) return lower
    return unicodeKey(k)
  }
  if (strict) throw new Error(`Unknown key "${k}"`)
  // Other words are passed on as X keysym names (e.g. XF86AudioPlay); xdotool rejects unknown ones.
  return k
}

const chord = (s: string, strict: boolean): string => {
  // "ctrl++" and "+" press the plus key.
  const parts = s === '+' ? ['+'] : s.endsWith('++') ? [...s.slice(0, -2).split('+'), '+'] : s.split('+')
  if (parts.some((p) => !p)) throw new Error(`Can't read the key combination "${s}"`)
  return parts.map((p, i) => keyName(p, i === parts.length - 1, strict)).join('+')
}

/**
 * A key combination as xdotool key chords: "ctrl+shift+t" → ["ctrl+shift+t"], "win+d" → ["super+d"],
 * "enter" → ["Return"], "ctrl+/" → ["ctrl+slash"]. Spaces separate a sequence ("ctrl+k ctrl+s")
 * when every part is a known key; otherwise they're part of a key name ("page down").
 */
export const toXdotoolKeys = (combo: string): string[] => {
  const raw = combo.trim().replace(/\s*\+\s*/g, '+')
  if (!raw) throw new Error('No key given')
  const tokens = raw.split(/\s+/)
  if (tokens.length > 1) {
    try {
      return tokens.map((t) => chord(t, true))
    } catch {
      // Not a sequence: "page down" is one key.
    }
  }
  return [chord(tokens.join(''), false)]
}

/**
 * Text to type, split into ASCII runs xdotool types as text and runs of non-ASCII characters sent
 * as key presses (Unicode keysyms). xdotool types capital non-ASCII letters in lower case, so those
 * get Shift; and typing non-ASCII text next to such keys can drop characters while the app catches
 * up with the keyboard remapping, so every non-ASCII character goes the same way. Runs are split
 * into chunks so cancel() can take effect between them.
 */
export const typeSegments = (text: string): Array<{ text: string } | { keys: string[] }> => {
  const out: Array<{ text: string } | { keys: string[] }> = []
  let ascii: string[] = []
  let keys: string[] = []
  const flushAscii = () => {
    for (let i = 0; i < ascii.length; i += TYPE_CHUNK) out.push({ text: ascii.slice(i, i + TYPE_CHUNK).join('') })
    ascii = []
  }
  const flushKeys = () => {
    for (let i = 0; i < keys.length; i += TYPE_CHUNK) out.push({ keys: keys.slice(i, i + TYPE_CHUNK) })
    keys = []
  }
  for (const c of Array.from(text)) {
    if (c.codePointAt(0)! > 0x7f) {
      flushAscii()
      keys.push(`${c !== c.toLowerCase() ? 'shift+' : ''}${unicodeKey(c)}`)
    } else {
      flushKeys()
      ascii.push(c)
    }
  }
  flushAscii()
  flushKeys()
  return out
}

/** The user's home folder: $HOME when set, as on any Linux login. */
const home = () => process.env['HOME'] || homedir()

/** Escape glob characters so find's -iname matches the words literally. */
const globWord = (s: string) => s.replace(/[[\]*?\\]/g, '\\$&')

/**
 * Arguments for GNU find: matching files and folders under `root`, skipping dot-folders and
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

/** Complete lines of find output: when find was cut off, the last line may be half a path. */
export const completeLines = (out: string) => {
  const lines = out.split('\n')
  lines.pop() // after the final newline: empty, or a cut-off line
  return lines
}

// ---------------------------------------------------------------- apps (.desktop entries)

export interface DesktopApp {
  id: string
  name: string
  exec: string[]
}

/** Split a .desktop Exec line into arguments, dropping field codes like %U. */
export const parseExec = (exec: string): string[] => {
  const args: string[] = []
  for (const m of exec.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
    const a = m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]!
    if (/^%[a-zA-Z]$/.test(a)) continue
    args.push(a.replace(/%%/g, '%'))
  }
  return args
}

/** Parse a .desktop file; null unless it's a visible application with an Exec line. */
export const parseDesktopEntry = (id: string, text: string): DesktopApp | null => {
  let inEntry = false
  const kv = new Map<string, string>()
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t.startsWith('[')) {
      inEntry = t === '[Desktop Entry]'
      continue
    }
    const m = /^([A-Za-z0-9-]+)\s*=\s*(.*)$/.exec(t)
    if (inEntry && m && !kv.has(m[1]!)) kv.set(m[1]!, m[2]!)
  }
  if (kv.get('Type') !== 'Application' || kv.get('NoDisplay') === 'true' || kv.get('Hidden') === 'true') return null
  const exec = parseExec(kv.get('Exec') ?? '')
  if (!exec.length) return null
  return { id, name: kv.get('Name') ?? id, exec }
}

const appDirs = () => {
  const dataHome = process.env['XDG_DATA_HOME'] || join(home(), '.local/share')
  const dataDirs = (process.env['XDG_DATA_DIRS'] || '/usr/local/share:/usr/share').split(':')
  return [dataHome, ...dataDirs, '/var/lib/flatpak/exports/share'].map((d) => join(d, 'applications'))
}

/** The installed app whose name or desktop id matches, e.g. "Text Editor" or "firefox-esr". */
const findDesktopApp = (name: string): DesktopApp | null => {
  const needle = name.toLowerCase()
  const apps: DesktopApp[] = []
  for (const dir of appDirs()) {
    let files: string[] = []
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.desktop'))
    } catch {
      continue
    }
    for (const f of files) {
      try {
        const app = parseDesktopEntry(f.slice(0, -'.desktop'.length), readFileSync(join(dir, f), 'utf8'))
        if (app) apps.push(app)
      } catch {
        // unreadable entry: skip
      }
    }
  }
  const lastId = (a: DesktopApp) => a.id.toLowerCase().split('.').pop()
  return (
    apps.find((a) => a.name.toLowerCase() === needle) ??
    apps.find((a) => a.id.toLowerCase() === needle || lastId(a) === needle) ??
    apps.find((a) => a.name.toLowerCase().startsWith(needle)) ??
    null
  )
}

/** A command on PATH, tried as given and in lower case. */
const findCommand = (name: string): string | null => {
  for (const candidate of [name, name.toLowerCase()]) {
    for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
      if (!dir) continue
      const p = join(dir, candidate)
      try {
        accessSync(p, constants.X_OK)
        if (statSync(p).isFile()) return p
      } catch {
        // not here
      }
    }
  }
  return null
}

const looksLikeTarget = (t: string) => /^(\/|~(\/|$)|\.{1,2}\/|[a-z][a-z0-9+.-]*:)/i.test(t)
const expandHome = (p: string) => p.replace(/^~(?=\/|$)/, home())

// ---------------------------------------------------------------- process helpers

interface RunOpts {
  input?: string
  /** Stop after this many ms (default DEFAULT_TIMEOUT_MS). */
  timeoutMs?: number
  /** On timeout, resolve with what was printed so far instead of failing (find). */
  partialOnTimeout?: boolean
  /** Exit codes that still count as success (grep exits 1 for "no match"). */
  okCodes?: number[]
  /** Fail when stderr matches, even on exit code 0 (xdotool ignores unknown key names). */
  failOnStderr?: RegExp
  /** cancel() kills it at once (drags, scrolls, searches). Key presses are never killed. */
  killable?: boolean
}

/** `ownerPid` is chat-v2's main process: its windows are never targets. */
export const makeLinuxPlatform = (opts: { ownerPid: number; track?: (p: ChildProcess) => void }): Platform => {
  const track = opts.track ?? (() => {})
  const env = toolEnv()
  const running = new Set<ChildProcess>()
  /** Processes cancel() and dispose() may kill. */
  const killable = new Set<ChildProcess>()
  let cancelGen = 0
  let dragging = false

  const runBuf = (cmd: string, args: string[], o: RunOpts = {}): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const gen = cancelGen
      let p: ChildProcess
      try {
        p = spawn(cmd, args, { stdio: [o.input ? 'pipe' : 'ignore', 'pipe', 'pipe'], env })
      } catch (e) {
        reject(e as Error)
        return
      }
      track(p)
      running.add(p)
      if (o.killable) killable.add(p)
      const out: Buffer[] = []
      let err = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        p.kill('SIGTERM')
      }, o.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      const done = () => {
        clearTimeout(timer)
        running.delete(p)
        killable.delete(p)
      }
      p.stdout!.on('data', (d: Buffer) => out.push(d))
      p.stderr!.setEncoding('utf8').on('data', (d: string) => {
        if (err.length < 4096) err += d
      })
      p.on('error', (e: NodeJS.ErrnoException) => {
        done()
        reject(e.code === 'ENOENT' ? new Error(`${cmd} is not installed (needed for computer use on Linux)`) : e)
      })
      p.on('close', (code) => {
        done()
        if (gen !== cancelGen) return reject(cancelledError())
        if (timedOut) return o.partialOnTimeout ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} timed out`))
        if (o.failOnStderr?.test(err)) return reject(new Error(err.trim()))
        if (code === 0 || (code !== null && o.okCodes?.includes(code))) return resolve(Buffer.concat(out))
        reject(new Error(err.trim() || `${cmd} exited with ${code}`))
      })
      if (o.input) p.stdin!.end(o.input)
    })

  const run = async (cmd: string, args: string[], o: RunOpts = {}) => (await runBuf(cmd, args, o)).toString('utf8').trim()

  /**
   * xdotool commands that move the pointer and let apps see it arrive. (Not `mousemove --sync`:
   * it waits for the pointer to move, so it never returns when the pointer is already there.)
   */
  const moveTo = (x: number, y: number) => ['mousemove', String(Math.max(0, Math.round(x))), String(Math.max(0, Math.round(y))), 'sleep', '0.05']

  /**
   * An input action. It rejects with "Cancelled" if cancel() runs meanwhile. Drags and scrolls are
   * also stopped at once; key presses aren't, because killing xdotool between a key's press and
   * release leaves that key held down.
   */
  const act = (args: string[], o: RunOpts = {}) => run('xdotool', args, o)

  // ---------------------------------------------------------------- windows

  const describe = async (id: string): Promise<XWindow> =>
    parseXprop(id, await run('xprop', ['-id', id, '_NET_WM_NAME', 'WM_NAME', 'WM_CLASS', '_NET_WM_PID', '_NET_WM_STATE', '_NET_WM_WINDOW_TYPE']))

  const processName = async (w: XWindow) => {
    if (w.pid) {
      // The executable's name; /proc/<pid>/comm is cut at 15 characters.
      const exe = await readlink(`/proc/${w.pid}/exe`).catch(() => '')
      if (exe) return basename(exe.replace(/ \(deleted\)$/, ''))
      const comm = await readFile(`/proc/${w.pid}/comm`, 'utf8').catch(() => '')
      if (comm.trim()) return comm.trim()
    }
    return w.wmClass || 'unknown'
  }

  const info = async (w: XWindow | null): Promise<WindowInfo> => (w ? { title: w.title, process: await processName(w) } : { title: '', process: '' })

  const own = (w: XWindow) => w.pid === opts.ownerPid

  /** The active window's id. A missing property means none; a missing xprop is an error. */
  const activeId = async () => parseWindowIds(await run('xprop', ['-root', '_NET_ACTIVE_WINDOW']))[0] ?? null

  /** Top-level windows, bottom to top. */
  const stacking = async () => parseWindowIds(await run('xprop', ['-root', '_NET_CLIENT_LIST_STACKING']))

  const active = async () => {
    const id = await activeId()
    return id ? describe(id).catch(soft) : null
  }

  /** App windows that aren't chat-v2's, topmost first. */
  const appWindows = async () => {
    const ws: XWindow[] = []
    for (const id of (await stacking()).reverse()) {
      const w = await describe(id).catch(soft)
      if (w && w.app && !own(w)) ws.push(w)
    }
    return ws
  }

  /** The topmost visible app window that isn't chat-v2's: the app the user was in before. */
  const appBelow = async () => (await appWindows()).find((w) => !w.hidden) ?? null

  let remembered: XWindow | null = null

  /** The remembered app if its window still exists, else the next app down. */
  const rememberedOrBelow = async () => {
    const r = remembered ? await describe(remembered.id).catch(soft) : null
    remembered = r && r.app && !own(r) ? r : await appBelow()
    return remembered
  }

  /** Bring a window to the front; false if the window manager didn't give it focus. */
  const activate = async (id: string) => {
    await run('wmctrl', ['-i', '-a', id])
    for (let i = 0; i < 20; i++) {
      if ((await activeId()) === id) return true
      await new Promise((r) => setTimeout(r, 50))
    }
    return false
  }

  /** If chat-v2 (or nothing) is in front, bring the app the user was in back. */
  const bringBack = async (): Promise<XWindow | null> => {
    const w = await active()
    if (w && !own(w)) return w
    const r = await rememberedOrBelow()
    // No app window at all: nothing to bring back.
    if (!r) return null
    if (!(await activate(r.id))) throw new Error(`Couldn't bring "${r.title || r.wmClass}" to the front.`)
    return r
  }

  const target = async (): Promise<WindowInfo> => {
    const w = await active()
    if (w && own(w)) return info(await rememberedOrBelow())
    return info(w)
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
      if (!/is not installed/.test((e as Error).message)) throw e
    }
    // ImageMagick 7 without the legacy commands.
    try {
      return await runBuf('magick', ['import', ...args])
    } catch (e) {
      if (/is not installed/.test((e as Error).message)) {
        throw new Error('ImageMagick is not installed (its import command takes screenshots for computer use on Linux)')
      }
      throw e
    }
  }

  // ---------------------------------------------------------------- files and apps

  const grepFiles = async (paths: string[], text: string) => {
    const hits = new Set<string>()
    for (let i = 0; i < paths.length; i += 200) {
      const out = await run('grep', ['-l', '-i', '-F', '-I', '-s', '--', text, ...paths.slice(i, i + 200)], {
        okCodes: [1, 2],
        timeoutMs: 10_000,
        partialOnTimeout: true,
        killable: true
      })
      for (const p of out.split('\n')) if (p) hits.add(p)
    }
    return hits
  }

  /**
   * Start a program that keeps running after this call. Fails if it can't start, or if it exits
   * with an error within `waitMs` (xdg-open does that for a missing file or no handler). Its output
   * isn't piped: the app it starts inherits those streams and would die writing to a closed pipe.
   */
  const launch = (cmd: string, args: string[], waitMs = 0) =>
    new Promise<void>((resolve, reject) => {
      const p = spawn(cmd, args, { detached: true, stdio: 'ignore', env })
      let settled = false
      const finish = (f: () => void) => {
        if (settled) return
        settled = true
        p.unref()
        f()
      }
      p.once('error', (e: NodeJS.ErrnoException) =>
        finish(() => reject(e.code === 'ENOENT' ? new Error(`Nothing called "${cmd}" is installed`) : e))
      )
      p.once('spawn', () => {
        if (!waitMs) return finish(resolve)
        setTimeout(() => finish(resolve), waitMs)
      })
      p.once('exit', (code) => {
        if (code) finish(() => reject(new Error(`${cmd} ${args.join(' ')} failed (exit code ${code})`)))
        else finish(resolve)
      })
    })

  const xdgOpen = (target: string) => launch('xdg-open', [target], 1500)

  return {
    name: 'linux',
    controls: false,
    remember: async () => {
      const w = await active()
      if (w && !own(w)) remembered = w
      else await rememberedOrBelow()
      return w && !own(w) ? info(w) : info(remembered)
    },
    restoreFocus: async () => info(await bringBack()),
    foreground: target,
    windows: async () => {
      const ws = (await appWindows()).slice(0, 40)
      return Promise.all(ws.map(async (w) => ({ ...(await info(w)), ...(w.hidden ? { minimized: true } : {}) })))
    },
    focusWindow: async (title) => {
      const needle = title.trim().toLowerCase()
      if (!needle) throw new Error('Give the window title or app name to focus')
      for (const w of await appWindows()) {
        const proc = (await processName(w)).toLowerCase()
        if (proc === needle || w.wmClass.toLowerCase() === needle || w.title.toLowerCase().includes(needle)) {
          if (!(await activate(w.id))) throw new Error(`Couldn't bring "${w.title || w.wmClass}" to the front.`)
          remembered = w
          return info(w)
        }
      }
      throw new Error(`No open window matches ${title}`)
    },
    screenshot: async (maxWidth) => {
      // chat-v2 can't be hidden from capture on Linux: show the app the user was in instead of the chat.
      const front = await active()
      if (front && own(front) && (await rememberedOrBelow())) {
        // If the app won't come forward, still take the screenshot.
        if (await bringBack().catch(soft)) await new Promise((r) => setTimeout(r, 150))
      }
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
        args.push('sleep', '0.02', 'mousemove', String(Math.max(0, Math.round(x1 + ((x2 - x1) * s) / 12))), String(Math.max(0, Math.round(y1 + ((y2 - y1) * s) / 12))))
      }
      args.push('sleep', '0.05', 'mouseup', '1')
      dragging = true
      try {
        await act(args, { killable: true })
      } catch (e) {
        // Never leave the button held down.
        await run('xdotool', ['mouseup', '1']).catch(() => undefined)
        throw e
      } finally {
        dragging = false
      }
    },
    scroll: async (x, y, dy, dx) => {
      const args = moveTo(x, y)
      // X11 wheel buttons: 4 up, 5 down, 6 left, 7 right. One notch per unit, like Windows.
      const v = Math.round(dy)
      const h = Math.round(dx)
      if (v) args.push('click', '--repeat', String(Math.abs(v)), '--delay', '30', v > 0 ? '5' : '4')
      if (h) args.push('click', '--repeat', String(Math.abs(h)), '--delay', '30', h > 0 ? '7' : '6')
      await act(args, { killable: true })
    },
    type: async (text) => {
      // In short chunks, so cancel() takes effect between them without cutting a key press short.
      for (const seg of typeSegments(text)) {
        // Each non-ASCII key is mapped onto a spare keycode just for its press. One xdotool call per
        // run, without --clearmodifiers and with a delay, is what kept every character (tested).
        if ('keys' in seg) await act(['key', '--delay', '80', ...seg.keys, 'sleep', '0.05'])
        else await act(['type', '--clearmodifiers', '--delay', '12', '--', seg.text])
      }
    },
    keys: async (combo) => void (await act(['key', '--clearmodifiers', ...toXdotoolKeys(combo)], { failOnStderr: /No such key name/i })),
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
      const out = (await runBuf('find', buildFindArgs(q), { timeoutMs: 8_000, partialOnTimeout: true, okCodes: [1], killable: true })).toString('utf8')
      let hits = completeLines(out)
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
      if (!t) throw new Error('Nothing to open')
      if (looksLikeTarget(t)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^file:/i.test(t)) return xdgOpen(t)
        const path = /^file:/i.test(t) ? decodeURIComponent(new URL(t).pathname) : resolvePath(expandHome(t))
        if (!existsSync(path)) throw new Error(`There's no file or folder at ${path}`)
        return xdgOpen(path)
      }
      // An app, by its name ("Text Editor") or command name ("firefox"). Never with arguments:
      // a command line here would run without the approval shell commands need.
      const app = findDesktopApp(t)
      if (app) return launch(app.exec[0]!, app.exec.slice(1))
      if (/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(t)) {
        const cmd = findCommand(t)
        if (cmd) return launch(cmd, [])
        throw new Error(`No app called "${t}" is installed`)
      }
      throw new Error(`Open an app by its name or command name only, e.g. "firefox"; "${t}" isn't one.`)
    },
    reveal: async (path) => {
      const p = resolvePath(expandHome(path))
      if (!existsSync(p)) throw new Error(`There's no file or folder at ${p}`)
      // No standard "select this file" on Linux: open the folder (or the folder it's in).
      return xdgOpen(statSync(p).isDirectory() ? p : dirname(p))
    },
    cancel: async () => {
      cancelGen++
      for (const p of killable) p.kill('SIGTERM')
      // An interrupted drag must not leave the button held down. (Leave it alone otherwise: the
      // user may be holding it.)
      if (dragging) await run('xdotool', ['mouseup', '1']).catch(() => undefined)
    },
    dispose: () => {
      // Key presses in flight finish on their own (each is a short chunk), so no key is left held.
      for (const p of killable) p.kill('SIGTERM')
      killable.clear()
    }
  }
}
