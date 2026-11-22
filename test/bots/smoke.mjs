// Smoke test of bots and jobs in the built app, hidden (CHAT_V2_HEADLESS=1), on a chat.db seeded
// with chats from before bots (seed-old-db.ts) and a scripted model (smoke-query.ts). It checks the
// migration as the sidebar shows it, the sidebar's sections (Pinned, the jobs that need you,
// Working, Settled), talking to Tomo (everything stays in its one chat; work it hands itself runs in
// its own thread on a job and reports back as a card and a line), New topic (a divider, and a
// fresh session after it), continuing a finished job, and the Tomo card in Settings. Captures go to
// <outDir>.
//
//   bun run build
//   node test/bots/smoke.mjs <playwright-core dir> <outDir>
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const [pwDir, outDir = join(tmpdir(), 'tomo-bots-smoke')] = process.argv.slice(2)
if (!pwDir) throw new Error('usage: node test/bots/smoke.mjs <playwright-core dir> [outDir]')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const { _electron } = require(resolve(pwDir))
mkdirSync(outDir, { recursive: true })

const work = mkdtempSync(join(tmpdir(), 'tomo-bots-smoke-'))
const bundle = spawnSync('bun', ['build', join(repo, 'test/bots/smoke-query.ts'), '--target=node', '--format=cjs', '--external=electron', `--outfile=${join(work, 'smoke-query.cjs')}`], { stdio: 'inherit', shell: true })
if (bundle.status !== 0) throw new Error('bundling smoke-query failed')
const data = join(work, 'data')
mkdirSync(data)
writeFileSync(join(data, 'config.json'), JSON.stringify({ titleModel: 'claude-haiku-5-5', memoryModel: '', systemPrompt: 'Old global instructions.', effort: 'high' }))
const seed = spawnSync('bun', [join(repo, 'test/bots/seed-old-db.ts'), join(data, 'chat.db')], { stdio: 'inherit', shell: true })
if (seed.status !== 0) throw new Error('seeding failed')

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
const until = async (f, what, ms = 10_000) => {
  const t0 = Date.now()
  while (!(await f())) {
    if (Date.now() - t0 > ms) ok(false, what)
    await sleep(50)
  }
  ok(true, what)
}
/** A capture of the chat window. The hidden window paints only when captured, so this takes a few. */
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
    // The hidden window's compositor sometimes isn't ready for the first capture.
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
const sidebarRows = () => page.locator('aside [data-row^="chat:"]').allTextContents()
/** A section's label (Pinned, Working, Settled), which folds it. */
const head = (id) => page.locator(`aside [data-row="section:${id}"]`)
const headText = async (id) => ((await head(id).count()) ? (await head(id).textContent()).replace(/\s+/g, ' ').trim() : '')
const expanded = async (id) => (await head(id).getAttribute('aria-expanded')) === 'true'
const sectionRows = (id) => page.locator(`aside [data-section="${id}"] [data-row^="chat:"]`)
const inSection = async (id, title) => (await sectionRows(id).allTextContents()).some((r) => r.includes(title))
const authors = () => page.locator('[data-reply-author]').allInnerTexts()
/** Replies (not bots' posts, which are cards). */
const replies = () => page.locator('[data-reply-scope]:not([data-post])')
const lastReply = () => replies().last()
const repliesDone = async (n) => (await replies().allInnerTexts()).filter((t) => t.includes('That is all for now.')).length >= n
const dividers = () => page.locator('[data-topic]').count()
const rowCount = async () => (await sidebarRows()).length

try {
  await composer.waitFor({ timeout: 15_000 })
  await page.locator('[data-primary-entry]').waitFor()
  ok((await page.locator('[data-primary-entry]').innerText()).includes('Tomo'), 'the sidebar starts with Tomo')
  ok((await page.locator('[data-primary-entry].on').count()) === 1, "the app opens on Tomo's conversation")
  ok((await page.locator('[data-chat-title]').count()) === 0, 'whose it is is not repeated in the chat header')
  ok((await page.locator('[data-bar-bot]').count()) === 0, 'nor in the app bar while the sidebar shows it')
  ok((await page.locator('[data-job-chip]').count()) === 0, 'there is no job chip above the composer')
  // The sections as they start: Pinned and Settled shut, nothing that needs you, nothing running.
  ok(/^Pinned ?1$/.test(await headText('pinned')), `a pinned chat stays pinned (${await headText('pinned')})`)
  ok(/^Settled ?4$/.test(await headText('settled')), `the other old chats are settled, being finished (${await headText('settled')})`)
  ok(!(await expanded('pinned')) && !(await expanded('settled')), 'Pinned and Settled start shut')
  ok((await head('working').count()) === 0, 'with nothing running there is no Working section')
  ok((await page.locator('aside [data-nothing-needs-you]').innerText()).trim() === 'Nothing needs you', 'the main section says nothing needs you')
  ok((await rowCount()) === 0, 'shut sections show no rows')
  const layout = await page.evaluate(() => {
    const box = (sel) => document.querySelector(sel)?.getBoundingClientRect()
    return { pinned: box('aside [data-section="pinned"]'), main: box('aside [data-section="main"]'), settled: box('aside [data-section="settled"]') }
  })
  ok(layout.pinned.bottom <= layout.main.top && layout.main.bottom <= layout.settled.top, 'Pinned, then the main section, then Settled at the foot')
  ok(layout.main.height > 200, `the main section takes the free room (${Math.round(layout.main.height)}px)`)
  await capture('1-home')
  await head('pinned').click()
  await head('settled').click()
  ok((await expanded('pinned')) && (await expanded('settled')), 'a section opens from its label')
  await until(async () => (await rowCount()) === 5, 'every old chat is a job in the sidebar')
  ok(await inSection('pinned', 'Tomato soup recipe'), 'the pinned one in Pinned')
  // Kept across a reload.
  await page.reload()
  await composer.waitFor({ timeout: 15_000 })
  await until(async () => (await rowCount()) === 5 && (await expanded('pinned')) && (await expanded('settled')), 'open sections stay open after a reload')
  await capture('1a-sections-open')
  // The sidebar shut: the app bar names whose conversation is open.
  await page.locator('[data-sidebar-toggle]').click()
  await until(async () => (await page.locator('[data-bar-bot-name]').count()) === 1 && (await page.locator('[data-bar-bot-name]').innerText()).trim() === 'Tomo', 'the app bar shows Tomo with the sidebar shut')
  await capture('1b-bar-bot')
  await page.locator('[data-sidebar-toggle]').click()
  await until(async () => (await page.locator('[data-bar-bot]').count()) === 0, 'and not once it is open again')

  // Everything said to Tomo stays in its chat: no router, no job made for it, even about an old job.
  await send('Help, the printer is jammed again')
  await until(() => repliesDone(1), 'the reply streams in')
  let a = await authors()
  ok(a.length === 1 && a[0].trim() === 'Tomo', `the reply is Tomo's, on no job (${JSON.stringify(a)})`)
  ok(await inSection('settled', 'Printer keeps jamming'), 'the old printer job stays as it was, settled')
  ok((await rowCount()) === 5, 'and no job was made')
  await send('Hi there')
  await until(() => repliesDone(2), 'small talk is answered')
  ok((await authors()).at(-1).trim() === 'Tomo' && (await rowCount()) === 5, 'in the same chat, with no job')

  // Something that takes steps: Tomo hands it to itself, and the work runs in a job of its own.
  await send('make a page about cats')
  await until(async () => (await lastReply().innerText()).includes("I'm on it: making the cat page in its own thread."), 'Tomo says it is on it')
  ok((await lastReply().innerText()).includes('Started “Cat page” in its own thread'), 'with the hand-off as a step')
  await until(async () => /^Working ?1$/.test(await headText('working')), 'working, while Tomo does it in its own thread')
  if (!(await expanded('working'))) await head('working').click()
  await until(() => inSection('working', 'Cat page'), 'the job is in the sidebar, in Working')
  await capture('2-handed-off')
  // The report comes back into the chat as a card, with Tomo's line after it.
  await until(async () => (await page.locator('[data-post="report"]').count()) === 1, 'the report arrives in the chat as a card', 15_000)
  const report = page.locator('[data-post="report"]')
  ok((await report.innerText()).includes('Here it is.'), 'the card says what was done')
  ok((await report.locator('[data-post-job]').innerText()).trim() === 'Cat page', 'labelled with its job')
  await until(async () => (await lastReply().innerText()).includes('The cat page is ready: open the job to see it.'), "Tomo's line follows it")
  a = await authors()
  ok(a.at(-1).includes('Tomo') && a.at(-1).includes('Cat page'), `Tomo's answer is about the job (${a.at(-1)})`)
  await until(() => inSection('main', 'Cat page'), 'the job, reported back, needs a look (new)')
  await sleep(500)
  await capture('2a-reported')

  // The job opens on Tomo's own thread on it, where the work is.
  await report.locator('[data-post-job]').click()
  await until(async () => (await page.locator('[data-chat-title]').count()) === 1 && (await page.locator('[data-chat-title]').innerText()) === 'Cat page', "the card opens the job, on Tomo's own thread")
  ok((await lastReply().innerText()).includes('Here it is.'), 'which holds the work')
  ok((await page.locator('aside [data-row^="chat:"] .nav-item.on', { hasText: 'Cat page' }).count()) === 1, 'its row shows as open')
  await until(async () => !(await inSection('main', 'Cat page')), 'and opened, it needs you no more')
  await sleep(400)
  await capture('3-own-thread')
  await page.locator('[data-primary-entry]').click()
  await until(async () => (await page.locator('[data-primary-entry].on').count()) === 1, "back in Tomo's chat")

  // New topic: a divider, and Tomo's next reply starts afresh. From the Tomo row's compose button.
  ok((await dividers()) === 0, 'no divider yet')
  await send('What came before?')
  await until(async () => (await lastReply().innerText()).includes('I remember what came before.'), 'before New topic, Tomo carries on its session')
  await page.locator('[data-primary-entry]').hover()
  await page.locator('aside [data-primary-entry] ~ .acts [data-new-topic]').click()
  await until(async () => (await dividers()) === 1, 'New topic puts a divider in the chat')
  ok((await page.locator('[data-topic]').innerText()).trim().toLowerCase() === 'new topic', 'labelled New topic')
  await send('What came before?')
  await until(async () => (await lastReply().innerText()).includes('This is a fresh start.'), 'the next reply starts a fresh session')
  await send('What came before?')
  await until(async () => (await replies().allInnerTexts()).filter((t) => t.includes('I remember what came before.')).length === 2, 'and the one after carries on from it')
  await sleep(400)
  await capture('4-new-topic')
  // From the app bar with the sidebar shut, and Ctrl+N: one divider each time something came after.
  await page.locator('[data-sidebar-toggle]').click()
  await page.locator('[data-bar-bot]').waitFor()
  await page.locator('[data-sidebar-toggle] ~ [data-new-topic]').click()
  await until(async () => (await dividers()) === 2, 'the app bar’s New topic adds one')
  await page.locator('[data-sidebar-toggle]').click()
  await page.keyboard.press('Control+n')
  await sleep(500)
  ok((await dividers()) === 2, 'with nothing said since, Ctrl+N adds no second one')
  // From a job's thread, Ctrl+N goes back to Tomo's chat.
  await page.locator('aside [data-row^="chat:"]', { hasText: 'Rust lifetimes' }).locator('button').first().click()
  await until(async () => (await page.locator('[data-chat-title]').count()) === 1, 'a job opens')
  await page.keyboard.press('Control+n')
  await until(async () => (await page.locator('[data-primary-entry].on').count()) === 1, "Ctrl+N in a job's thread opens Tomo's chat")

  // A finished job's own thread: as a chat was.
  await page.locator('aside [data-row^="chat:"]', { hasText: 'Rust lifetimes' }).locator('button').first().click()
  await until(async () => (await page.locator('[data-chat-title]').innerText()) === 'Rust lifetimes', 'a job opens on its thread')
  ok((await page.locator('[data-job-finished]').count()) === 1, 'its header says it is finished')
  ok((await authors()).length === 0, "a job's thread looks as a chat did")
  await capture('5-0-finished')
  await send('Show me an example')
  await until(async () => (await lastReply().innerText()).includes('That is all for now.'), 'writing in it gets a reply')
  await until(async () => (await page.locator('[data-job-finished]').count()) === 0, 'and opens the job again')
  await capture('5-job-thread')

  // A reply that ends while its thread isn't open: the job needs you (it is new) until you open it.
  await send('Explain it slowly')
  await until(async () => /^Working ?1$/.test(await headText('working')), 'a running reply puts the job in Working')
  if (!(await expanded('working'))) await head('working').click()
  await until(() => inSection('working', 'Rust lifetimes'), 'open, Working shows the job')
  await page.locator('[data-primary-entry]').click()
  const order = await page.evaluate(() => {
    const top = (sel) => document.querySelector(sel)?.getBoundingClientRect().top ?? 0
    return [top('aside [data-section="main"]'), top('aside [data-section="working"]'), top('aside [data-section="settled"]')]
  })
  ok(order[0] < order[1] && order[1] < order[2], 'Working sits below the main section and above Settled')
  await capture('5a-working')
  await until(() => inSection('main', 'Rust lifetimes'), 'when the reply ends there unseen, the job moves into the main section', 10_000)
  ok((await page.locator('aside [data-section="main"] [data-need="unread"]', { hasText: 'Rust lifetimes' }).count()) === 1, 'marked as new')
  ok((await head('working').count()) === 0, 'and Working is gone with nothing running')
  await sleep(300)
  await capture('5b-unread')
  await page.getByRole('radio', { name: 'Dark' }).click()
  await sleep(500)
  await capture('5c-unread-dark')
  await page.getByRole('radio', { name: 'Light' }).click()
  await sectionRows('main').filter({ hasText: 'Rust lifetimes' }).locator('button').first().click()
  await until(async () => (await page.locator('[data-chat-title]').innerText()) === 'Rust lifetimes', 'the job opens')
  await until(async () => !(await inSection('main', 'Rust lifetimes')) && (await inSection('settled', 'Rust lifetimes')), 'opened, it leaves the main section for Settled')
  ok((await page.locator('aside [data-nothing-needs-you]').count()) === 1, 'and nothing needs you again')
  // Read stays read after a reload (it is saved).
  await page.locator('[data-primary-entry]').click()
  await page.reload()
  await composer.waitFor({ timeout: 15_000 })
  await until(async () => (await inSection('settled', 'Rust lifetimes')) && !(await inSection('main', 'Rust lifetimes')), 'and stays read after a reload')
  ok((await dividers()) === 2 && (await page.locator('[data-post="report"]').count()) === 1, 'the chat keeps its dividers and the report after a reload')

  // Settings › Bots: Tomo's card, with the instructions it was given from Settings.
  await page.keyboard.press('Control+,')
  await page.locator('[data-bot="tomo"]').waitFor()
  ok((await page.locator('textarea[aria-label="Instructions"]').inputValue()) === 'Old global instructions.', "Tomo's instructions came from Settings")
  await capture('6-settings')
  await page.keyboard.press('Escape')

  // Dark.
  await page.locator('[data-primary-entry]').click()
  await page.getByRole('radio', { name: 'Dark' }).click()
  await sleep(500)
  await capture('7-dark')
  await page.locator('aside [data-row^="chat:"]', { hasText: 'Cat page' }).locator('button').first().click()
  await until(async () => (await page.locator('[data-chat-title]').innerText()) === 'Cat page', "Tomo's own thread")
  await sleep(400)
  await capture('8-dark-own-thread')
  await page.locator('[data-primary-entry]').click()
  await page.getByRole('radio', { name: 'Light' }).click()

  ok(errors.length === 0, `no errors in the page${errors.length ? `: ${errors.join(' | ')}` : ''}`)
} finally {
  await app.close()
}

// The database, as the app left it.
const db = new DatabaseSync(join(data, 'chat.db'))
const jobs = db.prepare('select title, status from jobs order by title').all()
console.log(jobs.map((j) => `${j.status}  ${j.title}`).join('\n'))
ok(db.prepare(`select count(*) as n from sessions where kind = 'primary'`).get().n === 1, 'one primary conversation')
ok(db.prepare(`select count(*) as n from jobs`).get().n === 6, 'one job more than the old chats: the one handed off')
ok(db.prepare(`select count(*) as n from messages m join sessions s on s.id = m.session_id where s.kind = 'primary' and m.role = 'user' and m.author_bot_id is null`).get().n === 6, "the six things said to Tomo are all in its chat")
ok(db.prepare(`select count(*) as n from messages where via_session_id is not null and role = 'user' and author_bot_id is null and session_id != (select id from sessions where kind = 'primary')`).get().n === 0, 'none of them went to a job')
ok(db.prepare(`select count(*) as n from messages where post_kind = 'topic'`).get().n === 2, 'two dividers')
const own = db.prepare(`select s.kind, s.bot_id from sessions s join jobs j on j.id = s.job_id where j.title = 'Cat page' and s.kind = 'worker'`).all()
ok(own.length === 1 && own[0].bot_id === 'tomo', "the cat page was made in Tomo's own thread on its job")
ok(db.prepare(`select instructions, effort from bots where is_primary = 1`).get().effort === 'high', "Tomo's effort came from Settings")
ok(db.prepare(`select count(*) as n from sessions s where not exists (select 1 from jobs j where j.id = s.job_id) and s.kind != 'primary'`).get().n === 0, 'every thread has its job')
db.close()
console.log(`captures in ${outDir}`)
