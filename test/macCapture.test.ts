// Computer use on a Mac with its ScreenCaptureKit stream, as far as it can be checked away from a
// Mac: the port that drives the capture helper (against a pretend helper, fakeCaptureHelper.ts,
// which speaks its protocol), its fallbacks, and how the computer service waits, glances and
// tells the model about waiting when the stream is up and when it isn't.
import { afterEach, describe, expect, test } from 'bun:test'
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Effect, Layer, ManagedRuntime } from 'effect'
import { computerInstructions, computerTools, runComputerTool } from '../src/main/computerTools'
import type { ScreenChanges } from '../src/main/desktop'
import { type MacCaptureDeps, macCaptureScreen } from '../src/main/macCapture'
import { AppPaths } from '../src/main/services/AppPaths'
import { Computer, GLIDE_MS, SETTLE_MAX_MS, SETTLE_QUIET_MS, WAIT_QUIET_MS, WAIT_STILL_MS } from '../src/main/services/Computer'
import { SettingsStore } from '../src/main/services/SettingsStore'
import { SELF_PID, fakeDesktop, win } from './fakeDesktop'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('mac capture port', () => {
  const children: ChildProcessWithoutNullStreams[] = []
  afterEach(() => {
    for (const c of children.splice(0)) c.kill()
  })

  /** The port on a 2880×1800 Retina display, its helper the pretend one run with `flags`. */
  const port = (flags: string[] = [], over: Partial<MacCaptureDeps> = {}) => {
    const log = join(mkdtempSync(join(tmpdir(), 'chat-v2-sck-')), 'requests.log')
    writeFileSync(log, '')
    const t = { spawns: 0, hides: 0, fallbacks: 0, warnings: [] as string[] }
    const screen = macCaptureScreen({
      spawnHelper: () => {
        t.spawns++
        const child = spawn(process.execPath, [join(import.meta.dir, 'fakeCaptureHelper.ts'), '--log', log, ...flags])
        children.push(child)
        return child
      },
      display: () => ({ x: 0, y: 0, w: 2880, h: 1800, scale: 2 }),
      displayId: () => 69733378,
      cursor: () => ({ x: 0, y: 0 }),
      fallback: async (size) => {
        t.fallbacks++
        return { dataUrl: 'data:image/jpeg;base64,SOURCES', w: size.w, h: size.h, ms: { sources: 300, cover: 0, encode: 5 } }
      },
      hiddenWhile: async (capture) => {
        t.hides++
        return capture()
      },
      pid: SELF_PID,
      warn: (m) => t.warnings.push(m),
      ...over
    })
    const requests = () => readFileSync(log, 'utf8').split('\n').filter(Boolean)
    return { screen, requests, t }
  }

  test('opens on prepare with the display, this app and the physical size, and captures from the stream without hiding the overlay', async () => {
    const { screen, requests, t } = port()
    screen.prepare!()
    expect(await screen.watchable!()).toBe(true)
    expect(requests()).toEqual([`start 69733378 ${SELF_PID} 2880 1800`])
    expect(screen.live!()).toBe(true)
    expect(screen.keepsAppOut!()).toBe(true)
    expect(screen.keepsOverlayOut).toBe(true)
    const shot = await screen.capture({ w: 1280, h: 800 }, [{ x: 1, y: 2, w: 3, h: 4 }])
    expect(shot.dataUrl).toBe(`data:image/jpeg;base64,${Buffer.from('SCK').toString('base64')}`)
    expect([shot.w, shot.h]).toEqual([1280, 800])
    // What the timing log gets: the round trip as `sck`, and the helper's own parts.
    expect(Object.keys(shot.ms!).sort()).toEqual(['cover', 'draw', 'encode', 'sck'])
    expect(requests()[1]).toBe('grab 1280 800 [{"x":1,"y":2,"w":3,"h":4}] null 2880')
    expect(t.hides).toBe(0)
    expect(t.fallbacks).toBe(0)
    // A close-up asks for its part, from the display's corner, at full resolution.
    await screen.capture({ w: 600, h: 300 }, [], { x: 100, y: 50, w: 200, h: 100 })
    expect(requests()[2]).toBe('grab 600 300 [] {"x":100,"y":50,"w":200,"h":100} 2880')
    expect(t.spawns).toBe(1)
  })

  test("the screen's changes come from the helper's counts", async () => {
    const { screen } = port()
    expect(await screen.watchable!()).toBe(true)
    expect(await screen.changes!()).toEqual({ count: 1, stillMs: 42 })
    expect(await screen.changes!()).toEqual({ count: 2, stillMs: 42 })
  })

  test("a stream that can't come up in time leaves captures to getSources, with the overlay hidden, and a capture that must leave the app out refuses", async () => {
    // A helper that never answers its ready line: the stream never comes up.
    const hung = () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
      children.push(child)
      return child
    }
    const { screen, t } = port([], { spawnHelper: hung, upWaitMs: 100 })
    const first = performance.now()
    const shot = await screen.capture({ w: 1280, h: 800 }, [])
    expect(performance.now() - first).toBeGreaterThanOrEqual(95)
    // A start that outlasted one wait isn't waited for again.
    const second = performance.now()
    await screen.capture({ w: 1280, h: 800 }, [])
    expect(performance.now() - second).toBeLessThan(50)
    expect(shot.dataUrl).toBe('data:image/jpeg;base64,SOURCES')
    expect(t.hides).toBe(2)
    expect(Object.keys(shot.ms!)).toContain('hide')
    expect(await screen.changes!()).toBeNull()
    expect(screen.live!()).toBe(false)
    expect(screen.keepsAppOut!()).toBe(false)
    await expect(screen.capture({ w: 1280, h: 800 }, [], undefined, { withoutApp: true })).rejects.toThrow("can't be left out")
  })

  test('with no helper built, it captures as before and never tries the stream', async () => {
    const { screen, t } = port([], { spawnHelper: null })
    expect(await screen.watchable!()).toBe(false)
    expect((await screen.capture({ w: 1280, h: 800 }, [])).dataUrl).toBe('data:image/jpeg;base64,SOURCES')
    expect(await screen.changes!()).toBeNull()
    expect(t.hides).toBe(1)
  })

  test("a helper that can't be started falls back instead of crashing the app", async () => {
    const { screen, t } = port([], { spawnHelper: () => spawn(join(tmpdir(), 'no-such-dir', 'chat-v2-capture')) })
    expect(await screen.watchable!()).toBe(false)
    expect(t.warnings.join('\n')).toContain('the capture helper could not start')
    expect((await screen.capture({ w: 1280, h: 800 }, [])).dataUrl).toBe('data:image/jpeg;base64,SOURCES')
  })

  test('without Screen Recording permission the helper is never asked to capture, and stays off', async () => {
    const { screen, requests, t } = port(['--no-permission'])
    expect(await screen.watchable!()).toBe(false)
    expect(await screen.watchable!()).toBe(false)
    await screen.capture({ w: 1280, h: 800 }, [])
    expect(requests()).toEqual([])
    expect(t.spawns).toBe(1)
    expect(t.fallbacks).toBe(1)
    expect(t.warnings).toEqual(['Screen stream not used: the capture helper has no Screen Recording permission'])
  })

  test('on a macOS without ScreenCaptureKit it captures as before', async () => {
    const { screen, t } = port(['--old-os'])
    expect(await screen.watchable!()).toBe(false)
    expect(t.warnings).toEqual(["Screen stream not used: ScreenCaptureKit isn't available on macOS 12.2.0"])
  })

  test('a helper that dies mid-capture is replaced by getSources for that shot; after three failures the stream stays off', async () => {
    const { screen, t } = port(['--die-on-grab'])
    for (let i = 0; i < 3; i++) {
      expect(await screen.watchable!()).toBe(true)
      expect((await screen.capture({ w: 1280, h: 800 }, [])).dataUrl).toBe('data:image/jpeg;base64,SOURCES')
    }
    expect(await screen.watchable!()).toBe(false)
    expect(t.spawns).toBe(3)
    expect(t.warnings[0]).toContain('the capture helper stopped')
  })

  test('the stream closes after a while unused, and when told to (a reply ending)', async () => {
    const { screen, requests } = port([], { idleMs: 150 })
    expect(await screen.watchable!()).toBe(true)
    await sleep(300)
    expect(screen.live!()).toBe(false)
    expect(requests()).toEqual([`start 69733378 ${SELF_PID} 2880 1800`, 'stop'])
    expect(await screen.watchable!()).toBe(true)
    screen.release!()
    expect(screen.live!()).toBe(false)
    await sleep(50)
    expect(requests().slice(2)).toEqual([`start 69733378 ${SELF_PID} 2880 1800`, 'stop'])
  })

  test('a stream opened ahead of a reply closes after its own idle time; a capture renews it with the usual one', async () => {
    const { screen, requests } = port([], { idleMs: 400, prewarmIdleMs: 100 })
    screen.prepare!()
    await sleep(250)
    expect(requests()).toEqual([`start 69733378 ${SELF_PID} 2880 1800`, 'stop'])
    screen.prepare!()
    await sleep(50)
    await screen.capture({ w: 1280, h: 800 }, [])
    await sleep(200)
    expect(screen.live!()).toBe(true)
    await sleep(350)
    expect(screen.live!()).toBe(false)
  })

  test('closing (quitting) ends the helper process, and nothing starts it again', async () => {
    const { screen, t } = port()
    expect(await screen.watchable!()).toBe(true)
    const child = children.at(-1)!
    const exited = new Promise((r) => child.once('exit', r))
    screen.close!()
    expect(screen.live!()).toBe(false)
    await exited
    expect(await screen.watchable!()).toBe(false)
    screen.prepare!()
    await sleep(50)
    expect(t.spawns).toBe(1)
  })

  // The overlay blinking on a Mac: every capture that doesn't come from the stream hides it
  // (setOpacity(0), a frame's wait, getSources, then back), so a capture must not miss a stream
  // that is starting, or one that closed while the model took its time over the next step.
  test('a capture while the stream is still starting waits for it, and never hides the overlay', async () => {
    const { screen, requests, t } = port()
    screen.prepare!()
    const shot = await screen.capture({ w: 1280, h: 800 }, [])
    expect(shot.dataUrl).toBe(`data:image/jpeg;base64,${Buffer.from('SCK').toString('base64')}`)
    expect(t.hides).toBe(0)
    expect(t.fallbacks).toBe(0)
    expect(requests()).toEqual([`start 69733378 ${SELF_PID} 2880 1800`, 'grab 1280 800 [] null 2880'])
  })

  test('a step after a long think captures from the stream, without hiding the overlay', async () => {
    const { screen, t } = port([], { idleMs: 100 })
    expect(await screen.watchable!()).toBe(true)
    await screen.capture({ w: 1280, h: 800 }, [])
    // The model takes longer than the idle time over its next step.
    await sleep(250)
    const shot = await screen.capture({ w: 1280, h: 800 }, [])
    expect(shot.dataUrl).toBe(`data:image/jpeg;base64,${Buffer.from('SCK').toString('base64')}`)
    expect(t.hides).toBe(0)
  })

  test('a stream held for a reply stays open however long the model thinks, until released', async () => {
    const { screen, requests } = port([], { idleMs: 100, prewarmIdleMs: 100 })
    screen.hold!()
    expect(await screen.watchable!()).toBe(true)
    await screen.capture({ w: 1280, h: 800 }, [])
    await sleep(300)
    expect(screen.live!()).toBe(true)
    expect(requests().filter((r) => r === 'stop')).toEqual([])
    screen.release!()
    expect(screen.live!()).toBe(false)
    // Released, it's back to closing when idle.
    expect(await screen.watchable!()).toBe(true)
    await sleep(300)
    expect(screen.live!()).toBe(false)
  })

  test("where only the app's windows could be left out, the overlay is still hidden and the glance can't rely on the stream", async () => {
    const { screen, t } = port(['--no-app'])
    expect(await screen.watchable!()).toBe(true)
    expect(screen.keepsAppOut!()).toBe(false)
    const shot = await screen.capture({ w: 1280, h: 800 }, [])
    expect(shot.dataUrl).toBe(`data:image/jpeg;base64,${Buffer.from('SCK').toString('base64')}`)
    expect(t.hides).toBe(1)
    await expect(screen.capture({ w: 1280, h: 800 }, [], undefined, { withoutApp: true })).rejects.toThrow("doesn't leave this app's windows out")
  })
})

/** A screen that changes for `ms` from now, a frame every 40 ms, then holds still. */
const changingFor = (ms: number) => {
  const t0 = performance.now()
  return (): ScreenChanges => {
    const e = performance.now() - t0
    const last = Math.min(e, ms)
    return { count: Math.floor(last / 40) + 1, stillMs: e - last }
  }
}

describe('mac computer service with the stream', () => {
  const service = (opts: { stream?: boolean; windows?: Parameters<typeof fakeDesktop>[0] } = {}) => {
    const desktop = fakeDesktop(opts.windows ?? [win({ hwnd: 1, pid: 100, exe: 'TextEdit', title: 'Untitled', bundle: 'com.apple.TextEdit' })], 'darwin', { stream: opts.stream ?? true })
    const dir = mkdtempSync(join(tmpdir(), 'chat-v2-cu-sck-'))
    writeFileSync(join(dir, 'config.json'), '{}')
    const paths = AppPaths.layer(dir)
    const settings = SettingsStore.layer({ encrypt: (s) => s, decrypt: (s) => s }).pipe(Layer.provide(paths))
    const runtime = ManagedRuntime.make(Computer.layer(desktop.ports).pipe(Layer.provide(Layer.mergeAll(settings, paths))))
    const run = <A, E>(eff: Effect.Effect<A, E, Computer>) => runtime.runPromise(eff)
    const tool = (name: string, args: object = {}, watch?: boolean) =>
      run(Computer.use((c) => runComputerTool(c, name, JSON.stringify(args), watch === undefined ? {} : { watch })))
    return { desktop, run, tool }
  }

  test('a click waits only until the stream says the screen is still, and the overlay is never hidden', async () => {
    const t = service()
    await t.run(Computer.use((c) => c.begin('r')))
    await t.tool('computer_screenshot')
    const started = performance.now()
    const out = await t.tool('computer_click', { x: 100, y: 100, target: 'File' })
    const took = performance.now() - started
    // The glide, then SETTLE_QUIET_MS of stillness after the click; no fixed 550 ms, no two looks.
    expect(took).toBeGreaterThanOrEqual(GLIDE_MS + SETTLE_QUIET_MS - 5)
    expect(took).toBeLessThan(GLIDE_MS + SETTLE_QUIET_MS + 150)
    expect(out.text).toContain('It is current: it was taken once the screen stopped changing.')
    expect(t.desktop.changeLooks).toBeGreaterThan(0)
    expect(t.desktop.hides).toBe(0)
    expect(t.desktop.watchedWhileSpinning).toBe(0)
  })

  test('a screen still changing after a click keeps it waiting until it has held still', async () => {
    const t = service()
    await t.run(Computer.use((c) => c.begin('r')))
    await t.tool('computer_screenshot')
    const click = t.desktop.ports.driver!.click
    let clicked = 0
    t.desktop.ports.driver!.click = async (...a) => {
      await click(...a)
      clicked = performance.now()
      // A menu animating open for 400 ms.
      t.desktop.screenChanges = changingFor(400)
    }
    const out = await t.tool('computer_click', { x: 100, y: 100, target: 'Menu' })
    const took = performance.now() - clicked
    expect(took).toBeGreaterThanOrEqual(400 + SETTLE_QUIET_MS - 20)
    expect(took).toBeLessThan(400 + SETTLE_QUIET_MS + 150)
    expect(out.text).toContain('It is current')
  })

  test('a screen that never stops changing gives up at the cap, and says so', async () => {
    const t = service()
    await t.run(Computer.use((c) => c.begin('r')))
    await t.tool('computer_screenshot')
    t.desktop.screenChanges = changingFor(60_000)
    const started = performance.now()
    const out = await t.tool('computer_scroll', { x: 100, y: 100, direction: 'down', amount: 3 })
    expect(performance.now() - started).toBeGreaterThanOrEqual(SETTLE_MAX_MS)
    expect(out.text).toContain('The screen was still changing when it was taken')
  })

  test('computer_wait ends soon after the screen changes and holds still', async () => {
    const t = service()
    await t.run(Computer.use((c) => c.begin('r')))
    // Still for 300 ms, then a page loading for 300 ms, then still.
    const t0 = performance.now()
    const load = changingFor(600)
    t.desktop.screenChanges = () => (performance.now() - t0 < 300 ? { count: 0, stillMs: 60_000 } : load())
    const out = await t.tool('computer_wait', { seconds: 10 })
    const took = performance.now() - t0
    expect(took).toBeGreaterThanOrEqual(600 + WAIT_QUIET_MS - 100)
    expect(took).toBeLessThan(600 + WAIT_QUIET_MS + 400)
    expect(out.text).toContain('the screen changed, then held still, so it is ready to act on.')
  })

  test('computer_wait on a still screen ends after WAIT_STILL_MS', async () => {
    const t = service()
    await t.run(Computer.use((c) => c.begin('r')))
    const started = performance.now()
    const out = await t.tool('computer_wait', { seconds: 10 })
    expect(performance.now() - started).toBeGreaterThanOrEqual(WAIT_STILL_MS - 20)
    expect(performance.now() - started).toBeLessThan(WAIT_STILL_MS + 400)
    expect(out.text).toContain('nothing on the screen changed in that time.')
  })

  test('a run that was told the screen cannot be watched waits the whole time, stream or not', async () => {
    const t = service()
    await t.run(Computer.use((c) => c.begin('r')))
    const started = performance.now()
    const out = await t.tool('computer_wait', { seconds: 1 }, false)
    expect(performance.now() - started).toBeGreaterThanOrEqual(1000 - 5)
    expect(out.text).toContain("the whole time: the screen can't be watched for changes here.")
  })

  test('opening an app waits for its window to finish drawing, past the fixed second', async () => {
    const t = service()
    await t.run(Computer.use((c) => c.begin('r')))
    await t.tool('computer_screenshot')
    const launch = t.desktop.ports.driver!.launch
    let shown = 0
    t.desktop.ports.driver!.launch = async (id) => {
      await launch(id)
      shown = performance.now()
      t.desktop.screenChanges = changingFor(1500)
    }
    const out = await t.tool('computer_open_app', { name: 'davinci' })
    const took = performance.now() - shown
    expect(took).toBeGreaterThanOrEqual(1500 + WAIT_QUIET_MS - 100)
    expect(took).toBeLessThan(3000 + 300)
    expect(out.text).toContain('It is current')
  })

  test('getting ready waits for the chat to leave the window list, not a fixed time; without the stream it waits as before', async () => {
    const windows = () => [win({ hwnd: 3, pid: SELF_PID, exe: 'chat-v2', title: 'chat-v2' }), win({ hwnd: 1, pid: 100, exe: 'TextEdit', title: 'Untitled' })]
    const t = service({ windows: windows() })
    const t0 = performance.now()
    await t.run(Computer.use((c) => c.begin('r')))
    expect(performance.now() - t0).toBeLessThan(300)
    expect(t.desktop.chat).toEqual(['hide'])

    const old = service({ windows: windows(), stream: false })
    const t1 = performance.now()
    await old.run(Computer.use((c) => c.begin('r')))
    expect(performance.now() - t1).toBeGreaterThanOrEqual(350 - 5)
  })

  test('the glance leaves the chat out: what is under it shows, with no grey and no half-screen cut-off', async () => {
    // The chat over the whole screen, in front, with TextEdit under it.
    const t = service({ windows: [win({ hwnd: 3, pid: SELF_PID, exe: 'chat-v2', title: 'chat-v2' }), win({ hwnd: 1, pid: 100, exe: 'TextEdit', title: 'Untitled' })] })
    t.desktop.state.foreground = 3
    const g = await t.run(Computer.use((c) => c.glance('r')))
    expect(g!.image).not.toBeNull()
    expect(t.desktop.covers).toEqual([[]])
    expect(t.desktop.shots).toEqual([{ fresh: false, chatLeftOut: false, withoutApp: true }])
    expect(g!.text).toContain('Active window: this chat, which minimises when you first act')
    expect(g!.text).toContain('"Untitled" (TextEdit)')
    expect(g!.text).not.toContain('grey')
    expect(t.desktop.hides).toBe(0)
    // Its screenshot is the one the first action aims at.
    await t.run(Computer.use((c) => c.begin('r')))
    expect((await t.tool('computer_click', { x: 100, y: 100, target: 'Text' })).step.ok).toBe(true)
  })

  test("without the stream the glance paints the chat grey, and past half the screen there's no screenshot, as before", async () => {
    const t = service({ windows: [win({ hwnd: 3, pid: SELF_PID, exe: 'chat-v2', title: 'chat-v2' }), win({ hwnd: 1 })] })
    t.desktop.streamUp = false
    const g = await t.run(Computer.use((c) => c.glance('r')))
    expect(g!.image).toBeNull()
    expect(g!.text).toContain("No screenshot yet: this chat's window covers most of the screen.")
  })

  test('without the stream (the helper is missing or failed) actions wait their fixed times', async () => {
    const t = service()
    t.desktop.streamUp = false
    await t.run(Computer.use((c) => c.begin('r')))
    await t.tool('computer_screenshot')
    const started = performance.now()
    await t.tool('computer_click', { x: 100, y: 100, target: 'File' })
    expect(performance.now() - started).toBeGreaterThanOrEqual(GLIDE_MS + 550 - 5)
    const waited = performance.now()
    const out = await t.tool('computer_wait', { seconds: 1 })
    expect(performance.now() - waited).toBeGreaterThanOrEqual(1000 - 5)
    expect(out.text).toContain('the whole time')
  })

  test('the run is told it can watch the screen only when the stream can come up, and never before the permissions are checked', async () => {
    const t = service()
    t.desktop.ports.permissions = async () => null
    // Nothing looks at the screen (or starts the helper) before the app's own permission check.
    expect(await t.run(Computer.use((c) => c.canWatch))).toBe(false)
    expect(t.desktop.prepared).toBe(0)
    await t.run(Computer.use((c) => c.begin('r')))
    expect(await t.run(Computer.use((c) => c.canWatch))).toBe(true)
    t.desktop.canStream = false
    t.desktop.streamUp = false
    expect(await t.run(Computer.use((c) => c.canWatch))).toBe(false)
  })

  test('permissions granted in an earlier session let the first reply after launch watch the screen, and glance', async () => {
    const t = service()
    t.desktop.ports.permissions = async () => null
    t.desktop.ports.hasPermissions = () => true
    expect(await t.run(Computer.use((c) => c.canWatch))).toBe(true)
    expect(await t.run(Computer.use((c) => c.glance('r')))).not.toBeNull()
  })

  test('a reply holds the stream from taking control until it ends, which closes it', async () => {
    const t = service()
    await t.run(Computer.use((c) => c.begin('r')))
    expect(t.desktop.held).toBe(1)
    await t.run(Computer.use((c) => c.end('r')))
    expect(t.desktop.released).toBe(1)
  })
})

describe('what the model is told about waiting on a Mac', () => {
  const waitText = (watch?: boolean) => computerTools('darwin', watch === undefined ? {} : { watch }).find((t) => t.function.name === 'computer_wait')!.function.description

  test('with the stream it hears a long wait is cheap, as on Windows; without it, that it waits the whole time', () => {
    expect(waitText(true)).toBe(computerTools('win32').find((t) => t.function.name === 'computer_wait')!.function.description)
    expect(waitText(false)).toContain('it waits the whole time')
    expect(waitText()).toContain('it waits the whole time')
    expect(computerInstructions('darwin', { borrowPointer: true, watch: true })).toContain('it returns as soon as the screen is ready, so a long wait costs nothing')
    expect(computerInstructions('darwin', { borrowPointer: true, watch: true })).not.toContain("can't tell when the screen is ready")
    expect(computerInstructions('darwin', { borrowPointer: true, watch: false })).toContain("can't tell when the screen is ready")
    // Windows is told the same either way.
    expect(computerInstructions('win32', { borrowPointer: true, watch: false })).toBe(computerInstructions('win32', { borrowPointer: true, watch: true }))
  })
})
