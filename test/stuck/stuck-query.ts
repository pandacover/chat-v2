// CHAT_V2_FAKE_QUERY for the stuck smoke test (e2e.mjs bundles this to CommonJS): a scripted model
// that loops on the same tool call until the app pauses it, and finishes once continued.
import { fakeQuery, type Script } from '../fakeQuery'

const script: Script = async function* (t) {
  // A title or memory read, or a checkpoint judge.
  if (t.call.options.persistSession === false) {
    yield* t.text('Stuck test')
    return void (yield t.result())
  }
  const prompt = t.call.prompt.map((b) => b.text ?? '').join('\n')
  // Continued after the pause: the note says why it was paused.
  if (prompt.includes('You were paused because you seemed stuck')) {
    yield* t.text('Back on track: tried another way and finished.')
    return void (yield t.result())
  }
  if (prompt.includes('Keep looking')) {
    // A computer chat: the same look, run for real through MCP and its PostToolUse hook.
    yield* t.text('Watching the screen.')
    for (;;) yield* t.tool('mcp__computer__look_at_screen')
  }
  // No tool sets in the chat: the call is refused each time, so only the stream sees it.
  yield* t.text('Checking the job.')
  for (;;) yield* t.tool('mcp__jobs__check_status', { job: 1 })
}

export const { query } = fakeQuery(script)
