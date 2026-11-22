// CHAT_V2_FAKE_QUERY for the bots smoke test (smoke.mjs bundles this to CommonJS): a scripted model
// that routes, names and summarises jobs by keyword, and streams short replies.
import { ROUTER_INSTRUCTIONS, SUMMARY_INSTRUCTIONS } from '../../src/main/jobs'
import { fakeQuery, type Script } from '../fakeQuery'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The number of the listed job whose line matches `re`. */
const jobNumber = (prompt: string, re: RegExp) => prompt.split('\n').find((l) => /^\d+\. /.test(l) && re.test(l))?.split('.')[0]

const script: Script = async function* (t) {
  const prompt = t.call.prompt.map((b) => b.text ?? '').join('\n')
  if (t.call.options.persistSession === false) {
    const system = (t.call.options.systemPrompt as { prompt: string }).prompt
    let answer = 'Printer trouble'
    if (system === ROUTER_INSTRUCTIONS) {
      const message = prompt.split('<message>\n')[1] ?? ''
      await sleep(400)
      // Small talk, and what follows on from it, is no job.
      if (/^(hi|hello|thanks)\b/i.test(message) || (/job="none"/.test(prompt) && /^make a page/i.test(message))) answer = '{"job": "none"}'
      else if (/lisbon/i.test(message)) answer = '{"job": "new", "title": "Trip to Lisbon"}'
      else if (/printer/i.test(message)) answer = `{"job": ${jobNumber(prompt, /printer/i) ?? '"new"'}}`
      else answer = `{"job": ${jobNumber(prompt, /\(current\)$/) ?? '"new"'}}`
    } else if (system === SUMMARY_INSTRUCTIONS) {
      answer = `Talked about ${(prompt.split('<user>\n')[1] ?? '').split('\n')[0]!.slice(0, 40)}; nothing pending.`
    } else if (system.startsWith('You name chats.') && /cats/i.test(prompt)) {
      answer = 'Cat page'
    }
    yield* t.text(answer)
    yield t.result()
    return
  }
  const said = t.call.prompt.at(-1)?.text ?? ''
  // Asked to make a page: an artifact, which is work.
  if (/make a page/i.test(said)) {
    yield* t.text('Here it is.\n<artifact identifier="cats" title="Cats">\n<h1>Cats</h1>\n</artifact>\n\n')
    await sleep(150)
    yield* t.text('That is all for now.')
    yield t.result()
    return
  }
  yield* t.text('Sure. ')
  await sleep(150)
  yield* t.text(`You said: ${said.slice(0, 80)}\n\n`)
  await sleep(150)
  yield* t.text('That is all for now.')
  yield t.result()
}

export const { query } = fakeQuery(script)
