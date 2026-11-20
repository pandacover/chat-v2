// Renders the computer-use overlay headless and saves PNGs: the acting frame, and a Show-me
// spotlight with its callout, in light and dark, plus a long lesson, tall and full-screen targets,
// and a dragged callout. The window is never shown.
//   bun run build && bun test/computer/render-overlay.ts [outDir]
// Under Bun it bundles itself for Electron and runs it; under Electron it renders.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// The bundle runs from a temp folder, so Electron is told where the repo is.
const root = process.env.CV2_ROOT ?? resolve(import.meta.dirname, '../..')

const renderInElectron = async (outDir: string) => {
  const { app, nativeTheme, screen } = await import('electron')
  const { makeElectronOverlay } = await import('../../src/main/computer/overlay')
  await app.whenReady()
  const overlay = makeElectronOverlay({
    headless: true,
    preload: join(root, 'out/preload/computer.cjs'),
    page: join(root, 'out/renderer/computer-overlay.html')
  })
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const shoot = async (name: string, backdrop: boolean) => {
    const win = overlay.window!
    if (win.webContents.isLoading()) await new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()))
    // Stand-in for the desktop under the transparent window, so the frame and dim read in a picture.
    // Animations and glides only advance when a hidden window paints, so stills show their end state.
    const css = `.frame,.spot,.callout,.notch{animation:none !important;transition:none !important}${backdrop ? 'html,body{background:#d9d6cf !important}' : ''}`
    const key = await win.webContents.insertCSS(css)
    await sleep(700)
    await win.webContents.capturePage() // a hidden window hands back the previous frame first
    await sleep(300)
    const png = (await win.webContents.capturePage()).toPNG()
    await win.webContents.removeInsertedCSS(key)
    writeFileSync(join(outDir, `${name}.png`), png)
  }
  const d = screen.getPrimaryDisplay()
  // A control in input space (physical pixels on Windows), a third of the way across.
  const s = process.platform === 'win32' ? d.scaleFactor : 1
  const rect = { x: Math.round((d.bounds.x + d.bounds.width / 3) * s), y: Math.round((d.bounds.y + 180) * s), width: Math.round(160 * s), height: Math.round(36 * s) }
  for (const theme of ['light', 'dark'] as const) {
    nativeTheme.themeSource = theme
    overlay.show(true, null, null)
    await shoot(`acting-${theme}`, true)
    overlay.show(false, { rect, instruction: 'Click Display to open the screen settings.', step: 2, total: 4 }, null)
    await shoot(`teach-${theme}`, true)
  }
  await shoot('teach-transparent', false)
  // The notch (no chat window has focus here): working, and waiting on the user with a step up.
  overlay.show(true, null, { text: 'Working · Click · “Display”', waiting: false })
  await shoot('notch-working', true)
  overlay.show(false, { rect, instruction: 'Click Display to open the screen settings.', step: 2, total: 4 }, { text: 'Your turn · Step 2 of 4 · Click Display to open the screen settings.', waiting: true })
  await shoot('notch-teach', true)
  // An approval asked in the notch: arming, then armed (the stills turn animations off, so the
  // first is shot with arming forced), and a long one under a camera housing.
  const approval = { id: 'ap_1', title: 'Delete 3 files from Downloads', detail: 'old-1.txt\nold-2.txt\nold-3.txt' }
  overlay.show(false, null, { text: 'Needs your OK', waiting: true, approval })
  await shoot('notch-approval', true)
  overlay.window!.webContents.send('computer-overlay:state', {
    acting: false,
    teach: null,
    notch: {
      text: 'Needs your OK',
      waiting: true,
      approval: {
        id: 'ap_2',
        title: 'Run a command on your computer that removes every file in the old reports folder, including the hidden ones',
        detail: 'Remove-Item -Recurse -Force "C:\\Users\\me\\Documents\\Reports\\2019\\old" ; Remove-Item -Recurse -Force "C:\\Users\\me\\Documents\\Reports\\2020\\old"'
      },
      camera: { width: 200, height: 37 }
    }
  })
  await shoot('notch-approval-camera', true)
  const armedNow = await overlay.window!.webContents.executeJavaScript(`document.querySelector('.approve')?.disabled === false`)
  console.log(`[overlay] notch Approve armed after the beat: ${armedNow}`)
  // Around a MacBook's camera housing, as main sends it on such a screen.
  overlay.window!.webContents.send('computer-overlay:state', { acting: false, teach: null, notch: { text: 'Working · Click', waiting: false, camera: { width: 200, height: 37 } } })
  await shoot('notch-camera', true)
  const gap = await overlay.window!.webContents.executeJavaScript(
    `(() => { const r = document.querySelector('.housing').getBoundingClientRect(); return { centre: r.left + r.width / 2, width: r.width, screen: innerWidth / 2 } })()`
  )
  console.log(`[overlay] camera gap: ${gap.width} px wide, centred at ${gap.centre} (screen centre ${gap.screen})`)
  // A long lesson: the count stays, the progress dashes go.
  const teach = (r: typeof rect, step: number, total: number, instruction = 'Click Display to open the screen settings.') =>
    overlay.show(false, { rect: r, instruction, step, total }, null)
  teach(rect, 12, 20)
  await shoot('teach-many-steps', true)
  // A target nearly the screen's height: no room above or below, so the callout sits beside it, on screen.
  const tall = { x: Math.round((d.bounds.x + 40) * s), y: Math.round((d.bounds.y + 30) * s), width: Math.round(300 * s), height: Math.round((d.bounds.height - 60) * s) }
  teach(tall, 1, 3, 'Scroll this list to the bottom.')
  await shoot('teach-tall-target', true)
  // A target filling the screen: the callout goes inside it.
  teach({ x: d.bounds.x * s, y: d.bounds.y * s, width: d.bounds.width * s, height: d.bounds.height * s }, 2, 3, 'Click anywhere in the window.')
  await shoot('teach-full-target', true)
  const box = () =>
    overlay.window!.webContents.executeJavaScript(`(() => { const r = document.querySelector('.callout').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, pinned: document.querySelector('.callout').classList.contains('pinned') } })()`)
  // Pinned: drag the callout (input sent to the hidden window only), then a next target away from
  // it keeps it there, and one under it unpins it.
  teach(rect, 1, 3)
  await sleep(700)
  const b = await box()
  const wc = overlay.window!.webContents
  const at = (type: 'mouseDown' | 'mouseMove' | 'mouseUp', x: number, y: number) =>
    wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
  at('mouseDown', b.x + 40, b.y + 10)
  for (let i = 1; i <= 5; i++) at('mouseMove', b.x + 40 + i * 80, b.y + 10 + i * 60)
  at('mouseUp', b.x + 440, b.y + 310)
  await sleep(200)
  const pinned = await box()
  teach({ ...rect, x: Math.round((d.bounds.x + 60) * s) }, 2, 3)
  await shoot('teach-pinned-kept', true)
  const kept = await box()
  // The next target right under the pinned callout.
  teach({ x: Math.round((pinned.x + 20) * s + d.bounds.x * s), y: Math.round((pinned.y + 20) * s + d.bounds.y * s), width: Math.round(120 * s), height: Math.round(32 * s) }, 3, 3, 'Click Apply.')
  await shoot('teach-pinned-covered', true)
  const moved = await box()
  console.log(`[overlay] pinned at ${pinned.x},${pinned.y} (${pinned.pinned}); next target elsewhere: ${kept.x},${kept.y} (${kept.pinned}); next target under it: ${moved.x},${moved.y} (${moved.pinned})`)
  overlay.show(false, null, null)
  console.log(`[overlay] ${d.bounds.width}x${d.bounds.height} @${d.scaleFactor}x, wrote PNGs to ${outDir}`)
  overlay.dispose()
  app.quit()
}

if (process.versions.electron) {
  void renderInElectron(process.env.OVERLAY_OUT!).catch((e) => {
    console.error(e)
    process.exit(1)
  })
} else {
  const outDir = resolve(process.argv[2] ?? join(tmpdir(), 'cv2-overlay-shots'))
  mkdirSync(outDir, { recursive: true })
  const bundle = join(tmpdir(), 'cv2-render-overlay.mjs')
  const built = spawnSync('bun', ['build', import.meta.filename, '--target=node', '--format=esm', '--external', 'electron', '--outfile', bundle], {
    cwd: root,
    stdio: 'inherit'
  })
  if (built.status !== 0) process.exit(1)
  const electron = require(join(root, 'node_modules/electron')) as string
  const env: Record<string, string | undefined> = { ...process.env, OVERLAY_OUT: outDir, CV2_ROOT: root, CHAT_V2_HEADLESS: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const r = spawnSync(electron, [bundle], { cwd: root, stdio: 'inherit', env })
  process.exit(r.status ?? 1)
}
