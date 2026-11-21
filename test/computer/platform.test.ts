import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMdfindQuery, macCombo, makeElementIds, mouseFlags } from '../../src/main/computer/platform/macos'
import { HOST_CS, HOST_PS1 } from '../../src/main/computer/platform/hostSource'
import type { ScreenRect, UiElement } from '../../src/main/computer/platform/types'
import { HostTimeout, buildSearchSql, hostTimeout, installHost, makeHostChannel, makeWindowsPlatform, startHost } from '../../src/main/computer/platform/windows'

const sent = () => {
  const lines: Array<{ id: number; method: string; params: Record<string, unknown> }> = []
  const ch = makeHostChannel((l) => void lines.push(JSON.parse(l)))
  ch.onLine('{"ready":true}')
  return { ch, lines }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('file search queries', () => {
  test('Windows Search SQL escapes quotes and wildcards and filters noise', () => {
    const sql = buildSearchSql({ name: "bob's 50%_report", extensions: ['pdf', '.DOCX'], kind: 'file', limit: 500 }, 'C:\\Users\\me')
    expect(sql).toContain('SELECT TOP 100 ')
    expect(sql).toContain("SCOPE='file:C:/Users/me'")
    expect(sql).toContain("System.FileName LIKE '%bob''s%'")
    expect(sql).toContain("System.FileName LIKE '%50report%'")
    expect(sql).toContain("System.FileExtension = '.pdf' OR System.FileExtension = '.docx'")
    expect(sql).toContain("System.ItemType <> 'Directory'")
    expect(sql).toContain("NOT LIKE '%\\node_modules\\%'")
  })

  test('contents and recency', () => {
    const sql = buildSearchSql({ contains: "quarterly 'plan'", modifiedWithinDays: 7 }, 'C:\\Users\\me')
    expect(sql).toContain("FREETEXT('quarterly ''plan''')")
    expect(sql).toMatch(/System\.DateModified >= '\d{4}-\d\d-\d\d \d\d:\d\d:\d\d'/)
  })

  test('mdfind query', () => {
    expect(buildMdfindQuery({ name: 'tax', extensions: ['pdf'], kind: 'file', modifiedWithinDays: 30 })).toBe(
      'kMDItemFSName == "*tax*"cd && (kMDItemFSName == "*.pdf"c) && kMDItemContentType != "public.folder" && kMDItemFSContentChangeDate >= $time.today(-30)'
    )
    expect(buildMdfindQuery({ name: 'a"b*' })).toBe('kMDItemFSName == "*ab*"cd')
  })
})

describe('host channel', () => {
  test('matches out-of-order responses to their requests by id', async () => {
    const { ch, lines } = sent()
    const slow = ch.call('uiTree', { max: 10 })
    const fast = ch.call('cursor')
    await tick()
    expect(lines.map((l) => l.method)).toEqual(['uiTree', 'cursor'])
    // The host answers the cheap query first.
    ch.onLine(JSON.stringify({ id: lines[1]!.id, ok: true, result: { x: 1, y: 2 } }))
    expect(await fast).toEqual({ x: 1, y: 2 })
    expect(ch.pending()).toBe(1)
    ch.onLine(JSON.stringify({ id: lines[0]!.id, ok: true, result: { elements: [] } }))
    expect(await slow).toEqual({ elements: [] })
    expect(ch.pending()).toBe(0)
  })

  test('waits for ready before writing', async () => {
    const lines: string[] = []
    const ch = makeHostChannel((l) => void lines.push(l))
    const p = ch.call('ping')
    await tick()
    expect(lines).toHaveLength(0)
    ch.onLine('{"ready":true}')
    await tick()
    expect(lines).toHaveLength(1)
    ch.onLine(JSON.stringify({ id: JSON.parse(lines[0]!).id, ok: true, result: 'pong' }))
    expect(await p).toBe('pong')
  })

  test('a cancelled call rejects with an Error named Cancelled', async () => {
    const { ch, lines } = sent()
    const typing = ch.call('type', { text: 'long' })
    await tick()
    ch.onLine(JSON.stringify({ id: lines[0]!.id, ok: false, error: 'Cancelled' }))
    const e = await typing.catch((x: Error) => x)
    expect(e).toBeInstanceOf(Error)
    expect((e as Error).name).toBe('Cancelled')
  })

  test('other errors keep their message; junk and unknown ids are ignored', async () => {
    const { ch, lines } = sent()
    const p = ch.call('invoke', { id: 9 })
    await tick()
    ch.onLine('not json')
    ch.onLine('{"id":999,"ok":true,"result":1}')
    ch.onLine(JSON.stringify({ id: lines[0]!.id, ok: false, error: 'Element 9 is stale' }))
    const e = (await p.catch((x: Error) => x)) as Error
    expect(e.message).toBe('Element 9 is stale')
    expect(e.name).toBe('Error')
  })

  test('a call that hangs fails with a clear error and asks for a restart; quick calls do not', async () => {
    const lines: Array<{ id: number; method: string }> = []
    const timedOut: string[] = []
    const ch = makeHostChannel((l) => void lines.push(JSON.parse(l)), {
      timeout: (m) => (m === 'invoke' ? 30 : 1000),
      onTimeout: (m) => void timedOut.push(m)
    })
    ch.onLine('{"ready":true}')
    const hung = ch.call('invoke', { id: 3 }).catch((x: Error) => x)
    const quick = ch.call('cursor')
    await tick()
    ch.onLine(JSON.stringify({ id: lines[1]!.id, ok: true, result: { x: 0, y: 0 } }))
    expect(await quick).toEqual({ x: 0, y: 0 })
    const e = (await hung) as Error
    expect(e).toBeInstanceOf(HostTimeout)
    expect(e.message).toContain('didn\'t finish "invoke"')
    expect(e.message).toContain('restarted')
    expect(timedOut).toEqual(['invoke'])
    expect(ch.pending()).toBe(0)
    // A late answer to the timed-out call is ignored.
    ch.onLine(JSON.stringify({ id: lines[0]!.id, ok: true, result: 'invoked' }))
  })

  test('default timeouts: longer for control reads and search, sleep by its length', () => {
    expect(hostTimeout('invoke')).toBe(15_000)
    expect(hostTimeout('uiTree')).toBeGreaterThan(hostTimeout('invoke'))
    expect(hostTimeout('sql')).toBeGreaterThan(hostTimeout('invoke'))
    expect(hostTimeout('sleep', { ms: 4000 })).toBeGreaterThan(4000)
  })

  test('a dead host fails waiting and later calls', async () => {
    const { ch } = sent()
    const p = ch.call('screenshot').catch((x: Error) => x)
    await tick()
    ch.fail(new Error('host exited'))
    expect((await p) as Error).toHaveProperty('message', 'host exited')
    expect((await ch.call('ping').catch((x: Error) => x)) as Error).toHaveProperty('message', 'host exited')
  })
})

describe('element ids (macOS registry)', () => {
  test('ids continue across lists; old ones stay valid until dropped, then read as stale', () => {
    const ids = makeElementIds<UiElement>(3)
    const el = (name: string) => ({ type: 'Button', name, x: 0, y: 0, width: 10, height: 10 })
    const first = ids.add([el('a'), el('b')])
    const second = ids.add([el('c'), el('d')])
    expect(first.map((e) => e.id)).toEqual([1, 2])
    expect(second.map((e) => e.id)).toEqual([3, 4])
    expect(ids.get(2).name).toBe('b') // from the older list, still the same control
    expect(() => ids.get(1)).toThrow('Element 1 is stale or unknown (not in a recent control list); call ui_elements again')
    expect(() => ids.get(99)).toThrow('call ui_elements again')
  })
})

describe('macOS input helpers', () => {
  test('key combos: key codes, single characters, punctuation by name, plus; words that are no key fail', () => {
    expect(macCombo('cmd+shift+left')).toEqual({ mods: ['command down', 'shift down'], code: 123 })
    expect(macCombo('ctrl+/')).toEqual({ mods: ['control down'], char: '/' })
    expect(macCombo('cmd+plus')).toEqual({ mods: ['command down'], char: '+' })
    expect(macCombo('cmd++')).toEqual({ mods: ['command down'], char: '+' })
    expect(macCombo('+')).toEqual({ mods: [], char: '+' })
    expect(macCombo('cmd+bracketleft')).toEqual({ mods: ['command down'], char: '[' })
    expect(() => macCombo('cmd+banana')).toThrow('Unknown key "banana"')
    expect(() => macCombo('cmd+a+b')).toThrow('one key at a time')
    expect(() => macCombo('cmd+shift')).toThrow('No key')
  })

  test('click modifiers become CGEvent flags', () => {
    expect(mouseFlags([])).toBe(0)
    expect(mouseFlags(['cmd'])).toBe(0x100000)
    expect(mouseFlags(['shift', 'alt', 'ctrl'])).toBe(0x20000 | 0x80000 | 0x40000)
  })
})

describe('host install', () => {
  test('writes the inlined scripts once into a folder named by their hash', () => {
    const base = mkdtempSync(join(tmpdir(), 'cv2-host-'))
    try {
      const script = installHost(base)
      expect(readFileSync(script, 'utf8')).toBe(HOST_PS1)
      expect(readFileSync(join(script, '..', 'host.cs'), 'utf8')).toBe(HOST_CS)
      expect(installHost(base)).toBe(script)
      expect(HOST_CS).toContain('public static class ChatV2Host')
      expect(HOST_PS1).toContain('[ChatV2Host]::Serve()')
      // Hold-to-talk and full-screen detection are not part of computer use.
      expect(HOST_CS).not.toMatch(/watchKeys|Fullscreen|Tomo/)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

// The real host, read-only: no clicks, keys, typing, scrolls, drags or focus changes. The
// diagnostic "sleep" holds the serial lane to check the lanes and cancel.
describe.skipIf(process.platform !== 'win32')('windows host process', () => {
  const base = join(tmpdir(), 'cv2-host-test')
  const timed = async <T>(p: Promise<T>) => {
    const t = performance.now()
    const v = await p
    return { v, ms: performance.now() - t }
  }

  test(
    'compiles once, then starts from the cached DLL',
    async () => {
      rmSync(base, { recursive: true, force: true })
      const script = installHost(base)
      const first = startHost(script, process.pid)
      const cold = await timed(first.call('ping'))
      first.stop()
      expect(existsSync(script)).toBe(true)
      const second = startHost(script, process.pid)
      const warm = await timed(second.call('ping'))
      second.stop()
      console.log(`[host] first start (compile) ${Math.round(cold.ms)} ms, cached start ${Math.round(warm.ms)} ms`)
      expect(cold.v).toBe('pong')
      expect(warm.v).toBe('pong')
      expect(warm.ms).toBeLessThan(cold.ms)
    },
    120_000
  )

  test(
    'read-only calls: screenshot, windows, foreground, cursor, ui tree, element at, search',
    async () => {
      const host = startHost(installHost(base), process.pid)
      try {
        const shot = await timed(host.call<{ data: string; imageWidth: number; imageHeight: number; screen: ScreenRect; window: { title: string } }>('screenshot', { maxWidth: 1024 }))
        expect(shot.v.imageWidth).toBeLessThanOrEqual(1024)
        expect(shot.v.screen.width).toBeGreaterThan(0)
        expect(Buffer.from(shot.v.data, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8') // JPEG
        const wins = await timed(host.call<Array<{ title: string; process: string }>>('windows'))
        expect(Array.isArray(wins.v)).toBe(true)
        const fg = await host.call<{ title: string; process: string }>('foreground')
        expect(typeof fg.process).toBe('string')
        const remembered = await host.call<{ title: string }>('remember')
        expect(typeof remembered.title).toBe('string')
        const cursor = await host.call<{ x: number; y: number }>('cursor')
        expect(typeof cursor.x).toBe('number')
        const tree = await timed(host.call<{ elements: UiElement[]; window: { title: string } }>('uiTree', { max: 60 }))
        expect(Array.isArray(tree.v.elements)).toBe(true)
        const at = await timed(host.call<ScreenRect | null>('elementAt', { x: shot.v.screen.x + 40, y: shot.v.screen.y + 40 }))
        expect(at.v === null || typeof at.v.width === 'number').toBe(true)
        // The user's Point: the window under a point (past Tomo's own), and its control if any.
        const centre = { x: shot.v.screen.x + Math.round(shot.v.screen.width / 2), y: shot.v.screen.y + Math.round(shot.v.screen.height / 2) }
        const pick = await timed(host.call<{ window: { title: string; process: string }; control: (ScreenRect & { type: string; name: string }) | null } | null>('pointAt', { ...centre, budgetMs: 600 }))
        expect(pick.v === null || typeof pick.v.window.process === 'string').toBe(true)
        if (pick.v?.control) {
          expect(typeof pick.v.control.type).toBe('string')
          expect(pick.v.control.x <= centre.x && centre.x < pick.v.control.x + pick.v.control.width).toBe(true)
        }
        console.log(`[host] point at ${Math.round(pick.ms)} ms: ${pick.v ? `${pick.v.window.process}, ${pick.v.control ? `${pick.v.control.type} "${pick.v.control.name.slice(0, 30)}"` : 'no control'}` : 'no window'}`)
        const search = await timed(host.call<unknown[]>('sql', { query: buildSearchSql({ extensions: ['pdf'], limit: 3 }) }))
        expect(Array.isArray(search.v)).toBe(true)
        console.log(
          `[host] screenshot ${Math.round(shot.ms)} ms (${shot.v.imageWidth}x${shot.v.imageHeight} of ${shot.v.screen.width}x${shot.v.screen.height}, "${shot.v.window.title.slice(0, 40)}"), ` +
            `windows ${Math.round(wins.ms)} ms (${wins.v.length}), ui tree ${Math.round(tree.ms)} ms (${tree.v.elements.length}), ` +
            `element at ${Math.round(at.ms)} ms, search ${Math.round(search.ms)} ms (${search.v.length})`
        )
      } finally {
        host.stop()
      }
    },
    120_000
  )

  test(
    'read-only: region shots, the pointer, control state, another window, focus, key names',
    async () => {
      const host = startHost(installHost(base), process.pid)
      try {
        type Shot = { data: string; imageWidth: number; imageHeight: number; screen: ScreenRect; cursor?: { x: number; y: number } }
        const full = await host.call<Shot>('screenshot', { maxWidth: 1024 })
        expect(full.cursor && typeof full.cursor.x).toBe('number')
        // A region of the monitor: its own rect, at most 1:1, inside the box asked for.
        const region = { rx: full.screen.x + 10, ry: full.screen.y + 20, rw: 300, rh: 200 }
        const z = await timed(host.call<Shot>('screenshot', { maxWidth: 1024, maxHeight: 768, ...region }))
        expect(z.v.screen).toEqual({ x: region.rx, y: region.ry, width: 300, height: 200 })
        expect([z.v.imageWidth, z.v.imageHeight]).toEqual([300, 200])
        expect(Buffer.from(z.v.data, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8')
        const tall = await host.call<Shot>('screenshot', { maxWidth: 1024, maxHeight: 100, rx: full.screen.x, ry: full.screen.y, rw: 400, rh: 400 })
        expect([tall.imageWidth, tall.imageHeight]).toEqual([100, 100])
        // Control state comes with the right types where the app reports it.
        const tree = await host.call<{ elements: UiElement[] }>('uiTree', { max: 200 })
        for (const e of tree.elements) {
          if (e.value !== undefined) expect(typeof e.value).toBe('string')
          if (e.checked !== undefined) expect([true, false, 'mixed']).toContain(e.checked)
          if (e.selected !== undefined) expect(e.selected).toBe(true)
          if (e.expanded !== undefined) expect(typeof e.expanded).toBe('boolean')
        }
        const states = tree.elements.filter((e) => e.value !== undefined || e.checked !== undefined || e.selected || e.expanded !== undefined).length
        // Another window, by part of its title, without focusing it.
        const wins = await host.call<Array<{ title: string; process: string; minimized: boolean }>>('windows')
        const other = wins.find((w) => !w.minimized && w.title.length > 3)
        let otherCount = -1
        if (other) {
          const t = await host.call<{ window: { title: string }; elements: UiElement[] }>('uiTree', { max: 40, title: other.title.slice(0, 20) })
          expect(t.window.title.toLowerCase()).toContain(other.title.slice(0, 20).toLowerCase())
          otherCount = t.elements.length
        }
        const none = (await host.call('uiTree', { max: 5, title: 'no window is called this 7f3a' }).catch((e: Error) => e)) as Error
        expect(none.message).toContain('No open window matches')
        const focus = await host.call<{ type: string; name: string } | null>('focused')
        expect(focus === null || typeof focus.type === 'string').toBe(true)
        // Key names: parsed only, nothing is pressed.
        expect(await host.call('parseKeys', { combo: 'ctrl+/' })).toEqual([0x11, 0xbf])
        expect(await host.call('parseKeys', { combo: 'ctrl++' })).toEqual([0x11, 0xbb])
        expect(await host.call('parseKeys', { combo: '+' })).toEqual([0xbb])
        expect(await host.call('parseKeys', { combo: 'Ctrl + Shift + T' })).toEqual([0x11, 0x10, 0x54])
        expect(await host.call('parseKeys', { combo: 'ctrl+`' })).toEqual([0x11, 0xc0])
        expect(await host.call('parseKeys', { combo: 'alt+[' })).toEqual([0x12, 0xdb])
        expect(((await host.call('parseKeys', { combo: 'ctrl+banana' }).catch((e: Error) => e)) as Error).message).toContain('Unknown key "banana"')
        console.log(
          `[host] region shot ${Math.round(z.ms)} ms, ${tree.elements.length} controls (${states} with state), other window "${other?.title.slice(0, 30)}" ${otherCount} controls, focus ${focus ? `${focus.type} "${focus.name.slice(0, 30)}"` : 'none'}`
        )
      } finally {
        host.stop()
      }
    },
    120_000
  )

  test(
    'cheap queries answer while the serial lane is busy; cancel stops the running call and the queued ones',
    async () => {
      const host = startHost(installHost(base), process.pid)
      try {
        await host.call('ping')
        const t0 = performance.now()
        const running = host.call('sleep', { ms: 4000 }).catch((e: Error) => e)
        const queued = host.call('sleep', { ms: 4000 }).catch((e: Error) => e)
        const cursor = await timed(host.call<{ x: number; y: number }>('cursor'))
        expect(typeof cursor.v.x).toBe('number')
        expect(cursor.ms).toBeLessThan(1000)
        await host.call('cancel')
        expect(((await running) as Error).name).toBe('Cancelled')
        expect(((await queued) as Error).name).toBe('Cancelled')
        expect(performance.now() - t0).toBeLessThan(3500) // neither slept its 4 s
        // Calls made after the cancel run normally, and an idle cancel doesn't fail the next call.
        expect(await host.call('sleep', { ms: 10 })).toBe(true)
        await host.call('cancel')
        await new Promise((r) => setTimeout(r, 50))
        expect(await host.call('sleep', { ms: 10 })).toBe(true)
      } finally {
        host.stop()
      }
    },
    120_000
  )

  test(
    'ui tree ids continue across lists; an older id still resolves, an unknown one says stale',
    async () => {
      const host = startHost(installHost(base), process.pid)
      try {
        const a = await host.call<{ elements: UiElement[] }>('uiTree', { max: 20 })
        const b = await host.call<{ elements: UiElement[] }>('uiTree', { max: 20 })
        if (a.elements.length && b.elements.length) {
          expect(b.elements[0]!.id).toBeGreaterThan(a.elements.at(-1)!.id)
          // Read-only: the rect of a control from the first list.
          const r = await host.call<ScreenRect>('elementRect', { id: a.elements[0]!.id }).catch((e: Error) => e)
          if (r instanceof Error) expect(r.message).not.toContain('stale')
        }
        // The caller's id floor carries ids across host restarts.
        const c = await host.call<{ elements: UiElement[] }>('uiTree', { max: 5, firstId: 50_000 })
        for (const e of c.elements) expect(e.id).toBeGreaterThanOrEqual(50_000)
        const e = (await host.call('elementRect', { id: 999_999 }).catch((x: Error) => x)) as Error
        expect(e.message).toBe('Element 999999 is stale or unknown (not in a recent control list); call ui_elements again')
        console.log(`[host] ui tree ids ${a.elements[0]?.id}..${a.elements.at(-1)?.id}, then ${b.elements[0]?.id}.., then ${c.elements[0]?.id}..`)
      } finally {
        host.stop()
      }
    },
    120_000
  )

  test(
    'a call that hangs past its timeout ends the host; the next call starts a new one',
    async () => {
      const ended: number[] = []
      // "uiTree" gets 1 ms, so it always times out; everything else the default.
      const p = makeWindowsPlatform({
        ownerPid: process.pid,
        hostDir: base,
        timeout: (m, params) => (m === 'uiTree' ? 1 : hostTimeout(m, params)),
        track: (proc) => void proc.on('close', () => ended.push(proc.pid ?? 0))
      })
      try {
        const e = (await p.uiTree(10).catch((x: Error) => x)) as Error
        expect(e.name).toBe('HostTimeout')
        expect(e.message).toContain('restarted')
        // A new host answers.
        const again = await p.cursor()
        expect(typeof again.x).toBe('number')
        await new Promise((r) => setTimeout(r, 500))
        expect(ended.length).toBe(1)
      } finally {
        p.dispose()
      }
    },
    120_000
  )
})
