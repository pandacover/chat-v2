// CHAT_V2_FAKE_QUERY for the browser smoke test (smoke.mjs bundles this to CommonJS). In Tomo's
// chat, "browse: …" is work: Tomo hands it to itself with start_job, and its own thread drives the
// browser on CHAT_V2_TEST_PAGE (navigate, a long wait, a screenshot) and makes an artifact, while
// the user goes on talking to Tomo. "… slowly" makes Tomo's reply take a few seconds.
import { fakeQuery, type Script } from '../fakeQuery'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const systemOf = (o: { systemPrompt?: unknown }) => (o.systemPrompt as { prompt?: string } | undefined)?.prompt ?? ''
const END = 'That is all for now.'
const textOf = (r: { result: { content: Array<{ text?: string }> } | null; permission: { behavior: string } }) =>
  r.permission.behavior === 'deny' ? 'denied' : (r.result?.content ?? []).map((c) => c.text ?? '').join('')

const script: Script = async function* (t) {
  if (t.call.options.persistSession === false) {
    yield* t.text('Browse the test page')
    yield t.result()
    return
  }
  const system = systemOf(t.call.options)
  const last = t.call.prompt.at(-1)?.text ?? ''
  const fromBot = /^<from_bot [^>]*>\n([\s\S]*)\n<\/from_bot>$/.exec(last)
  const said = fromBot?.[1] ?? last
  if (system.includes('this is your one continuous chat with the user')) {
    if (fromBot) {
      yield* t.text(`The browsing job is done.\n\n${END}`)
      yield t.result()
      return
    }
    if (/browse:/i.test(said)) {
      const r = yield* t.tool('mcp__team__start_job', { bot: 'yourself', task: 'Browse the test page and note what it says.', title: 'Browse test page' })
      yield* t.text(`${textOf(r).startsWith('Opened') ? 'On it, in its own thread.' : `That didn't work: ${textOf(r)}`}\n\n${END}`)
      yield t.result()
      return
    }
    // A whole line, so it shows before the pause (a reply's text shows a line at a time).
    yield* t.text('Sure.\n\n')
    await sleep(/slowly/i.test(said) ? 4000 : 150)
    yield* t.text(`You said: ${said.slice(0, 80)}\n\n${END}`)
    yield t.result()
    return
  }
  if (system.includes('working on a task you handed yourself') && /Browse the test page/.test(said)) {
    const opened = yield* t.tool('mcp__browser__navigate', { url: process.env.CHAT_V2_TEST_PAGE ?? 'http://127.0.0.1:1/' })
    // Long enough for the user to talk to Tomo meanwhile, with the browser driven out of sight.
    const waited = yield* t.tool('mcp__browser__wait', { seconds: 7 })
    const shot = yield* t.tool('mcp__browser__screenshot', {})
    const shotOk = !shot.result?.isError && (shot.result?.content ?? []).some((c) => c.type === 'image' && (c.data ?? '').length > 1000)
    // The user asked for a screenshot and a recording: saved, still out of sight.
    const saved = yield* t.tool('mcp__browser__screenshot', { save: true })
    const started = yield* t.tool('mcp__browser__record', { action: 'start' })
    yield* t.tool('mcp__browser__scroll', { direction: 'down' })
    yield* t.tool('mcp__browser__wait', { seconds: 2 })
    const stopped = yield* t.tool('mcp__browser__record', { action: 'stop' })
    const video = /saved to (.+\.webm)/.exec(textOf(stopped))?.[1]
    yield* t.text(
      [
        `Opened: ${/Test page for Tomo/.test(textOf(opened)) ? 'ok' : `failed (${textOf(opened).slice(0, 120)})`}.`,
        `Waited: ${/Waited|Test page/.test(textOf(waited)) ? 'ok' : 'failed'}.`,
        `Screenshot: ${shotOk ? 'ok' : `failed (${textOf(shot).slice(0, 120)})`}.`,
        `Saved screenshot: ${/attached to your reply/.test(textOf(saved)) ? 'ok' : `failed (${textOf(saved).slice(0, 160)})`}.`,
        `Recording started: ${/Recording the browser panel/.test(textOf(started)) ? 'ok' : `failed (${textOf(started).slice(0, 160)})`}.`,
        `Video: ${video ?? `failed (${textOf(stopped).slice(0, 160)})`}`,
        '<artifact identifier="notes" title="Notes">\n<h1>Notes</h1>\n</artifact>',
        '',
        END
      ].join('\n')
    )
    yield t.result()
    return
  }
  yield* t.text(`You said: ${said.slice(0, 80)}\n\n${END}`)
  yield t.result()
}

export const { query } = fakeQuery(script)
