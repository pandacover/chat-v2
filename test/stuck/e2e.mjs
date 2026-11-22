// Smoke test for stuck replies, in the real app, hidden (CHAT_V2_HEADLESS=1), with a scripted model
// (stuck-query.ts) that loops on the same tool call: the reply pauses, the pause card says why,
// and Continue resumes it to the end. Twice: a refused call (found in the stream, the query
// interrupted) and a computer look run for real (found at its PostToolUse hook), with a fake
// platform, so nothing reaches the desktop. Captures go to <outDir>.
//
//   bun run build
//   node test/stuck/e2e.mjs <playwright-core dir> [outDir]
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const [pwDir, outDir = join(tmpdir(), 'tomo-stuck-e2e')] = process.argv.slice(2)
if (!pwDir) throw new Error('usage: node test/stuck/e2e.mjs <playwright-core dir> [outDir]')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const { _electron } = require(resolve(pwDir))
mkdirSync(outDir, { recursive: true })

const work = mkdtempSync(join(tmpdir(), 'tomo-stuck-e2e-'))
for (const [dir, name] of [['test/stuck', 'stuck-query'], ['test/computer', 'e2e-platform']]) {
  const r = spawnSync('bun', ['build', join(repo, dir, `${name}.ts`), '--target=node', '--format=cjs', '--external=electron', `--outfile=${join(work, `${name}.cjs`)}`], { stdio: 'inherit', shell: true })
  if (r.status !== 0) throw new Error(`bundling ${name} failed`)
}
const data = join(work, 'data')
mkdirSync(data)
writeFileSync(join(data, 'config.json'), JSON.stringify({ titleModel: '', memoryModel: '' }))

const env = { ...process.env, CHAT_V2_HEADLESS: '1', CHAT_V2_FAKE_QUERY: join(work, 'stuck-query.cjs'), CHAT_V2_FAKE_COMPUTER: join(work, 'e2e-platform.cjs') }
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
/** The hidden window paints only when captured, a frame behind: take a few. */
const capture = async (name) => {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'))
    for (let i = 0; i < 6; i++) {
      await w.webContents.capturePage().catch(() => null)
      await new Promise((r) => setTimeout(r, 150))
    }
    return (await w.webContents.capturePage()).toPNG().toString('base64')
  })
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(png, 'base64'))
}

let page = await app.firstWindow()
for (const w of app.windows()) if (w.url().includes('index.html')) page = w
await page.waitForSelector('textarea')
const composer = page.locator('textarea').first()
const send = async (text) => {
  await composer.fill(text)
  await composer.press('Enter')
}
const lastReply = () => page.locator('[data-reply-scope]').last()
const card = () => lastReply().locator('[data-paused]')

try {
  // 1. A refused call, again and again: the stream finds it, the query is interrupted.
  await send('Check the job until it is done')
  await until(async () => (await card().count()) === 1, 'the looping reply pauses and shows the pause card')
  const reason = await card().locator('[data-pause-reason]').innerText()
  ok(reason === 'It made the same check status call 4 times in a row and got the same result each time.', `the card says why: “${reason}”`)
  ok((await lastReply().innerText()).includes('Checking the job.'), 'the work before the pause is kept')
  ok((await page.getByRole('button', { name: 'Stop', exact: true }).count()) === 0, 'the reply is no longer running')
  ok((await lastReply().innerText()).includes('This looked stuck'), 'the card says it stopped because it looked stuck')
  await sleep(600)
  await capture('paused')
  await card().getByRole('button', { name: 'Continue' }).click()
  await until(async () => (await lastReply().innerText()).includes('Back on track: tried another way and finished.'), 'Continue resumes the reply to its end')
  await until(async () => (await card().count()) === 0, 'and the pause card goes')
  ok((await lastReply().innerText()).includes('Checking the job.'), 'the resumed reply keeps what it had')
  ok(!(await lastReply().innerText()).includes('job.Back'), 'and goes on in a line of its own (the text before the pause had ended)')
  await sleep(600)
  await capture('resumed')

  // 2. A computer look run for real: its PostToolUse hook pauses the reply.
  // Computer use is Tomo's (Settings › Bots), not a switch of the chat: the composer's tools open it there.
  await page.locator('button[data-tools]').click()
  await page.locator('[data-bot]').waitFor()
  await page.getByRole('switch', { name: 'Computer' }).click()
  await page.getByRole('switch', { name: 'Computer', checked: true }).waitFor()
  await page.keyboard.press('Escape')
  await page.locator('button[data-tools~="computer"]').waitFor()
  // Computer work runs in Tomo's own thread on a job it hands itself, not in its chat.
  await send('Hand the screen watch to yourself')
  const jobRow = page.locator('aside [data-row^="chat:"]', { hasText: 'Screen watch' })
  await until(async () => (await jobRow.count()) === 1, 'the job needs you once its reply pauses', 15_000)
  await jobRow.locator('button').first().click()
  await until(async () => (await page.locator('[data-chat-title]').count()) === 1, "it opens on Tomo's own thread")
  await until(async () => (await card().count()) === 1, 'a computer reply looping on its look pauses too', 15_000)
  const why = await card().locator('[data-pause-reason]').innerText()
  ok(/^It made the same look at screen call [45] times in a row/.test(why), `and says why: “${why}”`)
  await sleep(600)
  await capture('paused-computer')
  await card().getByRole('button', { name: 'Continue' }).click()
  await until(async () => (await lastReply().innerText()).includes('Back on track'), 'Continue resumes the computer reply')
} finally {
  await app.close()
}

// Every pause is recorded, with whether it was resumed.
const db = new DatabaseSync(join(data, 'chat.db'), { readOnly: true })
const pauses = db.prepare('select signal, step, reason, resumed_at from stuck_pauses order by id').all()
// Progress notes are job notes now: the old table was moved into them and dropped.
const oldNotes = db.prepare(`select count(*) as n from sqlite_master where name = 'progress_notes'`).get().n
db.close()
ok(oldNotes === 0, 'progress notes live in job notes (the progress_notes table is gone)')
ok(pauses.length === 2 && pauses.every((p) => p.resumed_at !== null), `both pauses are recorded and marked resumed (${pauses.map((p) => `${p.signal}@${p.step}`).join(', ')})`)
console.log(`Stuck e2e passed. Captures in ${outDir}`)
