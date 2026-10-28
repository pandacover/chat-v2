// Computer use: what the guard protects, how model coordinates map to the screen, and the
// events the on-screen overlay draws. Pure, so the main process and tests share it.

/** A top-level window, in z-order (frontmost first), with its bounds in physical screen pixels. */
export interface WindowInfo {
  hwnd: number
  pid: number
  /**
   * Executable file name on Windows, e.g. "Resolve.exe"; the app's name on macOS, e.g. "DaVinci
   * Resolve". Empty when the system won't say (protected processes).
   */
  exe: string
  /** The app's bundle identifier on macOS, e.g. "com.apple.Terminal". */
  bundle?: string
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

/** The systems computer use runs on; each has its own list of protected apps. */
export type DesktopOs = 'win32' | 'darwin'

export interface ProtectedApp {
  label: string
  /** Where the entry applies. */
  os: DesktopOs | 'any'
  /** Executable names (macOS: app names), lower case, without ".exe". */
  exes: string[]
  /** Names as they appear in the Start menu or Applications, for refusing to open the app at all. */
  names: string[]
  /** macOS bundle identifiers, lower case. */
  bundles?: string[]
}

/**
 * Apps the assistant may never see or touch. Settings and security tools could switch the
 * guard off or leak secrets; terminals, script tools and the Run box would let it run anything;
 * credential prompts are where passkeys, Windows Hello and Touch ID ask for a fingerprint or PIN.
 */
export const PROTECTED_APPS: ProtectedApp[] = [
  { label: 'Windows Settings', os: 'win32', exes: ['systemsettings', 'systemsettingsadminflows', 'systempropertiesadvanced', 'systempropertiescomputername', 'systempropertiesprotection', 'systempropertiesremote', 'useraccountcontrolsettings', 'msconfig'], names: ['settings', 'system configuration'] },
  { label: 'Control Panel', os: 'win32', exes: ['control', 'rundll32'], names: ['control panel'] },
  { label: 'Windows Security', os: 'win32', exes: ['sechealthui', 'securityhealthhost', 'securityhealthtray'], names: ['windows security'] },
  { label: 'Passkey and sign-in prompts', os: 'win32', exes: ['credentialuibroker', 'credentialenrollmentmanager', 'consent', 'logonui', 'lockapp', 'webauthn', 'ngcpopkeysrv'], names: [] },
  { label: 'Admin tools', os: 'win32', exes: ['mmc', 'regedit', 'taskmgr', 'gpedit', 'secpol', 'certmgr', 'resmon', 'perfmon', 'eventvwr', 'compmgmtlauncher'], names: ['registry editor', 'task manager', 'computer management', 'services', 'event viewer', 'windows tools', 'local security policy', 'credential manager'] },
  { label: 'Terminals', os: 'win32', exes: ['cmd', 'powershell', 'pwsh', 'powershell_ise', 'windowsterminal', 'wt', 'openconsole', 'conhost', 'wsl', 'wslhost', 'bash', 'mintty', 'alacritty', 'wezterm-gui', 'hyper', 'tabby'], names: ['command prompt', 'windows powershell', 'powershell', 'terminal', 'windows terminal', 'git bash', 'ubuntu', 'wsl'] },
  { label: 'Start, search and quick settings', os: 'win32', exes: ['startmenuexperiencehost', 'searchhost', 'searchapp', 'searchui', 'shellexperiencehost', 'shellhost', 'controlcenter'], names: ['run'] },
  { label: 'Password managers', os: 'any', exes: ['1password', 'bitwarden', 'keepass', 'keepassxc', 'lastpass', 'dashlane', 'nordpass', 'keeper', 'keeperpasswordmanager', 'enpass', 'proton pass', 'roboform', 'authy desktop', 'yubico authenticator', 'ykman'], names: ['1password', 'bitwarden', 'keepass', 'keepassxc', 'lastpass', 'dashlane', 'nordpass', 'keeper', 'enpass', 'proton pass', 'roboform', 'authy', 'yubico authenticator'], bundles: ['com.1password.1password', 'com.agilebits.onepassword7', 'com.bitwarden.desktop', 'org.keepassxc.keepassxc', 'com.lastpass.lastpassmacdesktop', 'com.dashlane.dashlanephonefinal', 'me.proton.pass.electron'] },
  { label: 'System Settings', os: 'darwin', exes: ['system settings', 'system preferences'], names: ['system settings', 'system preferences'], bundles: ['com.apple.systempreferences', 'com.apple.settings'] },
  { label: 'Keychain and Passwords', os: 'darwin', exes: ['keychain access', 'passwords'], names: ['keychain access', 'passwords'], bundles: ['com.apple.keychainaccess', 'com.apple.passwords'] },
  { label: 'Password and Touch ID prompts', os: 'darwin', exes: ['securityagent', 'coreautha', 'universalaccessauthwarn', 'loginwindow', 'screensaverengine', 'coreservicesuiagent'], names: [], bundles: ['com.apple.securityagent', 'com.apple.localauthentication.uiagent', 'com.apple.loginwindow', 'com.apple.screensaver.engine'] },
  { label: 'Admin and script tools', os: 'darwin', exes: ['activity monitor', 'disk utility', 'directory utility', 'console', 'script editor', 'automator', 'shortcuts'], names: ['activity monitor', 'disk utility', 'directory utility', 'console', 'script editor', 'automator', 'shortcuts'], bundles: ['com.apple.activitymonitor', 'com.apple.diskutility', 'com.apple.scripteditor2', 'com.apple.automator', 'com.apple.shortcuts'] },
  { label: 'Terminals', os: 'darwin', exes: ['terminal', 'iterm2', 'iterm', 'warp', 'ghostty', 'kitty', 'alacritty', 'wezterm', 'wezterm-gui', 'hyper', 'tabby'], names: ['terminal', 'iterm', 'warp', 'ghostty', 'kitty', 'alacritty', 'wezterm', 'hyper', 'tabby'], bundles: ['com.apple.terminal', 'com.googlecode.iterm2', 'dev.warp.warp-stable', 'com.mitchellh.ghostty', 'net.kovidgoyal.kitty', 'org.alacritty', 'com.github.wez.wezterm', 'co.zeit.hyper'] },
  { label: 'Spotlight and Control Center', os: 'darwin', exes: ['spotlight', 'control center', 'notification center', 'controlcenter', 'notificationcenter'], names: ['spotlight'], bundles: ['com.apple.spotlight', 'com.apple.controlcenter', 'com.apple.notificationcenterui'] }
]

/** The protected apps that apply on a system. */
export const protectedAppsFor = (os: DesktopOs) => PROTECTED_APPS.filter((a) => a.os === 'any' || a.os === os)

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
  /** Defaults to Windows. */
  os?: DesktopOs
}

/** Why a window is off limits, or null when the assistant may use it. */
export const protectedReason = (win: Pick<WindowInfo, 'pid' | 'exe' | 'title' | 'bundle'>, ctx: GuardContext): string | null => {
  if (win.pid === ctx.selfPid) return 'chat-v2 itself'
  // The system won't name some processes (system ones, mostly). What can't be named isn't touched.
  if (!win.exe.trim()) return 'an app the system will not identify'
  const exe = exeKey(win.exe)
  const bundle = win.bundle?.toLowerCase() ?? ''
  for (const app of protectedAppsFor(ctx.os ?? 'win32')) {
    if (app.exes.includes(exe) || (bundle && app.bundles?.includes(bundle))) return app.label
  }
  for (const { label, pattern } of PROTECTED_TITLES) if (pattern.test(win.title.trim())) return label
  const title = win.title.toLowerCase()
  for (const raw of ctx.extra) {
    const word = raw.trim().toLowerCase()
    if (word && (exe === exeKey(word) || title.includes(word))) return `${raw.trim()} (protected in Settings)`
  }
  return null
}

/**
 * Why an app may not be opened by name, or null. Matches the Start menu name and its id, or on
 * macOS the app's name and path.
 */
export const protectedAppName = (name: string, id: string, extra: string[], os: DesktopOs = 'win32'): string | null => {
  const n = name.trim().toLowerCase()
  const lowerId = id.toLowerCase()
  if (/immersivecontrolpanel|windowsterminal|\\(cmd|powershell|pwsh|regedit|mmc|taskmgr|control)\.exe$/.test(lowerId)) return 'a protected system app'
  for (const app of protectedAppsFor(os)) {
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

/**
 * Shortcuts that reach protected places directly: Run, Settings, Start search, lock and Task
 * Manager on Windows; Spotlight, Force Quit and lock on macOS, where Cmd (0x5b) is the everyday
 * modifier rather than the Windows key.
 */
export const protectedChord = (vks: number[], os: DesktopOs = 'win32'): string | null => {
  const has = (vk: number) => vks.includes(vk)
  if (os === 'darwin') {
    if (has(0x5b) && has(0x20)) return 'Cmd+Space opens Spotlight, which can open anything'
    if (has(0x11) && has(0x20)) return 'Ctrl+Space switches input sources'
    if (has(0x5b) && has(0x12) && has(0x1b)) return 'Cmd+Option+Esc opens Force Quit'
    if (has(0x11) && has(0x5b) && has(0x51)) return 'Ctrl+Cmd+Q locks the screen'
    return null
  }
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

// --- What an action changed ----------------------------------------------------------------

/**
 * Where two screenshots of the same size differ, as a grid of cells over them (see
 * ScreenPort.diff). The model keeps only its newest screenshot, so it can't compare one with the
 * one before: this is how it hears whether an action did anything, and where.
 */
export interface ShotDiff {
  /** The screenshots' size, in their pixels. */
  w: number
  h: number
  /** Cell size, in screenshot pixels. */
  cell: number
  cols: number
  rows: number
  /** One flag per cell, row by row: 1 where it changed. */
  changed: Uint8Array
}

const cellRect = (d: ShotDiff, i: number): Rect => {
  const x = (i % d.cols) * d.cell
  const y = Math.floor(i / d.cols) * d.cell
  return { x, y, w: Math.min(d.cell, d.w - x), h: Math.min(d.cell, d.h - y) }
}
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** The diff without the cells under `ignore` (the user's own pointer, which moves on its own). */
export const ignoreCells = (d: ShotDiff, ignore: Rect[]): ShotDiff => {
  if (!ignore.length) return d
  const changed = d.changed.slice()
  for (let i = 0; i < changed.length; i++) if (changed[i] && ignore.some((r) => overlaps(cellRect(d, i), r))) changed[i] = 0
  return { ...d, changed }
}

/** Whether anything changed within `radius` screenshot pixels of a point. */
export const changedNear = (d: ShotDiff, x: number, y: number, radius: number) => {
  const box = { x: x - radius, y: y - radius, w: radius * 2, h: radius * 2 }
  for (let i = 0; i < d.changed.length; i++) if (d.changed[i] && overlaps(cellRect(d, i), box)) return true
  return false
}

/** The share of the screenshot that changed, 0 to 1. */
export const changedShare = (d: ShotDiff) => {
  let n = 0
  for (const c of d.changed) n += c
  return d.changed.length ? n / d.changed.length : 0
}

/** The changed areas: bounding boxes of cells that touch (corners count), largest first. */
export const changedRegions = (d: ShotDiff): Rect[] => {
  const seen = new Uint8Array(d.changed.length)
  const out: Array<Rect & { cells: number }> = []
  for (let start = 0; start < d.changed.length; start++) {
    if (!d.changed[start] || seen[start]) continue
    let [c0, r0, c1, r1, cells] = [d.cols, d.rows, -1, -1, 0]
    const stack = [start]
    seen[start] = 1
    while (stack.length) {
      const i = stack.pop()!
      const c = i % d.cols
      const r = Math.floor(i / d.cols)
      ;[c0, r0, c1, r1, cells] = [Math.min(c0, c), Math.min(r0, r), Math.max(c1, c), Math.max(r1, r), cells + 1]
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nc = c + dc
          const nr = r + dr
          const j = nr * d.cols + nc
          if (nc < 0 || nr < 0 || nc >= d.cols || nr >= d.rows || seen[j] || !d.changed[j]) continue
          seen[j] = 1
          stack.push(j)
        }
      }
    }
    const x = c0 * d.cell
    const y = r0 * d.cell
    out.push({ x, y, w: Math.min(d.w, (c1 + 1) * d.cell) - x, h: Math.min(d.h, (r1 + 1) * d.cell) - y, cells })
  }
  return out.sort((a, b) => b.cells - a.cells).map(({ cells: _, ...r }) => r)
}

/**
 * How the windows changed between two looks, in a few plain lines: what opened (and whether it
 * took the front), what closed, what came to the front, and titles that changed (a document
 * that now has unsaved changes, a page that loaded). Only windows on the screen in `screen`
 * (physical pixels) count, and never this app's own (`selfPid`); a protected one is named only
 * by why it's protected.
 */
export const windowChanges = (
  before: DesktopState,
  after: DesktopState,
  opts: { screen: Rect; selfPid: number; reasonOf: (w: WindowInfo) => string | null; max?: number }
): string[] => {
  const counts = (w: WindowInfo) => !w.clickThrough && w.pid !== opts.selfPid && overlaps(w, opts.screen)
  // Menus have no title: #32768 is a Windows popup menu, and layer 101 a Mac's pop-up menu level.
  const menu = (w: WindowInfo) => w.cls === '#32768' || w.cls === 'layer 101'
  const titled = (w: WindowInfo) => w.title.trim() !== '' || menu(w)
  const name = (w: WindowInfo) => {
    const reason = opts.reasonOf(w)
    if (reason) return `a protected window (${reason})`
    if (menu(w)) return 'a menu'
    return `"${w.title.trim().length > 60 ? `${w.title.trim().slice(0, 60)}…` : w.title.trim()}" (${w.exe || 'an app'})`
  }
  const was = new Map(before.windows.filter(counts).map((w) => [w.hwnd, w]))
  const now = new Map(after.windows.filter(counts).map((w) => [w.hwnd, w]))
  const lines: string[] = []
  for (const w of now.values()) {
    if (was.has(w.hwnd) || !titled(w)) continue
    lines.push(`${name(w)} opened${w.hwnd === after.foreground ? ' and is in front' : ''}.`)
  }
  for (const w of was.values()) if (!now.has(w.hwnd) && titled(w)) lines.push(`${name(w)} closed.`)
  // Only from another counted window: after this app's chat leaves the front (its first action),
  // what comes forward is just what was under it.
  const front = now.get(after.foreground)
  if (front && after.foreground !== before.foreground && was.has(front.hwnd) && was.has(before.foreground) && titled(front)) lines.push(`${name(front)} came to the front.`)
  for (const w of now.values()) {
    const old = was.get(w.hwnd)
    if (!old || old.title.trim() === w.title.trim() || opts.reasonOf(w) || opts.reasonOf(old)) continue
    if (!old.title.trim() || !w.title.trim()) continue
    lines.push(`${name(old)} is now titled "${w.title.trim().length > 60 ? `${w.title.trim().slice(0, 60)}…` : w.title.trim()}".`)
  }
  const max = opts.max ?? 5
  return lines.length > max ? [...lines.slice(0, max - 1), `…and ${lines.length - max + 1} more window changes.`] : lines
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
   * `busy` (here and on a hint): the model is deciding the next step, so the cursor waits where it
   * is with a spinner beside `label`, until the next status or hint.
   */
  | { type: 'status'; state: 'working' | 'done' | 'idle' | 'off'; label: string; busy?: boolean }
  /** Whether the sketch cursor follows the user's pointer when the assistant isn't driving it. */
  | { type: 'mode'; follow: boolean }
  /** A few words under the sketch cursor while the assistant thinks or reads, before it acts. */
  | { type: 'hint'; label: string; busy?: boolean }
  /**
   * Where the overlay's window landed relative to the display (DIPs). The system may move or trim
   * a window meant to cover the screen (macOS keeps them clear of the menu bar), and everything is
   * placed in display coordinates.
   */
  | { type: 'frame'; dx: number; dy: number; w: number; h: number }
  /** Where the user's pointer is (DIPs), or null when it's on another display. */
  | { type: 'pointer'; x: number; y: number }
  | { type: 'pointer'; x: null; y: null }
  | { type: 'marks'; marks: Mark[] }
  | { type: 'clear' }
  /**
   * What the assistant is saying to the user, as it writes it (see `spoken`): shown in the
   * cursor's tag above what it is doing, so a step it explains or teaches reads where it happens.
   * Empty takes it down.
   */
  | { type: 'say'; text: string }

/** The most of what the assistant says that the cursor carries: its last few lines' worth. */
export const SAY_MAX_CHARS = 280

/**
 * Reply text as the cursor shows it: plain words, without Markdown, code or step lines, and only
 * its end when it runs long (cut at a word, after an ellipsis), since that is what's being said now.
 */
export const spoken = (text: string): string => {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/(^|\W)[*_](\S[^*_]*?)[*_](?=\W|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
  if (plain.length <= SAY_MAX_CHARS) return plain
  const tail = plain.slice(-SAY_MAX_CHARS)
  const cut = tail.indexOf(' ')
  return `…${cut >= 0 && cut < 40 ? tail.slice(cut + 1) : tail}`
}

/** Overlay → main. */
export type OverlayCommand = 'stop' | 'show-chat' | 'clear'
