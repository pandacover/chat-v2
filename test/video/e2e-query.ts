// CHAT_V2_FAKE_QUERY for the video end-to-end test (e2e.mjs bundles this to CommonJS): a scripted
// model that, given a <video> in the message, calls the video tools for real (frames decoded with
// WebCodecs in the app's worker view) and says what came back.
import { fakeQuery, type Script } from '../fakeQuery'

const script: Script = async function* (t) {
  if (t.call.options.persistSession === false) {
    yield* t.text('Video test')
    yield t.result()
    return
  }
  const blocks = t.call.prompt.map((b) => b.text ?? '').join('\n')
  const id = /<video file="[^"]*" id="([^"]+)">/.exec(blocks)?.[1]
  if (!id) {
    yield* t.text('No video here.')
    return void (yield t.result())
  }
  const frames = yield* t.tool('mcp__video__frames', { video: id, count: 3 })
  const content = frames.result?.content ?? []
  const images = content.filter((c) => c.type === 'image')
  const jpegs = images.filter((c) => (c.data ?? '').startsWith('/9j/')).length
  const times = content.flatMap((c) => (c.type === 'text' && c.text?.startsWith('At ') ? [c.text] : []))
  const head = content.find((c) => c.type === 'text')?.text ?? ''
  const transcript = yield* t.tool('mcp__video__transcript', { video: id })
  const heard = (transcript.result?.content ?? []).map((c) => c.text ?? '').join('')
  yield* t.text(`frames: ${images.length} images, ${jpegs} jpeg; ${times.join(', ')}; ${head}\ntranscript: ${heard.slice(0, 200)}`)
  yield t.result()
}

export const { query } = fakeQuery(script)
