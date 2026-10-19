// Drives the built capture helper for real, as the app does: streams the main display, grabs a
// screenshot and a close-up, reads the change reports before and after something opens on
// screen, and times it. For a Mac that allows Screen Recording to whatever runs this (GitHub's
// macOS runners do); without the permission it says so and exits, unless --require.
//
//   bun scripts/mac-capture-smoke.ts [--require] [--out <dir>]
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { helperProcess } from '../src/main/helperProcess'

const args = process.argv.slice(2)
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1]! : join(import.meta.dir, '../native/mac-capture/out/smoke')
const helperPath = join(import.meta.dir, '../native/mac-capture/out/chat-v2-capture')

const fail = (why: string): never => {
  console.error(`FAIL: ${why}`)
  process.exit(1)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let ready: Record<string, unknown> = {}
const helper = helperProcess(
  () => spawn(helperPath),
  (r) => {
    ready = r
    return null
  },
  'the capture helper'
)

const jpegOf = (r: Record<string, unknown>, name: string) => {
  const bytes = Buffer.from(String(r.jpeg), 'base64')
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) fail(`${name} is not a JPEG`)
  writeFileSync(join(outDir, name), bytes)
  return bytes.length
}

const main = async () => {
  mkdirSync(outDir, { recursive: true })
  // The first request starts the helper and reads its ready line.
  await helper.request('changes').catch(() => undefined)
  console.log('ready:', JSON.stringify(ready))
  if (ready.permission !== true) {
    if (args.includes('--require')) fail('no Screen Recording permission')
    console.log('Skipped: this process may not record the screen.')
    return
  }
  const display = ready.display as { id: number; w: number; h: number }
  let t = performance.now()
  const started = await helper.request('start', display.id, process.pid, display.w, display.h)
  console.log(`start: ${(performance.now() - t).toFixed(0)} ms`, JSON.stringify(started))

  const size = { w: 1280, h: Math.round((1280 * display.h) / display.w) }
  const times: number[] = []
  let shot: Record<string, unknown> = {}
  for (let i = 0; i < 5; i++) {
    t = performance.now()
    shot = await helper.request('grab', size.w, size.h, JSON.stringify([{ x: 20, y: 20, w: 200, h: 120 }]), 'null', display.w)
    times.push(performance.now() - t)
  }
  const bytes = jpegOf(shot, 'screen.jpg')
  console.log(`grab ${size.w}×${size.h}: ${times.map((x) => x.toFixed(0)).join(', ')} ms; ${bytes} bytes; parts ${JSON.stringify(shot.ms)}`)
  if (shot.w !== size.w || shot.h !== size.h) fail(`the screenshot is ${shot.w}×${shot.h}, not ${size.w}×${size.h}`)

  // The top-left corner: the Apple menu and the app's name, so a flipped close-up shows.
  const crop = { x: 0, y: 0, w: Math.round(display.w / 3), h: Math.round(display.w / 3 / 4) }
  const zoom = await helper.request('grab', 1200, 300, '[]', JSON.stringify(crop), display.w)
  console.log(`close-up: ${jpegOf(zoom, 'closeup.jpg')} bytes; parts ${JSON.stringify(zoom.ms)}`)

  /** What redrew lately: each frame's age, share of the screen, rects (x, y, w, h), and whether it counted. */
  const recent = async (label: string) => {
    const r = await helper.request('recent')
    const frames = r.frames as Array<{ ago: number; area: number; counted: boolean; rects: number[][] }>
    console.log(`${label}: ${frames.length} frames`)
    for (const f of frames.slice(-15)) {
      console.log(`  ${f.ago.toFixed(0).padStart(6)} ms ago  ${(f.area * 100).toFixed(3).padStart(7)}%  ${f.counted ? 'counted' : 'ignored'}  ${JSON.stringify(f.rects)}`)
    }
  }

  // A moment for the first frames (and the Dock or anything else settling) to pass.
  await sleep(1000)
  const a = await helper.request('changes')
  await sleep(800)
  const b = await helper.request('changes')
  console.log('changes, 0.8 s apart:', JSON.stringify(a), JSON.stringify(b))
  await recent('idle screen')
  if (Number(b.stillMs) < Number(a.stillMs) && b.count === a.count) fail('stillMs went down without a change')
  // Nothing moves on an idle screen but the menu bar (the recording indicator pulses there), which doesn't count.
  if (Number(b.count) > Number(a.count)) fail(`an idle screen counted ${Number(b.count) - Number(a.count)} changes in 0.8 s`)

  // Something opening on screen should show as a change.
  try {
    execFileSync('open', ['-a', 'Calculator'])
  } catch (e) {
    console.log(`Could not open Calculator: ${(e as Error).message}`)
  }
  let c = b
  for (let i = 0; i < 40 && c.count === b.count; i++) {
    await sleep(100)
    c = await helper.request('changes')
  }
  console.log('after opening Calculator:', JSON.stringify(c))
  await sleep(1500)
  const after = await helper.request('grab', size.w, size.h, '[]', 'null', display.w)
  jpegOf(after, 'after-open.jpg')
  const d = await helper.request('changes')
  console.log('settled:', JSON.stringify(d))
  await recent('1.5 s after opening Calculator')
  if (c.count === b.count) fail('no change seen while Calculator opened')
  try {
    execFileSync('osascript', ['-e', 'quit app "Calculator"'])
  } catch {}
  await helper.request('stop')

  // Leaving an app out, as the app leaves itself out: Calculator, started hidden, then shown after
  // the stream is up (as the overlay is created after it). Its window must not be in the frame.
  await sleep(1000)
  execFileSync('open', ['-g', '-j', '-a', 'Calculator'])
  let pid = 0
  for (let i = 0; i < 50 && !pid; i++) {
    await sleep(100)
    try {
      pid = Number(execFileSync('pgrep', ['-x', 'Calculator']).toString().trim().split(/\s+/)[0])
    } catch {}
  }
  if (!pid) fail('Calculator did not start')
  await sleep(1000)
  const left = await helper.request('start', display.id, pid, display.w, display.h)
  console.log('stream leaving out Calculator:', JSON.stringify(left))
  if (left.appExcluded !== true) fail('Calculator was not left out as an app')
  const before = await helper.request('changes')
  execFileSync('open', ['-a', 'Calculator'])
  await sleep(2000)
  const shown = await helper.request('changes')
  console.log('while it showed its window:', JSON.stringify(before), JSON.stringify(shown))
  await recent('Calculator shown, left out')
  jpegOf(await helper.request('grab', size.w, size.h, '[]', 'null', display.w), 'calculator-left-out.jpg')
  try {
    execFileSync('osascript', ['-e', 'quit app "Calculator"'])
  } catch {}

  await helper.request('stop')
  await helper.request('changes').then(
    () => fail('changes answered after stop'),
    (e: Error) => console.log(`after stop: ${e.message}`)
  )
  console.log('OK')
}

main()
  .catch((e) => fail(e instanceof Error ? e.message : String(e)))
  .finally(() => {
    helper.close()
    setTimeout(() => process.exit(0), 200)
  })
