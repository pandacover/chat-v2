// The driver with a stuck watch: nudges ride on tool results through PostToolUse hooks, a pause
// at a hook ends the query (continue: false), and a pause anywhere else interrupts it, or aborts
// it when the query can't be interrupted. Run through fakeQuery, which calls hooks as Claude Code does.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { type ReplyRequest, makeAgent } from '../src/main/agent/driver'
import type { ToolModuleFactory } from '../src/main/agent/module'
import { type Pause, makeWatch } from '../src/main/agent/watch'
import { type Script, fakeQuery } from './fakeQuery'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A tool set with a tool that always fails and one that always says the same. */
const tools: ToolModuleFactory = () => ({
  name: 'work',
  instructions: '',
  server: createSdkMcpServer({
    name: 'work',
    tools: [
      tool('flaky', 'Always fails', {}, async () => ({ content: [{ type: 'text', text: 'Error: the disk is full' }], isError: true })),
      tool('same', 'Always the same', { n: z.number().optional() }, async () => ({ content: [{ type: 'text', text: 'nothing new' }] }))
    ]
  })
})

const run = async (script: Script, opts: { interruptible?: boolean } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'tomo-stuck-'))
  dirs.push(dir)
  const fake = fakeQuery(script)
  const agent = makeAgent({ query: opts.interruptible === false ? fake.plain : fake.query, configDir: join(dir, 'claude'), cwd: dir, clientApp: 'tomo/test' })
  const pauses: Pause[] = []
  const text: string[] = []
  const req: ReplyRequest = {
    sessionId: 's1',
    messageId: 'm1',
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    instructions: 'Be brief.',
    profile: '',
    prompt: [{ type: 'text', text: 'Clean up the disk' }],
    session: { id: 'sess-1', resume: null, baseCost: 0 },
    modules: [tools],
    auth: { kind: 'login' },
    watch: (control) =>
      makeWatch({ judge: null, notes: { add: () => {}, recent: () => [] }, pauses: { record: (p) => void pauses.push(p) } }, { sessionId: 's1', messageId: 'm1', task: 'Clean up the disk' }, control)
  }
  const result = await agent.reply(req, { text: (d) => void text.push(d), step: async () => {}, attach: async () => {}, checkpoint: () => {} }, new AbortController().signal)
  return { result, pauses, text: text.join(''), fake }
}

const said = (r: { result: { content: Array<{ text?: string }> } | null }) => (r.result?.content ?? []).map((c) => c.text ?? '').join('\n')

describe('driver with a stuck watch', () => {
  test('no maxTurns; hooks for tool results are registered', async () => {
    let options: Record<string, unknown> = {}
    await run(async function* (t) {
      options = t.call.options as Record<string, unknown>
      yield* t.text('Hi')
      yield t.result()
    })
    expect(options.maxTurns).toBeUndefined()
    expect(Object.keys(options.hooks as object)).toEqual(['PostToolUse', 'PostToolUseFailure'])
  })

  test('the same error: the 3rd result carries a nudge to the model, the 4th pauses the reply at its hook', async () => {
    const seen: string[] = []
    let after = 0
    const { result, pauses, fake } = await run(async function* (t) {
      for (let i = 0; i < 10; i++) {
        after = i
        seen.push(said(yield* t.tool('mcp__work__flaky')))
      }
      yield t.result()
    })
    expect(seen[1]).not.toContain('system-reminder')
    expect(seen[2]).toContain('<system-reminder>\nThis exact mcp__work__flaky call has now failed 3 times in a row with the same error.')
    // The query ended at the 4th call's hook (index 3): no 5th call, no interrupt needed.
    expect(after).toBe(3)
    expect(fake.interrupts()).toBe(0)
    expect(result.paused).toEqual({ signal: 'same_error', reason: 'It kept getting the same error from flaky: “Error: the disk is full”', step: 4 })
    expect(result.usage).not.toBeNull()
    expect(pauses).toHaveLength(1)
  })

  test('the same call and result 4 times pauses at the 4th', async () => {
    let calls = 0
    const { result } = await run(async function* (t) {
      for (;;) {
        calls++
        yield* t.tool('mcp__work__same', { n: 1 })
      }
    })
    expect(calls).toBe(4)
    expect(result.paused).toMatchObject({ signal: 'same_result', step: 4 })
  })

  test('a refused call has no hook: the stream finds the loop and the query is interrupted', async () => {
    const { result, fake } = await run(async function* (t) {
      for (let i = 0; i < 10; i++) yield* t.tool('mcp__elsewhere__poke', { at: 1 })
      yield t.result()
    })
    expect(fake.interrupts()).toBe(1)
    expect(result.paused).toMatchObject({ signal: 'same_result', reason: 'It made the same poke call 4 times in a row and got the same result each time.' })
    // Interrupted, Claude Code still reports what the reply used.
    expect(result.usage).not.toBeNull()
  })

  test('repeated text interrupts the reply and keeps what was written', async () => {
    const line = 'I will check the configuration file once more now. '
    const { result, text } = await run(async function* (t) {
      yield* t.text(...Array.from({ length: 40 }, () => line))
      yield t.result()
    })
    expect(result.paused).toMatchObject({ signal: 'repeated_text' })
    expect(text.startsWith(line.repeat(10))).toBe(true)
    // Nothing after the pause is kept.
    expect(text.length).toBeLessThan(line.length * 13)
  })

  test('a query that cannot be interrupted is aborted, and the reply still ends paused', async () => {
    const { result } = await run(
      async function* (t) {
        for (let i = 0; i < 10; i++) yield* t.tool('mcp__elsewhere__poke', { at: 1 })
        yield t.result()
      },
      { interruptible: false }
    )
    expect(result.paused).toMatchObject({ signal: 'same_result' })
    // Aborted, there is no result to read usage from.
    expect(result.usage).toBeNull()
  })

  test('a reply that makes progress runs to the end', async () => {
    const { result } = await run(async function* (t) {
      for (let i = 0; i < 12; i++) yield* t.tool('mcp__work__same', { n: i })
      yield* t.text('All clean.')
      yield t.result()
    })
    expect(result.paused).toBeNull()
  })
})
