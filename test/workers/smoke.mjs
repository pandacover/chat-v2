// Smoke test of workers in the built app, hidden (CHAT_V2_HEADLESS=1), with a scripted model that
// plays every bot (smoke-query.ts). It adds two bots in Settings › Bots, has Tomo hand a job to one
// (start_job), checks the report arriving in Tomo's conversation as a card, once, with Tomo's short
// answer after it, then a message sent while Tomo is replying: queued (a quiet note under it) and
// answered once that reply ends. Then the job view (its posts, the bots on it) and the worker's own
// thread (talking to it directly), then a request from one worker to a worker with more access:
// held on an approval card naming both, approved with Ctrl+Enter (the worker ends its reply; the
// answer comes as its next turn, and its report reaches Tomo after), and another denied with Esc.
// Then deleting a bot. Captures (light and dark) go to <outDir>.
//
//   bun run build
//   node test/workers/smoke.mjs <playwright-core dir> <outDir>
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const [pwDir, outDir = join(tmpdir(), 'tomo-workers-smoke')] = process.argv.slice(2)
if (!pwDir) throw new Error('usage: node test/workers/smoke.mjs <playwright-core dir> [outDir]')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const { _electron } = require(resolve(pwDir))
mkdirSync(outDir, { recursive: true })

const work = mkdtempSync(join(tmpdir(), 'tomo-workers-smoke-'))
const bundle = spawnSync('bun', ['build', join(repo, 'test/workers/smoke-query.ts'), '--target=node', '--format=cjs', '--external=electron', `--outfile=${join(work, 'smoke-query.cjs')}`], { stdio: 'inherit', shell: true })
if (bundle.status !== 0) throw new Error('bundling smoke-query failed')
const data = join(work, 'data')
mkdirSync(data)
writeFileSync(join(data, 'config.json'), JSON.stringify({ titleModel: '', memoryModel: '' }))

const env = { ...process.env, CHAT_V2_HEADLESS: '1', CHAT_V2_FAKE_QUERY: join(work, 'smoke-query.cjs') }
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
const until = async (f, what, ms = 12_000) => {
  const t0 = Date.now()
  while (!(await f().catch(() => false))) {
    if (Date.now() - t0 > ms) ok(false, what)
    await sleep(60)
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
const send = async (text) => {
  await composer.fill(text)
  await composer.press('Enter')
}
const nav = (name) => page.locator('nav[aria-label="Settings sections"]').getByRole('button', { name })
const reports = page.locator('[data-post="report"]')
const reportWith = (text) => reports.filter({ hasText: text })
const roster = page.locator('[data-roster] [data-roster-bot]')
const card = page.locator('[data-approval-elsewhere] [data-computer-wait="approval"]')
/** A job's row in the sidebar, in whichever section; shut sections are opened first. */
const jobRow = async (title) => {
  for (const head of await page.locator('aside [data-row^="section:"][aria-expanded="false"]').all()) await head.click()
  return page.locator('aside [data-row^="chat:"]', { hasText: title }).first()
}
const setTheme = async (name) => {
  await page.getByRole('radio', { name }).first().click()
  await sleep(400)
}

try {
  await composer.waitFor({ timeout: 15_000 })
  ok((await page.locator('[data-roster]').count()) === 0, 'with Tomo alone there is no roster')

  // Settings › Bots: two workers. Scout has no tools; Builder has the browser.
  await page.keyboard.press('Control+,')
  await page.locator('[data-add-bot]').waitFor()
  ok((await nav('Bots').getAttribute('aria-current')) === 'page', 'Settings opens on Bots')
  const addBot = async (name, instructions) => {
    await page.locator('[data-add-bot]').click()
    await page.locator('[data-bot-pick="New bot"]').waitFor()
    await page.locator('input[aria-label="Bot name"]').fill(name)
    await page.locator('textarea[aria-label="Instructions"]').fill(instructions)
    await page.locator(`[data-bot-pick="${name}"]`).waitFor()
    await sleep(700)
  }
  await addBot('Scout', 'Finds and compares options, and says which is best.')
  ok((await page.locator('[data-make-primary]').count()) === 1 && (await page.locator('[data-delete-bot]').count()) === 1, 'a worker can be made primary or deleted')
  ok((await page.locator('[role="radiogroup"][aria-label="Avatar"] [aria-label="The fox"]').count()) === 0, "a worker can't take the fox")
  await page.locator('[data-tint="green"]').click()
  await sleep(600)
  await addBot('Builder', 'Books and buys things on the web.')
  await page.getByRole('switch', { name: 'Browser' }).click()
  await page.getByRole('switch', { name: 'Browser', checked: true }).waitFor()
  await sleep(700)
  await page.locator('[data-bot-pick="Tomo"]').click()
  ok((await page.locator('[role="radiogroup"][aria-label="Avatar"] [aria-label="The fox"][aria-checked="true"]').count()) === 1, 'Tomo, the primary, shows the fox')
  await capture('1-settings-bots')
  await page.keyboard.press('Escape')
  await until(async () => (await roster.count()) === 3, 'the sidebar shows a roster of the three bots')
  const names = await roster.evaluateAll((els) => els.map((e) => e.dataset.rosterBot))
  ok(names.join(',') === 'Tomo,Scout,Builder', `the primary first (${names})`)

  // Tomo hands a job to Scout and carries on; Scout's report arrives in Tomo's conversation as a
  // card labelled with the job, and Tomo answers it in a line.
  await send('delegate: Compare the flights')
  await until(async () => (await reportWith('Scout done: Compare the flights').count()) === 1, "Scout's report arrives in Tomo's conversation as a card")
  const report = reportWith('Scout done: Compare the flights')
  ok((await report.locator('[data-post-job]').innerText()).trim() === 'Compare the flights', 'the card is labelled with its job')
  ok((await report.locator('[data-post-head]').innerText()).includes('Scout'), 'and names who reports')
  await until(async () => (await page.getByText('Tomo: Scout reported back.').count()) === 1, 'Tomo answers the report in a line')
  const order = await page.locator('.msg').evaluateAll((els) => els.map((e) => (e.querySelector('[data-post]') ? `card:${e.innerText.includes('Scout done: Compare the flights')}` : e.innerText.includes('Tomo: Scout reported back.') ? 'answer' : 'other')))
  ok(order.indexOf('card:true') >= 0 && order.indexOf('answer') === order.indexOf('card:true') + 1, `the answer comes right after the card (${order.join(', ')})`)
  ok(order.filter((o) => o === 'card:true').length === 1, 'and the report shows once')
  await until(async () => (await (await jobRow('Compare the flights')).locator('[data-row-owner="Scout"]').count()) === 1, "the job's row shows its owner, Scout")
  await sleep(500)
  await capture('2-report-card')

  // A message while Tomo is replying: queued, not refused, and answered once that reply ends.
  await send('linger 2500')
  await until(async () => (await page.getByText('Let me think about that.').count()) === 1, 'Tomo is replying')
  ok(await page.locator('button:has(.sr-only:text-is("Stop"))').count() === 1, 'the composer offers Stop while it replies')
  await composer.fill('Are you still there?')
  ok(await page.locator('button:has(.sr-only:text-is("Send"))').isEnabled(), 'with text in it, Send is on while Tomo replies')
  await composer.press('Enter')
  await until(async () => (await page.locator('[data-queued]').count()) === 1, 'the message shows as queued')
  ok((await page.locator('.msg', { has: page.locator('[data-queued]') }).innerText()).includes('Are you still there?'), 'under the message sent')
  ok((await page.getByText('Tomo heard: Are you still there?').count()) === 0, 'and is not answered yet')
  await sleep(300)
  await capture('2b-queued')
  await until(async () => (await page.getByText('Tomo heard: Are you still there?').count()) === 1, 'it is answered once the reply ends', 15_000)
  await until(async () => (await page.locator('[data-queued]').count()) === 0, 'and the note goes')
  ok((await page.getByText('Done thinking.').count()) === 1, 'the reply it waited for finished first')

  // The job view: the shared thread with its posts, and the bots on it.
  await report.locator('[data-post-job]').click()
  await until(async () => (await page.locator('[data-chat-title]').innerText()) === 'Compare the flights', 'the card opens its job')
  await until(async () => (await page.locator('[data-post]').count()) === 2, 'its shared thread holds the task and the report')
  ok((await page.locator('[data-post="task"] [data-post-head]').innerText()).includes('Tomo'), "the task is Tomo's, to Scout")
  await page.locator('[data-job-bar] [data-job-bot="Scout"]').waitFor()
  ok((await page.locator('[data-job-bar] [data-job-bot]').count()) === 2, 'the job bar shows the bots on the job')
  await page.locator('[data-job-notes-toggle]').click()
  await page.locator('[data-job-notes]').waitFor()
  await capture('3-job-view')
  await page.locator('[data-job-notes-toggle]').click()

  // Scout's own thread: talk to it directly.
  await page.locator('[data-job-bar] [data-job-bot="Scout"]').click()
  await until(async () => (await page.locator('[data-post="task"]').count()) === 1, "Scout's own thread opens, starting with the task from Tomo")
  // With the sidebar shut, the app bar names whose thread it is.
  await page.locator('[data-sidebar-toggle]').click()
  await until(async () => (await page.locator('[data-bar-bot-name]').count()) === 1 && (await page.locator('[data-bar-bot-name]').innerText()).trim() === 'Scout', 'the app bar shows Scout')
  await page.locator('[data-sidebar-toggle]').click()
  await send('Also check the trains')
  await until(async () => (await page.locator('[data-reply-scope]').last().innerText()).includes('Scout done: Also check the trains'), 'Scout answers you there')
  await capture('4-worker-thread')

  // A worker asking a worker with more access: held, on a card naming both. Ctrl+Enter approves.
  await page.locator('[data-primary-entry]').click()
  await until(async () => (await page.locator('[data-primary-entry].on').count()) === 1 && (await page.locator('[data-chat-title]').count()) === 0, "back in Tomo's conversation")
  await send('delegate: ask Builder | Book the cheaper one')
  await card.waitFor({ timeout: 15_000 })
  const text = await card.innerText()
  ok(text.includes('Scout asks Builder to do what Scout can’t'), `the card names who asks and who will act (${text.split('\n')[1]})`)
  ok(text.includes('Book the cheaper one'), 'and what will be done')
  ok((await page.locator('[data-approval-elsewhere]').innerText()).includes("From Scout's thread"), 'and says where it is from')
  await until(async () => (await roster.filter({ hasText: 'Scout' }).innerText()).includes('Waiting for you'), "Scout's presence says it waits for you")
  ok((await page.locator('[data-wait-badge]').count()) === 1, 'the job shows a badge in the sidebar')
  await sleep(900)
  await capture('5-approval-light')
  await page.keyboard.press('Control+Enter')
  await until(async () => (await card.count()) === 0, 'Ctrl+Enter approves it')
  await until(async () => (await reportWith('Scout done: Builder done: Book the cheaper one').count()) === 1, "Builder's answer reaches Scout as its next turn, and Scout's report reaches Tomo", 20_000)
  ok((await reportWith('Posted to Builder').count()) === 0, "Scout's reply that asked Builder didn't report on its own")
  await until(async () => (await page.getByText('Tomo: Scout reported back.').count()) === 2, 'Tomo answers that report too')
  ok((await page.locator('[data-wait-badge]').count()) === 0, 'the badge goes')

  // Esc denies: nothing reaches Builder.
  await send('delegate: ask Builder | Cancel the old booking')
  await card.waitFor({ timeout: 15_000 })
  await setTheme('Dark')
  await sleep(900)
  await capture('6-approval-dark')
  await page.keyboard.press('Escape')
  await until(async () => (await card.count()) === 0, 'Esc denies it')
  await until(async () => (await reportWith("didn't approve").count()) === 1, 'Scout reports it was not passed on')
  await sleep(400)
  await capture('7-conversation-dark')
  await (await jobRow('Cancel the old booking')).locator('button').first().click()
  await until(async () => (await page.locator('[data-post-state="declined"]').count()) === 1, 'the job shows the declined message')
  await capture('8-job-dark')
  await setTheme('Light')

  // Deleting a bot.
  await page.keyboard.press('Control+,')
  await page.locator('[data-bot-pick="Builder"]').click()
  await page.locator('[data-delete-bot]').click()
  await page.locator('[data-confirm-delete]').click()
  await until(async () => (await page.locator('[data-bot-pick="Builder"]').count()) === 0, 'Builder is deleted')
  await page.keyboard.press('Escape')
  await until(async () => (await roster.count()) === 2, 'and leaves the roster')

  ok(errors.length === 0, `no errors in the page${errors.length ? `: ${errors.join(' | ')}` : ''}`)
} finally {
  await app.close()
}

// The database, as the app left it.
const db = new DatabaseSync(join(data, 'chat.db'))
const posts = db.prepare(`select post_kind as k, post_state as s from messages where post_kind is not null and role = 'assistant' order by seq`).all()
console.log(posts.map((p) => `${p.k}${p.s ? ` (${p.s})` : ''}`).join(', '))
ok(posts.filter((p) => p.k === 'task').length === 3, 'three tasks handed out')
ok(posts.some((p) => p.s === 'declined'), 'one message declined')
ok(db.prepare(`select count(*) as n from sessions where kind = 'worker'`).get().n >= 3, "workers' own threads are kept")
ok(db.prepare(`select count(*) as n from bots`).get().n === 2, 'two bots left')
db.close()
console.log(`captures in ${outDir}`)
