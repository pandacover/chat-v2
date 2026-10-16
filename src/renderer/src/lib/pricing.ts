import type { ModelInfo } from '@shared/types'

/** Dollars per million tokens: $15, $3.75, $0.30, $0.075, $0.0005. */
export const money = (n: number) => {
  if (n === 0) return '$0'
  if (Number.isInteger(n)) return `$${n}`
  if (n >= 1) return `$${n.toFixed(2)}`
  // Two significant digits below a dollar, keeping at least cents.
  let s = n.toPrecision(2)
  if (s.includes('e')) s = n.toFixed(7)
  return `$${s.replace(/(\.\d{2}\d*?)0+$/, '$1')}`
}

const isFree = (p: ModelInfo['pricing']) => p.input === 0 && p.output === 0

/** One line for a picker row: "$3 in · $15 out · cache $0.30 / $3.75". */
export const priceLine = (m: ModelInfo): string => {
  if (m.image) return 'Priced per image'
  const p = m.pricing
  if (p.input === null && p.output === null) return 'Price varies'
  if (isFree(p)) return 'Free'
  const parts = [p.input !== null ? `${money(p.input)} in` : '', p.output !== null ? `${money(p.output)} out` : '']
  if (p.cacheRead !== null || p.cacheWrite !== null) {
    parts.push(`cache ${[p.cacheRead, p.cacheWrite].map((v) => (v === null ? '–' : money(v))).join(' / ')}`)
  }
  return parts.filter(Boolean).join(' · ')
}

/** Spelled out for tooltips. */
export const priceDetail = (m: ModelInfo): string => {
  if (m.image) return 'Charged per generated image; see the model page on OpenRouter'
  const p = m.pricing
  if (p.input === null && p.output === null) return 'Price depends on the model OpenRouter routes to'
  if (isFree(p)) return 'Free'
  const row = (label: string, v: number | null) => (v === null ? '' : `${label} ${money(v)}`)
  return ['Per million tokens:', row('input', p.input), row('output', p.output), row('cache read', p.cacheRead), row('cache write', p.cacheWrite)]
    .filter(Boolean)
    .join(' · ')
    .replace(':', ':')
}
