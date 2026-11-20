// CHAT_V2_FAKE_QUERY for the end-to-end test (e2e.mjs bundles this to CommonJS): a scripted model
// that calls the computer tools for real, through MCP and the permission check.
import { fakeQuery, type Script } from '../fakeQuery'

const script: Script = async function* (t) {
  // A title or memory read.
  if (t.call.options.persistSession === false) {
    yield* t.text('Computer test')
    yield t.result()
    return
  }
  // The new message comes last, after any turns the session doesn't have.
  const prompt = t.call.prompt.at(-1)?.text ?? ''
  yield* t.tool('mcp__computer__look_at_screen')
  // A message with a Point attached: say back what came with it.
  const note = t.call.prompt.find((b) => b.text?.startsWith('<file name="point-'))?.text
  if (note) {
    const images = t.call.prompt.filter((b) => b.type === 'image').length
    yield* t.text(`Point note: ${note}\n\nImages: ${images}`)
  } else if (prompt.startsWith('[mode: teach]')) {
    for (const [step, instruction] of ['Click Display', 'Click Night light', 'Turn it on'].entries())
      yield* t.tool('mcp__computer__teach_step', { instruction, step: step + 1, total: 3, x: 300, y: 200 + step * 60 })
    yield* t.text('Night light is on.')
  } else if (prompt.includes('type a lot')) {
    yield* t.tool('mcp__computer__type_text', { text: 'x'.repeat(2000) })
    yield* t.text('Typed it all.')
  } else {
    yield* t.tool('mcp__computer__click', { x: 100, y: 100 })
    const r = yield* t.tool('mcp__computer__ask_approval', { action: 'Delete 3 files from Downloads', detail: 'old-1.txt\nold-2.txt\nold-3.txt' })
    const approved = r.result?.content[0]?.text?.startsWith('Approved') ?? false
    yield* t.text(approved ? 'Deleted them.' : 'Left them alone.')
  }
  yield t.result()
}

export const { query } = fakeQuery(script)
