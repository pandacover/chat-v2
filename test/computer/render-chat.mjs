// Renders the chat's computer-use parts in the hidden app, as close-ups, for judging looks: the
// Computer switch and Point button, the live step line, the Stop hint and mode chip, a finished
// run with a failed step (folded and open), a denied approval, the approval card (arming, armed),
// the Show-me card, and Point's chips. Also frame sequences across changes (a run's line moving
// from step to step and landing, the approval card arming and leaving, a Show-me step moving on),
// with the step list's box per frame in sequences.json, to catch flicker and layout shift. A
// scripted model (polish-query.ts) and a fake platform (polish-platform.ts): nothing reaches the
// desktop.
//
//   bun run build
//   node test/computer/render-chat.mjs <playwright-core dir> <outDir> [light|dark] [scale]
// Scale 2 is a page zoom of 2 (as on a 200% display): the chat lays out in half the window's
// pixels and rasterises at twice the density.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [pwDir, outDir, theme = 'light', scale = '1'] = process.argv.slice(2)
if (!pwDir || !outDir) throw new Error('usage: node test/computer/render-chat.mjs <playwright-core dir> <outDir> [light|dark] [scale]')
const here = dirname(fileURLToPath(import.meta.url))
// CV2_REPO renders another checkout's build (e.g. the commit before a change) with these scripts.
const repo = process.env.CV2_REPO ? resolve(process.env.CV2_REPO) : resolve(here, '../..')
const require = createRequire(import.meta.url)
const { _electron } = require(resolve(pwDir))
mkdirSync(outDir, { recursive: true })

const work = mkdtempSync(join(tmpdir(), 'chat-v2-render-chat-'))
for (const name of ['polish-query', 'polish-platform']) {
  const r = spawnSync('bun', ['build', join(here, `${name}.ts`), '--target=node', '--format=cjs', '--external=electron', `--outfile=${join(work, `${name}.cjs`)}`], { stdio: 'inherit', shell: true })
  if (r.status !== 0) throw new Error(`bundling ${name} failed`)
}
const data = join(work, 'data')
mkdirSync(data)
writeFileSync(join(data, 'config.json'), JSON.stringify({ titleModel: '', memoryModel: '' }))
const env = { ...process.env, CHAT_V2_HEADLESS: '1', CHAT_V2_FAKE_QUERY: join(work, 'polish-query.cjs'), CHAT_V2_FAKE_COMPUTER: join(work, 'polish-platform.cjs') }
delete env.ELECTRON_RUN_AS_NODE
const app = await _electron.launch({ executablePath: require(join(repo, 'node_modules/electron')), args: [repo, `--user-data-dir=${data}`], env })
const log = []
app.process().stdout.on('data', (d) => log.push(...d.toString().split('\n').filter(Boolean)))
app.process().stderr.on('data', (d) => log.push(...d.toString().split('\n').filter(Boolean)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (f, what, ms = 15_000) => {
  const t0 = Date.now()
  while (!(await f())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}\n${log.slice(-30).join('\n')}`)
    await sleep(40)
  }
}

/** A capture of part of the chat window (DIPs). The hidden window paints only when captured. */
const grab = (rect, settle = true) =>
  app.evaluate(
    async ({ BrowserWindow }, { rect, settle, scale }) => {
      const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'))
      // Rects are the page's CSS pixels; zoomed, the window's pixels are `scale` times that.
      const shoot = async () => {
        for (let i = 0; ; i++) {
          try {
            return await w.webContents.capturePage({ x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale })
          } catch (e) {
            if (i > 8) throw e
            await new Promise((r) => setTimeout(r, 200))
          }
        }
      }
      if (settle) {
        for (let i = 0; i < 6; i++) {
          await shoot()
          await new Promise((r) => setTimeout(r, 150))
        }
        await shoot()
        await new Promise((r) => setTimeout(r, 300))
      }
      return (await shoot()).toPNG().toString('base64')
    },
    { rect, settle, scale: Number(scale) }
  )
const save = (name, b64) => writeFileSync(join(outDir, `${name}.png`), Buffer.from(b64, 'base64'))
/** Brings a part to the middle of the chat (not under the composer) before it is measured. */
const reveal = async (locator) => {
  await locator.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await sleep(300)
}
const around = async (locator, pad = 12, extra = {}) => {
  const b = await locator.boundingBox()
  return {
    x: Math.max(0, Math.floor(b.x - pad)),
    y: Math.max(0, Math.floor(b.y - pad - (extra.top ?? 0))),
    width: Math.ceil(b.width + pad * 2),
    height: Math.ceil(b.height + pad * 2 + (extra.top ?? 0) + (extra.bottom ?? 0))
  }
}
const shot = async (name, locator, pad, extra) => {
  if (!extra?.keep) await reveal(locator)
  // Measured once its transitions have run (they advance only as captures force frames).
  await grab({ x: 0, y: 0, width: 8, height: 8 })
  save(name, await grab(await around(locator, pad, extra)))
}

const sequences = {}
/** Frames of `rect` every `every` ms (each capture forces a frame), with what `probe` reads from the page. */
const sequence = async (name, rect, frames, every, probe, start) => {
  const dir = join(outDir, `seq-${name}`)
  mkdirSync(dir, { recursive: true })
  const out = []
  const t0 = Date.now()
  if (start) await start()
  for (let i = 0; i < frames; i++) {
    save(join(`seq-${name}`, String(i).padStart(3, '0')), await grab(rect, false))
    out.push({ i, t: Date.now() - t0, ...(await probe()) })
    await sleep(every)
  }
  sequences[name] = out
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
const box = page.locator('div.rounded-lg.bg-surface').filter({ has: page.locator('button[aria-expanded]', { hasText: /^\s*(Computer|Browser)/ }) }).last()

try {
  if (scale !== '1') await app.evaluate(({ BrowserWindow }, k) => {
    const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'))
    w.setSize(1600, 1000)
    w.webContents.setZoomFactor(k)
  }, Number(scale))
  await sleep(400)
  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio').nth(theme === 'dark' ? 1 : 0).click()
  await sleep(400)
  const footer = page.locator('textarea').locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]')
  await shot('composer-off', footer, 10, { keep: true })
  await page.getByRole('switch', { name: 'Computer' }).click()
  await page.getByRole('switch', { name: 'Computer', checked: true }).waitFor()
  await shot('composer-on', footer, 10, { keep: true })
  await page.getByRole('button', { name: 'Point', exact: true }).hover()
  await sleep(700)
  await shot('composer-point-tip', footer, 10, { top: 40, keep: true })
  await page.mouse.move(5, 5)

  // A paced run: the line moves from step to step, one fails, and the reply ends.
  await send('Please do a slow run')
  await box.waitFor()
  const stepProbe = async () =>
    page.evaluate(() => {
      const line = [...document.querySelectorAll('[data-step-line]')].at(-1)
      const list = line?.closest('.rounded-lg')
      const r = list?.getBoundingClientRect()
      return {
        line: line?.getAttribute('data-step-line'),
        text: line?.innerText,
        layers: line?.children.length ?? 0,
        list: r ? { y: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width) } : null
      }
    })
  const runRect = await around(lastReply(), 8, { bottom: 50 })
  await sequence('run', { ...runRect, height: 110 }, 90, 40, stepProbe)
  await until(async () => (await lastReply().innerText()).includes('report file was not there'), 'the slow run ends')
  await sleep(600)
  await shot('run-done-folded', box, 10, { bottom: 40 })
  await lastReply().getByText(/Computer/).first().click()
  await sleep(500)
  await shot('run-done-open', box, 10)

  // Live: catch the line while it types, with the Stop hint and the mode chip under it.
  await send('Please do a slow run')
  await until(async () => (await lastReply().locator('[data-step-line="now"]').count()) === 1 && (await lastReply().locator('[data-step-line="now"]').innerText()).includes('Type'), 'typing shows live', 20_000)
  await shot('run-live', box, 10, { bottom: 34 })
  await lastReply().getByText(/Computer/).first().click()
  await sleep(200)
  await shot('run-live-open', box, 10, { bottom: 34 })
  await until(async () => (await lastReply().innerText()).includes('report file was not there'), 'the second run ends', 20_000)

  // The approval: arming, armed, and leaving.
  await send('Delete the old files')
  const card = page.locator('[data-computer-wait="approval"]:not([inert])')
  await card.waitFor()
  await reveal(card)
  const cardRect = await around(card, 12, { bottom: 40 })
  const cardProbe = async () => page.evaluate(() => ({ cards: document.querySelectorAll('[data-computer-wait]').length }))
  await sequence('approval-arming', cardRect, 14, 50, cardProbe)
  await shot('approval-armed', card, 12, { bottom: 40 })
  await reveal(card)
  const leaving = await around(lastReply(), 8, { bottom: 60 })
  await sequence('approval-leaves', { ...leaving, y: Math.max(0, leaving.y - 40), height: leaving.height + 120 }, 14, 50, stepProbe, () =>
    card.getByRole('button', { name: /Approve/ }).click()
  )
  await until(async () => (await lastReply().innerText()).includes('Deleted them.'), 'approved')

  // Denied: a neutral step, not a failure.
  await send('Delete them again')
  await card.waitFor()
  await card.getByRole('button', { name: /Deny/ }).click()
  await until(async () => (await lastReply().innerText()).includes('Left them alone.'), 'denied')
  await sleep(400)
  await lastReply().getByText(/Computer/).first().click()
  await sleep(500)
  await shot('denied-open', box, 10)

  // Show me: the step card, moving on to step 2.
  await send('show me how to turn on night light')
  const step = page.locator('[data-computer-wait="teach"]:not([inert])')
  await step.waitFor()
  await shot('show-me-card', step, 12, { bottom: 40 })
  await reveal(step)
  const stepRect = await around(step, 12, { bottom: 60 })
  await sequence('show-me-next', stepRect, 14, 50, cardProbe, () => step.getByRole('button', { name: 'Done' }).click())
  await until(async () => (await step.innerText()).includes('Step 2 of 2'), 'step 2')
  await step.getByRole('button', { name: 'Done' }).click()
  await until(async () => (await lastReply().innerText()).includes('Night light is on.'), 'the lesson ends')

  // Point: a click on the fake Save control adds the image and its note as chips.
  await page.getByRole('button', { name: 'Point', exact: true }).click()
  const overlay = app.windows().find((w) => w.url().includes('computer-overlay.html'))
  await overlay.locator('[data-point]').waitFor()
  await app.evaluate(({ screen }) => {
    const b = screen.getPrimaryDisplay().bounds
    globalThis.e2ePointer = { x: b.x + 300, y: b.y + 200 }
  })
  await overlay.mouse.move(455, 316, { steps: 3 })
  await sleep(300)
  await overlay.mouse.down()
  await overlay.mouse.up()
  await until(async () => (await page.locator('button[aria-label^="Remove point-"]').count()) === 2, 'the Point chips')
  await sleep(600)
  await shot('composer-point-chips', footer, 10, { keep: true })
} finally {
  writeFileSync(join(outDir, 'sequences.json'), JSON.stringify(sequences, null, 1))
  await app.close()
}
console.log(`Rendered the chat's computer-use parts (${theme}, @${scale}x) to ${outDir}`)
