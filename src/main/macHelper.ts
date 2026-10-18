import { spawn } from 'node:child_process'
import { readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DesktopState, WindowInfo } from '@shared/computer'
import type { Driver } from './driver'
import { helperProcess } from './helperProcess'

// macOS input and window inspection for computer use, without native modules: one long-lived
// osascript process runs JavaScript for Automation, which reaches CoreGraphics, AppKit and the
// Accessibility API through its Objective-C bridge. Same line protocol as the Windows helper:
//   <id> state | click win x y left|right|middle count | hover win x y | drag win x0 y0 x1 y1
//   <id> wheel win x y dx dy | text <base64 utf-8> | keys keycode flags | focus win
// `win` is a CGWindowID. Coordinates here are points (macOS's global display coordinates); the
// driver below converts to and from the physical pixels the rest of computer use works in.
//
// The mouse is never moved. A click presses the element under the point through Accessibility
// (buttons, menus, rows, links, text fields), which apps can't ignore and which says whether it
// worked; where nothing takes a press, mouse events are posted to the app that owns the window,
// which many Mac apps ignore, and the model is told so. Dragging can only be posted, since macOS
// has no way to drag without the pointer. Keys and text reach the app in front.

export const MAC_HELPER_SCRIPT = String.raw`
ObjC.import('Cocoa')
ObjC.import('CoreGraphics')
ObjC.import('ApplicationServices')

// Nothing here is released by hand: the bridge owns what CoreGraphics' Create and Copy functions
// return and frees it itself, so a CFRelease would free it twice and crash the helper.

var stdout = $.NSFileHandle.fileHandleWithStandardOutput
var stderr = $.NSFileHandle.fileHandleWithStandardError

function send(obj) {
  stdout.writeData($(JSON.stringify(obj) + '\n').dataUsingEncoding($.NSUTF8StringEncoding))
}

// Each step is noted on stderr first, so if the bridge ever crashes the process, the app can say where.
function at(step) {
  stderr.writeData($('at: ' + step + '\n').dataUsingEncoding($.NSUTF8StringEncoding))
}

function point(x, y) {
  try { return $.CGPointMake(x, y) } catch (e) { return { x: x, y: y } }
}

function unwrapList(ref) {
  var list = null
  try { list = ObjC.deepUnwrap(ObjC.castRefToObject(ref)) } catch (e) {}
  return Array.isArray(list) ? list : []
}

var bundles = {}
function bundleOf(pid) {
  if (bundles.hasOwnProperty(pid)) return bundles[pid]
  var id = ''
  try {
    var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid)
    if (app && !app.isNil() && app.bundleIdentifier && !app.bundleIdentifier.isNil()) id = app.bundleIdentifier.js
  } catch (e) {}
  bundles[pid] = id
  return id
}

function frontPid() {
  try { return $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier } catch (e) { return 0 }
}

// On screen only, without the desktop picture and icons; frontmost first.
function windowList() {
  at('listing windows')
  return unwrapList($.CGWindowListCopyWindowInfo(1 | 16, 0))
}

function windowById(win) {
  at('finding window ' + win)
  var list = unwrapList($.CGWindowListCopyWindowInfo(8, win))
  for (var i = 0; i < list.length; i++) if (list[i].kCGWindowNumber === win) return list[i]
  throw new Error('That window is gone')
}

function state() {
  bundles = {}
  var front = frontPid()
  var raw = windowList()
  at('reading ' + raw.length + ' windows')
  var windows = []
  var foreground = 0
  for (var i = 0; i < raw.length && windows.length < 80; i++) {
    var w = raw[i]
    var b = w.kCGWindowBounds || {}
    if (!(b.Width >= 2 && b.Height >= 2)) continue
    if (w.kCGWindowAlpha !== undefined && w.kCGWindowAlpha <= 0) continue
    var layer = w.kCGWindowLayer || 0
    var pid = w.kCGWindowOwnerPID || 0
    var info = {
      hwnd: w.kCGWindowNumber, pid: pid, exe: w.kCGWindowOwnerName || '', bundle: bundleOf(pid),
      title: w.kCGWindowName || '', cls: 'layer ' + layer, layer: layer,
      x: b.X, y: b.Y, w: b.Width, h: b.Height, clickThrough: false
    }
    if (!foreground && pid === front && layer === 0) foreground = info.hwnd
    windows.push(info)
  }
  // AppKit counts up from the bottom of the main display; CoreGraphics, like everything here, down from the top.
  at('reading the pointer')
  var m = $.NSEvent.mouseLocation
  var top = $.NSScreen.screens.objectAtIndex(0).frame.size.height
  return { cursor: { x: m.x, y: top - m.y }, foreground: foreground, windows: windows }
}

// Raises one window of an app and makes the app frontmost, through Accessibility, which needs
// no other permission; activation by AppKit is a second try.
function focusWindow(win) {
  var info = windowById(win)
  at('bringing window ' + win + ' forward')
  var pid = info.kCGWindowOwnerPID
  var title = info.kCGWindowName || ''
  try {
    var app = $.AXUIElementCreateApplication(pid)
    $.AXUIElementSetAttributeValue(app, $('AXFrontmost'), $.NSNumber.numberWithBool(true))
    var ref = Ref()
    if ($.AXUIElementCopyAttributeValue(app, $('AXWindows'), ref) === 0) {
      var wins = ObjC.castRefToObject(ref[0])
      for (var i = 0; i < wins.count; i++) {
        var w = wins.objectAtIndex(i)
        var t = ''
        try {
          var tref = Ref()
          $.AXUIElementCopyAttributeValue(w, $('AXTitle'), tref)
          t = ObjC.castRefToObject(tref[0]).js
        } catch (e) {}
        if (!title || t === title) {
          $.AXUIElementPerformAction(w, $('AXRaise'))
          break
        }
      }
    }
  } catch (e) {}
  if (frontPid() !== pid) {
    try { $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid).activateWithOptions(3) } catch (e) {}
  }
  return pid
}

// The app a pointer action goes to, brought to the front if it isn't.
function target(win) {
  var info = windowById(win)
  var pid = info.kCGWindowOwnerPID
  if (frontPid() !== pid) {
    focusWindow(win)
    delay(0.15)
  }
  return pid
}

function postMouse(pid, win, type, x, y, button, clicks) {
  at('posting mouse event ' + type)
  var e = $.CGEventCreateMouseEvent(null, type, point(x, y), button)
  if (clicks) $.CGEventSetIntegerValueField(e, 1, clicks)
  // The window under the pointer, and the one under it that takes this event.
  $.CGEventSetIntegerValueField(e, 91, win)
  $.CGEventSetIntegerValueField(e, 92, win)
  $.CGEventPostToPid(pid, e)
}

// --- Accessibility: clicks that apps can't ignore -----------------------------------------
// Mac apps ignore most mouse events posted to them. Accessibility is how macOS lets another app
// press a button, pick a row or focus a field without the pointer, and it says whether it worked.

var axPrepared = {}
function axApp(pid) {
  var app = $.AXUIElementCreateApplication(pid)
  if (!axPrepared[pid]) {
    axPrepared[pid] = true
    // Electron apps build their accessibility tree only when something asks for it.
    try { $.AXUIElementSetAttributeValue(app, $('AXManualAccessibility'), $.NSNumber.numberWithBool(true)) } catch (e) {}
  }
  return app
}

function axGet(el, name) {
  var ref = Ref()
  return $.AXUIElementCopyAttributeValue(el, $(name), ref) === 0 ? ref[0] : null
}

function axString(el, name) {
  var v = axGet(el, name)
  if (v === null || v === undefined) return ''
  try {
    var s = ObjC.castRefToObject(v).js
    return typeof s === 'string' ? s : ''
  } catch (e) { return '' }
}

function axNumber(el, name) {
  var v = axGet(el, name)
  if (v === null || v === undefined) return null
  try {
    var n = ObjC.castRefToObject(v).js
    return typeof n === 'number' ? n : null
  } catch (e) { return null }
}

function axActions(el) {
  var ref = Ref()
  if ($.AXUIElementCopyActionNames(el, ref) !== 0) return []
  try {
    var list = ObjC.deepUnwrap(ObjC.castRefToObject(ref[0]))
    return Array.isArray(list) ? list : []
  } catch (e) { return [] }
}

function axAt(pid, x, y) {
  at('finding what is at ' + Math.round(x) + ',' + Math.round(y))
  var ref = Ref()
  return $.AXUIElementCopyElementAtPosition(axApp(pid), x, y, ref) === 0 ? ref[0] : null
}

// Only a window's surface: the app hasn't built its tree yet (Chromium, Electron) or draws its own.
function coarse(el) {
  var role = axString(el, 'AXRole')
  return !role || role === 'AXWindow' || role === 'AXApplication' || (role === 'AXGroup' && axActions(el).length === 0 && !axString(el, 'AXTitle'))
}

function axHit(pid, x, y) {
  var el = axAt(pid, x, y)
  if (el && !coarse(el)) return el
  // Ask Chromium apps for their tree, and give them a moment to build it.
  try { $.AXUIElementSetAttributeValue(axApp(pid), $('AXEnhancedUserInterface'), $.NSNumber.numberWithBool(true)) } catch (e) {}
  delay(0.3)
  return axAt(pid, x, y) || el
}

function axName(el) {
  var role = axString(el, 'AXRoleDescription') || axString(el, 'AXRole').replace(/^AX/, '')
  var name = axString(el, 'AXTitle') || axString(el, 'AXDescription') || axString(el, 'AXHelp')
  return (role || 'element') + (name ? ' "' + name.slice(0, 60) + '"' : '')
}

var TEXT_ROLES = ['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField']
var PICKED_ROLES = ['AXRow', 'AXCell', 'AXOutlineRow', 'AXRadioButton', 'AXTab']
var STOP_ROLES = ['AXWindow', 'AXApplication', 'AXSheet', 'AXDrawer']

// Presses whatever is at the point, or the nearest thing above it that can be pressed (text
// inside a button, an icon inside a row). Says what it did, or null when nothing there responds.
function axClick(pid, x, y, which, count) {
  var cur = axHit(pid, x, y)
  for (var depth = 0; depth < 6 && cur; depth++) {
    var role = axString(cur, 'AXRole')
    if (STOP_ROLES.indexOf(role) >= 0) break
    var acts = axActions(cur)
    at('pressing ' + role)
    if (which === 'right') {
      if (acts.indexOf('AXShowMenu') >= 0 && $.AXUIElementPerformAction(cur, $('AXShowMenu')) === 0) return 'Opened the menu of the ' + axName(cur) + ' through Accessibility.'
    } else {
      if (TEXT_ROLES.indexOf(role) >= 0 && $.AXUIElementSetAttributeValue(cur, $('AXFocused'), $.NSNumber.numberWithBool(true)) === 0) {
        return 'Put the text cursor in the ' + axName(cur) + ' through Accessibility.'
      }
      var tries = count >= 2 ? ['AXOpen', 'AXPress', 'AXConfirm', 'AXPick'] : ['AXPress', 'AXPick', 'AXConfirm', 'AXOpen']
      for (var k = 0; k < tries.length; k++) {
        if (acts.indexOf(tries[k]) >= 0 && $.AXUIElementPerformAction(cur, $(tries[k])) === 0) return 'Pressed the ' + axName(cur) + ' through Accessibility.'
      }
      if (PICKED_ROLES.indexOf(role) >= 0 && $.AXUIElementSetAttributeValue(cur, $('AXSelected'), $.NSNumber.numberWithBool(true)) === 0) {
        return 'Selected the ' + axName(cur) + ' through Accessibility.'
      }
    }
    cur = axGet(cur, 'AXParent')
  }
  return null
}

// Scrolls the scroll area under the point by moving its scroll bar, 1% of the way a line.
function axScroll(pid, x, y, dx, dy) {
  var cur = axHit(pid, x, y)
  for (var depth = 0; depth < 12 && cur; depth++) {
    if (axString(cur, 'AXRole') === 'AXScrollArea') {
      var bar = axGet(cur, dy !== 0 ? 'AXVerticalScrollBar' : 'AXHorizontalScrollBar')
      if (!bar) return null
      var value = axNumber(bar, 'AXValue')
      if (value === null) return null
      // Wheel up (positive) moves toward the top; right (positive) toward the end.
      var next = Math.min(1, Math.max(0, value + (dy !== 0 ? -dy : dx) * 0.01))
      at('scrolling ' + axName(cur))
      if ($.AXUIElementSetAttributeValue(bar, $('AXValue'), $.NSNumber.numberWithDouble(next)) === 0) return 'Scrolled the ' + axName(cur) + ' through Accessibility.'
      return null
    }
    cur = axGet(cur, 'AXParent')
  }
  return null
}

// Down and up event types, and the button number.
var BUTTONS = { left: [1, 2, 0], right: [3, 4, 1], middle: [25, 26, 2] }

function click(win, x, y, which, count) {
  var pid = windowById(win).kCGWindowOwnerPID
  var done = axClick(pid, x, y, which, count)
  if (done) return done
  // Nothing there takes an Accessibility press (a canvas, a game, a custom control): post the
  // mouse events, which some apps take, with the app in front.
  target(win)
  var b = BUTTONS[which] || BUTTONS.left
  postMouse(pid, win, 5, x, y, 0, 0)
  for (var n = 1; n <= Math.max(1, count); n++) {
    postMouse(pid, win, b[0], x, y, b[2], n)
    delay(0.03)
    postMouse(pid, win, b[1], x, y, b[2], n)
    if (n < count) delay(0.04)
  }
  return "Nothing there responds to Accessibility, so I posted mouse events instead. Many Mac apps ignore those: if the screenshot shows no change, the click didn't happen. Use the keyboard instead (Tab, Space, Return, the app's shortcuts)."
}

function drag(win, x0, y0, x1, y1) {
  var pid = target(win)
  postMouse(pid, win, 5, x0, y0, 0, 0)
  postMouse(pid, win, 1, x0, y0, 0, 1)
  var steps = 14
  for (var i = 1; i <= steps; i++) {
    delay(0.028)
    postMouse(pid, win, 6, x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, 0, 0)
  }
  postMouse(pid, win, 2, x1, y1, 0, 1)
  return "macOS has no way to drag without moving the user's pointer, so this was posted as mouse events, which most Mac apps ignore. If the screenshot shows no change, it didn't work: do it another way (menus, keyboard shortcuts, fields in a settings panel), or ask the user to drag it."
}

function wheel(win, x, y, dx, dy) {
  if (typeof $.CGEventCreateScrollWheelEvent2 !== 'function') throw new Error("Scrolling without moving the mouse isn't available on this Mac. Use the keyboard instead: Page Down, Space, or the arrow keys")
  var pid = windowById(win).kCGWindowOwnerPID
  var done = axScroll(pid, x, y, dx, dy)
  if (done) return done
  at('scrolling')
  // In lines, vertical first.
  var e = $.CGEventCreateScrollWheelEvent2(null, 1, 2, dy, dx, 0)
  $.CGEventSetLocation(e, point(x, y))
  $.CGEventSetIntegerValueField(e, 91, win)
  $.CGEventSetIntegerValueField(e, 92, win)
  $.CGEventPostToPid(pid, e)
  return "There's no scroll bar there to move, so I posted a scroll event, which some Mac apps ignore. If nothing moved, use the keyboard (Page Down, Space, the arrow keys)."
}

function key(code, flags, down) {
  at('pressing key ' + code)
  var e = $.CGEventCreateKeyboardEvent(null, code, down)
  $.CGEventSetFlags(e, flags)
  $.CGEventPost(0, e)
}

// Modifiers go down first and come up last, each with the flags held at that moment, as a
// hand would press them: some apps read modifiers from their own events, and Cmd+Tab's
// switcher only closes when Cmd comes up.
var MOD_FLAGS = { 56: 0x20000, 60: 0x20000, 59: 0x40000, 62: 0x40000, 58: 0x80000, 61: 0x80000, 55: 0x100000, 54: 0x100000 }
function chord(code, flags, mods) {
  var held = 0
  for (var i = 0; i < mods.length; i++) {
    held |= MOD_FLAGS[mods[i]] || 0
    key(mods[i], held, true)
  }
  if (mods.indexOf(code) < 0) {
    key(code, flags, true)
    key(code, flags, false)
  }
  for (var j = mods.length - 1; j >= 0; j--) {
    held &= ~(MOD_FLAGS[mods[j]] || 0)
    key(mods[j], held, false)
  }
}

// Text through System Events (macOS asks once to let chat-v2 control it). Posting the characters
// as key events would need a raw character buffer, which the bridge can't safely hand over.
var systemEvents = null
function typeChunk(chunk) {
  at('typing')
  if (!systemEvents) systemEvents = Application('System Events')
  systemEvents.keystroke(chunk)
}

function typeText(text) {
  var lines = text.replace(/\r/g, '').split('\n')
  for (var i = 0; i < lines.length; i++) {
    if (i > 0) chord(36, 0, [])
    for (var j = 0; j < lines[i].length; j += 16) {
      typeChunk(lines[i].slice(j, j + 16))
      delay(0.012)
    }
  }
}

function decode(b64) {
  var data = $.NSData.alloc.initWithBase64EncodedStringOptions($(b64 || ''), 0)
  return $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js
}

function op(a) {
  var n = function (i) { return Number(a[i]) }
  switch (a[1]) {
    case 'state': return state()
    case 'click': return { done: true, note: click(n(2), n(3), n(4), a[5], n(6)) }
    case 'hover': postMouse(windowById(n(2)).kCGWindowOwnerPID, n(2), 5, n(3), n(4), 0, 0); return { done: true }
    case 'drag': return { done: true, note: drag(n(2), n(3), n(4), n(5), n(6)) }
    case 'wheel': return { done: true, note: wheel(n(2), n(3), n(4), n(5), n(6)) }
    case 'text': typeText(decode(a[2])); return { done: true }
    case 'keys': chord(n(2), n(3), a[4] && a[4] !== '-' ? a[4].split(',').map(Number) : []); return { done: true }
    case 'focus': focusWindow(n(2)); return { done: true }
    default: throw new Error('unknown op ' + a[1])
  }
}

function run() {
  var input = $.NSFileHandle.fileHandleWithStandardInput
  // What the bridge reaches on this Mac: each is a function the helper relies on.
  var has = {
    postToPid: typeof $.CGEventPostToPid === 'function',
    scroll2: typeof $.CGEventCreateScrollWheelEvent2 === 'function',
    pointMake: typeof $.CGPointMake === 'function',
    ax: typeof $.AXUIElementCreateApplication === 'function',
    windows: typeof $.CGWindowListCopyWindowInfo === 'function'
  }
  var trusted = false
  try { trusted = !!$.AXIsProcessTrusted() } catch (e) {}
  send({ ready: true, postToPid: has.postToPid, trusted: trusted, has: has })
  var buf = ''
  while (true) {
    var data = input.availableData
    if (!data || data.length === 0) break
    buf += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js
    var i
    while ((i = buf.indexOf('\n')) >= 0) {
      var line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      var a = line.split(' ')
      at('request ' + a[1])
      try {
        var r = op(a) || {}
        r.id = Number(a[0])
        r.ok = true
        send(r)
      } catch (e) {
        send({ id: Number(a[0]), ok: false, error: String((e && e.message) || e) })
      }
    }
  }
}
`

/** macOS key codes for the Windows virtual-key codes parseKeys gives (US layout positions). */
const MAC_KEYS: Record<number, number> = {
  0x08: 51, 0x09: 48, 0x0d: 36, 0x14: 57, 0x1b: 53, 0x20: 49, 0x21: 116, 0x22: 121, 0x23: 119, 0x24: 115,
  0x25: 123, 0x26: 126, 0x27: 124, 0x28: 125, 0x2d: 114, 0x2e: 117,
  0x41: 0, 0x42: 11, 0x43: 8, 0x44: 2, 0x45: 14, 0x46: 3, 0x47: 5, 0x48: 4, 0x49: 34, 0x4a: 38, 0x4b: 40, 0x4c: 37, 0x4d: 46,
  0x4e: 45, 0x4f: 31, 0x50: 35, 0x51: 12, 0x52: 15, 0x53: 1, 0x54: 17, 0x55: 32, 0x56: 9, 0x57: 13, 0x58: 7, 0x59: 16, 0x5a: 6,
  0x30: 29, 0x31: 18, 0x32: 19, 0x33: 20, 0x34: 21, 0x35: 23, 0x36: 22, 0x37: 26, 0x38: 28, 0x39: 25,
  0xba: 41, 0xbb: 24, 0xbc: 43, 0xbd: 27, 0xbe: 47, 0xbf: 44, 0xc0: 50, 0xdb: 33, 0xdc: 42, 0xdd: 30, 0xde: 39,
  0x70: 122, 0x71: 120, 0x72: 99, 0x73: 118, 0x74: 96, 0x75: 97, 0x76: 98, 0x77: 100, 0x78: 101, 0x79: 109, 0x7a: 103, 0x7b: 111,
  0x7c: 105, 0x7d: 107, 0x7e: 113, 0x7f: 106, 0x80: 64, 0x81: 79, 0x82: 80, 0x83: 90
}

/** Modifier virtual-key codes: their flag, and their own key code when pressed alone. */
const MAC_MODIFIERS: Record<number, { flag: number; code: number }> = {
  0x10: { flag: 0x20000, code: 56 },
  0x11: { flag: 0x40000, code: 59 },
  0x12: { flag: 0x80000, code: 58 },
  // The Windows key is Cmd on a Mac.
  0x5b: { flag: 0x100000, code: 55 },
  0x5c: { flag: 0x100000, code: 54 }
}

/**
 * A chord as one macOS key code, its modifier flags, and the modifier keys to hold around it.
 * Throws for keys a Mac doesn't have.
 */
export const macChord = (vks: number[]): { code: number; flags: number; mods: number[] } => {
  let flags = 0
  let code: number | null = null
  let lastModifier: number | null = null
  const mods: number[] = []
  for (const vk of vks) {
    const mod = MAC_MODIFIERS[vk]
    if (mod) {
      flags |= mod.flag
      lastModifier = mod.code
      if (!mods.includes(mod.code)) mods.push(mod.code)
      continue
    }
    const mac = MAC_KEYS[vk]
    if (mac === undefined) throw new Error('That key has no equivalent on a Mac keyboard')
    code = mac
  }
  if (code === null && lastModifier === null) throw new Error('No keys given')
  return { code: code ?? lastModifier!, flags, mods }
}

/**
 * Windows clicks pass through: overlays like ours, the system's full-screen layers, and the
 * window server's own (the menu bar), which events posted to an app can't reach.
 */
const seeThrough = (w: WindowInfo & { layer?: number }, display: { w: number; h: number }) =>
  (w.layer ?? 0) >= 1000 ||
  w.exe === 'Window Server' ||
  ((w.layer ?? 0) !== 0 && ['Dock', 'Window Server', 'WindowManager'].includes(w.exe) && w.w >= display.w && w.h >= display.h * 0.9)

const APP_FOLDERS = () => ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', join(homedir(), 'Applications')]

/** Installed apps, from the usual folders and one level of subfolders (e.g. /Applications/DaVinci Resolve/). */
const listApps = () => {
  const found = new Map<string, { name: string; id: string }>()
  const scan = (dir: string, depth: number) => {
    let entries: Array<{ name: string; isDirectory(): boolean }>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const path = join(dir, e.name)
      if (e.name.endsWith('.app')) {
        const name = e.name.slice(0, -4)
        if (!found.has(name.toLowerCase())) found.set(name.toLowerCase(), { name, id: path })
      } else if (depth > 0) scan(path, depth - 1)
    }
  }
  for (const dir of APP_FOLDERS()) scan(dir, 1)
  return [...found.values()]
}

/**
 * Starts the helper on first use, and again if it dies. `scriptFile` is where the script is
 * written; `display` is the primary display in points, with its scale (pixels per point).
 */
export const macDriver = (scriptFile: string, display: () => { w: number; h: number; scale: number }): Driver => {
  let apps: Array<{ name: string; id: string }> | null = null
  const { request, close } = helperProcess(
    () => {
      writeFileSync(scriptFile, MAC_HELPER_SCRIPT, 'utf8')
      return spawn('osascript', ['-l', 'JavaScript', scriptFile])
    },
    (ready) =>
      ready.postToPid === false
        ? "this version of macOS doesn't let chat-v2 click in apps without moving your mouse"
        : ready.trusted === false
          ? 'chat-v2 needs Accessibility access: allow it in System Settings → Privacy & Security → Accessibility, then quit and reopen chat-v2'
          : null
  )
  const note = (reply: Record<string, unknown>) => (typeof reply.note === 'string' ? reply.note : null)
  // Pixels to points and back.
  const pt = (v: number) => v / display().scale
  const px = (v: number) => Math.round(v * display().scale)

  return {
    state: async () => {
      const r = await request('state')
      const d = display()
      const windows = (r.windows as Array<WindowInfo & { layer?: number }>).map((w) => {
        const { layer: _, ...rest } = w
        return { ...rest, x: px(w.x), y: px(w.y), w: px(w.w), h: px(w.h), clickThrough: seeThrough(w, d) }
      })
      const cursor = r.cursor as DesktopState['cursor']
      return { cursor: { x: px(cursor.x), y: px(cursor.y) }, foreground: r.foreground as number, windows }
    },
    click: async (win, x, y, button, count) => note(await request('click', win, pt(x), pt(y), button, count)),
    hover: async (win, x, y) => void (await request('hover', win, pt(x), pt(y))),
    drag: async (win, from, to) => note(await request('drag', win, pt(from.x), pt(from.y), pt(to.x), pt(to.y))),
    // A wheel notch is three lines, as on Windows.
    wheel: async (win, x, y, dx, dy) => note(await request('wheel', win, pt(x), pt(y), Math.round(dx * 3), Math.round(dy * 3))),
    text: async (text) => void (await request('text', Buffer.from(text, 'utf8').toString('base64'))),
    keys: async (vks) => {
      const { code, flags, mods } = macChord(vks)
      await request('keys', code, flags, mods.length ? mods.join(',') : '-')
    },
    focus: async (win) => void (await request('focus', win)),
    apps: async () => {
      if (apps) return apps
      apps = listApps()
      // Installs change the list; read it again in a while.
      setTimeout(() => (apps = null), 5 * 60 * 1000).unref()
      return apps
    },
    launch: async (id) => {
      spawn('open', [id], { detached: true, stdio: 'ignore' }).unref()
    },
    close
  }
}
