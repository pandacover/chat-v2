<script lang="ts">
  import { tick, untrack } from 'svelte'
  import { cubicOut } from 'svelte/easing'
  import { APPROVE_ARM_MS } from '@shared/computer'
  import type { ComputerOverlayBridge, OverlayState } from '../../../preload/computer-overlay'

  /**
   * Full-screen, click-through layer above everything.
   *  - While computer use drives: an ember hairline around the screen (the chat says what it's doing).
   *  - In Show-me mode: a spotlight on the exact control, with the instruction beside it. The
   *    spotlight glides from step to step; the user can drag the callout aside.
   *  - While the chat is out of sight: a notch at the top of the screen with what it's doing, Point
   *    and Stop. An approval opens the same notch downwards into a small panel.
   * The look (tokens, pills, keys) is shared with the chat: computer.css.
   */
  const bridge = (window as unknown as { computerOverlay: ComputerOverlayBridge }).computerOverlay

  type Box = { x: number; y: number; w: number; h: number }
  const PAD = 6
  const holeOf = (r: { x: number; y: number; width: number; height: number }): Box => ({ x: r.x - PAD, y: r.y - PAD, w: r.width + PAD * 2, h: r.height + PAD * 2 })
  const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  /** Keeps a position 8 px inside the screen. */
  const clamp = (v: number, max: number) => Math.min(Math.max(8, v), max - 8)

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
  /** Enter and leave: short eased fades; things that come from an edge slide from it. */
  const fade = (_: Element, { duration = 200, y = 0 }: { duration?: number; y?: number } = {}) => ({
    duration: reduce.matches ? 0 : duration,
    easing: cubicOut,
    css: (t: number) => `opacity:${t};${y ? `transform:translateY(${(1 - t) * y}px)` : ''}`
  })
  const drop = (_: Element, { duration = 280 }: { duration?: number } = {}) => ({
    duration: reduce.matches ? 0 : duration,
    easing: cubicOut,
    css: (t: number) => `transform:translateY(${(t - 1) * 100}%);opacity:${Math.min(1, t * 1.6)}`
  })

  /**
   * What is drawn. A part that main turns off stays HOLD ms more, so a state that flaps (the notch
   * as the chat window takes focus for a moment, a step ending just as the next one starts) doesn't
   * blink; the next step glides from the last one instead of fading out and in.
   */
  const HOLD = 160
  let st = $state<OverlayState>({ acting: false, teach: null, notch: null })
  let raw: OverlayState = { acting: false, teach: null, notch: null }
  let release: ReturnType<typeof setTimeout> | undefined

  /** Where the user dragged the callout, and the grab point while they drag it. */
  let pin = $state<{ left: number; top: number } | null>(null)
  let drag: { dx: number; dy: number } | null = null
  let calloutEl: HTMLElement | undefined = $state()

  const show = (next: OverlayState) => {
    // Where the user dragged the callout holds for the rest of the lesson (a lesson starts at
    // step 1), unless it would cover the next target.
    if (next.teach?.step === 1 && st.teach?.step !== 1) pin = null
    if (pin && next.teach && calloutEl && overlaps({ x: pin.left, y: pin.top, w: calloutEl.offsetWidth, h: calloutEl.offsetHeight }, holeOf(next.teach.rect))) pin = null
    st = next
  }
  $effect(() => {
    const off = bridge.onState((s) => {
      raw = s
      const held = (st.acting && !s.acting) || (!!st.teach && !s.teach) || (!!st.notch && !s.notch)
      show({ acting: s.acting || (held && st.acting), teach: s.teach ?? st.teach, notch: s.notch ?? st.notch })
      if (!held) {
        clearTimeout(release)
        release = undefined
      } else
        release ??= setTimeout(() => {
          release = undefined
          show(raw)
        }, HOLD)
    })
    return () => {
      off()
      clearTimeout(release)
    }
  })

  /**
   * The overlay covers the whole screen, so it may only take the mouse while the pointer is on one
   * of its controls (`data-hit`). A click-through window hears no mouse moves of its own, so main
   * watches the pointer; this tells it where the controls are. While anything moves (a glide, the
   * notch opening, a part leaving) it reports every frame, so the area main uses never lags what
   * is drawn. A part on its way out (Svelte makes it inert) takes no clicks. Mid-drag the whole
   * window counts, so a quick drag can't slip off the callout.
   */
  let sent = ''
  const report = () => {
    const rects = drag
      ? [{ x: 0, y: 0, width: innerWidth, height: innerHeight }]
      : [...document.querySelectorAll('[data-hit]')]
          .filter((el) => !el.closest('[inert]'))
          .map((el) => {
            const r = el.getBoundingClientRect()
            return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) }
          })
    const key = JSON.stringify(rects)
    if (key === sent) return
    sent = key
    bridge.hits(rects)
  }
  let followUntil = 0
  let following = false
  const follow = (ms = 520) => {
    followUntil = Math.max(followUntil, performance.now() + ms)
    if (following) return
    following = true
    const frame = () => {
      report()
      if (performance.now() < followUntil) requestAnimationFrame(frame)
      else following = false
    }
    requestAnimationFrame(frame)
  }
  $effect(() => {
    void st
    void pin
    void tick().then(() => {
      report()
      follow()
    })
  })
  $effect(() => {
    const settled = () => report()
    const moving = () => follow()
    addEventListener('transitionrun', moving)
    addEventListener('animationstart', moving)
    addEventListener('transitionend', settled)
    addEventListener('animationend', settled)
    return () => {
      removeEventListener('transitionrun', moving)
      removeEventListener('animationstart', moving)
      removeEventListener('transitionend', settled)
      removeEventListener('animationend', settled)
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
  const ask = $derived(n?.approval ?? null)
  /** The approval the panel shows; kept while it closes, so its text doesn't vanish before it folds away. */
  let shownAsk = $state<NonNullable<typeof ask> | null>(null)
  $effect.pre(() => {
    if (ask) shownAsk = ask
  })

  /**
   * The panel stays open HOLD ms after an approval is answered while the notch stays up, so a
   * next approval that follows at once (back to back) replaces it in place instead of the panel
   * folding and opening again. Its buttons are inert meanwhile.
   */
  let asking = $state(false)
  let askRelease: ReturnType<typeof setTimeout> | undefined
  $effect.pre(() => {
    const open = !!ask
    const up = !!n
    untrack(() => {
      clearTimeout(askRelease)
      if (open) asking = true
      else if (asking && up) askRelease = setTimeout(() => (asking = false), HOLD)
      else asking = false
    })
  })
  $effect(() => () => clearTimeout(askRelease))

  // Approve in the notch arms after the same beat as the chat's, so a click meant for the app
  // under it can't say yes. Every state push is a new object: only a new approval re-arms.
  const askId = $derived(ask?.id ?? null)
  let armed = $state(false)
  $effect(() => {
    if (!askId) return
    armed = false
    const timer = setTimeout(() => (armed = true), APPROVE_ARM_MS)
    return () => clearTimeout(timer)
  })

  /** The approval's text runs past what the notch shows: it offers the chat's card, which has it all. */
  let titleEl: HTMLElement | undefined = $state()
  let detailEl: HTMLElement | undefined = $state()
  let clipped = $state(false)
  $effect(() => {
    void shownAsk
    void tick().then(() => {
      const over = (el: HTMLElement | undefined) => !!el && el.scrollHeight > el.clientHeight + 1
      clipped = over(titleEl) || over(detailEl)
    })
  })

  const t = $derived(st.teach)
  const hole = $derived(t ? holeOf(t.rect) : null)

  /** Past this many steps the progress dashes would overflow the callout; the count alone says it. */
  const MAX_DASHES = 8
  const CALLOUT_W = 320
  const GAP = 12
  /** The callout's rendered height (a guess until it has rendered once). */
  let calloutH = $state(124)
  /**
   * The callout glides from step to step, but not into its first place: until it has been
   * measured, its height is a guess, and a correction that glided would drift it on entry.
   */
  let placed = $state(false)
  $effect(() => {
    if (!calloutEl) {
      placed = false
      return
    }
    let raf = requestAnimationFrame(() => (raf = requestAnimationFrame(() => (placed = true))))
    return () => cancelAnimationFrame(raf)
  })
  /** A step's ping waits for the spotlight's glide to the new target to end; the first one sooner. */
  const GLIDE = 420
  let pingDelay = $state(120)
  let pingKey: string | number | null = null
  $effect.pre(() => {
    const k = t ? (t.id ?? t.step) : null
    untrack(() => {
      if (k !== pingKey) pingDelay = pingKey !== null && k !== null ? GLIDE : 120
      pingKey = k
    })
  })

  // Below the target if there's room, else above, else beside it, else inside it; always on screen.
  // Above, it hangs from its bottom edge (lifted by its own height), so its height never moves it.
  const callout = $derived.by(() => {
    if (!hole) return null
    const vw = window.innerWidth
    const vh = window.innerHeight
    const h = calloutH
    const left = Math.min(Math.max(16, hole.x), vw - CALLOUT_W - 16)
    const at = (l: number, top: number, side: 'below' | 'above' | 'beside' | 'inside') => ({ left: clamp(l, vw - CALLOUT_W), top: clamp(top, vh - h), side, lift: false })
    if (hole.y + hole.h + GAP + h + 8 <= vh) return at(left, hole.y + hole.h + GAP, 'below')
    if (hole.y - GAP - h >= 8) return { left: clamp(left, vw - CALLOUT_W), top: Math.min(hole.y - GAP, vh - 8), side: 'above' as const, lift: true }
    // Beside: level with the middle of the part of the target that's on screen.
    const top = (Math.max(0, hole.y) + Math.min(vh, hole.y + hole.h)) / 2 - h / 2
    if (hole.x + hole.w + GAP + CALLOUT_W + 8 <= vw) return at(hole.x + hole.w + GAP, top, 'beside')
    if (hole.x - GAP - CALLOUT_W >= 8) return at(hole.x - GAP - CALLOUT_W, top, 'beside')
    return at(hole.x + GAP, hole.y + GAP, 'inside')
  })
</script>

{#if st.acting}
  <!-- Computer use is driving: an ember hairline around the screen. The chat says what it's doing. -->
  <div class="frame" aria-hidden="true" in:fade={{ duration: 320 }} out:fade={{ duration: 240 }}></div>
{/if}

{#if t && hole && callout}
  <div class="spot" style="left:{hole.x}px;top:{hole.y}px;width:{hole.w}px;height:{hole.h}px" in:fade={{ duration: 260 }} out:fade={{ duration: 180 }}>
    <span class="ring"></span>
    <!-- Once per step, a single soft ring draws the eye to the target. -->
    {#key t.id ?? t.step}<span class="ping" style="--ping-delay:{pingDelay}ms"></span>{/key}
  </div>
  <div
    class="callout cu-ink"
    class:pinned={!!pin}
    class:placed
    style="left:{pin?.left ?? callout.left}px;top:{pin?.top ?? callout.top}px;translate:0 {callout.lift && !pin ? '-100%' : '0'};width:{CALLOUT_W}px"
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
    in:fade={{ duration: 220, y: callout.side === 'above' && !pin ? -6 : 6 }}
    out:fade={{ duration: 160 }}
  >
    <div class="meta">
      <span class="count">Step <b>{t.step}</b> of {t.total}</span>
      <span class="grip" aria-hidden="true" title="Drag to move"></span>
      <span class="cu-dashes" aria-hidden="true">
        {#if t.total <= MAX_DASHES}
          {#each Array(t.total) as _, i (i)}<i class:on={i < t.step}></i>{/each}
        {/if}
      </span>
    </div>
    <p>{t.instruction}</p>
    <div class="row">
      <button class="cu-btn" onclick={() => t.id && bridge.press('cant_find', t.id)}>Can’t find it</button>
      <button class="cu-btn" onclick={() => t.id && bridge.press('hand_over', t.id)}>Do it for me</button>
      <button class="cu-btn primary" onclick={() => t.id && bridge.press('done', t.id)}>Done</button>
    </div>
  </div>
{/if}

{#if n}
  <!-- The chat is out of sight: what computer use is doing, at the top of the screen. On a MacBook
       with a camera notch it wraps around the housing, with the status left of it and the buttons
       right. An approval opens it downwards (the same element, so nothing re-enters). -->
  <div
    class="notch cu-ink"
    class:camera={!!n.camera}
    class:asking
    style={n.camera ? `--cam-w:${n.camera.width}px;--cam-h:${n.camera.height}px` : ''}
    role={ask ? 'alertdialog' : 'status'}
    aria-labelledby={ask ? 'ask-title' : undefined}
    data-hit
    in:drop
    out:drop={{ duration: 200 }}
  >
    <div class="head">
      <button class="status" onclick={() => bridge.press('chat')} title="Show the chat">
        <span class="cu-dot" class:waiting={n.waiting}></span>
        <!-- A new status fades in where the last one was, which goes at once: two never overlap. -->
        <span class="text-slot">{#key n.text}<span class="text" in:fade={{ duration: 120 }}>{n.text}</span>{/key}</span>
      </button>
      {#if n.camera}<span class="housing" aria-hidden="true"></span>{/if}
      <span class="actions">
        <!-- Point: mark something on screen for the next message (PointLayer.svelte). -->
        <button class="cu-btn small" onclick={() => bridge.press('point')} title="Point at something on screen for your next message">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"
            ><circle cx="12" cy="12" r="8" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></svg
          >Point
        </button>
        <button class="cu-btn small line" onclick={() => bridge.press('stop')}>Stop</button>
      </span>
    </div>
    <!-- An approval waits: asked right here, answered through the same call as the chat's card. -->
    <div class="body" inert={!ask}>
      <div class="body-in">
        {#if shownAsk}
          <p class="ask-title" id="ask-title" bind:this={titleEl}>{shownAsk.title}</p>
          {#if shownAsk.detail}<div class="ask-detail" bind:this={detailEl}>{shownAsk.detail}</div>{/if}
          <div class="ask-row">
            {#if clipped}<button class="cu-btn small see-all" onclick={() => bridge.press('chat')}>See all in chat</button>{/if}
            <button class="cu-btn line deny" onclick={() => ask && bridge.press('deny', ask.id)}>Deny</button>
            {#key shownAsk.id}
              <button class="cu-btn primary approve" class:arming={!armed} class:armed disabled={!armed} onclick={() => ask && bridge.press('approve', ask.id)}>
                {#if !armed}<span class="cu-fill" style="--arm:{APPROVE_ARM_MS}ms" aria-hidden="true"></span>{/if}
                <span class="cu-label">Approve</span>
              </button>
            {/key}
          </div>
        {/if}
      </div>
    </div>
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
    font-family: var(--cu-font);
    font-size: 13px;
    line-height: 1.45;
    -webkit-font-smoothing: antialiased;
    font-optical-sizing: auto;
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
    /* An ember hairline, with a dark one inside it so it holds on an ember-coloured wallpaper. */
    box-shadow:
      inset 0 0 0 2px color-mix(in srgb, var(--cu-accent) 92%, transparent),
      inset 0 0 0 3px rgb(20 19 17 / 0.16);
  }

  /* ---------------------------------------------------------------- Show me */
  .spot {
    position: fixed;
    border-radius: 10px;
    /* The dim is the spotlight's own shadow, so the hole is always exact. */
    box-shadow: 0 0 0 200vmax rgb(12 11 10 / 0.38);
    transition:
      left var(--cu-glide) var(--cu-ease),
      top var(--cu-glide) var(--cu-ease),
      width var(--cu-glide) var(--cu-ease),
      height var(--cu-glide) var(--cu-ease);
    pointer-events: none;
  }
  /* Paper ring with an ink hairline outside it: it reads on light and dark controls alike. */
  .ring,
  .ping {
    position: absolute;
    inset: 0;
    border-radius: inherit;
  }
  .ring {
    box-shadow:
      0 0 0 2px var(--cu-paper),
      0 0 0 3px rgb(20 19 17 / 0.5);
  }
  /* The ping grows by the same 8 px on every side, whatever the target's size. */
  .ping {
    outline: 2px solid var(--cu-paper);
    outline-offset: 0;
    opacity: 0;
    animation: ping 900ms var(--cu-ease) var(--ping-delay, 120ms) both;
  }
  @keyframes ping {
    from {
      opacity: 0.85;
      outline-offset: 0;
    }
    to {
      opacity: 0;
      outline-offset: 8px;
    }
  }

  .callout {
    position: fixed;
    padding: 12px 14px 12px 16px;
    border-radius: var(--cu-r-card);
    cursor: grab;
    touch-action: none;
  }
  .callout.placed {
    transition:
      left var(--cu-glide) var(--cu-ease),
      top var(--cu-glide) var(--cu-ease),
      translate var(--cu-glide) var(--cu-ease);
  }
  /* Dragged by the user: it stays where they put it, without gliding. */
  .callout.pinned.placed {
    transition: none;
  }
  .callout:active {
    cursor: grabbing;
  }
  /* The count, the grip and the dashes: the grip stays centred whatever the count's width. */
  .meta {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    height: 16px;
  }
  .count {
    font-size: 11.5px;
    color: var(--cu-fg-3);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .count b {
    font-weight: 500;
    color: var(--cu-fg);
  }
  .grip {
    width: 20px;
    height: 3px;
    border-radius: 2px;
    background: var(--cu-hair-strong);
  }
  .callout .cu-dashes {
    justify-self: end;
  }
  .callout p {
    margin: 10px 0 12px;
    font-size: 16px;
    font-weight: 450;
    line-height: 1.38;
    letter-spacing: -0.012em;
    text-wrap: pretty;
    overflow-wrap: break-word;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 2px;
    margin: 0 -2px 0 -10px;
  }
  .row .primary {
    margin-left: auto;
  }

  /* ---------------------------------------------------------------- notch */
  .notch {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    margin: 0 auto;
    /* One width for every state, so the notch never jumps as its text changes. */
    width: 380px;
    max-width: calc(100vw - 24px);
    border-radius: 0 0 var(--cu-r-card) var(--cu-r-card);
    overflow: hidden;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 36px;
    /* The notch's insets, in every variant and its panel: 14 px left, 8 px right. */
    padding: 0 8px 0 14px;
  }
  /* Around a MacBook's camera housing: the black meets the physical notch, with the status on its
     left and the buttons on its right, and nothing under the camera itself. */
  .notch.camera {
    width: calc(356px + var(--cam-w));
  }
  .notch.camera .head {
    display: grid;
    /* Equal 178 px wings (insets included), so the gap sits exactly under the centred camera. */
    grid-template-columns: 164px var(--cam-w) 170px;
    gap: 0;
    height: var(--cam-h);
  }
  .housing {
    height: 100%;
  }
  .actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: 2px;
    margin-left: auto;
  }
  .notch.camera .actions {
    justify-self: end;
  }
  .status {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 9px;
    min-width: 0;
    height: 100%;
    padding: 0;
    border: 0;
    background: none;
    color: var(--cu-fg-2);
    font: inherit;
    font-size: 12.5px;
    cursor: default;
    transition: color var(--cu-fast) var(--cu-ease);
  }
  .status:hover {
    color: var(--cu-fg);
  }
  .status .cu-dot {
    color: var(--cu-fg);
  }
  .text-slot {
    display: grid;
    min-width: 0;
  }
  .text {
    grid-area: 1 / 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    text-align: left;
  }
  /* The approval panel: the notch opens downwards (grid rows 0fr → 1fr), and folds back. */
  .body {
    display: grid;
    grid-template-rows: 0fr;
    visibility: hidden;
    transition:
      grid-template-rows var(--cu-morph) var(--cu-ease),
      visibility 0s linear var(--cu-morph);
  }
  .notch.asking .body {
    grid-template-rows: 1fr;
    visibility: visible;
    transition:
      grid-template-rows var(--cu-morph) var(--cu-ease),
      visibility 0s;
  }
  .body-in {
    min-height: 0;
    overflow: hidden;
    padding: 0 8px 0 14px;
    opacity: 0;
    transition: opacity 160ms var(--cu-ease);
  }
  .notch.asking .body-in {
    opacity: 1;
    transition: opacity 200ms var(--cu-ease);
  }
  .ask-title {
    margin: 4px 0 0;
    font-size: 15px;
    font-weight: 500;
    line-height: 1.35;
    letter-spacing: -0.01em;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  /* Up to four lines of the exact target; longer scrolls (the chat's card has it all too). */
  .ask-detail {
    margin: 8px 0 0;
    padding: 6px 10px;
    border-radius: var(--cu-r-inner);
    background: var(--cu-ink-raised);
    box-shadow: inset 0 0 0 1px var(--cu-hair);
    color: var(--cu-fg-2);
    font-family: var(--cu-mono);
    font-size: 11px;
    line-height: 1.5;
    max-height: calc(4 * 1.5em + 12px);
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-all;
    scrollbar-width: thin;
    scrollbar-color: var(--cu-hair-strong) transparent;
  }
  .ask-row {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    margin: 12px 0 0;
    padding-bottom: 8px;
  }
  .see-all {
    margin-right: auto;
    margin-left: -10px;
  }
</style>
