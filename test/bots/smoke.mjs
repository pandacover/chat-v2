// Smoke test of bots and jobs in the built app, hidden (CHAT_V2_HEADLESS=1), on a chat.db seeded
// with chats from before bots (seed-old-db.ts) and a scripted model (smoke-query.ts). It checks the
// migration as the sidebar shows it, the sidebar's sections (Pinned, the jobs that need you,
// Working, Settled), talking to Tomo (routing, the reply's author and job, the job
// chip moving a wrong guess), sending while another job's reply runs, continuing a finished job,
// and the Tomo card in Settings. Captures go to <outDir>.
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
const lastReply = () => page.locator('[data-reply-scope]').last()
const chip = page.locator('[data-job-chip] button[aria-haspopup="menu"]')
const repliesDone = async (n) => (await page.locator('[data-reply-scope]').allInnerTexts()).filter((t) => t.includes('That is all for now.')).length >= n

try {
  await composer.waitFor({ timeout: 15_000 })
  await page.locator('[data-primary-entry]').waitFor()
  ok((await page.locator('[data-primary-entry]').innerText()).includes('Tomo'), 'the sidebar starts with Tomo')
  ok((await page.locator('[data-primary-entry].on').count()) === 1, "the app opens on Tomo's conversation")
  ok((await page.locator('[data-chat-title]').count()) === 0, 'whose it is is not repeated in the chat header')
  ok((await page.locator('[data-bar-bot]').count()) === 0, 'nor in the app bar while the sidebar shows it')
  // The sections as they start: Pinned and Settled shut, nothing that needs you, nothing running.
  ok(/^Pinned ?1$/.test(await headText('pinned')), `a pinned chat stays pinned (${await headText('pinned')})`)
  ok(/^Settled ?4$/.test(await headText('settled')), `the other old chats are settled, being finished (${await headText('settled')})`)
  ok(!(await expanded('pinned')) && !(await expanded('settled')), 'Pinned and Settled start shut')
  ok((await head('working').count()) === 0, 'with nothing running there is no Working section')
  ok((await page.locator('aside [data-nothing-needs-you]').innerText()).trim() === 'Nothing needs you', 'the main section says nothing needs you')
  ok((await sidebarRows()).length === 0, 'shut sections show no rows')
  const layout = await page.evaluate(() => {
    const box = (sel) => document.querySelector(sel)?.getBoundingClientRect()
    return { pinned: box('aside [data-section="pinned"]'), main: box('aside [data-section="main"]'), settled: box('aside [data-section="settled"]') }
  })
  ok(layout.pinned.bottom <= layout.main.top && layout.main.bottom <= layout.settled.top, 'Pinned, then the main section, then Settled at the foot')
  ok(layout.main.height > 200, `the main section takes the free room (${Math.round(layout.main.height)}px)`)
  ok((await chip.innerText()).includes('Tomo picks the job'), 'the chip says Tomo picks the job')
  await capture('1-home')
  await head('pinned').click()
  await head('settled').click()
  ok((await expanded('pinned')) && (await expanded('settled')), 'a section opens from its label')
  await until(async () => (await sidebarRows()).length === 5, 'every old chat is a job in the sidebar')
  ok(await inSection('pinned', 'Tomato soup recipe'), 'the pinned one in Pinned')
  // Kept across a reload.
  await page.reload()
  await composer.waitFor({ timeout: 15_000 })
  await until(async () => (await sidebarRows()).length === 5 && (await expanded('pinned')) && (await expanded('settled')), 'open sections stay open after a reload')
  await capture('1a-sections-open')
  // The sidebar shut: the app bar names whose conversation is open, after New topic.
  await page.locator('[data-sidebar-toggle]').click()
  await until(async () => (await page.locator('[data-bar-bot-name]').count()) === 1 && (await page.locator('[data-bar-bot-name]').innerText()).trim() === 'Tomo', 'the app bar shows Tomo with the sidebar shut')
  await capture('1b-bar-bot')
  await page.locator('[data-sidebar-toggle]').click()
  await until(async () => (await page.locator('[data-bar-bot]').count()) === 0, 'and not once it is open again')

  // Back to an old (finished) job, picked by the router; it opens again.
  await send('Help, the printer is jammed again')
  await until(() => repliesDone(1), 'the reply streams in')
  let a = await authors()
  ok(a.length === 1 && a[0].includes('Tomo') && a[0].includes('Printer keeps jamming'), `the reply is signed by Tomo, in the printer job (${a})`)
  await until(async () => !/finished/i.test(await chip.innerText()), 'the printer job is open again')
  ok((await chip.innerText()).includes('Printer keeps jamming'), 'the chip shows the current job')

  // Something new: a new job, named by the router.
  await send('Plan a trip to Lisbon in May')
  await until(() => repliesDone(2), 'the second reply streams in')
  a = await authors()
  ok(a.at(-1).includes('Trip to Lisbon'), 'a new topic gets a new job')
  await until(async () => (await sidebarRows()).some((r) => r.includes('Trip to Lisbon')), 'the new job is in the sidebar (in Settled, once its reply ended)')
  await capture('2-routed')

  // Changing the topic with nothing typed sends nothing again: it only picks where the next message goes.
  const menu = page.locator('[data-job-chip] [role="menu"]')
  const turns = async () => (await page.locator('[data-reply-scope]').count())
  const before = await turns()
  await chip.click()
  await menu.waitFor()
  ok((await menu.innerText()).toLowerCase().includes('send your next message to'), 'with nothing typed, the chip picks where the next message goes')
  await menu.getByRole('menuitem', { name: /^New topic/ }).click()
  ok((await chip.innerText()).includes('New topic'), 'the chip shows New topic')
  await chip.click()
  await menu.getByRole('menuitem', { name: /Printer keeps jamming/ }).click()
  ok((await chip.innerText()).includes('Printer keeps jamming'), 'and then the picked job')
  await sleep(800)
  ok((await turns()) === before && (await authors()).at(-1).includes('Trip to Lisbon'), 'picking a topic sent the last message nowhere')
  ok((await sidebarRows()).some((r) => r.includes('Trip to Lisbon')), 'and its job is still there')
  await page.getByRole('button', { name: 'Let Tomo pick' }).click()

  // A wrong guess, put right with the chip's own Move item: the last message moves to the printer job.
  await chip.click()
  await menu.locator('[data-move-last]').click()
  ok((await menu.innerText()).toLowerCase().includes('move your last message to'), 'the Move item asks where the last message goes')
  ok((await menu.getByRole('menuitem', { name: /Trip to Lisbon/ }).count()) === 0, 'without the job it is already in')
  await capture('3-chip-menu')
  await menu.getByRole('menuitem', { name: /Printer keeps jamming/ }).click()
  await until(async () => (await authors()).at(-1)?.includes('Printer keeps jamming'), 'the moved turn is answered in the printer job')
  await until(async () => !(await sidebarRows()).some((r) => r.includes('Trip to Lisbon')), 'the job made for it is gone')
  await until(() => repliesDone(2), 'and its reply finished')

  // Nothing pauses: a message for another job goes while a reply still runs.
  await send('Is the printer toner low?')
  await sleep(450)
  await send('Find hotels in Lisbon')
  await until(() => repliesDone(4), 'both replies finish', 15_000)
  a = await authors()
  ok(a.at(-1).includes('Trip to Lisbon') && a.at(-2).includes('Printer keeps jamming'), `each went to its own job (${a.slice(-2)})`)

  // The chip before sending: picked job for the next message.
  await composer.fill('Something about soup')
  await chip.click()
  ok((await menu.innerText()).toLowerCase().includes('send your next message to'), 'with a draft, the chip picks where it goes')
  await menu.getByRole('menuitem', { name: /Tomato soup recipe$/ }).first().click()
  ok((await chip.innerText()).includes('Tomato soup recipe'), 'the chip shows the picked job')
  await composer.press('Enter')
  await until(() => repliesDone(5), 'the picked job answers')
  ok((await authors()).at(-1).includes('Tomato soup recipe'), 'the message went to the picked job')
  await sleep(600)
  await capture('4-conversation')

  // Small talk makes no job: Tomo answers it in its own conversation.
  const jobRows = (await sidebarRows()).length
  await send('Hi there')
  await until(() => repliesDone(6), 'small talk is answered')
  a = await authors()
  ok(a.at(-1).trim() === 'Tomo', `with no job on the reply (${JSON.stringify(a.at(-1))})`)
  ok((await sidebarRows()).length === jobRows, 'and no job in the sidebar')
  // Asked for work while chatting: answered there too, then filed as a job once it made something.
  await send('make a page about cats')
  await until(() => repliesDone(7), 'the work is done')
  await until(async () => (await sidebarRows()).some((r) => r.includes('Cat page')), 'and filed as a job, named after it')
  await until(async () => (await authors()).at(-1)?.includes('Cat page'), 'which the reply now shows')
  ok((await authors()).at(-2).trim() === 'Tomo', 'the small talk before it stays out of jobs')
  await sleep(400)
  await capture('4b-filed')
  // Filed by hand, as it is: the chip's Move item puts the cat page in the soup job, answering nothing again.
  await chip.click()
  await menu.locator('[data-move-last]').click()
  ok((await menu.innerText()).includes('Nothing is done again'), 'the Move item says nothing is redone')
  await menu.getByRole('menuitem', { name: /^Tomato soup recipe(?! \(fork)/ }).first().click()
  await until(async () => (await authors()).at(-1)?.includes('Tomato soup recipe'), 'the moved turn shows the job it went to')
  await until(async () => !(await sidebarRows()).some((r) => r.includes('Cat page')), 'the job made for it is gone')
  await sleep(500)
  ok(await repliesDone(7) && !(await repliesDone(8)), 'and it was not answered again')

  // A finished job's own thread: as a chat was, with its chip.
  await page.locator('aside [data-row^="chat:"]', { hasText: 'Rust lifetimes' }).locator('button').first().click()
  await until(async () => (await page.locator('[data-chat-title]').innerText()) === 'Rust lifetimes', 'a job opens on its thread')
  ok(/finished/i.test(await chip.innerText()), 'its chip says it is finished')
  ok((await authors()).length === 0, "a job's thread looks as a chat did")
  await send('Show me an example')
  await until(async () => (await lastReply().innerText()).includes('That is all for now.'), 'writing in it gets a reply')
  await until(async () => !/finished/i.test(await chip.innerText()), 'and opens the job again')
  await capture('5-job-thread')

  // A reply that ends while its thread isn't open: the job needs you (it is new) until you open it.
  await send('Explain it slowly')
  await until(async () => /^Working ?1$/.test(await headText('working')), 'a running reply puts the job in Working')
  ok(!(await expanded('working')), 'Working starts shut')
  await head('working').click()
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
  await chip.click()
  await sleep(300)
  await capture('8-dark-chip')
  await page.keyboard.press('Escape')
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
ok(db.prepare(`select count(*) as n from messages where via_session_id is not null`).get().n === 7, 'seven turns sent to Tomo (the moved ones counted once)')
ok(db.prepare(`select count(*) as n from messages m join sessions s on s.id = m.session_id where s.kind = 'primary' and m.role = 'user'`).get().n === 1, 'one turn (the small talk) in no job')
ok(db.prepare(`select instructions, effort from bots where is_primary = 1`).get().effort === 'high', "Tomo's effort came from Settings")
ok(db.prepare(`select count(*) as n from sessions s where not exists (select 1 from jobs j where j.id = s.job_id) and s.kind != 'primary'`).get().n === 0, 'every thread has its job')
db.close()
console.log(`captures in ${outDir}`)
