// Usage, end to end in the built app, hidden (CHAT_V2_HEADLESS=1), on a scripted model
// (smoke-query.ts): the sidebar meter and its popover, the quiet warning before extra usage, a
// reply in Tomo's own thread on a job it handed itself, paused at the 5-hour limit, that continues
// by itself after the reset (and reports back once, when done), Cancel on a second pause, the job's
// use and share on its title and in Settings › Usage, in light and dark. Captures go to <outDir>.
//
//   bun run build
//   node test/usage/smoke.mjs <playwright-core dir> [outDir]
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [pwDir, outDir = join(tmpdir(), 'tomo-usage-smoke')] = process.argv.slice(2)
if (!pwDir) throw new Error('usage: node test/usage/smoke.mjs <playwright-core dir> [outDir]')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const { _electron } = require(resolve(pwDir))
mkdirSync(outDir, { recursive: true })

const work = mkdtempSync(join(tmpdir(), 'tomo-usage-smoke-'))
const r = spawnSync('bun', ['build', join(repo, 'test/usage/smoke-query.ts'), '--target=node', '--format=cjs', '--external=electron', `--outfile=${join(work, 'smoke-query.cjs')}`], { stdio: 'inherit', shell: true })
if (r.status !== 0) throw new Error('bundling smoke-query failed')
const data = join(work, 'data')
mkdirSync(data)
writeFileSync(join(data, 'config.json'), JSON.stringify({ titleModel: '', memoryModel: '' }))

const env = { ...process.env, CHAT_V2_HEADLESS: '1', CHAT_V2_FAKE_QUERY: join(work, 'smoke-query.cjs'), CHAT_V2_MIN_PAUSE_MS: '0' }
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
/** The hidden window paints only when captured; a few captures let transitions finish. */
const capture = async (name) => {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    for (let i = 0; i < 5; i++) {
      await w.webContents.capturePage()
      await new Promise((r) => setTimeout(r, 120))
    }
    return (await w.webContents.capturePage()).toPNG().toString('base64')
  })
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(png, 'base64'))
}

let page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await page.waitForSelector('textarea')
const composer = page.locator('textarea').first()
const send = async (text) => {
  await composer.fill(text)
  await composer.press('Enter')
}
const lastReply = () => page.locator('[data-reply-scope]').last()
const pauseCard = page.locator('[data-limit-pause]')
const meterRow = page.locator('[data-usage-meter]')

try {
  // The meter: read once at launch, no message sent.
  await meterRow.waitFor({ timeout: 15_000 })
  await until(async () => (await meterRow.innerText()).includes('Weekly') && (await meterRow.innerText()).includes('63%'), 'the sidebar meter shows the fullest window (weekly, 63%)')
  await meterRow.hover()
  const pop = page.getByRole('tooltip').filter({ hasText: 'Plan usage' })
  await pop.waitFor()
  const popText = await pop.innerText()
  ok(popText.includes('5-hour') && popText.includes('Weekly Fable') && popText.includes('$12.40 of $50.00'), 'its popover lists every window and the extra usage spent')
  await capture('meter-popover-light')
  await page.mouse.move(800, 400)

  // Work Tomo hands itself runs into the limit in its own thread on the job: a quiet warning first,
  // then it pauses with its work saved.
  await send('Write the long report')
  await until(async () => (await lastReply().innerText()).includes("I'm on it."), 'Tomo hands the write-up to itself')
  const toast = page.locator('[role="status"]').filter({ hasText: 'extra usage' })
  await until(async () => (await toast.count()) > 0, 'a quiet notice warns before work moves onto extra usage')
  ok((await toast.first().innerText()).includes('85% of your 5-hour limit'), `the notice names the window (${(await toast.first().innerText()).trim()})`)
  // The job opens on Tomo's own thread on it, where the reply is paused.
  const jobRow = page.locator('aside [data-row^="chat:"]', { hasText: 'Long write-up' })
  await until(async () => (await jobRow.count()) === 1, 'the job is in the sidebar')
  await jobRow.locator('button').first().click()
  await until(async () => (await page.locator('[data-chat-title]').count()) === 1 && (await page.locator('[data-chat-title]').innerText()) === 'Long write-up', "it opens on Tomo's own thread")
  await pauseCard.waitFor()
  ok((await pauseCard.innerText()).includes('Paused at your 5-hour limit'), 'the reply pauses at the 5-hour limit')
  ok((await lastReply().innerText()).includes('Part one.'), 'with its work so far kept')
  await until(async () => (await meterRow.innerText()).includes('Paused'), 'the meter says a reply is paused')
  await capture('paused-light')
  // At the reset it continues by itself.
  await until(async () => (await lastReply().innerText()).includes('Part two.'), 'it continues by itself after the reset', 20_000)
  await until(async () => (await pauseCard.count()) === 0, 'and the pause card goes')
  ok((await lastReply().innerText()).split('Part one.').length === 2, 'the continuation does not repeat the first part')

  // A second pause, cancelled: the reply stays stopped with Continue and Retry.
  await send('Hit the limit again')
  await pauseCard.waitFor()
  await pauseCard.getByRole('button', { name: 'Cancel' }).click()
  await until(async () => (await pauseCard.count()) === 0, 'Cancel ends the pause')
  ok((await lastReply().innerText()).includes('Stopped.') && (await lastReply().getByRole('button', { name: 'Continue' }).count()) === 1, 'the reply stays stopped, with Continue')

  // The job's title says what the job used, and its share.
  const jobTitle = (await page.locator('[data-chat-title]').innerText()).trim()
  await page.locator('[data-chat-title]').hover()
  const titleTip = page.locator('.app-tooltip')
  await until(async () => (await titleTip.count()) > 0 && /Used .*tokens · \$.*of this 5-hour window.*\(an estimate\)/.test(await titleTip.first().innerText()), "the job title's tooltip gives the job's use and estimated share")
  console.log(`   tooltip: ${await titleTip.first().innerText()}`)
  await capture('job-title-light')
  await page.mouse.move(800, 300)
  // In Tomo's chat the report came back once, when the write-up was done; the pause didn't report.
  await page.locator('[data-primary-entry]').click()
  await until(async () => (await page.locator('[data-post="report"]').count()) === 1, "the finished write-up's report is in Tomo's chat")
  ok((await page.locator('[data-post="report"]').innerText()).includes('Part two.') && !(await page.locator('[data-post="report"]').innerText()).includes('stopped'), 'once, with the finished work')
  await jobRow.locator('button').first().click()
  await until(async () => (await page.locator('[data-chat-title]').count()) === 1, 'back on the job')

  // Settings › Usage, from the meter.
  await meterRow.click()
  const usage = page.locator('#settings-usage')
  await usage.waitFor()
  await until(async () => (await usage.locator('[data-usage-window]').count()) >= 3, 'Settings › Usage lists the windows')
  const text = await usage.innerText()
  ok(/max plan/i.test(text) && /extra usage/i.test(text) && text.includes('$12.40 of $50.00 this month'), 'with the plan and extra usage')
  ok(!text.includes('Past it, work moves onto extra usage'), 'no extra-usage warning once a limit was hit without it')
  // The open thread is on the job: its use, and its share, estimated.
  await until(async () => (await usage.locator('[data-usage-job]').count()) === 1, 'Settings › Usage shows the current job')
  ok((await usage.locator('[data-usage-job]').innerText()).includes(jobTitle), 'the one open')
  ok(/tokens · \$[\d.]+ over \d+ repl/.test(await usage.locator('[data-usage-job]').innerText()), 'with its tokens and cost')
  await until(async () => (await usage.locator('[data-usage-share]').count()) === 2, "and the job's estimated share of the 5-hour window and the week")
  const shareText = await usage.locator('[data-usage-share="five_hour"]').innerText()
  // The 5-hour window rose to 85 and 100 while the job's replies ran (in its thread): it's theirs.
  ok(/^about \d+% of this 5-hour window$/.test(shareText), `labelled as an estimate (${shareText}; ${await usage.locator('[data-usage-share="seven_day"]').innerText()})`)
  await capture('settings-usage-light')
  await page.keyboard.press('Escape')
  await page.getByRole('radio', { name: 'Dark' }).click()
  await sleep(300)
  await capture('paused-cancelled-dark')
  await meterRow.click()
  await usage.waitFor()
  await sleep(400)
  await capture('settings-usage-dark')
  await page.keyboard.press('Escape')
  await meterRow.hover()
  await pop.waitFor()
  await capture('meter-popover-dark')
  ok(errors.length === 0, `no errors in the page${errors.length ? `: ${errors.join(' | ')}` : ''}`)
} finally {
  await app.close()
}
console.log(`Usage smoke passed. Captures in ${outDir}`)
