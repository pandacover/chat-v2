// Svelte transitions don't honour prefers-reduced-motion on their own; these do.
import { fade as svelteFade, fly as svelteFly, scale as svelteScale } from 'svelte/transition'
import type { FadeParams, FlyParams, ScaleParams } from 'svelte/transition'

const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')

/** The app's single easing curve, matching --ease-out in CSS. */
export const ease = (t: number) => {
  // cubic-bezier(0.2, 0.8, 0.2, 1) approximated by an exponential ease-out.
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t)
}

const gate = <P extends { duration?: number }>(p: P): P => (reduce.matches ? { ...p, duration: 0 } : p)

export const fade = (node: Element, p: FadeParams = {}) => svelteFade(node, gate({ duration: 160, easing: ease, ...p }))
export const fly = (node: Element, p: FlyParams = {}) => svelteFly(node, gate({ duration: 220, easing: ease, y: 6, ...p }))
export const pop = (node: Element, p: ScaleParams = {}) =>
  svelteScale(node, gate({ duration: 180, easing: ease, start: 0.97, opacity: 0, ...p }))
