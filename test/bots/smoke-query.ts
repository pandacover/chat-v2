// CHAT_V2_FAKE_QUERY for the bots smoke test (smoke.mjs bundles this to CommonJS): a scripted model
// that names and summarises jobs, and streams short replies. In Tomo's chat, "make a page …" is work:
// Tomo hands it to itself with start_job, the page is made in its own thread, and the report comes
// back as a turn that Tomo answers in a line. "What came before?" says whether the reply resumed an
// earlier session (it doesn't after New topic).
import { SUMMARY_INSTRUCTIONS } from '../../src/main/jobs'
import { fakeQuery, type Script } from '../fakeQuery'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const systemOf = (o: { systemPrompt?: unknown }) => (o.systemPrompt as { prompt?: string } | undefined)?.prompt ?? ''
const END = 'That is all for now.'

const script: Script = async function* (t) {
  const prompt = t.call.prompt.map((b) => b.text ?? '').join('\n')
  if (t.call.options.persistSession === false) {
    const system = systemOf(t.call.options)
    let answer = 'Printer trouble'
    if (system === SUMMARY_INSTRUCTIONS) answer = `Talked about ${(prompt.split('<user>\n')[1] ?? '').split('\n')[0]!.slice(0, 40)}; nothing pending.`
    yield* t.text(answer)
    yield t.result()
    return
  }
  const system = systemOf(t.call.options)
  const last = t.call.prompt.at(-1)?.text ?? ''
  const fromBot = /^<from_bot [^>]*>\n([\s\S]*)\n<\/from_bot>$/.exec(last)
  const said = fromBot?.[1] ?? last
  // Tomo's chat with the user.
  if (system.includes('this is your one continuous chat with the user')) {
    if (fromBot) {
      // Its own report, back in the chat: the outcome in a line.
      yield* t.text(`The cat page is ready: open the job to see it.\n\n${END}`)
      yield t.result()
      return
    }
    if (/make a page/i.test(said)) {
      const r = yield* t.tool('mcp__team__start_job', { bot: 'yourself', task: `Make a page about cats with a heading, for the user. They asked: ${said}`, title: 'Cat page' })
      const ok = (r.result?.content ?? []).some((c) => (c.text ?? '').startsWith('Opened'))
      yield* t.text(ok ? `I'm on it: making the cat page in its own thread.\n\n${END}` : `That didn't work.\n\n${END}`)
      yield t.result()
      return
    }
    if (/what came before/i.test(said)) {
      yield* t.text(`${t.call.options.resume ? 'I remember what came before.' : 'This is a fresh start.'}\n\n${END}`)
      yield t.result()
      return
    }
  }
  // Tomo's own thread on the job it handed itself: the page, an artifact.
  if (system.includes('working on a task you handed yourself') && /page about cats/i.test(said)) {
    yield* t.text('Here it is.\n<artifact identifier="cats" title="Cats">\n<h1>Cats</h1>\n</artifact>\n\n')
    await sleep(4000)
    yield* t.text(END)
    yield t.result()
    return
  }
  yield* t.text('Sure. ')
  await sleep(150)
  yield* t.text(`You said: ${said.slice(0, 80)}\n\n`)
  // Asked to take it slowly: long enough for the user to look elsewhere before it ends.
  await sleep(/slowly/i.test(said) ? 5000 : 150)
  yield* t.text(END)
  yield t.result()
}

export const { query } = fakeQuery(script)
