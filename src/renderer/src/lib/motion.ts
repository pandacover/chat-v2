// Svelte transitions don't honour prefers-reduced-motion on their own; these do.
import { fade as svelteFade, fly as svelteFly, scale as svelteScale, slide as svelteSlide } from 'svelte/transition'
import type { FadeParams, FlyParams, ScaleParams, SlideParams } from 'svelte/transition'

const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')

/** The app's single easing curve, matching --ease-out in CSS. */
export const ease = (t: number) => {
  // cubic-bezier(0.2, 0.8, 0.2, 1) approximated by an exponential ease-out.
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t)
}

const gate = <P extends { duration?: number }>(p: P): P => (reduce.matches ? { ...p, duration: 0 } : p)

export const fade = (node: Element, p: FadeParams = {}) => svelteFade(node, gate({ duration: 160, easing: ease, ...p }))
export const fly = (node: Element, p: FlyParams = {}) => svelteFly(node, gate({ duration: 220, easing: ease, y: 6, ...p }))
export const slide = (node: Element, p: SlideParams = {}) => svelteSlide(node, gate({ duration: 200, easing: ease, ...p }))
/**
 * Folds a part of a flex column away, its gap to the part before it included, so what follows
 * moves up in one glide instead of a slide and a final snap of the gap.
 */
export const collapse = (node: Element, p: { duration?: number } = {}) => {
  const el = node as HTMLElement
  const h = el.offsetHeight
  const mt = parseFloat(getComputedStyle(el).marginTop) || 0
  const gap = el.previousElementSibling ? parseFloat(getComputedStyle(el.parentElement!).rowGap) || 0 : 0
  return gate({
    duration: 200,
    easing: ease,
    ...p,
    css: (t: number) => `overflow:hidden;height:${t * h}px;margin-top:${mt * t - gap * (1 - t)}px;opacity:${t}`
  })
}
export const pop =(node: Element, p: ScaleParams = {}) =>
  svelteScale(node, gate({ duration: 180, easing: ease, start: 0.97, opacity: 0, ...p }))
