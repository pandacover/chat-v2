// End to end: computer use in the real app, hidden (CHAT_V2_HEADLESS=1), with a scripted model
// (e2e-query.ts) and a fake platform (e2e-platform.ts), so nothing reaches the desktop. It drives
// the chat window: Do it with an approval (clicked, denied with Esc, approved with Ctrl+Enter
// once armed), Show me (the overlay's Done, the chat's Done, a typed answer), and Stop in the
// middle of typing. Captures of the cards go to <outDir>.
//
//   bun run build
//   node test/computer/e2e.mjs <playwright-core dir> <outDir>
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
  const r = spawnSync('bun', ['build', join(repo, 'test/computer', `${name}.ts`), '--target=node', '--format=cjs', `--outfile=${join(work, `${name}.cjs`)}`], { stdio: 'inherit', shell: true })
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
  // Do it: the switch and the mode control.
  await page.getByRole('switch', { name: 'Computer' }).click()
  await page.getByRole('radiogroup', { name: 'Computer mode' }).waitFor()
  ok((await page.getByRole('radio', { name: 'Do it' }).getAttribute('aria-checked')) === 'true', 'a new computer chat starts in Do it')

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

  // Show me, switched with Tab in the composer.
  await composer.focus()
  await page.keyboard.press('Tab')
  await until(async () => (await page.getByRole('radio', { name: 'Show me' }).getAttribute('aria-checked')) === 'true', 'Tab switches to Show me')
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
  await overlay.getByRole('button', { name: 'Done' }).click()
  await until(async () => (await step.innerText()).includes('Step 2 of 3'), "the overlay's Done ends the step")
  // The chat's Done.
  await step.getByRole('button', { name: 'Done' }).click()
  await until(async () => (await step.innerText()).includes('Step 3 of 3'), "the chat's Done ends the step")
  // A typed answer.
  const before = await page.locator('[aria-label="Edit message"]').count()
  await send('There is no switch for it')
  await until(async () => (await lastReply().innerText()).includes('Night light is on.'), 'a typed message answers the step')
  await sleep(300)
  ok((await lastReply().innerText()).split('Night light is on.').length === 2, 'the reply shows its last line once')
  ok((await page.locator('[aria-label="Edit message"]').count()) === before, 'the typed answer is not a new message')
  await lastReply().getByText(/Computer/).first().click()
  ok((await lastReply().innerText()).includes('You said “There is no switch for it”'), 'the step line keeps what was typed')
  await capture('show-me-done')

  // Stop in the middle of typing.
  await page.getByRole('radio', { name: 'Do it' }).click()
  await send('Please type a lot')
  await until(async () => fake('type').length > 0, 'typing started')
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
} finally {
  await app.close()
}
ok(fake('dispose').length === 1, 'quitting disposed the platform once')
console.log(`E2E passed. Captures in ${outDir}`)
