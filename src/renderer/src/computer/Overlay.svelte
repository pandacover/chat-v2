<script lang="ts">
  import type { ComputerOverlayBridge, OverlayState } from '../../../preload/computer-overlay'

  /**
   * Full-screen, click-through layer above everything.
   *  - While computer use drives: a hairline frame around the screen (the chat says what it's doing).
   *  - In Show-me mode: a spotlight on the exact control, with the instruction beside it. The
   *    spotlight glides from step to step.
   */
  const bridge = (window as unknown as { computerOverlay: ComputerOverlayBridge }).computerOverlay

  let st = $state<OverlayState>({ acting: false, teach: null })
  // Main makes the overlay click-through again on every new state; report afresh from here.
  $effect(() =>
    bridge.onState((s) => {
      st = s
      over = false
    })
  )

  /**
   * The overlay covers the whole screen, so it may only take the mouse while the pointer is on the
   * callout. Hit-tested on every move, not with enter/leave: a callout that goes away under the
   * pointer (Done) never gets a mouseleave, and would leave a full-screen window eating every click.
   */
  let calloutEl: HTMLElement | undefined = $state()
  let over = false
  const onmove = (e: MouseEvent) => {
    const r = calloutEl?.getBoundingClientRect()
    const hit = !!r && e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom
    if (hit === over) return
    over = hit
    bridge.interactive(hit)
  }

  const PAD = 6
  const t = $derived(st.teach)
  const hole = $derived(t ? { x: t.rect.x - PAD, y: t.rect.y - PAD, w: t.rect.width + PAD * 2, h: t.rect.height + PAD * 2 } : null)

  // Callout below the target if there's room, otherwise above; clamped to the screen.
  const CALLOUT_W = 320
  const callout = $derived.by(() => {
    if (!hole) return null
    const vw = window.innerWidth
    const vh = window.innerHeight
    const below = hole.y + hole.h + 12
    const placeBelow = below + 120 < vh
    const left = Math.min(Math.max(16, hole.x), vw - CALLOUT_W - 16)
    return placeBelow ? { left, top: below, below: true } : { left, bottom: vh - hole.y + 12, below: false }
  })
</script>

<svelte:window onmousemove={onmove} />

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
    class:above={!callout.below}
    style="left:{callout.left}px;{callout.below ? `top:${callout.top}px` : `bottom:${callout.bottom}px`};width:{CALLOUT_W}px"
    role="dialog"
    tabindex="-1"
    aria-label="Step {t.step} of {t.total}"
    bind:this={calloutEl}
  >
    <div class="meta">
      <span class="count">{t.step}<span class="of">/{t.total}</span></span>
      <span class="progress" aria-hidden="true">
        {#each Array(t.total) as _, i}<i class:on={i < t.step}></i>{/each}
      </span>
    </div>
    <p>{t.instruction}</p>
    <div class="row">
      <span class="hint">Do it, then</span>
      <button onclick={() => bridge.done()}>Done</button>
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
    font-family: 'Inter Variable', 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
    font-size: 13px;
    line-height: 1.45;
    -webkit-font-smoothing: antialiased;
    font-feature-settings: 'cv11', 'ss01', 'ss03';
  }
  :global(:root) {
    --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
    --font-mono: 'Geist Mono Variable', 'Geist Mono', ui-monospace, 'SF Mono', 'Cascadia Mono', monospace;
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
      top 420ms var(--ease-out),
      bottom 420ms var(--ease-out);
  }
  .callout.above {
    animation-name: sink;
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
