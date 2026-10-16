// A single shared tooltip, used through the `tip` action instead of the native `title`
// attribute (which waits ~1.5 s and cannot be styled).

export type TipInput = string | { text: string; kbd?: string; placement?: 'top' | 'bottom' } | null | undefined

// Long enough not to flash while the pointer crosses the UI, short enough to feel immediate.
const DELAY = 200
// After a tooltip hides, the next one shows instantly for this long (moving along a toolbar).
const WARM = 450

let el: HTMLDivElement | null = null
let showTimer: ReturnType<typeof setTimeout> | undefined
let warmUntil = 0
let owner: HTMLElement | null = null

const ensure = () => {
  if (el) return el
  el = document.createElement('div')
  el.setAttribute('role', 'tooltip')
  el.id = 'app-tooltip'
  el.className = 'app-tooltip'
  document.body.appendChild(el)
  return el
}

const normalize = (input: TipInput) =>
  input == null || input === '' ? null : typeof input === 'string' ? { text: input } : input

const place = (anchor: HTMLElement, preferred: 'top' | 'bottom') => {
  const tip = ensure()
  const a = anchor.getBoundingClientRect()
  const t = tip.getBoundingClientRect()
  const gap = 7
  let top = preferred === 'top' ? a.top - t.height - gap : a.bottom + gap
  let side = preferred
  // Flip when there is no room on the preferred side.
  if (side === 'top' && top < 6) {
    top = a.bottom + gap
    side = 'bottom'
  } else if (side === 'bottom' && top + t.height > innerHeight - 6) {
    top = a.top - t.height - gap
    side = 'top'
  }
  const left = Math.min(innerWidth - t.width - 6, Math.max(6, a.left + a.width / 2 - t.width / 2))
  tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
  tip.dataset.side = side
}

const show = (anchor: HTMLElement, input: TipInput) => {
  const tip = ensure()
  const data = normalize(input)
  if (!data) return
  tip.textContent = data.text
  if (data.kbd) {
    const k = document.createElement('kbd')
    k.textContent = data.kbd
    tip.appendChild(k)
  }
  owner = anchor
  anchor.setAttribute('aria-describedby', 'app-tooltip')
  tip.dataset.open = 'false'
  place(anchor, data.placement ?? 'top')
  // Commit the closed state, then open in the same frame (no wait for requestAnimationFrame).
  void tip.offsetWidth
  tip.dataset.open = 'true'
}

const hide = () => {
  clearTimeout(showTimer)
  if (!owner) return
  owner.removeAttribute('aria-describedby')
  owner = null
  warmUntil = Date.now() + WARM
  if (el) el.dataset.open = 'false'
}

const schedule = (anchor: HTMLElement, input: TipInput) => {
  clearTimeout(showTimer)
  if (!normalize(input)) return
  const delay = Date.now() < warmUntil || owner ? 0 : DELAY
  showTimer = setTimeout(() => show(anchor, input), delay)
}

// Create the element up front so the first tooltip does not pay for it.
if (document.body) ensure()
else addEventListener('DOMContentLoaded', () => ensure(), { once: true })

addEventListener('scroll', hide, true)
addEventListener('keydown', (e) => e.key === 'Escape' && hide())
addEventListener('blur', hide)

/**
 * `use:tip={'Copy'}` or `use:tip={{ text: 'New chat', kbd: 'Ctrl N' }}`.
 * Icon-only controls also get the text as their accessible name.
 */
export const tip = (node: HTMLElement, input: TipInput) => {
  let current = input
  const label = () => {
    const data = normalize(current)
    if (data && !node.textContent?.trim() && !node.hasAttribute('data-tip-no-label')) node.setAttribute('aria-label', data.text)
  }
  label()
  const enter = () => schedule(node, current)
  const leave = () => {
    if (owner === node || showTimer) hide()
  }
  const focus = () => node.matches(':focus-visible') && schedule(node, current)
  node.addEventListener('pointerenter', enter)
  node.addEventListener('pointerleave', leave)
  node.addEventListener('pointerdown', hide)
  node.addEventListener('focus', focus)
  node.addEventListener('blur', leave)
  return {
    update(next: TipInput) {
      current = next
      label()
      // Live-update an open tooltip (e.g. "Copy" → "Copied").
      if (owner === node) {
        const data = normalize(next)
        if (data) show(node, next)
        else hide()
      }
    },
    destroy() {
      if (owner === node) hide()
      node.removeEventListener('pointerenter', enter)
      node.removeEventListener('pointerleave', leave)
      node.removeEventListener('pointerdown', hide)
      node.removeEventListener('focus', focus)
      node.removeEventListener('blur', leave)
    }
  }
}
