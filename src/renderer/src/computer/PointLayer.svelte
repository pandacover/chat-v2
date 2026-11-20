<script lang="ts">
  import type { ComputerOverlayBridge, OverlayPoint, OverlayPointHit, OverlayRect } from '../../../preload/computer-overlay'

  /**
   * Point mode, over the whole display (main makes the window take every click meanwhile): a
   * crosshair; hovering highlights the control under the pointer where the platform reads
   * controls; a click marks a spot (or that control), a drag marks a box, Esc or a right-click
   * cancels. Main captures the screen and adds the mark to the next message.
   */
  const bridge = (window as unknown as { computerOverlay: ComputerOverlayBridge }).computerOverlay

  /** Below this many DIPs a press is a click, not a drag. */
  const DRAG_PX = 5
  /** How long the pointer rests before main is asked what is under it. */
  const REST_MS = 70

  let point = $state<OverlayPoint | null>(null)
  /** The notch is up (Overlay.svelte draws it), so the hint sits below it. */
  let notch = $state(false)
  $effect(() => bridge.onState((s) => (notch = s.notch !== null)))
  let hover = $state<OverlayPointHit['control']>(null)
  let box = $state<OverlayRect | null>(null)
  let down: { x: number; y: number; id: number } | null = null
  let dragging = false
  let at = { x: -1, y: -1 }
  let asked = { x: -1, y: -1 }
  let rest: ReturnType<typeof setTimeout> | undefined

  const reset = () => {
    clearTimeout(rest)
    hover = null
    box = null
    down = null
    dragging = false
  }

  $effect(() =>
    bridge.onPoint((p) => {
      reset()
      point = p
    })
  )
  $effect(() =>
    bridge.onPointHit((hit) => {
      if (!point || dragging || hit.x !== asked.x || hit.y !== asked.y) return
      const r = hit.control?.rect
      // Only while the pointer is still on it.
      hover = r && at.x >= r.x && at.x < r.x + r.width && at.y >= r.y && at.y < r.y + r.height ? hit.control : null
    })
  )

  const inside = (r: OverlayRect, x: number, y: number) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height

  const ondown = (e: PointerEvent) => {
    if (!point) return
    if (e.button !== 0) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    down = { x: e.clientX, y: e.clientY, id: e.pointerId }
  }
  const onmove = (e: PointerEvent) => {
    if (!point) return
    at = { x: e.clientX, y: e.clientY }
    if (down) {
      if (!dragging && Math.hypot(e.clientX - down.x, e.clientY - down.y) < DRAG_PX) return
      if (!dragging) {
        dragging = true
        hover = null
        bridge.pointDragging(true)
      }
      const x = Math.min(down.x, e.clientX)
      const y = Math.min(down.y, e.clientY)
      box = { x, y, width: Math.abs(e.clientX - down.x), height: Math.abs(e.clientY - down.y) }
      return
    }
    if (hover && !inside(hover.rect, at.x, at.y)) hover = null
    clearTimeout(rest)
    rest = setTimeout(() => {
      asked = { x: Math.round(at.x), y: Math.round(at.y) }
      bridge.pointHover(asked)
    }, REST_MS)
  }
  const onup = (e: PointerEvent) => {
    if (!point || !down || e.pointerId !== down.id) return
    const start = down
    const wasDrag = dragging && box && box.width >= DRAG_PX && box.height >= DRAG_PX
    const rect = wasDrag ? box : null
    if (dragging) bridge.pointDragging(false)
    reset()
    point = null
    bridge.pointDone(rect ? { point: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, rect: { ...rect } } : { point: { x: start.x, y: start.y }, rect: null })
  }
  const cancel = () => {
    if (!point) return
    reset()
    point = null
    bridge.pointCancel()
  }
  const onkeydown = (e: KeyboardEvent) => {
    if (point && e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }

  const tagAbove = (r: OverlayRect) => (r.y >= 30 ? r.y - 26 : r.y + r.height + 6)
</script>

<svelte:window {onkeydown} />

{#if point}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="point"
    class:boxing={!!box}
    data-point
    onpointerdown={ondown}
    onpointermove={onmove}
    onpointerup={onup}
    onpointercancel={cancel}
    oncontextmenu={(e) => {
      e.preventDefault()
      cancel()
    }}
  >
    {#if box}
      <div class="box" style="left:{box.x}px;top:{box.y}px;width:{box.width}px;height:{box.height}px"></div>
      <span class="tag mono" style="left:{box.x}px;top:{tagAbove(box)}px">{Math.round(box.width)} × {Math.round(box.height)}</span>
    {:else if hover}
      <div class="control" style="left:{hover.rect.x}px;top:{hover.rect.y}px;width:{hover.rect.width}px;height:{hover.rect.height}px"></div>
      <span class="tag" style="left:{hover.rect.x}px;top:{tagAbove(hover.rect)}px">{hover.label}</span>
    {/if}
  </div>
  <div class="hint" class:below-notch={notch} role="status">
    <span>Click a spot or a control, or drag a box</span>
    <span class="sep" aria-hidden="true"></span>
    <button onclick={cancel}>Cancel <kbd>Esc</kbd></button>
  </div>
{/if}

<style>
  /* The app's tokens (src/renderer/src/app.css); this page doesn't load the app's stylesheet. The
     hint and tags keep the light theme's ink in both themes, like the notch and the callout. */
  .point,
  .hint {
    --fg: #1d1b18;
    --bg: #f7f5f0;
    --accent: #b9502a;
    --accent-wash: #b9502a14;
    --scrim: #1d1b1824;
    --shadow: 0 1px 2px #1d1b180d, 0 8px 24px -8px #1d1b1826;
  }
  @media (prefers-color-scheme: dark) {
    .point,
    .hint {
      --accent: #e5703f;
      --accent-wash: #e5703f1a;
      --scrim: #00000033;
      --shadow: 0 1px 2px #0000004d, 0 12px 32px -12px #00000099;
    }
  }

  .point {
    position: fixed;
    inset: 0;
    cursor: crosshair;
    background: var(--scrim);
    touch-action: none;
  }
  /* While a box is drawn the dim moves to the box's shadow, so the box itself shows clear. */
  .point.boxing {
    background: transparent;
  }
  .box {
    position: absolute;
    border-radius: 4px;
    box-shadow:
      0 0 0 200vmax var(--scrim),
      inset 0 0 0 2px var(--accent);
    pointer-events: none;
  }
  .control {
    position: absolute;
    border-radius: 4px;
    background: var(--accent-wash);
    box-shadow: inset 0 0 0 1.5px var(--accent);
    pointer-events: none;
    transition:
      left 80ms ease-out,
      top 80ms ease-out,
      width 80ms ease-out,
      height 80ms ease-out;
  }
  .tag {
    position: absolute;
    max-width: 360px;
    height: 20px;
    padding: 0 7px;
    border-radius: 6px;
    background: var(--fg);
    color: var(--bg);
    font-size: 11.5px;
    line-height: 20px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
  }
  .mono {
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .hint {
    position: fixed;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 10px;
    height: 32px;
    padding: 0 5px 0 12px;
    border-radius: 10px;
    background: var(--fg);
    color: var(--bg);
    font-size: 12.5px;
    white-space: nowrap;
    box-shadow: var(--shadow);
    cursor: default;
  }
  .hint.below-notch {
    top: 48px;
  }
  .sep {
    width: 1px;
    height: 14px;
    background: currentColor;
    opacity: 0.2;
  }
  .hint button {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 22px;
    padding: 0 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 12px;
    cursor: default;
  }
  .hint button:hover {
    background: color-mix(in srgb, var(--bg) 14%, transparent);
  }
  kbd {
    font-family: var(--font-mono);
    font-size: 10.5px;
    opacity: 0.6;
  }
</style>
