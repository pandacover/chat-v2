// Smoke test, in the built app run hidden (CHAT_V2_HEADLESS=1) with a scripted model
// (smoke-query.ts): the browser and artifacts belong to the thread they were opened in. Tomo hands
// a job to itself whose thread drives the browser on a local page while the user goes on talking
// to Tomo. Tomo's chat must not show the browser, its panel, or that thread's browser steps; the
// page still loads, waits and is captured out of sight; opening the job shows the browser there,
// and its artifact stays with it as the user goes back and forth. Also: Settings' Close stays in
// view when its page scrolls. Captures go to <outDir>.
//
//   bun run build
//   node test/browser/smoke.mjs <playwright-core dir> <outDir>
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [pwDir, outDir = join(tmpdir(), 'tomo-browser-smoke')] = process.argv.slice(2)
if (!pwDir) throw new Error('usage: node test/browser/smoke.mjs <playwright-core dir> [outDir]')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const { _electron } = require(resolve(pwDir))
mkdirSync(outDir, { recursive: true })

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><title>Test page for Tomo</title><body style="background:#fde"><h1>Test page for Tomo</h1><p>Otters hold hands while they sleep.</p></body>')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const pageUrl = `http://127.0.0.1:${server.address().port}/`

const work = mkdtempSync(join(tmpdir(), 'tomo-browser-smoke-'))
const bundle = spawnSync('bun', ['build', join(repo, 'test/browser/smoke-query.ts'), '--target=node', '--format=cjs', '--external=electron', `--outfile=${join(work, 'smoke-query.cjs')}`], { stdio: 'inherit', shell: true })
if (bundle.status !== 0) throw new Error('bundling smoke-query failed')
const data = join(work, 'data')
mkdirSync(data)
writeFileSync(join(data, 'config.json'), JSON.stringify({ titleModel: 'claude-haiku-5-5', memoryModel: '' }))

const env = { ...process.env, CHAT_V2_HEADLESS: '1', CHAT_V2_FAKE_QUERY: join(work, 'smoke-query.cjs'), CHAT_V2_TEST_PAGE: pageUrl }
delete env.ELECTRON_RUN_AS_NODE
const app = await _electron.launch({ executablePath: require(join(repo, 'node_modules/electron')), args: [repo, `--user-data-dir=${data}`], env })
const log = []
app.process().stdout.on('data', (d) => log.push(...d.toString().split('\n').filter(Boolean)))
app.process().stderr.on('data', (d) => log.push(...d.toString().split('\n').filter(Boolean)))

const ok = (cond, what) => {
  if (!cond) throw new Error(`FAILED: ${what}\n--- app output ---\n${log.slice(-60).join('\n')}`)
  console.log(`ok: ${what}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (f, what, ms = 15_000) => {
  const t0 = Date.now()
  while (!(await f())) {
    if (Date.now() - t0 > ms) ok(false, what)
    await sleep(50)
  }
  ok(true, what)
}
const capture = async (name, tries = 3) => {
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
    if (tries > 1) return capture(name, tries - 1)
    console.log(`(no capture of ${name}: ${String(e).split('\n')[0]})`)
  }
}

const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

const composer = page.locator('textarea').first()
const send = async (text) => {
  await composer.fill(text)
  await composer.press('Enter')
}
const replies = () => page.locator('[data-reply-scope]:not([data-post])')
const replyTexts = () => replies().allInnerTexts()
const panelState = () => page.locator('[data-panel]').getAttribute('data-panel')
const browserState = async () => ((await page.locator('[data-browser]').count()) ? page.locator('[data-browser]').getAttribute('data-browser') : 'none')
const tabs = async () => page.locator('[data-panel="open"] [data-panel-tab]').evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('data-panel-tab')))])
/** The URL the browser's page is on, read from its webview in main. */
const guestUrl = () => app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getType() === 'webview')?.getURL() ?? '')
const jobRow = () => page.locator('aside [data-row^="chat:"]', { hasText: 'Browse test page' })

try {
  await composer.waitFor({ timeout: 15_000 })
  const bots = await page.evaluate(() => window.api.bots.list())
  const tomo = bots.find((b) => b.isPrimary)
  await page.evaluate((id) => window.api.bots.update(id, { modules: ['browser'] }), tomo.id)
  ok(true, `Tomo (${tomo.id}) may use the browser`)

  await send('browse: the test page')
  await until(async () => (await guestUrl()).startsWith(pageUrl), "Tomo's own thread opens the test page in the browser")
  // Tomo's chat goes on while the job's thread drives the browser.
  await send('hello, slowly')
  let seen = []
  await until(async () => {
    seen = await replyTexts()
    const last = seen.at(-1) ?? ''
    return last.includes('Sure.') && !last.includes('You said')
  }, "Tomo's reply to the next message is streaming").catch((e) => {
    throw new Error(`${e.message}\n--- replies ---\n${seen.join('\n---\n')}`)
  })
  const during = { panel: await panelState(), browser: await browserState(), toggle: await page.locator('[data-panel-toggle]').getAttribute('aria-pressed') }
  ok(during.panel === 'parked' && during.toggle === 'false', `Tomo's chat shows no panel while the job's thread browses (${JSON.stringify(during)})`)
  ok(during.browser === 'away', 'the browser runs out of sight, mounted but not on show')
  const steps = await page.locator('[data-reply-scope]').allInnerTexts()
  ok(!steps.some((t) => /Waiting 7s|Opened 127\.0\.0\.1|Waited|Claude is browsing/.test(t)), "none of the job thread's browser steps show in Tomo's chat")
  const streaming = (await replies().last().innerText()).trim()
  ok(/^Tomo\s+Sure\.$/.test(streaming), `Tomo's streaming reply shows only its own words (${JSON.stringify(streaming)})`)
  await capture('1-tomo-while-thread-browses')

  await until(async () => (await replyTexts()).some((t) => t.includes('You said: hello, slowly')), "Tomo's reply ends")
  ok((await panelState()) === 'parked', 'still no panel in Tomo’s chat after its reply')
  await until(async () => (await replyTexts()).some((t) => t.includes('The browsing job is done')), 'the job reports back to Tomo', 30_000)
  ok((await panelState()) === 'parked', 'nor once the report is in')

  // The job's thread has the browser, its steps and its artifact.
  await jobRow().first().click()
  await until(async () => (await panelState()) === 'open' && (await browserState()) === 'shown', "opening the job shows the browser in its thread's panel")
  const thread = (await replyTexts()).join('\n')
  ok(/Opened: ok/.test(thread) && /Waited: ok/.test(thread), `the page loaded and the wait ran while out of sight (${thread.match(/Opened: [^\n]*|Waited: [^\n]*/g)})`)
  ok(/Screenshot: ok/.test(thread), `a screenshot taken out of sight came back (${thread.match(/Screenshot: [^\n]*/)})`)
  ok((await tabs()).includes('browser'), 'its panel has the browser tab')
  await capture('2-job-thread-with-browser')
  await page.locator('[data-reply-scope] button', { hasText: 'Notes' }).first().click()
  await until(async () => (await tabs()).includes('artifact:notes'), 'its artifact opens in a tab beside the browser')

  // Back to Tomo: neither the browser nor the artifact comes along.
  await page.locator('[data-primary-entry]').click()
  await until(async () => (await panelState()) === 'parked', "back in Tomo's chat the panel goes")
  await page.locator('[data-panel-toggle]').click()
  await until(async () => (await panelState()) === 'open', "Tomo's own panel opens from the toggle")
  ok((await tabs()).length === 0, `with nothing of the job's in it (${await tabs()})`)
  ok((await browserState()) === 'away', 'the browser stays mounted out of sight for the job')
  await capture('3-tomo-panel-empty')
  await page.locator('[data-panel-toggle]').click()
  await until(async () => (await panelState()) === 'parked', 'and closes again')

  // And back to the job: both are where they were.
  await jobRow().first().click()
  await until(async () => (await panelState()) === 'open', "the job's panel comes back with it")
  const back = await tabs()
  ok(back.includes('browser') && back.includes('artifact:notes'), `with the browser and the artifact (${back})`)
  ok((await guestUrl()).startsWith(pageUrl), 'and the page still loaded')

  // Closing the browser in the job's thread closes it.
  await page.locator('[data-panel="open"] [data-panel-close="browser"]').first().click()
  await until(async () => (await browserState()) === 'none', 'closing its tab closes the browser')

  // Settings: Close stays in view when the page scrolls.
  await page.keyboard.press('Control+,')
  await page.locator('[data-settings-scroller]').waitFor()
  const closeAt = async () => page.locator('[data-settings-close]').evaluate((e) => e.getBoundingClientRect().top)
  const before = await closeAt()
  await page.locator('[data-settings-scroller]').evaluate((e) => e.scrollTo({ top: e.scrollHeight }))
  await sleep(200)
  const scrolled = await page.locator('[data-settings-scroller]').evaluate((e) => e.scrollTop)
  ok(scrolled > 100, `Settings' page scrolls (${scrolled}px)`)
  ok(Math.abs((await closeAt()) - before) < 1, `Close stays where it was (${before} → ${await closeAt()})`)
  await capture('4-settings-scrolled')
  await page.keyboard.press('Escape')

  ok(errors.length === 0, `no errors in the window${errors.length ? `: ${errors.join(' | ')}` : ''}`)
  console.log('PASS')
} finally {
  await app.close().catch(() => {})
  server.close()
}
