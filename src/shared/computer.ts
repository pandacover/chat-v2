// Computer use: what the guard protects, how model coordinates map to the screen, and the
// events the on-screen overlay draws. Pure, so the main process and tests share it.

/** A top-level window, in z-order (frontmost first), with its bounds in physical screen pixels. */
export interface WindowInfo {
  hwnd: number
  pid: number
  /** Executable file name, e.g. "Resolve.exe". Empty when Windows won't say (protected processes). */
  exe: string
  title: string
  cls: string
  x: number
  y: number
  w: number
  h: number
  /** Ignores the mouse (overlays like ours); clicks land on whatever is below it. */
  clickThrough: boolean
}

export interface DesktopState {
  cursor: { x: number; y: number }
  foreground: number
  windows: WindowInfo[]
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

// --- The guard -----------------------------------------------------------------------------

export interface ProtectedApp {
  label: string
  /** Executable names, lower case, without ".exe". */
  exes: string[]
  /** Names as they appear in the Start menu, for refusing to open the app at all. */
  names: string[]
}

/**
 * Apps the assistant may never see or touch. Settings and security tools could switch the
 * guard off or leak secrets; terminals and the Run box would let it run anything; credential
 * prompts are where passkeys and Windows Hello ask for a fingerprint or PIN.
 */
export const PROTECTED_APPS: ProtectedApp[] = [
  { label: 'Windows Settings', exes: ['systemsettings', 'systemsettingsadminflows', 'systempropertiesadvanced', 'systempropertiescomputername', 'systempropertiesprotection', 'systempropertiesremote', 'useraccountcontrolsettings', 'msconfig'], names: ['settings', 'system configuration'] },
  { label: 'Control Panel', exes: ['control', 'rundll32'], names: ['control panel'] },
  { label: 'Windows Security', exes: ['sechealthui', 'securityhealthhost', 'securityhealthtray'], names: ['windows security'] },
  { label: 'Passkey and sign-in prompts', exes: ['credentialuibroker', 'credentialenrollmentmanager', 'consent', 'logonui', 'lockapp', 'webauthn', 'ngcpopkeysrv'], names: [] },
  { label: 'Admin tools', exes: ['mmc', 'regedit', 'taskmgr', 'gpedit', 'secpol', 'certmgr', 'resmon', 'perfmon', 'eventvwr', 'compmgmtlauncher'], names: ['registry editor', 'task manager', 'computer management', 'services', 'event viewer', 'windows tools', 'local security policy', 'credential manager'] },
  { label: 'Terminals', exes: ['cmd', 'powershell', 'pwsh', 'powershell_ise', 'windowsterminal', 'wt', 'openconsole', 'conhost', 'wsl', 'wslhost', 'bash', 'mintty', 'alacritty', 'wezterm-gui', 'hyper', 'tabby'], names: ['command prompt', 'windows powershell', 'powershell', 'terminal', 'windows terminal', 'git bash', 'ubuntu', 'wsl'] },
  { label: 'Start, search and quick settings', exes: ['startmenuexperiencehost', 'searchhost', 'searchapp', 'searchui', 'shellexperiencehost', 'shellhost', 'controlcenter'], names: ['run'] },
  { label: 'Password managers', exes: ['1password', 'bitwarden', 'keepass', 'keepassxc', 'lastpass', 'dashlane', 'nordpass', 'keeper', 'keeperpasswordmanager', 'enpass', 'proton pass', 'roboform', 'authy desktop', 'yubico authenticator', 'ykman'], names: ['1password', 'bitwarden', 'keepass', 'keepassxc', 'lastpass', 'dashlane', 'nordpass', 'keeper', 'enpass', 'proton pass', 'roboform', 'authy', 'yubico authenticator'] }
]

/**
 * Window titles that mark secret places inside otherwise allowed apps, mostly browser tabs:
 * password and passkey pages, browser settings, wallets and recovery codes.
 */
export const PROTECTED_TITLES: Array<{ label: string; pattern: RegExp }> = [
  { label: 'Passwords and passkeys', pattern: /\b(passwords?|passkeys?|password manager|credential manager|keychain|security keys?)\b/i },
  { label: 'Sign-in security', pattern: /\b(windows hello|windows security|authenticator|two-factor|2fa|recovery (codes?|keys?|phrase)|seed phrase|private key)\b/i },
  // A browser's settings tab is titled "Settings - <browser>". An app's own "Project Settings"
  // or "Preferences" dialog stays usable.
  { label: 'Settings pages', pattern: /^settings(\s*[-–—|:]|$)|\b(chrome|edge|brave|opera|vivaldi):\/\/|\babout:(preferences|logins)\b/i },
  { label: 'Run dialog', pattern: /^run$/i }
]

const exeKey = (exe: string) => exe.toLowerCase().replace(/\.exe$/, '')

export interface GuardContext {
  /** This app's process id: the chat window holds the Stop button, settings and API keys. */
  selfPid: number
  /** Extra apps or title words the user protected in Settings. */
  extra: string[]
}

/** Why a window is off limits, or null when the assistant may use it. */
export const protectedReason = (win: Pick<WindowInfo, 'pid' | 'exe' | 'title'>, ctx: GuardContext): string | null => {
  if (win.pid === ctx.selfPid) return 'chat-v2 itself'
  // Windows won't name some processes (system ones, mostly). What can't be named isn't touched.
  if (!win.exe.trim()) return 'an app Windows will not identify'
  const exe = exeKey(win.exe)
  for (const app of PROTECTED_APPS) if (exe && app.exes.includes(exe)) return app.label
  for (const { label, pattern } of PROTECTED_TITLES) if (pattern.test(win.title.trim())) return label
  const title = win.title.toLowerCase()
  for (const raw of ctx.extra) {
    const word = raw.trim().toLowerCase()
    if (word && (exe === exeKey(word) || title.includes(word))) return `${raw.trim()} (protected in Settings)`
  }
  return null
}

/** Why an app may not be opened by name, or null. Matches the Start menu name and its id. */
export const protectedAppName = (name: string, id: string, extra: string[]): string | null => {
  const n = name.trim().toLowerCase()
  const lowerId = id.toLowerCase()
  if (/immersivecontrolpanel|windowsterminal|\\(cmd|powershell|pwsh|regedit|mmc|taskmgr|control)\.exe$/.test(lowerId)) return 'a protected system app'
  for (const app of PROTECTED_APPS) {
    // "Developer Command Prompt for VS 2022" is still a command prompt; "Run" must match whole.
    if (app.names.some((p) => (p.length < 5 ? n === p : n.includes(p))) || app.exes.includes(exeKey(n))) return app.label
    if (app.exes.some((e) => lowerId.endsWith(`\\${e}.exe`))) return app.label
  }
  for (const { label, pattern } of PROTECTED_TITLES) if (pattern.test(name.trim())) return label
  for (const raw of extra) {
    const word = raw.trim().toLowerCase()
    if (word && n.includes(word)) return `${raw.trim()} (protected in Settings)`
  }
  return null
}

// --- Keys ----------------------------------------------------------------------------------

const VK: Record<string, number> = {
  backspace: 0x08, tab: 0x09, enter: 0x0d, return: 0x0d, shift: 0x10, ctrl: 0x11, control: 0x11, alt: 0x12, option: 0x12,
  pause: 0x13, capslock: 0x14, escape: 0x1b, esc: 0x1b, space: 0x20, pageup: 0x21, pagedown: 0x22, end: 0x23, home: 0x24,
  left: 0x25, arrowleft: 0x25, up: 0x26, arrowup: 0x26, right: 0x27, arrowright: 0x27, down: 0x28, arrowdown: 0x28,
  printscreen: 0x2c, insert: 0x2d, delete: 0x2e, del: 0x2e, win: 0x5b, meta: 0x5b, super: 0x5b, cmd: 0x5b, command: 0x5b,
  menu: 0x5d, contextmenu: 0x5d, plus: 0xbb, minus: 0xbd, comma: 0xbc, period: 0xbe
}
const PUNCT: Record<string, number> = { ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf, '`': 0xc0, '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde }

/** Virtual-key codes for a chord such as "Ctrl+Shift+S", modifiers first. Throws on an unknown key. */
export const parseKeys = (combo: string): number[] => {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean)
  // "Ctrl++" means Ctrl and the plus key.
  if (/\+\s*\+$/.test(combo)) parts.push('plus')
  if (parts.length === 0) throw new Error('No keys given')
  return parts.map((part) => {
    const k = part.toLowerCase()
    if (VK[k] !== undefined) return VK[k]
    if (/^f([1-9]|1[0-9]|2[0-4])$/.test(k)) return 0x6f + Number(k.slice(1))
    if (/^[a-z0-9]$/.test(k)) return k.toUpperCase().charCodeAt(0)
    if (PUNCT[part] !== undefined) return PUNCT[part]
    throw new Error(`Unknown key "${part}"`)
  })
}

/** Shortcuts that reach protected places directly (Run, Settings, Start search, lock, Task Manager). */
export const protectedChord = (vks: number[]): string | null => {
  const has = (vk: number) => vks.includes(vk)
  if (has(0x5b) || has(0x5c)) return 'Windows-key shortcuts open Start, Run and Settings'
  if (has(0x11) && has(0x12) && has(0x2e)) return 'Ctrl+Alt+Delete opens the security screen'
  if (has(0x11) && has(0x10) && has(0x1b)) return 'Ctrl+Shift+Esc opens Task Manager'
  if (has(0x11) && has(0x1b)) return 'Ctrl+Esc opens Start'
  return null
}

// --- Coordinates ---------------------------------------------------------------------------

/**
 * How a screenshot sent to the model lines up with the screen. The model works in screenshot
 * pixels; input goes in physical pixels; the overlay draws in DIPs relative to the display.
 */
export interface Frame {
  shotW: number
  shotH: number
  /** The display in physical pixels. */
  screenX: number
  screenY: number
  screenW: number
  screenH: number
  /** Physical pixels per DIP. */
  scale: number
}

/** The screenshot size for a screen: the long side at most `max`, aspect kept. */
export const fitShot = (w: number, h: number, maxW = 1280, maxH = 800) => {
  const k = Math.min(1, maxW / w, maxH / h)
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) }
}

export const makeFrame = (display: { x: number; y: number; w: number; h: number; scale: number }): Frame => {
  const shot = fitShot(display.w, display.h)
  return { shotW: shot.w, shotH: shot.h, screenX: display.x, screenY: display.y, screenW: display.w, screenH: display.h, scale: display.scale }
}

export const inShot = (f: Frame, x: number, y: number) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < f.shotW && y < f.shotH

export const toPhysical = (f: Frame, x: number, y: number) => ({
  x: Math.round(f.screenX + (x * f.screenW) / f.shotW),
  y: Math.round(f.screenY + (y * f.screenH) / f.shotH)
})

export const toShot = (f: Frame, x: number, y: number) => ({
  x: Math.round(((x - f.screenX) * f.shotW) / f.screenW),
  y: Math.round(((y - f.screenY) * f.shotH) / f.screenH)
})

/** Screenshot pixels to overlay DIPs. */
export const toOverlay = (f: Frame, x: number, y: number) => ({
  x: (x * f.screenW) / f.shotW / f.scale,
  y: (y * f.screenH) / f.shotH / f.scale
})

export const shotRect = (f: Frame, r: Rect): Rect => {
  const a = toShot(f, r.x, r.y)
  const b = toShot(f, r.x + r.w, r.y + r.h)
  return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }
}

const contains = (w: Rect, x: number, y: number) => x >= w.x && y >= w.y && x < w.x + w.w && y < w.y + w.h

/** The window that gets a click at a physical point: the frontmost one there that takes the mouse. */
export const windowAt = (windows: WindowInfo[], x: number, y: number): WindowInfo | null =>
  windows.find((w) => !w.clickThrough && contains(w, x, y)) ?? null

const intersect = (a: Rect, b: Rect): Rect | null => {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const r = Math.min(a.x + a.w, b.x + b.w)
  const btm = Math.min(a.y + a.h, b.y + b.h)
  return r > x && btm > y ? { x, y, w: r - x, h: btm - y } : null
}

/** `a` minus `cut`, as up to four rectangles. */
export const subtract = (a: Rect, cut: Rect): Rect[] => {
  const i = intersect(a, cut)
  if (!i) return [a]
  const out: Rect[] = []
  if (i.y > a.y) out.push({ x: a.x, y: a.y, w: a.w, h: i.y - a.y })
  if (i.y + i.h < a.y + a.h) out.push({ x: a.x, y: i.y + i.h, w: a.w, h: a.y + a.h - i.y - i.h })
  if (i.x > a.x) out.push({ x: a.x, y: i.y, w: i.x - a.x, h: i.h })
  if (i.x + i.w < a.x + a.w) out.push({ x: i.x + i.w, y: i.y, w: a.x + a.w - i.x - i.w, h: i.h })
  return out
}

export interface Hidden {
  window: WindowInfo
  reason: string
  /** The parts of it that show, in physical pixels. */
  parts: Rect[]
}

/**
 * The visible parts of protected windows, to be painted over before the model sees the screen.
 * Only what shows is covered, so a protected window behind a full-screen app hides nothing.
 */
export const hiddenRegions = (windows: WindowInfo[], reasonOf: (w: WindowInfo) => string | null, screen: Rect): Hidden[] => {
  const out: Hidden[] = []
  const above: Rect[] = []
  for (const w of windows) {
    if (w.clickThrough) continue
    const box = intersect(w, screen)
    if (!box) continue
    const reason = reasonOf(w)
    if (reason) {
      let parts = [box]
      for (const cover of above) parts = parts.flatMap((p) => subtract(p, cover))
      parts = parts.filter((p) => p.w > 0 && p.h > 0)
      if (parts.length) out.push({ window: w, reason, parts })
    }
    above.push(box)
  }
  return out
}

/**
 * A short name for a window's app, from its title: the part naming the exe ("DaVinci Resolve"
 * for Resolve.exe, wherever it sits), else the last part ("notes.txt - Notepad"), else the exe.
 */
export const appName = (w: Pick<WindowInfo, 'exe' | 'title'>): string => {
  const parts = w.title.split(/\s+[-–—|]\s+/).map((s) => s.trim()).filter(Boolean)
  const exe = w.exe.replace(/\.exe$/i, '')
  const named = exe.length > 2 ? parts.find((p) => p.length <= 40 && p.toLowerCase().includes(exe.toLowerCase())) : undefined
  if (named) return named
  const last = parts.length > 1 ? parts[parts.length - 1]! : ''
  if (last && last.length <= 40) return last
  return exe || w.title.slice(0, 40) || 'a window'
}

// --- Overlay -------------------------------------------------------------------------------

/** Colours the model can pick for marks; the overlay maps them to pens that read on any screen. */
export const MARK_COLORS = ['red', 'blue', 'green', 'yellow', 'black'] as const
export type MarkColor = (typeof MARK_COLORS)[number]

/** A mark on screen, in overlay DIPs. Each has an id that seeds its wobble, so it holds still. */
export type Mark =
  | { id: string; kind: 'circle' | 'box' | 'underline' | 'highlight'; x: number; y: number; w: number; h: number; color: MarkColor; label?: string }
  | { id: string; kind: 'arrow'; from: { x: number; y: number }; to: { x: number; y: number }; color: MarkColor; label?: string }
  | { id: string; kind: 'path'; points: Array<{ x: number; y: number }>; color: MarkColor; label?: string }
  | { id: string; kind: 'text'; x: number; y: number; text: string; color: MarkColor }

/** Main → overlay. */
export type OverlayEvent =
  /** The sketch cursor glides to a point (DIPs); `action` adds a click ripple or drag trail. */
  | { type: 'cursor'; x: number; y: number; label: string; action?: 'click' | 'double' | 'right' | 'drag' | 'scroll' | 'type' }
  /**
   * `working`: the assistant has the mouse. `done`: it finished and left marks. `idle`: computer
   * use is on but nothing is running; the sketch cursor keeps the user's company. `off`: gone.
   */
  | { type: 'status'; state: 'working' | 'done' | 'idle' | 'off'; label: string }
  /** Whether the sketch cursor follows the user's pointer when the assistant isn't driving it. */
  | { type: 'mode'; follow: boolean }
  /** A few words under the sketch cursor while the assistant thinks or reads, before it acts. */
  | { type: 'hint'; label: string }
  /** Where the user's pointer is (DIPs), or null when it's on another display. */
  | { type: 'pointer'; x: number; y: number }
  | { type: 'pointer'; x: null; y: null }
  | { type: 'marks'; marks: Mark[] }
  | { type: 'clear' }

/** Overlay → main. */
export type OverlayCommand = 'stop' | 'show-chat' | 'clear'
