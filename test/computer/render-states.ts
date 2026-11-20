// Renders every state of the computer-use overlay as close-up PNGs, for judging looks, plus frame
// sequences across state changes (to catch flicker and layout shift), without showing a window.
//   bun run build && bun test/computer/render-states.ts [outDir] [scale]
// For each theme (light, dark) it shoots the acting frame, the Show-me spotlight and callout, the
// notch (working, waiting, approval arming and armed, a long approval, a MacBook camera housing),
// and Point (idle hint, hovered control, box), on a light, a dark and a busy wallpaper. Sequences:
// the notch working → approval → working, a step's callout gliding to the next, a step leaving,
// Point's highlight moving, two approvals back to back, a step entering above and beside its
// target, and a wide target's ping. It also checks that a state pushed mid-arm or after arming
// leaves Approve's arming alone (arm-checks in sequences.json; it fails if not). Each sequence
// frame records the [data-hit] rects in the page and the last ones the page reported to main, so a
// hit area that lags a transition shows up in sequences.json. REDUCED=1 emulates
// prefers-reduced-motion.
// Under Bun it bundles itself for Electron and runs it; under Electron it renders.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { APPROVE_ARM_MS } from '../../src/shared/computer'

const root = process.env.CV2_ROOT ?? resolve(import.meta.dirname, '../..')

type Rect = { x: number; y: number; width: number; height: number }

const WALLPAPERS = {
  light: 'linear-gradient(180deg,#f4f2ee 0 64px,#e7e4dd 64px 66px,#fbfaf8 66px)',
  dark: 'linear-gradient(180deg,#1b1d22 0 64px,#2a2d33 64px 66px,#121417 66px)',
  busy: 'linear-gradient(120deg,#1f3b5c 0%,#7a5c8f 30%,#e3a36b 55%,#f3e7d3 75%,#3c6e5a 100%)'
} as const

const renderInElectron = async (outDir: string) => {
  const { app, ipcMain, nativeTheme, screen } = await import('electron')
  const { makeElectronOverlay } = await import('../../src/main/computer/overlay')
  await app.whenReady()
  const hitLog: Array<{ t: number; rects: Rect[] }> = []
  const overlay = makeElectronOverlay({
    headless: true,
    preload: join(root, 'out/preload/computer.cjs'),
    page: join(root, 'out/renderer/computer-overlay.html')
  })
  ipcMain.on('computer-overlay:hits', (_e, rects: Rect[]) => hitLog.push({ t: Date.now(), rects }))
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const d = screen.getPrimaryDisplay()
  const s = process.platform === 'win32' ? d.scaleFactor : 1
  let W = d.bounds.width
  let H = d.bounds.height
  overlay.show(true, null, null)
  const wc = () => overlay.window!.webContents
  if (wc().isLoading()) await new Promise<void>((r) => wc().once('did-finish-load', () => r()))
  // Reduced motion is emulated through the debugger, attached after a page has loaded (before, it
  // hangs). Scale 2 is a page zoom of 2: the page lays out in half the pixels and rasterises at
  // twice the density, as on a 200% display of the same size (a forced scale factor shrinks the
  // hidden window, and a DevTools screenshot waits forever for a hidden window's frame).
  const scale = Number(process.env.OVERLAY_SCALE ?? 1)
  if (process.env.REDUCED === '1') {
    wc().debugger.attach('1.3')
    await wc().debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  }
  // Always set: Chromium keeps a page zoom per origin (every file:// page is one), so a zoom
  // left from a scale-2 run would otherwise carry over.
  wc().setZoomFactor(scale)
  // The page's own size (CSS pixels), which a zoom divides. A hidden window takes the zoom (and its
  // size) only as frames are forced, so it is read after a few.
  for (let i = 0; i < 4; i++) {
    await wc().capturePage().catch(() => null)
    await sleep(150)
  }
  ;({ W, H } = await wc().executeJavaScript('({ W: innerWidth, H: innerHeight })'))
  let paper: string | null = null
  let paperKey: string | null = null
  const wallpaper = async (name: keyof typeof WALLPAPERS | null) => {
    if (paperKey) await wc().removeInsertedCSS(paperKey)
    paperKey = null
    paper = name
    if (name) paperKey = await wc().insertCSS(`html{background:${WALLPAPERS[name]} !important}`)
  }
  /** A never-painted hidden window can throw UnknownVizError on its first captures. */
  /** Rects are in the page's CSS pixels; at scale 2 the window's pixels are twice that. */
  const grab = async (r?: Rect) => {
    const k = scale
    for (let i = 0; ; i++) {
      try {
        return r ? await wc().capturePage({ x: r.x * k, y: r.y * k, width: r.width * k, height: r.height * k }) : await wc().capturePage()
      } catch (e) {
        if (i > 8) throw e
        await sleep(200)
      }
    }
  }
  /** Lets animations finish: a hidden window paints only when captured, and hands back the previous frame. */
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await grab()
      await sleep(150)
    }
    await grab()
    await sleep(300)
  }
  const box = (sel: string): Promise<Rect | null> =>
    wc().executeJavaScript(
      `(() => { const els = [...document.querySelectorAll(${JSON.stringify(sel)})]; if (!els.length) return null; const rs = els.map((e) => e.getBoundingClientRect()); const x = Math.min(...rs.map((r) => r.left)), y = Math.min(...rs.map((r) => r.top)), r = Math.max(...rs.map((r) => r.right)), b = Math.max(...rs.map((r) => r.bottom)); return { x, y, width: r - x, height: b - y } })()`
    )
  const pad = (r: Rect, p: number): Rect => {
    const x = Math.max(0, Math.floor(r.x - p))
    const y = Math.max(0, Math.floor(r.y - p))
    return { x, y, width: Math.min(W - x, Math.ceil(r.width + p * 2)), height: Math.min(H - y, Math.ceil(r.height + p * 2)) }
  }
  const shot = async (name: string, area: Rect | string, p = 24) => {
    await settle()
    const r = typeof area === 'string' ? await box(area) : area
    if (!r) throw new Error(`nothing matches ${area} for ${name}`)
    const png = (await grab(pad(r, p))).toPNG()
    writeFileSync(join(outDir, `${name}.png`), png)
  }
  const hits = (): Promise<Rect[]> =>
    wc().executeJavaScript(
      `[...document.querySelectorAll('[data-hit]')].filter((el) => !el.closest('[inert]')).map((el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height } })`
    )
  const sequences: Record<string, unknown> = {}
  /** Frames every `every` ms while `change` runs, cropped to `area`, with the page's and main's hit rects. */
  const sequence = async (name: string, area: Rect, change: () => void | Promise<void>, frames = 12, every = 50) => {
    await settle()
    const log: unknown[] = []
    const dir = join(outDir, `seq-${name}`)
    mkdirSync(dir, { recursive: true })
    const t0 = Date.now()
    await change()
    for (let i = 0; i < frames; i++) {
      const img = await grab(pad(area, 0))
      writeFileSync(join(dir, `${String(i).padStart(2, '0')}.png`), img.toPNG())
      const page = await hits()
      const reported = hitLog.at(-1)?.rects ?? []
      const notch = await box('.notch')
      const callout = await box('.callout')
      log.push({ i, t: Date.now() - t0, notch, callout, page, reported })
      await sleep(every)
    }
    sequences[name] = log
  }

  // A control in input space (physical pixels on Windows), a third of the way across.
  const toInput = (r: Rect): Rect => ({ x: Math.round((d.bounds.x + r.x) * s), y: Math.round((d.bounds.y + r.y) * s), width: Math.round(r.width * s), height: Math.round(r.height * s) })
  const target = { x: Math.round(W / 3), y: 180, width: 160, height: 36 }
  const teach = (r: Rect, step: number, total: number, instruction = 'Click Display to open the screen settings.', id = `t_${step}`) =>
    ({ rect: toInput(r), instruction, step, total, id })
  const top: Rect = { x: Math.round(W / 2 - 300), y: 0, width: 600, height: 230 }
  const send = (state: unknown) => wc().send('computer-overlay:state', state)
  const approval = { id: 'ap_1', title: 'Delete 3 files from Downloads', detail: 'old-1.txt\nold-2.txt\nold-3.txt' }
  const long = {
    id: 'ap_2',
    title: 'Run a command on your computer that removes every file in the old reports folder, including the hidden ones',
    detail: 'Remove-Item -Recurse -Force "C:\\Users\\me\\Documents\\Reports\\2019\\old" ; Remove-Item -Recurse -Force "C:\\Users\\me\\Documents\\Reports\\2020\\old"'
  }

  for (const theme of ['light', 'dark'] as const) {
    nativeTheme.themeSource = theme
    for (const wp of ['light', 'dark', 'busy'] as const) {
      await wallpaper(wp)
      const tag = `${theme}-${wp}`
      overlay.show(true, null, null)
      await shot(`acting-corner-${tag}`, { x: 0, y: 0, width: 160, height: 120 }, 0)
      overlay.show(true, null, { text: 'Working · Click · “Display”', waiting: false })
      await shot(`notch-working-${tag}`, '.notch')
      if (wp !== 'busy') continue
      overlay.show(false, teach(target, 2, 4), null)
      await shot(`teach-${tag}`, { x: target.x - 40, y: target.y - 40, width: 420, height: 240 }, 0)
      overlay.show(false, teach(target, 2, 4), { text: 'Your turn · Step 2 of 4 · Click Display to open the screen settings.', waiting: true })
      await shot(`notch-waiting-${tag}`, '.notch')
      overlay.show(false, null, { text: 'Needs your OK', waiting: true, approval })
      await shot(`notch-approval-armed-${tag}`, '.notch')
      send({ acting: false, teach: null, notch: { text: 'Needs your OK', waiting: true, approval: long, camera: null } })
      await shot(`notch-approval-long-${tag}`, '.notch')
      // Past what the notch shows: it offers the chat's card, which has it all.
      const huge = { id: 'ap_4', title: long.title + ', then empties the Recycle Bin and clears the backup of the same folder on the network drive', detail: [long.detail, long.detail, long.detail].join(' ; ') }
      send({ acting: false, teach: null, notch: { text: 'Needs your OK', waiting: true, approval: huge, camera: null } })
      await shot(`notch-approval-huge-${tag}`, '.notch')
      send({ acting: false, teach: null, notch: { text: 'Working · Click', waiting: false, camera: { width: 200, height: 37 } } })
      await shot(`notch-camera-${tag}`, '.notch')
      send({ acting: false, teach: null, notch: { text: 'Needs your OK', waiting: true, approval, camera: { width: 200, height: 37 } } })
      await shot(`notch-camera-approval-${tag}`, '.notch')
      overlay.show(false, teach(target, 12, 20), null)
      await shot(`teach-many-steps-${tag}`, '.callout')
      overlay.show(false, teach(target, 1, 3, 'Open the Display settings, then scroll down to Night light and switch it on so the screen gets warmer after sunset.'), null)
      await shot(`teach-long-text-${tag}`, '.callout')
      overlay.show(false, null, null)
    }
    // Point, on the busy wallpaper.
    await wallpaper('busy')
    const point = async (hover: boolean, drag: boolean) => {
      overlay.point(d)
      wc().send('computer-overlay:point', { display: d.id })
      await sleep(100)
      const fire = (type: string, x: number, y: number, buttons = 0) =>
        wc().executeJavaScript(
          `document.querySelector('[data-point]').dispatchEvent(new PointerEvent(${JSON.stringify(type)}, { clientX: ${x}, clientY: ${y}, button: 0, buttons: ${buttons}, pointerId: 1, bubbles: true })); 0`
        )
      if (hover) {
        await fire('pointermove', 460, 318)
        await sleep(150)
        wc().send('computer-overlay:point-hit', { x: 460, y: 318, control: { rect: { x: 400, y: 300, width: 120, height: 36 }, label: 'Button · Save' } })
      }
      if (drag) {
        await wc().executeJavaScript(`Element.prototype.setPointerCapture = () => {}; 0`)
        await fire('pointerdown', 360, 260, 1)
        await fire('pointermove', 700, 420, 1)
      }
      return fire
    }
    await point(false, false)
    await shot(`point-hint-${theme}`, '.hint')
    await shot(`point-idle-${theme}`, { x: Math.round(W / 2 - 320), y: 0, width: 640, height: 140 }, 0)
    await point(true, false)
    await shot(`point-hover-${theme}`, { x: 360, y: 250, width: 220, height: 120 }, 0)
    const fire = await point(false, true)
    await shot(`point-box-${theme}`, { x: 320, y: 200, width: 420, height: 260 }, 0)
    await fire('pointerup', 700, 420)
    wc().send('computer-overlay:point', null)
    overlay.point(null)
    // The notch with Point's hint below it.
    overlay.show(true, null, { text: 'Working · Click · “Display”', waiting: false })
    await point(false, false)
    await shot(`point-hint-below-notch-${theme}`, { x: Math.round(W / 2 - 320), y: 0, width: 640, height: 140 }, 0)
    wc().send('computer-overlay:point', null)
    overlay.point(null)
    // Under a MacBook's camera notch, which is wider and taller.
    const onEdge = await point(false, false)
    // (After Point starts: it has main send its own state.)
    send({ acting: true, teach: null, notch: { text: 'Working · Click · “Display”', waiting: false, camera: { width: 200, height: 37 } } })
    await shot(`point-hint-below-camera-${theme}`, { x: Math.round(W / 2 - 360), y: 0, width: 720, height: 140 }, 0)
    // A control at the screen's right edge with a long label: its tag stays on screen.
    await onEdge('pointermove', W - 30, 318)
    await sleep(150)
    wc().send('computer-overlay:point-hit', { x: W - 30, y: 318, control: { rect: { x: W - 64, y: 300, width: 60, height: 36 }, label: 'Button · Save the quarterly report as a PDF' } })
    await shot(`point-tag-edge-${theme}`, { x: W - 420, y: 250, width: 420, height: 120 }, 0)
    wc().send('computer-overlay:point', null)
    overlay.point(null)
    send({ acting: false, teach: null, notch: null })
    overlay.show(false, null, null)
  }

  // Sequences, light theme, busy wallpaper.
  nativeTheme.themeSource = 'light'
  await wallpaper('busy')
  const working = { text: 'Working · Click · “Display”', waiting: false }
  overlay.show(true, null, working)
  await sequence('notch-working-to-approval', top, () => overlay.show(false, null, { text: 'Needs your OK', waiting: true, approval }), 16)
  await sequence('notch-approval-to-working', top, () => overlay.show(true, null, { text: 'Working · Delete', waiting: false }), 16)
  await sequence('notch-text-changes', top, async () => {
    for (const text of ['Working · Look at the screen', 'Working · Type · “hello world”', 'Working · Click · “Save”']) {
      overlay.show(true, null, { text, waiting: false })
      await sleep(60)
    }
  })
  await sequence('notch-flap', top, async () => {
    // The chat window takes focus for a moment: the notch goes and comes back.
    overlay.show(true, null, null)
    await sleep(80)
    overlay.show(true, null, working)
  })
  await sequence('notch-leaves', top, () => overlay.show(false, null, null), 10)
  const area: Rect = { x: target.x - 60, y: target.y - 60, width: 760, height: 400 }
  overlay.show(false, teach(target, 1, 3, 'Click Display.'), null)
  await sequence('teach-next-step', area, () => overlay.show(false, teach({ ...target, x: target.x + 260, y: target.y + 60 }, 2, 3, 'Click Night light.'), null), 14)
  await sequence('teach-step-gap', area, async () => {
    // A step ends; the next one comes 100 ms later (Show me as main runs it, with a fast model).
    overlay.show(false, null, null)
    await sleep(100)
    overlay.show(false, teach(target, 3, 3, 'Turn it on.'), null)
  }, 14)
  await sequence('teach-leaves', area, () => overlay.show(false, null, null), 10)
  await sequence('acting-in', { x: 0, y: 0, width: 200, height: 120 }, () => overlay.show(true, null, null), 10)
  await sequence('acting-flap', { x: 0, y: 0, width: 200, height: 120 }, async () => {
    overlay.show(false, null, null)
    await sleep(60)
    overlay.show(true, null, null)
  }, 10)
  overlay.show(false, null, null)

  // Two approvals back to back: the panel stays open and the second replaces the first in place.
  const second = { id: 'ap_3', title: 'Empty the Recycle Bin', detail: '12 items, 48 MB' }
  overlay.show(false, null, { text: 'Needs your OK', waiting: true, approval })
  await sequence('notch-back-to-back', top, async () => {
    overlay.show(false, null, { text: 'Working · Delete', waiting: false })
    await sleep(60)
    overlay.show(false, null, { text: 'Needs your OK', waiting: true, approval: second })
  }, 14)
  overlay.show(false, null, null)

  // A Show-me step entering above its target (no room below) and beside it (no room above or
  // below): it appears where it settles, without drifting from a guessed height.
  overlay.show(false, null, null)
  await sequence('teach-enter-above', { x: target.x - 60, y: H - 360, width: 760, height: 360 }, () =>
    overlay.show(false, teach({ ...target, y: H - 90 }, 1, 2, 'Click Display to open the screen settings.', 'above_1'), null), 10)
  overlay.show(false, null, null)
  await sequence('teach-enter-beside', { x: target.x - 60, y: 40, width: 820, height: H - 80 }, () =>
    overlay.show(false, teach({ x: target.x, y: 60, width: 220, height: H - 120 }, 1, 2, 'Click the sidebar.', 'beside_1'), null), 10)
  overlay.show(false, null, null)
  // A wide target: the ping grows by the same few pixels on every side.
  await sequence('teach-ping-wide', { x: 40, y: 120, width: Math.min(W - 80, 1000), height: 260 }, () =>
    overlay.show(false, teach({ x: 120, y: 180, width: Math.min(W - 240, 840), height: 40 }, 1, 2, 'Click the address bar.', 'wide_1'), null), 14, 80)
  overlay.show(false, null, null)

  /**
   * Approve arms once per approval. Main sends a new state object on every change (focus, text, a
   * held part let go), with the same approval in it: that must neither restart the arming nor
   * disarm an armed Approve. Checked mid-arm and after arming.
   */
  const armChecks: unknown[] = []
  for (const pushAfter of [300, APPROVE_ARM_MS + 100]) {
    overlay.show(false, null, null)
    await settle()
    const ask = { ...approval, id: `ap_arm_${pushAfter}` }
    const t0 = Date.now()
    overlay.show(false, null, { text: 'Needs your OK', waiting: true, approval: ask })
    await sleep(pushAfter)
    overlay.show(false, null, { text: 'Needs your OK', waiting: true, approval: { ...ask } })
    await sleep(Math.max(0, t0 + Math.max(pushAfter, APPROVE_ARM_MS) + 150 - Date.now()))
    await grab()
    const armed = (await wc().executeJavaScript(
      `(() => { const b = document.querySelector('.notch .approve'); return !!b && !b.disabled && !b.querySelector('.cu-fill') })()`
    )) as boolean
    armChecks.push({ pushAfter, checkedAt: Date.now() - t0, armed })
  }
  sequences['arm-checks'] = armChecks
  overlay.show(false, null, null)

  writeFileSync(join(outDir, 'sequences.json'), JSON.stringify(sequences, null, 1))
  const rearmed = armChecks.filter((c) => !(c as { armed: boolean }).armed)
  if (rearmed.length) throw new Error(`a state push re-armed Approve: ${JSON.stringify(rearmed)}`)
  console.log(`[states] ${W}x${H} @${d.scaleFactor * scale}x${process.env.REDUCED === '1' ? ' reduced motion' : ''}, wrote PNGs to ${outDir}`)
  void paper
  overlay.dispose()
  app.quit()
}

if (process.versions.electron) {
  void renderInElectron(process.env.OVERLAY_OUT!).catch((e) => {
    console.error(e)
    process.exit(1)
  })
} else {
  const outDir = resolve(process.argv[2] ?? join(tmpdir(), 'cv2-overlay-states'))
  const scale = process.argv[3]
  mkdirSync(outDir, { recursive: true })
  const bundle = join(tmpdir(), 'cv2-render-states.mjs')
  const built = spawnSync('bun', ['build', import.meta.filename, '--target=node', '--format=esm', '--external', 'electron', '--outfile', bundle], { cwd: root, stdio: 'inherit' })
  if (built.status !== 0) process.exit(1)
  const electron = require(join(root, 'node_modules/electron')) as string
  const env: Record<string, string | undefined> = { ...process.env, OVERLAY_OUT: outDir, CV2_ROOT: root, CHAT_V2_HEADLESS: '1', OVERLAY_SCALE: scale ?? '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const args = [bundle]
  const r = spawnSync(electron, args, { cwd: root, stdio: 'inherit', env })
  process.exit(r.status ?? 1)
}
