// CHAT_V2_FAKE_QUERY for the reconciler smoke test (smoke.mjs bundles this to CommonJS): the memory
// model answers the daily review with changes picked from its prompt, the extractor finds nothing,
// and a reply says which playbook lessons its system prompt carried.
import { RECONCILER_INSTRUCTIONS } from '../../src/main/reconciler'
import { fakeQuery, type Script } from '../fakeQuery'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** The id of the record whose line in the prompt says `text`. */
const recordId = (prompt: string, text: string) => Number(prompt.split('\n').find((l) => /^\d+\. \[/.test(l) && l.includes(text))?.split('.')[0])
/** The number of the job titled `title`. */
const jobNo = (prompt: string, title: string) => {
  const blocks = prompt.split('<job n="').slice(1)
  const hit = blocks.find((b) => b.includes(`Title: ${title}`))
  return hit ? Number(hit.split('"')[0]) : 0
}

const script: Script = async function* (t) {
  const prompt = t.call.prompt.map((b) => b.text ?? '').join('\n')
  const system = (t.call.options.systemPrompt as { prompt?: string } | undefined)?.prompt ?? ''
  if (t.call.options.persistSession === false) {
    let answer = '{}'
    if (system === RECONCILER_INSTRUCTIONS) {
      await sleep(900)
      const invoice = jobNo(prompt, 'Invoice script')
      const garden = jobNo(prompt, 'Garden')
      answer = JSON.stringify({
        changes: [
          { op: 'merge', ids: [recordId(prompt, 'Likes cats.'), recordId(prompt, 'Has a cat.')], text: 'Loves cats and has one.', jobs: [garden] },
          { op: 'update', id: recordId(prompt, 'Prefers detailed answers.'), text: 'Prefers short answers.', correction: true, jobs: [invoice] },
          { op: 'add', to: 'playbook', text: 'Never add comments to code.', type: 'procedure', jobs: [invoice] },
          { op: 'add', to: 'profile', text: 'Lives in Lisbon.', jobs: [invoice] }
        ]
      })
    }
    yield* t.text(answer)
    yield t.result()
    return
  }
  const lessons = system.split('Your playbook:')[1]?.split('\n\n')[0]?.split('\n').filter((l) => l.startsWith('- ')) ?? []
  yield* t.text(`playbook: ${lessons.length ? lessons.join(' | ') : 'none'}\n\nThat is all for now.`)
  yield t.result()
}

export const { query } = fakeQuery(script)
