<script lang="ts">
  import { tick } from 'svelte'
  import type { ComputerOverlayBridge, OverlayState } from '../../../preload/computer-overlay'

  /**
   * Full-screen, click-through layer above everything.
   *  - While computer use drives: a hairline frame around the screen (the chat says what it's doing).
   *  - In Show-me mode: a spotlight on the exact control, with the instruction beside it. The
   *    spotlight glides from step to step; the user can drag the callout aside.
   *  - While the chat is out of sight: a notch at the top of the screen with what it's doing and Stop.
   */
  const bridge = (window as unknown as { computerOverlay: ComputerOverlayBridge }).computerOverlay

  type Box = { x: number; y: number; w: number; h: number }
  const PAD = 6
  const holeOf = (r: { x: number; y: number; width: number; height: number }): Box => ({ x: r.x - PAD, y: r.y - PAD, w: r.width + PAD * 2, h: r.height + PAD * 2 })
  const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  /** Keeps a position 8 px inside the screen. */
  const clamp = (v: number, max: number) => Math.min(Math.max(8, v), max - 8)

  let st = $state<OverlayState>({ acting: false, teach: null, notch: null })
  $effect(() =>
    bridge.onState((s) => {
      // Where the user dragged the callout holds for the rest of the lesson (a lesson starts at
      // step 1), unless it would cover the next target.
      if (s.teach?.step === 1 && st.teach?.step !== 1) pin = null
      if (pin && s.teach && calloutEl && overlaps({ x: pin.left, y: pin.top, w: calloutEl.offsetWidth, h: calloutEl.offsetHeight }, holeOf(s.teach.rect))) pin = null
      st = s
    })
  )

  /** Where the user dragged the callout, and the grab point while they drag it. */
  let pin = $state<{ left: number; top: number } | null>(null)
  let drag: { dx: number; dy: number } | null = null
  let calloutEl: HTMLElement | undefined = $state()

  /**
   * The overlay covers the whole screen, so it may only take the mouse while the pointer is on one
   * of its controls (`data-hit`). A click-through window hears no mouse moves of its own, so main
   * watches the pointer; this tells it where the controls are, after each change and each glide.
   * Mid-drag the whole window counts, so a quick drag can't slip off the callout.
   */
  const report = () =>
    bridge.hits(
      drag
        ? [{ x: 0, y: 0, width: innerWidth, height: innerHeight }]
        : [...document.querySelectorAll('[data-hit]')].map((el) => {
            const r = el.getBoundingClientRect()
            return { x: r.left, y: r.top, width: r.width, height: r.height }
          })
    )
  $effect(() => {
    void st
    void pin
    void tick().then(report)
  })
  $effect(() => {
    addEventListener('transitionend', report)
    addEventListener('animationend', report)
    return () => {
      removeEventListener('transitionend', report)
      removeEventListener('animationend', report)
    }
  })

  const ondown = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest('button') || !calloutEl) return
    const r = calloutEl.getBoundingClientRect()
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top }
    calloutEl.setPointerCapture(e.pointerId)
    report()
  }
  const onmove = (e: PointerEvent) => {
    if (!drag || !calloutEl) return
    pin = { left: clamp(e.clientX - drag.dx, innerWidth - calloutEl.offsetWidth), top: clamp(e.clientY - drag.dy, innerHeight - calloutEl.offsetHeight) }
  }
  const onup = () => {
    if (!drag) return
    drag = null
    report()
    bridge.press('moved')
  }

  const n = $derived(st.notch)

  const t = $derived(st.teach)
  const hole = $derived(t ? holeOf(t.rect) : null)

  /** Past this many steps the progress dashes would overflow the callout; the count alone says it. */
  const MAX_DASHES = 8
  const CALLOUT_W = 320
  const GAP = 12
  /** The callout's rendered height (a guess until it has rendered once). */
  let calloutH = $state(120)

  // Below the target if there's room, else above, else beside it, else inside it; always on screen.
  const callout = $derived.by(() => {
    if (!hole) return null
    const vw = window.innerWidth
    const vh = window.innerHeight
    const h = calloutH
    const left = Math.min(Math.max(16, hole.x), vw - CALLOUT_W - 16)
    const at = (l: number, top: number, side: 'below' | 'above' | 'beside' | 'inside') => ({ left: clamp(l, vw - CALLOUT_W), top: clamp(top, vh - h), side })
    if (hole.y + hole.h + GAP + h + 8 <= vh) return at(left, hole.y + hole.h + GAP, 'below')
    if (hole.y - GAP - h >= 8) return at(left, hole.y - GAP - h, 'above')
    // Beside: level with the middle of the part of the target that's on screen.
    const top = (Math.max(0, hole.y) + Math.min(vh, hole.y + hole.h)) / 2 - h / 2
    if (hole.x + hole.w + GAP + CALLOUT_W + 8 <= vw) return at(hole.x + hole.w + GAP, top, 'beside')
    if (hole.x - GAP - CALLOUT_W >= 8) return at(hole.x - GAP - CALLOUT_W, top, 'beside')
    return at(hole.x + GAP, hole.y + GAP, 'inside')
  })
</script>

{#if st.acting}
  <!-- Computer use is driving: a hairline around the screen. The chat says what it's doing. -->
  <div class="frame" aria-hidden="true"></div>
{/if}

{#if t && hole && callout}
  <div class="spot" style="left:{hole.x}px;top:{hole.y}px;width:{hole.w}px;height:{hole.h}px">
    <span class="ring"></span>
    <span class="pulse"></span>
  </div>
  <div
    class="callout"
    class:above={callout.side === 'above' && !pin}
    class:pinned={!!pin}
    style="left:{pin?.left ?? callout.left}px;top:{pin?.top ?? callout.top}px;width:{CALLOUT_W}px"
    role="dialog"
    tabindex="-1"
    aria-label="Step {t.step} of {t.total}"
    data-hit
    bind:this={calloutEl}
    bind:offsetHeight={calloutH}
    onpointerdown={ondown}
    onpointermove={onmove}
    onpointerup={onup}
    onpointercancel={onup}
  >
    <div class="meta">
      <span class="count">{t.step}<span class="of">/{t.total}</span></span>
      <span class="grip" aria-hidden="true" title="Drag to move"></span>
      <span class="progress" aria-hidden="true">
        {#if t.total <= MAX_DASHES}
          {#each Array(t.total) as _, i}<i class:on={i < t.step}></i>{/each}
        {/if}
      </span>
    </div>
    <p>{t.instruction}</p>
    <div class="row">
      <span class="hint">Do it, then</span>
      <button onclick={() => bridge.press('done')}>Done</button>
    </div>
  </div>
{/if}

{#if n}
  <!-- The chat is out of sight: what computer use is doing, at the top of the screen. On a MacBook
       with a camera notch it wraps around the housing, with the status left of it and Stop right. -->
  <div
    class="notch"
    class:camera={!!n.camera}
    style={n.camera ? `--cam-w:${n.camera.width}px;--cam-h:${n.camera.height}px` : ''}
    role="status"
    data-hit
  >
    <button class="status" onclick={() => bridge.press('chat')} title="Show the chat">
      <span class="dot" class:waiting={n.waiting}></span>
      <span class="text">{n.text}</span>
    </button>
    {#if n.camera}<span class="housing" aria-hidden="true"></span>{/if}
    <button class="stop" onclick={() => bridge.press('stop')}>Stop</button>
  </div>
{/if}

<style>
  :global(*),
  :global(*::before),
  :global(*::after) {
    box-sizing: border-box;
  }
  :global(html),
  :global(body) {
    margin: 0;
    padding: 0;
    background: transparent;
    overflow: hidden;
    width: 100vw;
    height: 100vh;
    user-select: none;
    font-family: 'Inter Variable', 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
    font-size: 13px;
    line-height: 1.45;
    -webkit-font-smoothing: antialiased;
    font-feature-settings: 'cv11', 'ss01', 'ss03';
  }
  :global(:root) {
    --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
    --font-mono: 'Geist Mono Variable', 'Geist Mono', ui-monospace, 'SF Mono', 'Cascadia Mono', monospace;
    /* The app's accent (app.css, dark scheme): the notch is always dark. */
    --accent: #e5703f;
  }
  /* As app.css: no loops or glides for people who asked for less motion. */
  @media (prefers-reduced-motion: reduce) {
    :global(*),
    :global(*::before),
    :global(*::after) {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
  }

  /* ---------------------------------------------------------------- acting */
  .frame {
    position: fixed;
    inset: 0;
    pointer-events: none;
    box-shadow:
      inset 0 0 0 2px rgba(11, 11, 11, 0.5),
      inset 0 0 24px rgba(11, 11, 11, 0.12);
    animation: frame-in 400ms var(--ease-out) both;
  }
  @media (prefers-color-scheme: dark) {
    .frame {
      box-shadow:
        inset 0 0 0 2px rgba(255, 255, 255, 0.45),
        inset 0 0 24px rgba(255, 255, 255, 0.08);
    }
  }
  @keyframes frame-in {
    from {
      opacity: 0;
    }
  }

  /* ---------------------------------------------------------------- Show me */
  .spot {
    position: fixed;
    border-radius: 10px;
    /* The dim is the spotlight's own shadow, so the hole is always exact. */
    box-shadow: 0 0 0 200vmax rgba(8, 8, 8, 0.36);
    transition:
      left 420ms var(--ease-out),
      top 420ms var(--ease-out),
      width 420ms var(--ease-out),
      height 420ms var(--ease-out);
    pointer-events: none;
    animation: dim 260ms ease-out both;
  }
  .ring {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow:
      0 0 0 2px #fff,
      0 0 0 3px rgba(0, 0, 0, 0.55),
      0 6px 24px rgba(0, 0, 0, 0.3);
  }
  .pulse {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.9);
    animation: pulse 1.8s var(--ease-out) infinite;
  }

  .callout {
    position: fixed;
    padding: 12px 14px 12px;
    border-radius: 14px;
    background: rgba(11, 11, 11, 0.96);
    color: #fff;
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.08),
      0 16px 40px -10px rgba(0, 0, 0, 0.55);
    animation: rise 300ms var(--ease-out) both;
    transition:
      left 420ms var(--ease-out),
      top 420ms var(--ease-out);
  }
  .callout.above {
    animation-name: sink;
  }
  .callout {
    cursor: grab;
    touch-action: none;
  }
  /* Dragged by the user: it stays where they put it, without gliding. */
  .callout.pinned {
    transition: none;
  }
  .callout:active {
    cursor: grabbing;
  }
  .grip {
    width: 18px;
    height: 6px;
    border-radius: 3px;
    background: radial-gradient(circle, rgba(255, 255, 255, 0.35) 1px, transparent 1.5px) 0 0 / 6px 3px;
  }
  .meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .count {
    font-family: var(--font-mono);
    font-size: 11px;
    color: #fff;
  }
  .of {
    color: rgba(255, 255, 255, 0.45);
  }
  .progress {
    display: inline-flex;
    gap: 3px;
  }
  .progress i {
    width: 12px;
    height: 2px;
    border-radius: 1px;
    background: rgba(255, 255, 255, 0.22);
  }
  .progress i.on {
    background: #fff;
  }
  p {
    margin: 8px 0 12px;
    font-size: 15px;
    font-weight: 540;
    line-height: 1.4;
    letter-spacing: -0.012em;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
  }
  .hint {
    font-size: 11.5px;
    color: rgba(255, 255, 255, 0.5);
  }
  .row button {
    font: inherit;
    border: 0;
    cursor: default;
    height: 28px;
    padding: 0 14px;
    border-radius: 999px;
    background: #fff;
    color: #0b0b0b;
    font-size: 12.5px;
    font-weight: 560;
  }
  .row button:hover {
    background: #e9e9e7;
  }

  /* ---------------------------------------------------------------- notch */
  .notch {
    position: fixed;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 10px;
    height: 32px;
    max-width: 460px;
    padding: 0 5px 0 12px;
    border-radius: 0 0 14px 14px;
    background: #0b0b0b;
    color: #fff;
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.06),
      0 8px 24px -8px rgba(0, 0, 0, 0.5);
    animation: drop 320ms var(--ease-out) both;
  }
  /* Around a MacBook's camera housing: the black meets the physical notch, with the status on its
     left and Stop on its right, and nothing under the camera itself. */
  .notch.camera {
    display: grid;
    /* Equal wings, so the gap sits exactly under the centred camera. */
    grid-template-columns: 150px var(--cam-w) 150px;
    height: var(--cam-h);
    max-width: none;
    gap: 0;
    padding: 0 8px;
    border-radius: 0 0 12px 12px;
  }
  .housing {
    height: 100%;
  }
  .notch.camera .stop {
    justify-self: end;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    height: 100%;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    font-size: 12.5px;
    cursor: default;
  }
  .text {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    animation: breathe 1.6s ease-in-out infinite;
  }
  /* Waiting on the user: a steady ring in the same accent. */
  .dot.waiting {
    background: none;
    box-shadow: inset 0 0 0 1.5px var(--accent);
    animation: none;
  }
  .stop {
    flex: none;
    height: 22px;
    padding: 0 10px;
    border: 0;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.14);
    color: #fff;
    font: inherit;
    font-size: 12px;
    font-weight: 560;
    cursor: default;
  }
  .stop:hover {
    background: rgba(255, 255, 255, 0.24);
  }
  @keyframes drop {
    from {
      transform: translate(-50%, -100%);
    }
  }
  @keyframes breathe {
    50% {
      opacity: 0.35;
    }
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }
  @keyframes sink {
    from {
      opacity: 0;
      transform: translateY(-6px);
    }
  }
  @keyframes dim {
    from {
      box-shadow: 0 0 0 200vmax rgba(8, 8, 8, 0);
    }
  }
  @keyframes pulse {
    0% {
      opacity: 0.9;
      transform: scale(1);
    }
    70%,
    100% {
      opacity: 0;
      transform: scale(1.08);
    }
  }
</style>
