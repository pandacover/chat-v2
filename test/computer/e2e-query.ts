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
  const said = (r: { result: { content: Array<{ text?: string }> } | null }) => (r.result?.content ?? []).map((c) => c.text ?? '').join('')
  if (prompt.includes('change the scale')) {
    // The callout's other ways out: "Can't find it", then "Do it for me", after which acting is allowed.
    for (;;) {
      const r = said(yield* t.tool('mcp__computer__teach_step', { instruction: 'Click Scale', step: 1, total: 2, element: 4 }))
      if (r.includes('Do it for me')) break
      if (!r.includes("Can't find it")) return void (yield t.result())
    }
    const click = yield* t.tool('mcp__computer__click', { x: 100, y: 100 })
    yield* t.text(click.permission.behavior === 'allow' ? 'Changed the scale.' : 'Could not act.')
  } else if (prompt.includes('pin the tab')) {
    // Switched with the reply's mode chip while the step waits.
    const r = said(yield* t.tool('mcp__computer__teach_step', { instruction: 'Click Pin', step: 1, total: 1, element: 4 }))
    const click = yield* t.tool('mcp__computer__click', { x: 100, y: 100 })
    yield* t.text(r.includes('Do it for me') && click.permission.behavior === 'allow' ? 'Pinned it.' : 'Could not act.')
  } else if (prompt.includes('open settings')) {
    // Ended by a click inside the spotlight, which follows the control as it moves.
    const r = said(yield* t.tool('mcp__computer__teach_step', { instruction: 'Click Settings', step: 1, total: 1, element: 4 }))
    yield* t.text(r.includes('clicked the highlighted control') ? 'Settings are open.' : `Unexpected: ${r}`)
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
