// Renders the computer-use overlay headless and saves PNGs: the acting frame, and a Show-me
// spotlight with its callout, in light and dark. The window is never shown.
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
    // Entry animations only advance when a hidden window paints, so stills show their end state.
    const css = `.frame,.spot,.callout,.notch{animation:none !important}${backdrop ? 'html,body{background:#d9d6cf !important}' : ''}`
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
  overlay.show(true, null, { text: 'Working · Click', waiting: false })
  await shoot('notch-working', true)
  overlay.show(false, { rect, instruction: 'Click Display to open the screen settings.', step: 2, total: 4 }, { text: 'Your turn · Step 2 of 4', waiting: true })
  await shoot('notch-teach', true)
  // Around a MacBook's camera housing, as main sends it on such a screen.
  overlay.window!.webContents.send('computer-overlay:state', { acting: false, teach: null, notch: { text: 'Working · Click', waiting: false, camera: { width: 200, height: 37 } } })
  await shoot('notch-camera', true)
  const gap = await overlay.window!.webContents.executeJavaScript(
    `(() => { const r = document.querySelector('.housing').getBoundingClientRect(); return { centre: r.left + r.width / 2, width: r.width, screen: innerWidth / 2 } })()`
  )
  console.log(`[overlay] camera gap: ${gap.width} px wide, centred at ${gap.centre} (screen centre ${gap.screen})`)
  overlay.show(false, null, null)
  // Point mode, as main drives it, with synthetic pointer events in the hidden page: a hovered
  // control (main's answer sent by hand), then a box being dragged.
  const wc = overlay.window!.webContents
  const fire = (type: string, x: number, y: number, buttons = 0) =>
    wc.executeJavaScript(
      `document.querySelector('[data-point]').dispatchEvent(new PointerEvent(${JSON.stringify(type)}, { clientX: ${x}, clientY: ${y}, button: 0, buttons: ${buttons}, pointerId: 1, bubbles: true }))`
    )
  for (const theme of ['light', 'dark'] as const) {
    nativeTheme.themeSource = theme
    overlay.point(d)
    wc.send('computer-overlay:point', { display: d.id })
    await sleep(100)
    await fire('pointermove', 460, 318)
    await sleep(150)
    wc.send('computer-overlay:point-hit', { x: 460, y: 318, control: { rect: { x: 400, y: 300, width: 120, height: 36 }, label: 'Button · Save' } })
    await shoot(`point-hover-${theme}`, true)
    // Drag a box; pointer capture needs a real pointer, so it is skipped in the page.
    await wc.executeJavaScript(`Element.prototype.setPointerCapture = () => {}; 0`)
    await fire('pointerdown', 360, 260, 1)
    await fire('pointermove', 700, 420, 1)
    await shoot(`point-box-${theme}`, true)
    wc.send('computer-overlay:point', null)
    overlay.point(null)
  }
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
