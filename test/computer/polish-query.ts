// CHAT_V2_FAKE_QUERY for render-chat.mjs: a scripted model paced like a real one, so each state of
// the chat's computer-use parts (live step line, failed and denied steps, the approval and Show-me
// cards) stays up long enough to be captured.
import { fakeQuery, type Script } from '../fakeQuery'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const script: Script = async function* (t) {
  if (t.call.options.persistSession === false) {
    yield* t.text('Computer polish')
    yield t.result()
    return
  }
  const prompt = t.call.prompt.at(-1)?.text ?? ''
  if (prompt.includes('slow run')) {
    yield* t.tool('mcp__computer__look_at_screen')
    yield* t.tool('mcp__computer__wait', { seconds: 1 })
    yield* t.tool('mcp__computer__click', { x: 120, y: 80 })
    await sleep(300)
    yield* t.tool('mcp__computer__type_text', { text: 'Quarterly numbers, final. '.repeat(10) })
    yield* t.tool('mcp__computer__reveal_file', { path: String.raw`C:\Users\me\Documents\missing-report.xlsx` })
    await sleep(300)
    yield* t.tool('mcp__computer__click', { x: 300, y: 200 })
    yield* t.text('Typed the numbers in; the report file was not there.')
  } else if (prompt.includes('show me')) {
    // A step's x, y are pixels of the last screenshot, so it looks first.
    yield* t.tool('mcp__computer__look_at_screen')
    for (const [step, instruction] of ['Click Display', 'Click Night light'].entries())
      yield* t.tool('mcp__computer__teach_step', { instruction, step: step + 1, total: 2, x: 300, y: 200 + step * 60 })
    yield* t.text('Night light is on.')
  } else {
    yield* t.tool('mcp__computer__look_at_screen')
    yield* t.tool('mcp__computer__click', { x: 100, y: 100 })
    const r = yield* t.tool('mcp__computer__ask_approval', { action: 'Delete 3 files from Downloads', detail: 'old-1.txt\nold-2.txt\nold-3.txt' })
    const approved = r.result?.content[0]?.text?.startsWith('Approved') ?? false
    yield* t.text(approved ? 'Deleted them.' : 'Left them alone.')
  }
  yield t.result()
}

export const { query } = fakeQuery(script)
