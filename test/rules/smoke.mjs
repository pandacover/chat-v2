// Smoke test of rules in the built app, hidden (CHAT_V2_HEADLESS=1), with a scripted model
// (smoke-query.ts): Settings › Bots (tools, rules, locked rules), the composer's read-only tools,
// and a reply whose calls are asked about (approved with Ctrl+Enter, denied with Esc) or blocked.
// Captures, light and dark, go to <outDir>.
//
//   bun run build
//   node test/rules/smoke.mjs <playwright-core dir> <outDir>
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const [pwDir, outDir = join(tmpdir(), 'tomo-rules-smoke')] = process.argv.slice(2)
if (!pwDir) throw new Error('usage: node test/rules/smoke.mjs <playwright-core dir> [outDir]')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const { _electron } = require(resolve(pwDir))
mkdirSync(outDir, { recursive: true })

const work = mkdtempSync(join(tmpdir(), 'tomo-rules-smoke-'))
const bundle = spawnSync('bun', ['build', join(repo, 'test/rules/smoke-query.ts'), '--target=node', '--format=cjs', '--external=electron', `--outfile=${join(work, 'smoke-query.cjs')}`], { stdio: 'inherit', shell: true })
if (bundle.status !== 0) throw new Error('bundling smoke-query failed')
const data = join(work, 'data')
mkdirSync(data)
writeFileSync(join(data, 'config.json'), JSON.stringify({ titleModel: '', memoryModel: '' }))

const env = { ...process.env, CHAT_V2_HEADLESS: '1', CHAT_V2_FAKE_QUERY: join(work, 'smoke-query.cjs') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CHAT_V2_FAKE_COMPUTER
const app = await _electron.launch({ executablePath: require(join(repo, 'node_modules/electron')), args: [repo, `--user-data-dir=${data}`], env })
const log = []
app.process().stdout.on('data', (d) => log.push(...d.toString().split('\n').filter(Boolean)))
app.process().stderr.on('data', (d) => log.push(...d.toString().split('\n').filter(Boolean)))

const ok = (cond, what) => {
  if (!cond) throw new Error(`FAILED: ${what}\n--- app output ---\n${log.slice(-60).join('\n')}`)
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
/** A capture of the chat window. The hidden window paints only when captured, so this takes a few. */
const capture = async (name) => {
  try {
    const png = await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'))
      for (let i = 0; i < 6; i++) {
        await w.webContents.capturePage()
        await new Promise((r) => setTimeout(r, 120))
      }
      return (await w.webContents.capturePage()).toPNG().toString('base64')
    })
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(png, 'base64'))
  } catch (e) {
    console.log(`(no capture of ${name}: ${String(e).split('\n')[0]})`)
  }
}

const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

const composer = page.locator('textarea').first()
const lastReply = () => page.locator('[data-reply-scope]').last()
const tools = page.locator('button[data-tools]')
const card = page.locator('[data-computer-wait="approval"]')
const rule = (id) => page.locator(`[data-rule="${id}"]`)
const verdictOf = async (id) => (await rule(id).locator('[role="radio"][aria-checked="true"]').innerText()).trim()
const nav = (name) => page.locator('nav[aria-label="Settings sections"]').getByRole('button', { name })
/** Light or dark, from Settings › Appearance, back on Bots. */
const setTheme = async (name) => {
  await nav('Appearance').click()
  await page.locator('#settings-appearance').getByRole('radio', { name }).click()
  await nav('Bots').click()
  await sleep(300)
}

try {
  await composer.waitFor({ timeout: 15_000 })

  // The composer shows what Tomo can use; no switches.
  ok((await page.getByRole('switch', { name: 'Computer' }).count()) + (await page.getByRole('switch', { name: 'Browser' }).count()) === 0, 'the composer has no Computer or Browser switch')
  ok((await tools.getAttribute('data-tools')) === 'none', 'a new Tomo has no tools on, as the switches started')

  // Settings › Bots, from the composer's tools.
  await tools.click()
  await page.locator('[data-bot="tomo"]').waitFor()
  ok((await nav('Bots').getAttribute('aria-current')) === 'page', 'the tools open Settings › Bots')
  ok((await page.getByRole('switch', { name: 'Computer', checked: false }).count()) === 1, 'Computer is off')
  ok((await page.locator('[data-rule-group="shell"]').innerText()).includes('Turn on Computer to use these'), 'its groups say what turns them on')
  ok(await rule('shell.run').getByRole('radio', { name: 'Ask' }).isDisabled(), "and can't be set while it is off")

  // Defaults, from computer/policy.ts.
  ok((await verdictOf('shell.read')) === 'Allow' && (await verdictOf('shell.run')) === 'Ask' && (await verdictOf('files.write')) === 'Ask', 'defaults: read-only commands allowed, other commands and file writes ask')
  for (const id of ['computer.irreversible', 'shell.irreversible']) {
    ok((await verdictOf(id)) === 'Ask', `${id} asks`)
    ok(await rule(id).getByRole('radio', { name: 'Allow' }).isDisabled(), `${id} can't be set to allow`)
  }

  // The browser on; clicking asks, scripts are blocked, job notes ask.
  await page.getByRole('switch', { name: 'Browser' }).click()
  await page.getByRole('switch', { name: 'Browser', checked: true }).waitFor()
  await rule('browser.act').getByRole('radio', { name: 'Ask' }).click()
  await rule('browser.script').getByRole('radio', { name: 'Block' }).click()
  await rule('jobs.notes').getByRole('radio', { name: 'Ask' }).click()
  ok((await verdictOf('browser.act')) === 'Ask' && (await verdictOf('browser.script')) === 'Block' && (await verdictOf('jobs.notes')) === 'Ask', 'rules are picked per tool')
  await page.getByText('Reset to defaults').waitFor()
  await sleep(700)
  await page.locator('[aria-label="Tools"]').scrollIntoViewIfNeeded()
  await page.locator('[data-rule-group="computer"]').scrollIntoViewIfNeeded()
  await capture('1-tools-light')
  await page.locator('[data-rule-group="browser"]').scrollIntoViewIfNeeded()
  await capture('2-rules-light')
  await setTheme('Dark')
  await page.locator('[data-rule-group="browser"]').scrollIntoViewIfNeeded()
  await capture('3-rules-dark')
  await page.locator('[data-bot="tomo"]').scrollIntoViewIfNeeded()
  await capture('4-bots-dark')
  await setTheme('Light')
  await page.keyboard.press('Escape')
  await until(async () => (await tools.getAttribute('data-tools')) === 'browser', "the composer shows Tomo's browser")
  await capture('5-composer')

  // A reply under those rules.
  await composer.fill('Buy the camera on the shop page')
  await composer.press('Enter')
  await card.waitFor({ timeout: 15_000 })
  ok((await card.innerText()).includes('Write a job note'), 'the first ask is on the approval card, saying what will be done')
  ok((await card.innerText()).includes('Looked at the shop page.'), 'and to what')
  await sleep(900)
  await capture('6-ask-light')
  await page.keyboard.press('Control+Enter')
  await until(async () => (await lastReply().innerText()).includes('Note: ran.'), 'Ctrl+Enter approves it, and it runs')
  await until(async () => (await card.count()) === 1 && (await card.innerText()).includes('Act on a web page'), 'the click asks next')
  await sleep(900)
  await page.keyboard.press('Escape')
  await until(async () => (await lastReply().innerText()).includes('Click: refused (The user denied this.)'), 'Esc denies it, and it never runs')
  await until(async () => (await lastReply().innerText()).includes('All done.'), 'the reply goes on to its end')
  const text = await lastReply().innerText()
  ok(/Script: refused \(The user's rules for Tomo block this/.test(text), 'the blocked script is refused without asking, and the model is told why')
  await until(async () => (await card.count()) === 0, 'no card is left waiting')
  await capture('7-reply')

  ok(errors.length === 0, `no errors in the page${errors.length ? `: ${errors.join(' | ')}` : ''}`)
} finally {
  await app.close()
}

// The database, as the app left it.
const db = new DatabaseSync(join(data, 'chat.db'))
const bot = db.prepare('select modules, rules from bots where is_primary = 1').get()
ok(bot.modules === '["browser"]', `Tomo's modules are saved (${bot.modules})`)
ok(JSON.stringify(JSON.parse(bot.rules)) === JSON.stringify({ 'browser.act': 'ask', 'browser.script': 'block', 'jobs.notes': 'ask' }), `and its rules (${bot.rules})`)
ok(db.prepare(`select count(*) as n from memory_current where scope = 'job'`).get().n === 1, 'the approved note was written')
db.close()
console.log(`Rules smoke passed. Captures in ${outDir}`)
