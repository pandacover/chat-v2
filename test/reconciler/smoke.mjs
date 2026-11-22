// Smoke test of the daily reconciler in the built app, hidden (CHAT_V2_HEADLESS=1), on a chat.db
// seeded with a profile and two finished jobs (seed.ts) and a scripted memory model
// (smoke-query.ts). It runs the review with Run now in Settings › Memory and checks what it shows:
// the last run and its revision, the merged and corrected records, Tomo's playbook with where a
// lesson came from, the history, the playbook reaching a new job's prompt, Purge and Restore, in
// light and dark. Captures go to <outDir>.
//
//   bun run build
//   node test/reconciler/smoke.mjs <playwright-core dir> <outDir>
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const [pwDir, outDir = join(tmpdir(), 'tomo-reconciler-smoke')] = process.argv.slice(2)
if (!pwDir) throw new Error('usage: node test/reconciler/smoke.mjs <playwright-core dir> [outDir]')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const { _electron } = require(resolve(pwDir))
mkdirSync(outDir, { recursive: true })

const work = mkdtempSync(join(tmpdir(), 'tomo-reconciler-smoke-'))
const bundle = spawnSync('bun', ['build', join(repo, 'test/reconciler/smoke-query.ts'), '--target=node', '--format=cjs', '--external=electron', `--outfile=${join(work, 'smoke-query.cjs')}`], { stdio: 'inherit', shell: true })
if (bundle.status !== 0) throw new Error('bundling smoke-query failed')
const data = join(work, 'data')
mkdirSync(data)
writeFileSync(join(data, 'config.json'), JSON.stringify({ titleModel: '', memoryModel: 'claude-haiku-5-5' }))
const seed = spawnSync('bun', [join(repo, 'test/reconciler/seed.ts'), join(data, 'chat.db')], { stdio: 'inherit', shell: true })
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
    await sleep(60)
  }
  ok(true, what)
}
/** A capture of the window. The hidden window paints only when captured, so this takes a few. */
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

let page = await app.firstWindow()
for (const w of app.windows()) if (w.url().includes('index.html')) page = w
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

const memory = page.locator('#settings-memory')
const review = page.locator('#memory-review')
const profileRow = (text) => memory.locator('li.fact.group', { hasText: text })
const playbook = page.locator('#memory-playbooks')
const nav = (name) => page.locator('nav[aria-label="Settings sections"] button', { hasText: name }).click()
const openMemory = async () => {
  await page.locator('button[aria-label="Settings"]').first().click()
  await nav('Memory')
  await memory.waitFor()
}

try {
  await page.waitForSelector('textarea', { timeout: 20_000 })
  await openMemory()
  await until(async () => (await review.innerText()).includes('2 finished jobs not read yet'), 'the review says two finished jobs wait')
  ok((await review.getByRole('button', { name: 'Run now' }).count()) === 1, 'with a Run now button')
  ok(!(await review.innerText()).includes('Last review'), 'and no last review yet')
  await until(async () => (await playbook.innerText()).includes('No lessons yet'), "Tomo's playbook is there, empty")
  await capture('1-before-light')

  await review.getByRole('button', { name: 'Run now' }).click()
  await until(async () => (await review.innerText()).includes('Reviewing…'), 'Run now shows the review under way')
  await until(async () => (await review.innerText()).includes('Read 2 finished jobs and made 3 changes.'), 'the last review says what it read and did', 15_000)
  const text = await review.innerText()
  ok(/Rev \d+/.test(text) && text.includes('Run from here'), 'with its revision and how it was started')
  ok(text.includes('Loves cats and has one.') && text.includes('Tomo’s playbook: Never add comments to code.'), 'and what the revision added')
  ok(text.includes('Left out 1 proposed change'), 'and that it left out the ungrounded change')
  ok(!text.includes('Lisbon'), 'without quoting it')

  await until(async () => (await profileRow('Loves cats and has one.').count()) === 1, 'the repeated records are merged into one')
  ok((await profileRow('Has a cat.').count()) === 0, 'the other one is hidden')
  ok((await profileRow(/Prefers short answers \(corrected \d{4}-\d{2}-\d{2}\)\./).count()) === 1, 'the corrected fact is a dated correction')
  ok((await profileRow('Lives in Lisbon').count()) === 0, 'nothing ungrounded was added')
  const lesson = playbook.locator('li.fact.group', { hasText: 'Never add comments to code.' })
  ok((await lesson.count()) === 1, "Tomo's playbook has the lesson")
  ok(!(await playbook.innerText()).includes('No lessons yet'), 'and no longer says it is empty')

  await lesson.hover()
  await lesson.locator('button[aria-label="Where did this come from?"]').click()
  await until(async () => (await lesson.innerText()).includes('Tidied up in the daily review in Invoice script'), 'the lesson says the review wrote it, from the invoice job')
  await capture('2-after-light')

  await memory.locator('button', { hasText: 'History' }).click()
  const history = memory.locator('ol.group-card > li')
  await until(async () => (await history.first().innerText()).includes('Review run from Settings of 2 finished jobs'), 'the history shows the run as one revision')
  ok((await history.first().innerText()).includes('Tomo’s playbook: Never add comments to code.'), 'with the playbook change in it')
  ok((await history.first().innerText()).includes('Prefers detailed answers.'), 'and the version it replaced')
  await capture('3-history-light')

  // The playbook reaches a new job's prompt.
  await page.keyboard.press('Escape')
  await until(async () => (await memory.count()) === 0, 'Settings closes')
  const composer = page.locator('textarea').first()
  await composer.fill('Write me a function that sorts a list')
  await composer.press('Enter')
  await until(async () => (await page.locator('body').innerText()).includes('playbook: - Never add comments to code.'), "the new job's reply had Tomo's playbook in its prompt", 15_000)
  await capture('4-reply-light')

  // Dark.
  await openMemory()
  await nav('Appearance')
  await page.locator('#settings-appearance').getByRole('radio', { name: 'Dark' }).click()
  await nav('Memory')
  await memory.waitFor()
  await until(async () => (await playbook.innerText()).includes('Never add comments to code.'), 'the playbook shows in dark')
  await capture('5-after-dark')

  // Purge a lesson: gone with its history, and the history says something went.
  await lesson.hover()
  await lesson.locator('button[aria-label="Forget this for good"]').click()
  await until(async () => (await lesson.innerText()).includes('Delete it and its history for good?'), 'purging a lesson asks first')
  await capture('6-purge-dark')
  await lesson.getByRole('button', { name: 'Delete', exact: true }).click()
  await until(async () => (await lesson.count()) === 0, 'the purged lesson is gone')
  await until(async () => (await playbook.innerText()).includes('No lessons yet'), 'the playbook is empty again')

  // Restore the revision before the review: the merged and corrected records come back as they were.
  await memory.locator('button', { hasText: 'History' }).click().catch(() => undefined)
  if ((await history.count()) === 0) await memory.locator('button', { hasText: 'History' }).click()
  const before = history.filter({ hasText: 'Edited by you' }).first()
  await before.getByRole('button', { name: 'Restore' }).click()
  await until(async () => (await profileRow('Has a cat.').count()) === 1 && (await profileRow('Prefers detailed answers.').count()) === 1, 'restoring the revision before the review brings the old records back')
  ok((await profileRow('Loves cats and has one.').count()) === 0, 'and takes the merge back')
  ok((await playbook.locator('li.fact.group').count()) === 0, 'the purged lesson does not come back')
  await capture('7-restored-dark')
  await nav('Appearance')
  await page.locator('#settings-appearance').getByRole('radio', { name: 'Light' }).click()
  ok(errors.length === 0, `no page errors (${errors.join('; ')})`)
} finally {
  await app.close()
}

const db = new DatabaseSync(join(data, 'chat.db'))
const runs = db.prepare('select trigger, outcome, jobs, dropped from reconciler_runs').all()
ok(runs.length === 1 && runs[0].trigger === 'manual' && runs[0].outcome === 'changed' && runs[0].jobs === 2, `one run, logged (${JSON.stringify(runs)})`)
const versions = db.prepare(`select v.writer, v.source_job_id from memory_versions v join memory_revisions r on r.rev = v.added_rev where r.kind = 'reconciled'`).all()
ok(versions.length > 0 && versions.every((v) => v.writer === 'reconciler' && v.source_job_id), 'every version the review wrote is by the reconciler, with its source job')
ok(db.prepare(`select count(*) as n from reconciled_jobs`).get().n === 2, 'both jobs are marked read')
db.close()
console.log('reconciler smoke passed')
