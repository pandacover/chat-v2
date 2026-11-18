import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Step } from '../src/shared/steps'
import { browserModule } from '../src/main/agent/browser'
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
    status: () => Effect.void,
    release: Effect.sync(() => void log.push('release'))
  }) as unknown as BrowserApi

/** The browser tool set for one pretend reply, called through MCP as Claude Code calls it. */
const connect = async (browser: BrowserApi) => {
  const steps: Step[] = []
  const signal = new AbortController().signal
  const module = browserModule(browser)({ sessionId: 's', messageId: 'm', signal, step: async (s) => void steps.push(s), attach: async () => {} })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await (module.server.instance as unknown as { connect(t: unknown): Promise<void> }).connect(b)
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(a)
  const call = async (name: string, args: object) => {
    const out = (await client.callTool({ name, arguments: args as Record<string, unknown> })) as { content: Array<{ text?: string }> }
    return { text: out.content.map((c) => c.text ?? '').join(''), step: steps.at(-1)! }
  }
  return { module, client, call }
}

describe('research tools', () => {
  test('the scripts that run in pages are valid JavaScript', () => {
    for (const js of [READ_JS, RESULTS_JS, SNAPSHOT_JS]) expect(() => new Function(`return ${js}`)).not.toThrow()
  })

  test('every tool has a description and a search hint for ToolSearch to match', async () => {
    const { client } = await connect(fakeBrowser(page('')))
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['click', 'evaluate', 'history', 'navigate', 'press', 'read', 'record', 'screenshot', 'scroll', 'search', 'snapshot', 'type', 'wait'])
    for (const t of tools) {
      expect(t.description!.length).toBeGreaterThan(20)
      expect(String((t._meta as Record<string, unknown> | undefined)?.['anthropic/searchHint'] ?? '').length).toBeGreaterThan(10)
      // Deferred: none asks to be loaded up front.
      expect((t._meta as Record<string, unknown> | undefined)?.['anthropic/alwaysLoad']).not.toBe(true)
    }
    await client.close()
  })

  test('search lists results and says to read them', async () => {
    const log: string[] = []
    const { client, call } = await connect(fakeBrowser(page(''), log))
    const out = await call('search', { query: 'brawlhalla camera settings' })
    expect(log).toEqual(['search brawlhalla camera settings'])
    expect(out.step).toEqual({ tool: 'browser_search', label: 'Searched “brawlhalla camera settings”', ok: true })
    expect(out.text).toContain('1. Camera settings\n   https://wiki.test/camera\n   Change the camera in Settings.')
    expect(out.text).toContain('2. Forum thread\n   https://forum.test/1')
    expect(out.text).toContain('Read the most relevant ones with read')
    await client.close()
  })

  test('read returns the page text, in parts for long pages', async () => {
    const long = `# Camera\n${'1. Open Settings > Controls. '.repeat(500)}`
    const { client, call } = await connect(fakeBrowser(page(long)))
    const out = await call('read', { url: 'https://wiki.test/camera' })
    expect(out.step).toMatchObject({ label: 'Read Camera - Game Wiki', detail: 'wiki.test' })
    expect(out.text).toContain(`Characters 0–10000 of ${long.length}:`)
    expect(out.text).toContain('[More below: read with offset 10000 to continue.]')
    const next = await call('read', { offset: 10000 })
    expect(next.text).toContain(`Characters 10000–${long.length}`)
    expect(next.text).not.toContain('More below')
    await client.close()
  })

  test('an empty page says so instead of looking like an answer', async () => {
    const { client, call } = await connect(fakeBrowser(page('')))
    expect((await call('read', {})).text).toContain('No readable text')
    await client.close()
  })

  test('a failed action is a result the model can recover from, and the reply ending hands the browser back', async () => {
    const log: string[] = []
    const browser = { ...fakeBrowser(page(''), log), read: () => Effect.fail({ message: 'net::ERR_NAME_NOT_RESOLVED' }) } as unknown as BrowserApi
    const { module, client, call } = await connect(browser)
    const out = await call('read', { url: 'https://nowhere.test' })
    expect(out.text).toBe('Error: net::ERR_NAME_NOT_RESOLVED')
    expect(out.step).toEqual({ tool: 'browser_read', label: 'read failed', ok: false, detail: 'net::ERR_NAME_NOT_RESOLVED' })
    await module.end!()
    expect(log).toEqual(['release'])
    await client.close()
  })
})
