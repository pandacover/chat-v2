// CHAT_V2_FAKE_QUERY for the rules smoke test (smoke.mjs bundles this to CommonJS): a scripted model
// that makes three tool calls, under rules the test set in Settings › Bots (write a job note: ask;
// click on a page: ask; run a page script: block), and says how each went.
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { fakeQuery, type Script } from '../fakeQuery'

const how = (r: { permission: PermissionResult }) => (r.permission.behavior === 'deny' ? `refused (${r.permission.message})` : 'ran')

const script: Script = async function* (t) {
  if (t.call.options.persistSession === false) {
    yield* t.text('Shopping')
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
