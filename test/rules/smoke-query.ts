// CHAT_V2_FAKE_QUERY for the rules smoke test (smoke.mjs bundles this to CommonJS): a scripted model
// that makes three tool calls, under rules the test set in Settings › Bots (write a job note: ask;
// click on a page: ask; run a page script: block), and says how each went. That is work, so it runs
// in a job's thread: in Tomo's chat, Tomo hands it to itself with start_job, and answers the report
// in a line.
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { fakeQuery, type Script } from '../fakeQuery'

const how = (r: { permission: PermissionResult }) => (r.permission.behavior === 'deny' ? `refused (${r.permission.message})` : 'ran')
const systemOf = (o: { systemPrompt?: unknown }) => (o.systemPrompt as { prompt?: string } | undefined)?.prompt ?? ''

const script: Script = async function* (t) {
  if (t.call.options.persistSession === false) {
    yield* t.text('Shopping')
    yield t.result()
    return
  }
  if (systemOf(t.call.options).includes('this is your one continuous chat with the user')) {
    const last = t.call.prompt.at(-1)?.text ?? ''
    if (/^<from_bot /.test(last)) yield* t.text('Tomo: done, with one click you declined.')
    else {
      yield* t.tool('mcp__team__start_job', { bot: 'yourself', task: last, title: 'Buy the camera' })
      yield* t.text("I'm on it.")
    }
    yield t.result()
    return
  }
  yield* t.text(`Note: ${how(yield* t.tool('mcp__notes__note', { kind: 'state', text: 'Looked at the shop page.' }))}.\n\n`)
  yield* t.text(`Click: ${how(yield* t.tool('mcp__browser__click', { ref: 'e1' }))}.\n\n`)
  yield* t.text(`Script: ${how(yield* t.tool('mcp__browser__evaluate', { code: 'return document.title' }))}.\n\n`)
  yield* t.text('All done.')
  yield t.result()
}

export const { query } = fakeQuery(script)
