// End to end: computer use in the real app, hidden (CHAT_V2_HEADLESS=1), with a scripted model
// (e2e-query.ts) and a fake platform (e2e-platform.ts), so nothing reaches the desktop. It drives
// the chat window: a task with an approval (clicked, denied with Esc, approved with Ctrl+Enter
// once armed), "show me how" (the overlay's Done, the chat's Done, a typed answer, Can't find it,
// Do it for me, a click inside the spotlight as it follows its control), the mode chip, an
// approval answered from the notch, the step under way shown live, and Stop in the middle of
// typing. Captures of the cards go to <outDir>.
//
//   bun run build
//   node test/computer/e2e.mjs <playwright-core dir> <outDir>
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [pwDir, outDir = join(tmpdir(), 'chat-v2-computer-e2e')] = process.argv.slice(2)
if (!pwDir) throw new Error('usage: node test/computer/e2e.mjs <playwright-core dir> [outDir]')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const { _electron } = require(resolve(pwDir))
mkdirSync(outDir, { recursive: true })

const work = mkdtempSync(join(tmpdir(), 'chat-v2-computer-e2e-'))
for (const name of ['e2e-query', 'e2e-platform']) {
  const r = spawnSync('bun', ['build', join(repo, 'test/computer', `${name}.ts`), '--target=node', '--format=cjs', '--external=electron', `--outfile=${join(work, `${name}.cjs`)}`], { stdio: 'inherit', shell: true })
  if (r.status !== 0) throw new Error(`bundling ${name} failed`)
}
const data = join(work, 'data')
mkdirSync(data)
writeFileSync(join(data, 'config.json'), JSON.stringify({ titleModel: '', memoryModel: '' }))

const env = { ...process.env, CHAT_V2_HEADLESS: '1', CHAT_V2_FAKE_QUERY: join(work, 'e2e-query.cjs'), CHAT_V2_FAKE_COMPUTER: join(work, 'e2e-platform.cjs') }
delete env.ELECTRON_RUN_AS_NODE
const app = await _electron.launch({ executablePath: require(join(repo, 'node_modules/electron')), args: [repo, `--user-data-dir=${data}`], env })
const log = []
app.process().stdout.on('data', (d) => log.push(...d.toString().split('\n').filter(Boolean)))
app.process().stderr.on('data', (d) => log.push(...d.toString().split('\n').filter(Boolean)))

const ok = (cond, what) => {
  if (!cond) throw new Error(`FAILED: ${what}\n--- app output ---\n${log.join('\n')}`)
  console.log(`ok: ${what}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (f, what, ms = 10_000) => {
  const t0 = Date.now()
  while (!(await f())) {
    if (Date.now() - t0 > ms) ok(false, what)
    await sleep(50)
  }
  ok(true, what)
}
const fake = (prefix) => log.filter((l) => l.startsWith(`[fake-computer] ${prefix}`))

/**
 * A capture of a window. The hidden window paints only when captured, and hands back the frame
 * the previous capture forced, so animations only move on with each capture: this takes a few.
 */
const capture = async (name, url = 'index.html') => {
  const png = await app.evaluate(async ({ BrowserWindow }, url) => {
    const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(url))
    for (let i = 0; i < 6; i++) {
      await w.webContents.capturePage()
      await new Promise((r) => setTimeout(r, 150))
    }
    return (await w.webContents.capturePage()).toPNG().toString('base64')
  }, url)
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(png, 'base64'))
}
const shortcutHeld = () => app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Alt+Escape'))

let page = await app.firstWindow()
for (const w of app.windows()) if (w.url().includes('index.html')) page = w
await page.waitForSelector('textarea')
const composer = page.locator('textarea').first()
const send = async (text) => {
  await composer.fill(text)
  await composer.press('Enter')
}
const lastReply = () => page.locator('[data-reply-scope]').last()

try {
  // The switch. There is no mode control: each message is read for doing or showing.
  await page.getByRole('switch', { name: 'Computer' }).click()
  await page.getByRole('switch', { name: 'Computer', checked: true }).waitFor()
  ok((await page.getByRole('radiogroup', { name: 'Computer mode' }).count()) + (await page.getByRole('radio', { name: 'Show me' }).count()) === 0, 'the composer has no Do it / Show me control')

  // Point before any computer reply: the overlay window is made for it, and its page still hears Point.
  ok(!app.windows().some((w) => w.url().includes('computer-overlay.html')), 'no overlay window before computer use has run')
  await page.getByRole('button', { name: 'Point', exact: true }).click()
  await until(() => app.windows().some((w) => w.url().includes('computer-overlay.html')), 'Point makes the overlay window')
  const early = app.windows().find((w) => w.url().includes('computer-overlay.html'))
  await early.locator('[data-point]').waitFor({ timeout: 5000 })
  ok(true, 'and its freshly loaded page shows Point')
  await early.keyboard.press('Escape')
  await until(async () => (await early.locator('[data-point]').count()) === 0, 'Esc ends it')

  // 1. An approval, clicked.
  await send('Delete the old files in Downloads')
  const card = page.locator('[data-computer-wait="approval"]')
  await card.waitFor()
  ok((await card.innerText()).includes('Delete 3 files from Downloads'), 'the approval shows in the chat with its title')
  ok(await shortcutHeld(), 'the Stop shortcut is held while a computer reply runs')
  await sleep(1200)
  await capture('approval')
  await card.getByRole('button', { name: /Approve/ }).click()
  await until(async () => (await lastReply().innerText()).includes('Deleted them.'), 'Approve lets the reply go on')
  ok(fake('click').length === 1, 'the click went to the fake platform')
  await until(async () => !(await shortcutHeld()), 'the Stop shortcut is let go after the reply')

  // 2. Denied with Esc.
  await send('Delete them again')
  await card.waitFor()
  // An Esc something else used (cancelling a recording, closing a panel) leaves the approval alone.
  await page.evaluate(() => addEventListener('keydown', (e) => e.key === 'Escape' && e.preventDefault(), { capture: true, once: true }))
  await page.keyboard.press('Escape')
  await sleep(200)
  ok((await card.count()) === 1, 'an Esc another handler used does not deny')
  await page.keyboard.press('Escape')
  await until(async () => (await lastReply().innerText()).includes('Left them alone.'), 'Esc denies')

  // 3. Ctrl+Enter only once armed.
  await send('And once more')
  await card.waitFor()
  await page.keyboard.press('Control+Enter')
  await sleep(150)
  ok((await card.count()) === 1, 'Ctrl+Enter right away does nothing')
  await sleep(700)
  await page.keyboard.press('Control+Enter')
  await until(async () => (await lastReply().innerText()).includes('Deleted them.'), 'Ctrl+Enter approves once armed')

  // Show me, from the message alone.
  await send('Show me how to turn on night light')
  const step = page.locator('[data-computer-wait="teach"]')
  await step.waitFor()
  ok((await step.innerText()).includes('Step 1 of 3'), 'the Show-me step shows in the chat')
  await sleep(1200)
  await capture('show-me')
  // The overlay's own Done.
  const overlay = app.windows().find((w) => w.url().includes('computer-overlay.html'))
  ok(!!overlay, 'the overlay window exists')
  await capture('overlay', 'computer-overlay.html')
  // The overlay is click-through, and takes the mouse only while the pointer is on the callout. Main
  // watches the pointer; here it reads a stand-in, and the window's mouse settings are recorded.
  await app.evaluate(({ BrowserWindow, screen }) => {
    globalThis.e2ePointer = { x: -99999, y: -99999 }
    screen.getCursorScreenPoint = () => globalThis.e2ePointer
    const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('computer-overlay.html'))
    const ignore = w.setIgnoreMouseEvents.bind(w)
    globalThis.e2eClickThrough = true
    w.setIgnoreMouseEvents = (on, o) => {
      globalThis.e2eClickThrough = on
      ignore(on, o)
    }
  })
  const takes = async () => !(await app.evaluate(() => globalThis.e2eClickThrough))
  const lets = () => app.evaluate(() => globalThis.e2eClickThrough)
  // Windows drops a click on a window that can't be activated.
  ok(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('computer-overlay.html')).isFocusable()),
    'the overlay can be activated, so Windows keeps a click on it'
  )
  const pointAt = async (box) =>
    app.evaluate(({ BrowserWindow }, box) => {
      const b = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('computer-overlay.html')).getBounds()
      globalThis.e2ePointer = box ? { x: Math.round(b.x + box.x + box.width / 2), y: Math.round(b.y + box.y + box.height / 2) } : { x: b.x + 5, y: b.y + 500 }
    }, box)
  const done = overlay.getByRole('button', { name: 'Done' })
  await pointAt(null)
  await sleep(200)
  ok(await lets(), 'the overlay lets clicks through while the pointer is off the callout')
  await pointAt(await done.boundingBox())
  await until(takes, 'the overlay takes the mouse with the pointer on Done', 2000)
  await pointAt(null)
  await until(lets, 'and lets it go when the pointer leaves', 2000)

  // The callout can be dragged aside, and stays there for the next step.
  const callout = overlay.locator('.callout')
  const from = await callout.boundingBox()
  await overlay.mouse.move(from.x + 40, from.y + 12)
  await overlay.mouse.down()
  await overlay.mouse.move(from.x + 240, from.y + 162, { steps: 6 })
  await overlay.mouse.up()
  const moved = await callout.boundingBox()
  ok(Math.abs(moved.x - from.x - 200) < 2 && Math.abs(moved.y - from.y - 150) < 2, `dragging moves the callout (by ${Math.round(moved.x - from.x)}, ${Math.round(moved.y - from.y)})`)
  await pointAt(await done.boundingBox())
  await until(takes, 'the overlay takes the mouse where the callout now is', 2000)

  // The notch: the chat window isn't focused (it is hidden here), so it says what's happening.
  const notch = overlay.locator('.notch')
  await until(async () => (await notch.count()) === 1 && (await notch.innerText()).includes('Your turn · Step 1 of 3'), 'the notch shows the step waiting on the user')
  await capture('overlay-notch', 'computer-overlay.html')

  await done.click()
  await until(async () => (await step.innerText()).includes('Step 2 of 3'), "the overlay's Done ends the step")
  await until(async () => (await overlay.locator('.callout p').innerText()) === 'Click Night light', 'the next step shows on the overlay')
  // A hidden window runs the new callout's 6 px rise only as captures force frames.
  await capture('overlay-step-2', 'computer-overlay.html')
  const next = await callout.boundingBox()
  ok(Math.abs(next.x - moved.x) < 2 && Math.abs(next.y - moved.y) < 2, `the next step keeps the place the callout was dragged to (${JSON.stringify(moved)} vs ${JSON.stringify(next)})`)
  // The chat's Done.
  await step.getByRole('button', { name: 'Done' }).click()
  await until(async () => (await step.innerText()).includes('Step 3 of 3'), "the chat's Done ends the step")
  // A typed answer.
  const before = await page.locator('[aria-label="Edit message"]').count()
  await send('There is no switch for it')
  await until(async () => (await lastReply().innerText()).includes('Night light is on.'), 'a typed message answers the step')
  await until(lets, 'the overlay is click-through again once the steps are over', 2000)
  await until(async () => (await notch.count()) === 0, 'and the notch goes with the reply')
  await sleep(300)
  ok((await lastReply().innerText()).split('Night light is on.').length === 2, 'the reply shows its last line once')
  ok((await page.locator('[aria-label="Edit message"]').count()) === before, 'the typed answer is not a new message')
  await lastReply().getByText(/Computer/).first().click()
  ok((await lastReply().innerText()).includes('You said “There is no switch for it”'), 'the step line keeps what was typed')
  await capture('show-me-done')

  // The callout's other answers: "Can't find it" (the model asks again), then "Do it for me".
  const calloutSays = async (text) => (await overlay.locator('.callout p').count()) === 1 && (await overlay.locator('.callout p').innerText()) === text
  const clicksBefore = fake('click').length
  await send('Show me how to change the scale')
  await step.waitFor()
  await until(() => calloutSays('Click Scale'), 'the scale step shows on the overlay')
  ok((await lastReply().locator('[data-computer-mode]').innerText()) === 'Showing you', 'the reply shows it is showing you how')
  await capture('mode-chip')
  await overlay.getByRole('button', { name: 'Can’t find it' }).click()
  await until(async () => (await lastReply().innerText()).includes("Couldn't find it"), "Can't find it ends the step, and the step line says so")
  await until(() => calloutSays('Click Scale'), 'the model shows the step again')
  await overlay.getByRole('button', { name: 'Do it for me' }).click()
  await until(async () => (await lastReply().innerText()).includes('Changed the scale.'), 'Do it for me hands over: the reply may act')
  ok(fake('click').length === clicksBefore + 1, 'and its click reached the platform')

  // The mode chip switches a running reply: from showing to doing, mid-step.
  await send('Show me how to pin the tab')
  await step.waitFor()
  await lastReply().locator('[data-computer-mode="teach"]').click()
  await until(async () => (await lastReply().innerText()).includes('Pinned it.'), 'the chip switches the reply to doing it, and the waiting step is handed over')

  // An approval answered from the notch, while the chat is out of sight.
  await send('Delete them once more')
  await card.waitFor()
  const asking = overlay.locator('.notch.asking')
  await until(async () => (await asking.count()) === 1 && (await asking.innerText()).includes('Delete 3 files from Downloads'), 'the notch asks the approval')
  const approve = asking.getByRole('button', { name: 'Approve' })
  ok(await approve.isDisabled(), "the notch's Approve is not armed at once")
  await capture('notch-approval', 'computer-overlay.html')
  await until(async () => !(await approve.isDisabled()), "and arms after a beat", 2000)
  await approve.click()
  await until(async () => (await lastReply().innerText()).includes('Deleted them.'), "the notch's Approve lets the reply go on")
  ok((await card.count()) === 0, "the chat's card went with it")

  // A click inside the spotlight ends a click step; the spotlight follows the control as it moves.
  await send('Show me how to open settings')
  await step.waitFor()
  await until(() => calloutSays('Click Settings'), 'the settings step shows on the overlay')
  const spotLeft = () => overlay.locator('.spot').evaluate((el) => el.style.left)
  const before2 = await spotLeft()
  await app.evaluate(() => void (globalThis.e2eRect = { x: 700, y: 420, width: 80, height: 30 }))
  await until(async () => (await spotLeft()) !== before2, `the spotlight follows the control (${before2} → moved)`, 3000)
  await app.evaluate(() => {
    globalThis.e2eUserCursor = { x: 710, y: 430 }
    globalThis.e2ePressed = true
  })
  await until(async () => (await lastReply().innerText()).includes('Settings are open.'), 'a click inside the spotlight ends the step', 3000)
  await app.evaluate(() => {
    globalThis.e2eUserCursor = null
    globalThis.e2eRect = undefined
  })

  // Stop in the middle of typing.
  await send('Please type a lot')
  await until(async () => fake('type').length > 0, 'typing started')
  // Live progress: the tool under way shows in the reply while it runs, with the reply's mode.
  await until(async () => (await lastReply().locator('[data-step-line="now"]').count()) === 1 && (await lastReply().locator('[data-step-line="now"]').innerText()).includes('Type'), 'the step under way shows live')
  ok((await lastReply().locator('[data-computer-mode]').innerText()) === 'Doing it', 'the reply shows it is doing it')
  await capture('live-step')
  const stop = page.getByRole('button', { name: 'Stop', exact: true })
  await stop.waitFor()
  const atClick = fake('type').length
  // Clicked in the page: Playwright's own click waits for the button to settle first.
  const t0 = Date.now()
  await stop.evaluate((button) => button.click())
  await until(async () => (await lastReply().innerText()).includes('Stopped.'), 'Stop stops the reply')
  await sleep(500)
  // The chunk in flight finishes (this fake can't cut it off; the Windows host can).
  const after = fake('type').length - atClick
  ok(after <= 2, `typing stopped: ${atClick} of 125 chunks before Stop, ${after} after (Stopped shown ${Date.now() - t0 - 500} ms after the click)`)
  ok(!(await shortcutHeld()), 'the Stop shortcut is let go after Stop')

  // Stop in the notch, as from any app.
  await send('Please type a lot')
  await until(async () => (await notch.count()) === 1 && (await notch.innerText()).includes('Working'), 'the notch shows a reply at work')
  await notch.getByRole('button', { name: 'Stop' }).click()
  await until(async () => (await lastReply().innerText()).includes('Stopped.'), "the notch's Stop stops the reply")
  await until(async () => (await notch.count()) === 0, 'and the notch goes')

  // Point: the user marks part of the screen for the next message. The overlay is hidden, so its
  // page gets Playwright's synthetic input; the fake platform answers pointAt and the capture.
  await app.evaluate(({ screen }) => {
    const b = screen.getPrimaryDisplay().bounds
    globalThis.e2ePointer = { x: b.x + 300, y: b.y + 200 }
  })
  const pointButton = page.getByRole('button', { name: 'Point', exact: true })
  ok((await pointButton.count()) === 1, 'the composer has a Point button while computer use is on')
  await pointButton.hover()
  await sleep(700)
  await capture('point-button')
  const layer = overlay.locator('[data-point]')
  // The names on the draft's attachment chips that came from Point (only the draft's can be removed).
  const draft = () =>
    page.evaluate(() => [...document.querySelectorAll('button[aria-label^="Remove point-"]')].map((b) => b.getAttribute('aria-label').slice('Remove '.length)))
  const pointsOn = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('computer-overlay.html')).getBounds())

  // Started from the chat; hovering shows the control the click would pick.
  await pointButton.click()
  await layer.waitFor()
  ok((await pointButton.getAttribute('aria-pressed')) === 'true', 'the Point button shows Point is on')
  await until(takes, 'the overlay takes every click while pointing', 2000)
  const primary = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds)
  ok(JSON.stringify(await pointsOn()) === JSON.stringify(primary), 'the overlay covers the display under the pointer')
  await capture('point-idle', 'computer-overlay.html')
  ok((await overlay.locator('.hint.below-notch').count()) === 0, 'with no notch up, the hint sits at the top')
  await overlay.mouse.move(300, 200)
  await overlay.mouse.move(460, 318, { steps: 4 })
  const highlight = overlay.locator('.control')
  await until(async () => (await highlight.count()) === 1, 'hovering highlights the control under the pointer')
  ok((await overlay.locator('.tag').innerText()) === 'Button · Save', 'and names it')
  await capture('point-hover', 'computer-overlay.html')
  await overlay.mouse.move(700, 600, { steps: 3 })
  await until(async () => (await highlight.count()) === 0, 'the highlight goes when the pointer leaves the control')

  // Esc cancels; nothing is added.
  await overlay.keyboard.press('Escape')
  await until(async () => (await layer.count()) === 0, 'Esc cancels Point')
  await until(async () => (await pointButton.getAttribute('aria-pressed')) === 'false', 'and the chat shows it ended')
  await until(lets, 'the overlay is click-through again', 2000)
  ok((await draft()).length === 0, 'a cancelled Point adds nothing')

  // The shortcut starts it; a second start (the notch's Point) while one is on changes nothing; the button cancels.
  await composer.focus()
  await page.keyboard.press('Control+p')
  await layer.waitFor()
  await overlay.evaluate(() => window.computerOverlay.press('point'))
  await sleep(200)
  ok((await layer.count()) === 1 && (await pointButton.getAttribute('aria-pressed')) === 'true', 'a second Point while one is on is ignored')
  await pointButton.click()
  await until(async () => (await layer.count()) === 0, "the chat's Point button cancels the one under way")

  // A click on the control: the marked image and its note go into the draft.
  await pointButton.click()
  await layer.waitFor()
  await overlay.mouse.move(455, 316, { steps: 3 })
  await until(async () => (await highlight.count()) === 1, 'the control is highlighted again')
  const fakeCaptures = fake('capture').length
  await overlay.mouse.down()
  await overlay.mouse.up()
  await until(async () => (await draft()).length === 2, 'a click adds an image and a note to the draft')
  ok(fake('capture').length === fakeCaptures + 1, 'the screen was captured once (by the fake platform)')
  ok((await layer.count()) === 0 && (await pointButton.getAttribute('aria-pressed')) === 'false', 'Point ends with the click')
  const names = await draft()
  ok(names.some((n) => /^point-\d{6}\.png$/.test(n)) && names.some((n) => /^point-\d{6}\.md$/.test(n)), `the chips are the image and the note (${names.join(', ')})`)
  // The image itself, as saved for the message: a PNG of the area around the control (360x220
  // DIPs at least), in the display's own pixels. Copied out for looking at.
  const scale = await app.evaluate(({ screen }) => (process.platform === 'win32' ? screen.getPrimaryDisplay().scaleFactor : 1))
  const factor = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().scaleFactor)
  const saved = readdirSync(join(data, 'attachments')).filter((f) => f.endsWith('.png')).map((f) => join(data, 'attachments', f))
  ok(saved.length === 1, 'one image was saved')
  const png = readFileSync(saved[0])
  const size = { w: png.readUInt32BE(16), h: png.readUInt32BE(20) }
  ok(png.subarray(1, 4).toString() === 'PNG' && Math.abs(size.w - 360 * factor) <= 2 && Math.abs(size.h - 220 * factor) <= 2, `the image is the marked crop (${size.w}x${size.h})`)
  writeFileSync(join(outDir, 'point-attached.png'), png)
  await capture('point-chips')

  // Sent, the model gets the note: the scripted model echoes it back.
  await send('What is this?')
  await until(async () => (await lastReply().innerText()).includes('Point note:'), 'the model gets the note with the message')
  const echoed = await lastReply().innerText()
  ok(echoed.includes('Control there: Button "Save"'), 'the note names the picked control')
  ok(echoed.includes('Images: 1'), 'and the marked image goes with it')
  // The fake screenshot is 1920x1080 at 0,0, captured to 1024x576, as look_at_screen's would be on a 1920x1080 monitor.
  const m = /Point: (\d+), (\d+)/.exec(echoed)
  ok(!!m, `the note gives the point in screenshot pixels (${m?.[0]})`)
  const w = primary.width * scale
  const k = Math.min(1, 1024 / w)
  const expect = { x: Math.round(455 * scale * k), y: Math.round(316 * scale * k) }
  ok(Math.abs(Number(m[1]) - expect.x) <= 1 && Math.abs(Number(m[2]) - expect.y) <= 1, `in the same pixels the tools take (expected ${expect.x}, ${expect.y})`)
  ok(fake('click').length === 3, 'Point itself never clicked anything')

  // A dragged box, and removing one of its chips removes both.
  await pointButton.click()
  await layer.waitFor()
  await overlay.mouse.move(360, 260)
  await overlay.mouse.down()
  await overlay.mouse.move(700, 420, { steps: 6 })
  ok((await overlay.locator('.box').count()) === 1, 'dragging draws a box')
  await capture('point-box', 'computer-overlay.html')
  await overlay.mouse.up()
  await until(async () => (await draft()).length === 2, 'a box adds an image and a note')
  const notes = readdirSync(join(data, 'attachments')).filter((f) => f.endsWith('.md')).map((f) => readFileSync(join(data, 'attachments', f), 'utf8'))
  const boxNote = notes.find((n) => n.includes('marked a box'))
  ok(!!boxNote && /- Box: \d+, \d+ to \d+, \d+/.test(boxNote) && !boxNote.includes('Control there'), 'the box note gives the box, not a control')
  writeFileSync(join(outDir, 'point-box-note.md'), boxNote ?? '')
  writeFileSync(join(outDir, 'point-note.md'), notes.find((n) => n.includes('pointed at a control')) ?? '')
  await page.locator('.max-w-36', { hasText: /\.png$/ }).first().hover()
  await page.getByRole('button', { name: /^Remove point-\d+\.png$/ }).click()
  await sleep(500)
  const left = await draft()
  ok(left.length === 0, `removing a Point's image removes its note too (left: ${left.join(', ') || 'none'})`)
} finally {
  await app.close()
}
ok(fake('dispose').length === 1, 'quitting disposed the platform once')
console.log(`E2E passed. Captures in ${outDir}`)
