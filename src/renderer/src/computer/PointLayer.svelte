<script lang="ts">
  import { cubicOut } from 'svelte/easing'
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
  /**
   * The notch is up (Overlay.svelte draws it, in this same page): the hint lines up under it, at
   * its width and left edge with a clear gap, and follows it as it opens or folds (an approval).
   */
  let notch = $state<{ left: number; width: number; bottom: number } | null>(null)
  $effect(() => {
    if (!point) return
    let raf = 0
    const measure = () => {
      const el = [...document.querySelectorAll<HTMLElement>('.notch')].find((e) => !e.closest('[inert]'))
      const r = el?.getBoundingClientRect()
      const next = r ? { left: Math.round(r.left), width: Math.round(r.width), bottom: Math.round(r.bottom) } : null
      if (JSON.stringify(next) !== JSON.stringify(notch)) notch = next
      raf = requestAnimationFrame(measure)
    }
    measure()
    return () => cancelAnimationFrame(raf)
  })
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

  const tagAbove = (r: OverlayRect) => (r.y >= 32 ? r.y - 28 : r.y + r.height + 6)
  /** A tag starts at its mark's left edge, but stays 8 px inside the screen. */
  let tagW = $state(0)
  const tagLeft = (r: OverlayRect) => Math.max(8, Math.min(r.x, innerWidth - tagW - 8))

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
  const fade = (_: Element, { duration = 160, y = 0 }: { duration?: number; y?: number } = {}) => ({
    duration: reduce.matches ? 0 : duration,
    easing: cubicOut,
    css: (t: number) => `opacity:${t};${y ? `transform:translateY(${(1 - t) * y}px)` : ''}`
  })
</script>

<svelte:window {onkeydown} />

{#if point}
  <!-- It leaves at once (no fade): the click that ends it is followed by a capture of the screen. -->
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
    in:fade
  >
    {#if box}
      <div class="box" style="left:{box.x}px;top:{box.y}px;width:{box.width}px;height:{box.height}px"></div>
      <span class="tag cu-ink mono" style="left:{tagLeft(box)}px;top:{tagAbove(box)}px" bind:offsetWidth={tagW}>{Math.round(box.width)} × {Math.round(box.height)}</span>
    {:else if hover}
      <div class="control" style="left:{hover.rect.x}px;top:{hover.rect.y}px;width:{hover.rect.width}px;height:{hover.rect.height}px"></div>
      <span class="tag cu-ink" style="left:{tagLeft(hover.rect)}px;top:{tagAbove(hover.rect)}px" bind:offsetWidth={tagW}>{hover.label}</span>
    {/if}
  </div>
  <div
    class="hint cu-ink"
    class:below-notch={!!notch}
    style={notch ? `left:${notch.left}px;width:${notch.width}px;top:${notch.bottom + 8}px` : ''}
    role="status"
    in:fade={{ duration: 200, y: -6 }}
  >
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"
      ><circle cx="12" cy="12" r="8" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></svg
    >
    <span>Click a spot or a control, or drag a box</span>
    <button class="cu-btn small" onclick={cancel}>Cancel <kbd class="cu-kbd">Esc</kbd></button>
  </div>
{/if}

<style>
  /* Computer use's shared look (computer.css): the hint and tags are ink, like the notch and the
     callout. The mark is the app's ember, as it is drawn into the image that goes with the message. */
  .point {
    position: fixed;
    inset: 0;
    cursor: crosshair;
    background: rgb(12 11 10 / 0.2);
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
      0 0 0 200vmax rgb(12 11 10 / 0.2),
      inset 0 0 0 2px var(--cu-accent);
    pointer-events: none;
  }
  .control {
    position: absolute;
    border-radius: 6px;
    background: color-mix(in srgb, var(--cu-accent) 10%, transparent);
    box-shadow:
      inset 0 0 0 2px var(--cu-accent),
      0 0 0 1px rgb(20 19 17 / 0.25);
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
    height: 22px;
    padding: 0 9px;
    border-radius: var(--cu-r-pill);
    font-size: 11.5px;
    font-weight: 500;
    line-height: 22px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
  }
  .mono {
    font-family: var(--cu-mono);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .hint {
    position: fixed;
    top: 16px;
    left: 0;
    right: 0;
    width: max-content;
    margin: 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 36px;
    padding: 0 5px 0 14px;
    border-radius: var(--cu-r-pill);
    color: var(--cu-fg-2);
    font-size: 12.5px;
    white-space: nowrap;
    cursor: default;
  }
  .hint > span {
    color: var(--cu-fg);
  }
  /* Under the notch: its width and left edge (set from its box), its insets, the text to the left. */
  .hint.below-notch {
    right: auto;
    margin: 0;
    padding: 0 8px 0 14px;
  }
  .hint.below-notch .cu-btn {
    margin-left: auto;
  }
  .hint.below-notch > span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hint .cu-btn {
    margin-left: 2px;
  }
  .hint .cu-kbd {
    color: var(--cu-fg-3);
  }
</style>
