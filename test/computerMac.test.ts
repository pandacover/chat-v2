// Computer use on macOS, as far as it can be checked away from a Mac: the guard's list, shortcut
// handling, the key-code translation and the helper script itself (which only runs on a Mac).
import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Layer, ManagedRuntime, type Effect } from 'effect'
import { parseKeys, protectedAppName, protectedChord, protectedReason, protectedAppsFor } from '../src/shared/computer'
import { MAC_HELPER_SCRIPT, macChord } from '../src/main/macHelper'
import { helperProcess } from '../src/main/helperProcess'
import { runComputerTool } from '../src/main/computerTools'
import { AppPaths } from '../src/main/services/AppPaths'
import { Computer } from '../src/main/services/Computer'
import { SettingsStore } from '../src/main/services/SettingsStore'
import { SELF_PID, fakeDesktop, win } from './fakeDesktop'

const mac = { selfPid: SELF_PID, extra: [] as string[], os: 'darwin' as const }
const app = (exe: string, title: string, bundle?: string) => win({ exe, title, ...(bundle ? { bundle } : {}) })

describe('mac guard', () => {
  test('protects System Settings, Keychain, Touch ID prompts, terminals and script tools', () => {
    expect(protectedReason(app('System Settings', 'Privacy & Security', 'com.apple.systempreferences'), mac)).toBe('System Settings')
    expect(protectedReason(app('Keychain Access', 'Keychain Access'), mac)).toBe('Keychain and Passwords')
    expect(protectedReason(app('Passwords', 'Passwords', 'com.apple.Passwords'), mac)).toBe('Keychain and Passwords')
    expect(protectedReason(app('coreautha', ''), mac)).toBe('Password and Touch ID prompts')
    expect(protectedReason(app('SecurityAgent', ''), mac)).toBe('Password and Touch ID prompts')
    expect(protectedReason(app('Terminal', 'zsh — 80×24'), mac)).toBe('Terminals')
    expect(protectedReason(app('iTerm2', 'bash'), mac)).toBe('Terminals')
    expect(protectedReason(app('Script Editor', 'Untitled'), mac)).toBe('Admin and script tools')
    expect(protectedReason(app('1Password', '1Password'), mac)).toBe('Password managers')
  })

  test('a renamed app is still caught by its bundle id', () => {
    expect(protectedReason(app('My Shell', 'zsh', 'com.googlecode.iterm2'), mac)).toBe('Terminals')
  })

  test('leaves ordinary Mac apps usable', () => {
    expect(protectedReason(app('DaVinci Resolve', 'DaVinci Resolve - Untitled Project', 'com.blackmagic-design.DaVinciResolve'), mac)).toBeNull()
    expect(protectedReason(app('Finder', 'Downloads', 'com.apple.finder'), mac)).toBeNull()
    expect(protectedReason(app('Safari', 'Apple', 'com.apple.Safari'), mac)).toBeNull()
  })

  test("each system has its own list, and Windows' entries don't apply on a Mac", () => {
    expect(protectedAppsFor('darwin').map((a) => a.label)).not.toContain('Windows Settings')
    expect(protectedAppsFor('win32').map((a) => a.label)).not.toContain('System Settings')
    expect(protectedAppsFor('darwin').map((a) => a.label)).toContain('Password managers')
  })

  test('refuses to open protected Mac apps by name', () => {
    expect(protectedAppName('System Settings', '/System/Applications/System Settings.app', [], 'darwin')).toBe('System Settings')
    expect(protectedAppName('Terminal', '/System/Applications/Utilities/Terminal.app', [], 'darwin')).toBe('Terminals')
    expect(protectedAppName('Keychain Access', '/System/Applications/Utilities/Keychain Access.app', [], 'darwin')).not.toBeNull()
    expect(protectedAppName('DaVinci Resolve', '/Applications/DaVinci Resolve/DaVinci Resolve.app', [], 'darwin')).toBeNull()
  })

  test('Cmd is the everyday modifier on a Mac; Spotlight, Force Quit and lock are blocked', () => {
    expect(protectedChord(parseKeys('Cmd+S'), 'darwin')).toBeNull()
    expect(protectedChord(parseKeys('Cmd+Tab'), 'darwin')).toBeNull()
    expect(protectedChord(parseKeys('Cmd+Space'), 'darwin')).not.toBeNull()
    expect(protectedChord(parseKeys('Cmd+Option+Esc'), 'darwin')).not.toBeNull()
    expect(protectedChord(parseKeys('Ctrl+Cmd+Q'), 'darwin')).not.toBeNull()
    // The same Cmd+S is the Windows key on Windows.
    expect(protectedChord(parseKeys('Cmd+S'))).not.toBeNull()
  })
})

describe('mac keys', () => {
  test('chords become a key code and modifier flags', () => {
    // The key, the flags it carries, and the modifier keys held around it.
    expect(macChord(parseKeys('Cmd+S'))).toEqual({ code: 1, flags: 0x100000, mods: [55] })
    expect(macChord(parseKeys('Cmd+Shift+N'))).toEqual({ code: 45, flags: 0x120000, mods: [55, 56] })
    expect(macChord(parseKeys('Enter'))).toEqual({ code: 36, flags: 0, mods: [] })
    expect(macChord(parseKeys('Option+Left'))).toEqual({ code: 123, flags: 0x80000, mods: [58] })
    expect(macChord(parseKeys('Cmd+,'))).toEqual({ code: 43, flags: 0x100000, mods: [55] })
    expect(macChord(parseKeys('F5'))).toEqual({ code: 96, flags: 0, mods: [] })
    // A modifier alone is pressed as itself.
    expect(macChord(parseKeys('Shift'))).toEqual({ code: 56, flags: 0x20000, mods: [56] })
    expect(() => macChord(parseKeys('PrintScreen'))).toThrow('no equivalent')
  })
})

describe('mac helper script', () => {
  test('parses as JavaScript, defines run(), and never moves the pointer', () => {
    expect(() => new Function(MAC_HELPER_SCRIPT)).not.toThrow()
    expect(MAC_HELPER_SCRIPT).toContain('function run()')
    // CGWarpMouseCursorPosition moves the pointer; mouse events go to an app with CGEventPostToPid instead.
    expect(MAC_HELPER_SCRIPT).not.toContain('CGWarpMouseCursorPosition')
    expect(MAC_HELPER_SCRIPT).not.toMatch(/CGEventPost\(0, e\)[\s\S]*CGEventCreateMouseEvent|postMouse[^\n]*CGEventPost\(/)
    expect(MAC_HELPER_SCRIPT).toContain('CGEventPostToPid(pid, e)')
  })

  test('never releases what the bridge owns (a double free crashed the helper on a real Mac)', () => {
    expect(MAC_HELPER_SCRIPT).not.toMatch(/\$\.(CFRelease|CFBridgingRelease|free)\(/)
  })

  test('a helper that dies says which step it was on', async () => {
    // Stands in for the helper: ready, two steps noted, then it exits mid-request.
    const script = `process.stdout.write(JSON.stringify({ ready: true }) + '\\n'); process.stdin.once('data', () => { process.stderr.write('at: request state\\nat: listing windows\\n'); setTimeout(() => process.exit(1), 20) })`
    const helper = helperProcess(() => spawn(process.execPath, ['-e', script]))
    await expect(helper.request('state')).rejects.toThrow('the input helper stopped while listing windows')
    helper.close()
  })

  test('the script survives being embedded: escapes are still escapes', () => {
    expect(MAC_HELPER_SCRIPT).toContain("JSON.stringify(obj) + '\\n'")
    expect(MAC_HELPER_SCRIPT).toContain(".split('\\n')")
  })
})

describe('mac computer service', () => {
  const service = () => {
    const desktop = fakeDesktop([win({ hwnd: 1, pid: 100, exe: 'TextEdit', title: 'Untitled', bundle: 'com.apple.TextEdit' })], 'darwin')
    const dir = mkdtempSync(join(tmpdir(), 'chat-v2-cu-mac-'))
    writeFileSync(join(dir, 'config.json'), '{}')
    const paths = AppPaths.layer(dir)
    const settings = SettingsStore.layer({ encrypt: (s) => s, decrypt: (s) => s }).pipe(Layer.provide(paths))
    const runtime = ManagedRuntime.make(Computer.layer(desktop.ports).pipe(Layer.provide(Layer.mergeAll(settings, paths))))
    const run = <A, E>(eff: Effect.Effect<A, E, Computer>) => runtime.runPromise(eff)
    const tool = (name: string, args: object = {}) => run(Computer.use((c) => runComputerTool(c, name, JSON.stringify(args))))
    return { desktop, run, tool }
  }

  test('Cmd shortcuts go through; Spotlight is refused', async () => {
    const t = service()
    await t.run(Computer.use((c) => c.begin('r')))
    await t.tool('computer_screenshot')
    expect((await t.tool('computer_key', { keys: 'Cmd+S' })).halt).toBeUndefined()
    expect(t.desktop.input).toContain(`keys ${[0x5b, 0x53].join(',')}`)
    expect((await t.tool('computer_key', { keys: 'Cmd+Space' })).halt).toContain('Spotlight')
  })

  test("windows macOS won't name are still listed, by their app", async () => {
    const t = service()
    t.desktop.state.windows = [win({ hwnd: 1, pid: 100, exe: 'TextEdit', title: '', cls: 'layer 0' })]
    await t.run(Computer.use((c) => c.begin('r')))
    const look = await t.tool('computer_screenshot')
    expect(look.text).toContain('- A window (TextEdit) at')
  })

  test('a missing permission stops it before it starts, with what to allow', async () => {
    const t = service()
    t.desktop.ports.permissions = async () => 'Computer use needs Accessibility access.'
    await expect(t.run(Computer.use((c) => c.begin('r')))).rejects.toThrow('Accessibility')
    expect(t.desktop.chat).toEqual([])
  })
})
