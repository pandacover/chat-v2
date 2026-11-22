// CHAT_V2_FAKE_QUERY for the workers smoke test (smoke.mjs bundles this to CommonJS): a scripted
// model that plays every bot. Tomo hands "delegate: <task>" to Scout with start_job. A worker reads
// its task as commands joined with " ; ": "ask <Bot> | <text>" (message) and "waitfor <Bot> <s>"
// (wait); anything else it just says. Each worker reply ends "<Name> done: <what its tools said>".
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { fakeQuery, type Script } from '../fakeQuery'

const systemOf = (o: { systemPrompt?: unknown }) => (o.systemPrompt as { prompt?: string } | undefined)?.prompt ?? ''

type Ran = { permission: PermissionResult; result: { content: Array<{ text?: string }> } | null }
const said = (r: Ran) => (r.permission.behavior === 'deny' ? `denied: ${r.permission.message}` : (r.result?.content ?? []).map((c) => c.text ?? '').join(''))

const script: Script = async function* (t) {
  if (t.call.options.persistSession === false) {
    yield* t.text('Flights')
    yield t.result()
    return
  }
  const who = /You are (\w+), one of the user's bots/.exec(systemOf(t.call.options))?.[1] ?? 'Tomo'
  const last = t.call.prompt.at(-1)?.text ?? ''
  const message = /<from_bot [^>]*>\n([\s\S]*)\n<\/from_bot>/.exec(last)?.[1] ?? last
  if (who === 'Tomo') {
    const task = /^delegate: (.+)$/s.exec(message.trim())?.[1]
    if (task) {
      const title = task.split(' ; ')[0]!.replace(/^ask \w+ \| /, '').slice(0, 40)
      const r = said((yield* t.tool('mcp__team__start_job', { bot: 'Scout', task, title })) as Ran)
      yield* t.text(r.startsWith('Opened') ? `I've handed “${title}” to Scout.` : `That didn't work: ${r}`)
    } else yield* t.text(`Tomo heard: ${message.trim()}`)
    yield t.result()
    return
  }
  const out: string[] = []
  for (const line of message.split(/\n| ; /).map((l) => l.trim()).filter(Boolean)) {
    let m: RegExpExecArray | null
    if ((m = /^ask (\w+) \| (.+)$/.exec(line))) out.push(said((yield* t.tool('mcp__team__message', { to: m[1], text: m[2] })) as Ran))
    else if ((m = /^waitfor (\w+) (\d+)$/.exec(line))) out.push(said((yield* t.tool('mcp__team__wait', { bot: m[1], timeout_seconds: Number(m[2]) })) as Ran))
    else out.push(line)
  }
  yield* t.text(`${who} done: ${out.join(' / ')}`)
  yield t.result()
}

export const { query } = fakeQuery(script)
