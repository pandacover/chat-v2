// Drives the built capture helper for real, as the app does: streams the main display, grabs a
// screenshot and a close-up, reads the change reports before and after something opens on
// screen, lists the windows (against the input helper's list) and types into TextEdit, and times it. For a Mac that allows Screen Recording to whatever runs this (GitHub's
// macOS runners do); without the permission it says so and exits, unless --require.
//
//   bun scripts/mac-capture-smoke.ts [--require] [--out <dir>]
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { helperProcess } from '../src/main/helperProcess'
import { MAC_HELPER_SCRIPT } from '../src/main/macHelper'

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
  await windowsAndTyping()
  console.log('OK')
}

/** A window list as both helpers give it: ids, the one in front, and how long it took. */
type Listed = { ids: number[]; foreground: number; ms: number; sample: unknown }
const listed = (r: Record<string, unknown>, ms: number): Listed => {
  const windows = r.windows as Array<{ hwnd: number }>
  return { ids: windows.map((w) => w.hwnd), foreground: Number(r.foreground), ms, sample: windows[0] }
}

/**
 * The window list and typing the capture helper does for the input helper (an osascript process
 * running MAC_HELPER_SCRIPT): the same windows as the input helper's `state`, faster, and text
 * typed into TextEdit. Typing needs Accessibility, which a runner may not grant: then it says so.
 */
const windowsAndTyping = async () => {
  const script = join(outDir, 'computer-helper.js')
  writeFileSync(script, MAC_HELPER_SCRIPT)
  const jxa = helperProcess(() => spawn('osascript', ['-l', 'JavaScript', script]), () => null, 'the input helper')
  try {
    const time = async (f: () => Promise<Record<string, unknown>>) => {
      const t = performance.now()
      const r = await f()
      return listed(r, performance.now() - t)
    }
    // The first of each starts its process; the rest are what an action pays.
    await time(() => jxa.request('state'))
    await time(() => helper.request('windows'))
    const native: Listed[] = []
    const bridge: Listed[] = []
    for (let i = 0; i < 5; i++) {
      bridge.push(await time(() => jxa.request('state')))
      native.push(await time(() => helper.request('windows')))
    }
    const ms = (ls: Listed[]) => ls.map((l) => l.ms.toFixed(1)).join(', ')
    console.log(`window list through the bridge: ${ms(bridge)} ms; natively: ${ms(native)} ms`)
    const a = bridge.at(-1)!
    const b = native.at(-1)!
    console.log(`bridge: ${a.ids.length} windows, front ${a.foreground}, first ${JSON.stringify(a.sample)}`)
    console.log(`native: ${b.ids.length} windows, front ${b.foreground}, first ${JSON.stringify(b.sample)}`)
    if (b.ids.length === 0) fail('the native window list is empty')
    const shared = b.ids.filter((id) => a.ids.includes(id)).length
    if (shared < Math.max(a.ids.length, b.ids.length) * 0.8) fail(`the window lists differ: ${JSON.stringify(a.ids)} and ${JSON.stringify(b.ids)}`)
    if (a.foreground !== b.foreground) console.log(`NOTE: the window in front differs (${a.foreground} and ${b.foreground})`)

    // Typing into a new TextEdit document, read back through AppleScript. TextEdit would correct
    // and capitalise what it's given, so that's turned off first.
    try {
      for (const key of ['NSAutomaticSpellingCorrectionEnabled', 'NSAutomaticCapitalizationEnabled', 'NSAutomaticPeriodSubstitutionEnabled', 'NSAutomaticQuoteSubstitutionEnabled', 'NSAutomaticDashSubstitutionEnabled', 'NSAutomaticTextCompletionEnabled']) {
        execFileSync('defaults', ['write', '-g', key, '-bool', 'false'])
      }
      execFileSync('osascript', ['-e', 'tell application "TextEdit" to activate', '-e', 'tell application "TextEdit" to make new document'])
    } catch (e) {
      console.log(`Could not open TextEdit: ${(e as Error).message}`)
      return
    }
    await sleep(1500)
    // Keys go to the app in front: only type if that's TextEdit, as the window list says.
    const now = await helper.request('windows')
    const front = (now.windows as Array<{ hwnd: number; exe: string }>).find((w) => w.hwnd === Number(now.foreground))
    if (front?.exe !== 'TextEdit') {
      console.log(`typing skipped: ${front?.exe ?? 'nothing'} is in front, not TextEdit`)
      return
    }
    const text = 'Hello from chat-v2, ünïcödé ✓\nsecond line'
    const t = performance.now()
    const typed = await helper.request('type', Buffer.from(text, 'utf8').toString('base64')).then(
      () => null,
      (e: Error) => e.message
    )
    const took = performance.now() - t
    if (typed) console.log(`typing skipped: ${typed}`)
    else {
      await sleep(500)
      const got = execFileSync('osascript', ['-e', 'tell application "TextEdit" to get text of document 1']).toString().replace(/\r/g, '\n').trimEnd()
      console.log(`typed ${text.length} characters in ${took.toFixed(0)} ms; TextEdit has ${JSON.stringify(got)}`)
      const display = ready.display as { id: number; w: number; h: number }
      await helper.request('start', display.id, process.pid, display.w, display.h)
      jpegOf(await helper.request('grab', 1280, Math.round((1280 * display.h) / display.w), '[]', 'null', display.w), 'typed.jpg')
      await helper.request('stop')
      if (got !== text) fail(`TextEdit has ${JSON.stringify(got)}, not ${JSON.stringify(text)}`)
    }
  } finally {
    jxa.close()
    try {
      execFileSync('osascript', ['-e', 'tell application "TextEdit" to quit saving no'])
    } catch {}
  }
}

main()
  .catch((e) => fail(e instanceof Error ? e.message : String(e)))
  .finally(() => {
    helper.close()
    setTimeout(() => process.exit(0), 200)
  })
