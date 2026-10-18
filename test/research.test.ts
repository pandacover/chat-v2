import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { runTool } from '../src/main/agent'
import { READ_JS, RESULTS_JS, SNAPSHOT_JS, type BrowserApi, type Reading } from '../src/main/services/Browser'

const page = (text: string): Reading => ({ url: 'https://wiki.test/camera', title: 'Camera - Game Wiki', text })

const fakeBrowser = (reading: Reading, log: string[] = []): BrowserApi =>
  ({
    search: (q: string) =>
      Effect.sync(() => {
        log.push(`search ${q}`)
        return [
          { title: 'Camera settings', url: 'https://wiki.test/camera', snippet: 'Change the camera in Settings.' },
          { title: 'Forum thread', url: 'https://forum.test/1', snippet: '' }
        ]
      }),
    read: (url: string | null) => Effect.sync(() => (log.push(`read ${url}`), reading)),
    status: () => Effect.void
  }) as unknown as BrowserApi

const run = (browser: BrowserApi, name: string, args: object) => Effect.runPromise(runTool(browser, new Map(), name, JSON.stringify(args)))

describe('research tools', () => {
  test('the scripts that run in pages are valid JavaScript', () => {
    for (const js of [READ_JS, RESULTS_JS, SNAPSHOT_JS]) expect(() => new Function(`return ${js}`)).not.toThrow()
  })

  test('browser_search lists results and says to read them', async () => {
    const log: string[] = []
    const out = await run(fakeBrowser(page(''), log), 'browser_search', { query: 'brawlhalla camera settings' })
    expect(log).toEqual(['search brawlhalla camera settings'])
    expect(out.step.label).toBe('Searched “brawlhalla camera settings”')
    expect(out.text).toContain('1. Camera settings\n   https://wiki.test/camera\n   Change the camera in Settings.')
    expect(out.text).toContain('2. Forum thread\n   https://forum.test/1')
    expect(out.text).toContain('browser_read')
  })

  test('browser_read returns the page text, in parts for long pages', async () => {
    const long = `# Camera\n${'1. Open Settings > Controls. '.repeat(500)}`
    const out = await run(fakeBrowser(page(long)), 'browser_read', { url: 'https://wiki.test/camera' })
    expect(out.step).toMatchObject({ label: 'Read Camera - Game Wiki', detail: 'wiki.test' })
    expect(out.text).toContain(`Characters 0–10000 of ${long.length}:`)
    expect(out.text).toContain('[More below: browser_read with offset 10000 to continue.]')
    const next = await run(fakeBrowser(page(long)), 'browser_read', { offset: 10000 })
    expect(next.text).toContain(`Characters 10000–${long.length}`)
    expect(next.text).not.toContain('More below')
  })

  test('an empty page says so instead of looking like an answer', async () => {
    const out = await run(fakeBrowser(page('')), 'browser_read', {})
    expect(out.text).toContain('No readable text')
  })
})
