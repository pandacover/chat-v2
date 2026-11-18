import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { SHOT_WIDTH, TYPE_CHUNK, makeControl, typeChunks, type Control } from '../../src/main/computer/control'
import type { Platform } from '../../src/main/computer/platform/types'
import { fakePlatform, sleep } from './fakes'

const run = <A, E>(p: Platform, f: (c: Control) => Effect.Effect<A, E>) => Effect.runPromise(f(makeControl(p)))

// A 2560x1440 monitor at x=1920, captured down to 1280x720.
const secondMonitor = {
  screenshot: async () => ({
    data: '',
    mime: 'image/jpeg' as const,
    imageWidth: 1280,
    imageHeight: 720,
    screen: { x: 1920, y: 0, width: 2560, height: 1440 },
    window: { title: 'Notepad', process: 'notepad' }
  })
}

describe('Control', () => {
  test('needs a screenshot before mapping coordinates', async () => {
    const { p } = fakePlatform()
    const r = await run(p, (c) => Effect.result(c.toScreen(10, 10)))
    expect(r._tag).toBe('Failure')
  })

  test("maps screenshot pixels to the monitor's physical pixels, and back", async () => {
    const { p } = fakePlatform(secondMonitor)
    const c = makeControl(p)
    const pt = await Effect.runPromise(Effect.andThen(c.screenshot(), c.toScreen(640, 360)))
    expect(pt).toEqual({ x: 1920 + 1280, y: 720 })
    expect(await Effect.runPromise(c.rectToScreen({ x: 10, y: 20, width: 30, height: 40 }))).toEqual({ x: 1940, y: 40, width: 60, height: 80 })
    expect(c.rectToImage({ x: 1940, y: 40, width: 60, height: 80 })).toEqual({ x: 10, y: 20, width: 30, height: 40 })
  })

  test('pauses when the user moves the mouse between actions', async () => {
    const f = fakePlatform()
    const r = await run(f.p, (c) =>
      Effect.gen(function* () {
        yield* c.click(100, 100, 'left', 1)
        f.moveMouse(400, 380) // the human grabs the mouse
        return yield* Effect.result(c.click(120, 120, 'left', 1))
      })
    )
    expect(r._tag).toBe('Failure')
    expect(f.calls).toEqual(['click 100,100'])
  })

  test('tiny jitter is not a takeover', async () => {
    const f = fakePlatform()
    await run(f.p, (c) =>
      Effect.gen(function* () {
        yield* c.click(100, 100, 'left', 1)
        f.moveMouse(104, 103)
        yield* c.click(120, 120, 'left', 1)
      })
    )
    expect(f.calls).toEqual(['click 100,100', 'click 120,120'])
  })

  test('refuses to type into an elevated window it can\'t control', async () => {
    const f = fakePlatform({ restoreFocus: async () => ({ title: 'Admin PowerShell', process: 'powershell', blocked: true }) })
    const r = await run(f.p, (c) => Effect.result(c.type('hello')))
    expect(r._tag).toBe('Failure')
    expect(r._tag === 'Failure' && (r.failure as { message?: string }).message).toContain('running as administrator')
    expect(f.calls).toEqual([])
  })

  test('Stop lands between typed chunks, and input works again after resume', async () => {
    const f = fakePlatform({
      type: async (t) => {
        await sleep(t.length * 4)
        f.calls.push(`type ${t}`)
      }
    })
    const r = await run(f.p, (c) =>
      Effect.gen(function* () {
        setTimeout(() => c.cancel(), 100)
        const first = yield* Effect.result(c.type('a'.repeat(400)))
        const blocked = yield* Effect.result(c.click(5, 5, 'left', 1))
        c.resume()
        yield* c.type('ok')
        return { first, blocked }
      })
    )
    expect(r.first._tag).toBe('Failure')
    expect(r.blocked._tag).toBe('Failure')
    const typed = f.calls.filter((x) => x.startsWith('type a')).join('').replaceAll('type ', '')
    expect(typed.length).toBeLessThanOrEqual(2 * TYPE_CHUNK)
    expect(f.calls.at(-1)).toBe('type ok')
    expect(f.calls.some((x) => x.startsWith('click'))).toBe(false)
  })

  test("Stop also cancels the host's in-flight step", async () => {
    let cancels = 0
    const f = fakePlatform({ cancel: async () => void cancels++ })
    await run(f.p, (c) => Effect.sync(() => c.cancel()))
    expect(cancels).toBe(1)
  })

  test('typing chunks never split an emoji', () => {
    expect(typeChunks('ab😀cd', 3)).toEqual(['ab😀', 'cd'])
    expect(typeChunks('')).toEqual([])
  })

  test('screenshots are captured at 1024 px wide', async () => {
    let asked = 0
    const f = fakePlatform()
    const shot = f.p.screenshot
    f.p.screenshot = (w) => {
      asked = w
      return shot(w)
    }
    await run(f.p, (c) => c.screenshot())
    expect(asked).toBe(SHOT_WIDTH)
    expect(SHOT_WIDTH).toBe(1024)
  })

  test('a click by UI Automation pattern does not arm the takeover check; a fallback click does', async () => {
    const f = fakePlatform({ invoke: async () => 'clicked' })
    const c = makeControl(f.p)
    await Effect.runPromise(c.invoke(3))
    // The fallback click went to the element's centre (100,100 40x20): the user moving away is a takeover.
    f.moveMouse(500, 500)
    const r = await Effect.runPromise(Effect.result(c.keys('enter')))
    expect(r._tag === 'Failure' && r.failure._tag).toBe('UserTookOver')
  })
})
