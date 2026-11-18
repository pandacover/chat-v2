import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMdfindQuery } from '../../src/main/computer/platform/macos'
import { HOST_CS, HOST_PS1 } from '../../src/main/computer/platform/hostSource'
import type { ScreenRect, UiElement } from '../../src/main/computer/platform/types'
import { buildSearchSql, installHost, makeHostChannel, startHost } from '../../src/main/computer/platform/windows'

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

  test('a dead host fails waiting and later calls', async () => {
    const { ch } = sent()
    const p = ch.call('screenshot').catch((x: Error) => x)
    await tick()
    ch.fail(new Error('host exited'))
    expect((await p) as Error).toHaveProperty('message', 'host exited')
    expect((await ch.call('ping').catch((x: Error) => x)) as Error).toHaveProperty('message', 'host exited')
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
})
