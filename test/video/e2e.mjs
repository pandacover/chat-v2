// End to end: a video in the real app, hidden (CHAT_V2_HEADLESS=1), with a scripted model
// (e2e-query.ts). A test video (made with ffmpeg) is picked in the composer: its chip shows its
// length and size, read from its headers in the main process; sent, the model gets a <video>
// description, takes 3 frames through the video tool (real JPEGs, decoded by Chromium) and asks for a
// transcript (no ElevenLabs key: it is told where to add one). Captures go to <outDir>.
//
//   bun run build
//   node test/video/e2e.mjs <playwright-core dir> [outDir]
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [pwDir, outDir = join(tmpdir(), 'tomo-video-e2e')] = process.argv.slice(2)
if (!pwDir) throw new Error('usage: node test/video/e2e.mjs <playwright-core dir> [outDir]')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const { _electron } = require(resolve(pwDir))
mkdirSync(outDir, { recursive: true })

const work = mkdtempSync(join(tmpdir(), 'tomo-video-e2e-'))
const built = spawnSync('bun', ['build', join(repo, 'test/video/e2e-query.ts'), '--target=node', '--format=cjs', '--external=electron', `--outfile=${join(work, 'e2e-query.cjs')}`], { stdio: 'inherit', shell: true })
if (built.status !== 0) throw new Error('bundling e2e-query failed')
const video = join(work, 'Test clip.mp4')
const made = spawnSync(
  'ffmpeg',
  ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=10:size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video],
  { stdio: 'inherit' }
)
if (made.status !== 0 || !existsSync(video)) throw new Error('making the test video needs ffmpeg')
const data = join(work, 'data')
mkdirSync(data)
writeFileSync(join(data, 'config.json'), JSON.stringify({ titleModel: '', memoryModel: '' }))

const env = { ...process.env, CHAT_V2_HEADLESS: '1', CHAT_V2_FAKE_QUERY: join(work, 'e2e-query.cjs') }
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
const until = async (f, what, ms = 20_000) => {
  const t0 = Date.now()
  while (!(await f())) {
    if (Date.now() - t0 > ms) ok(false, what)
    await sleep(100)
  }
  ok(true, what)
}
const capture = async (name) => {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    // The chat window: index.html when built, the dev server's root under electron-vite dev.
    const w = BrowserWindow.getAllWindows().find((w) => !/overlay|capture/.test(w.webContents.getURL()))
    for (let i = 0; i < 6; i++) {
      await w.webContents.capturePage()
      await new Promise((r) => setTimeout(r, 150))
    }
    return (await w.webContents.capturePage()).toPNG().toString('base64')
  })
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(png, 'base64'))
}

try {
  let page = await app.firstWindow()
  for (const w of app.windows()) if (!/overlay|capture/.test(w.url())) page = w
  await page.waitForSelector('textarea')

  // Picked from disk: copied by the main process, its length and size read by Chromium.
  await page.locator('input[type="file"]').first().setInputFiles(video)
  const chip = page.locator('button[aria-label^="Remove "]').first().locator('xpath=..')
  await until(async () => (await chip.count()) > 0 && (await chip.innerText()).includes('0:10 · 640×360'), 'the chip shows the length and size')
  ok((await chip.innerText()).includes('Test clip.mp4'), 'the chip names the file')
  const saved = readdirSync(join(data, 'attachments')).filter((f) => f.endsWith('.mp4'))
  ok(saved.length === 1, 'the video was copied into the attachments folder')
  await capture('chip')

  const composer = page.locator('textarea').first()
  await composer.fill('What happens in this?')
  await composer.press('Enter')
  const reply = page.getByText(/^frames: /).first()
  await until(async () => (await reply.count()) > 0, 'the reply came back')
  const said = await page.evaluate(() => [...document.querySelectorAll('*')].map((e) => e.textContent ?? '').find((t) => t.startsWith('frames: ')) ?? '')
  console.log(`  said: ${said.replace(/\s+/g, ' ').slice(0, 400)}`)
  ok(said.includes('frames: 3 images, 3 jpeg'), 'three real JPEG frames came back')
  ok(said.includes('At 0:01.7, At 0:05.0, At 0:08.3'), 'spread evenly over the video')
  ok(said.includes('Test clip.mp4: 0:10 long, 640×360'), 'the frames say what the video is')
  ok(said.includes('no ElevenLabs API key is set'), 'without a key, the transcript says where to add one')
  await until(async () => (await page.getByText('Looked at 3 frames of Test clip.mp4').count()) > 0, 'the step line shows')
  await capture('reply')
  console.log(`Video e2e passed. Captures in ${outDir}`)
} finally {
  await app.close().catch(() => {})
}
