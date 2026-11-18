import type { Usage } from '@shared/types'

const n = (v: number) => v.toLocaleString('en-US')

/** Dollars, with enough precision for fractions of a cent. */
export const formatCost = (cost: number) => {
  if (cost === 0) return '$0'
  if (cost < 0.0001) return '<$0.0001'
  return `$${cost < 0.01 ? cost.toFixed(4) : cost < 1 ? cost.toFixed(3) : cost.toFixed(2)}`
}

export const usageLabel = (u: Usage) => `${n(u.totalTokens)} tokens${u.cost !== null ? ` · ${formatCost(u.cost)}` : ''}`

export const usageDetail = (u: Usage) => {
  const cache = [u.cachedTokens ? `${n(u.cachedTokens)} from the cache` : '', u.cacheWriteTokens ? `${n(u.cacheWriteTokens)} written to it` : ''].filter(Boolean).join(', ')
  return [
    `Input ${n(u.promptTokens)}${cache ? ` (${cache})` : ''}`,
    `Output ${n(u.completionTokens)}${u.reasoningTokens ? ` (${n(u.reasoningTokens)} thinking)` : ''}`,
    u.requests > 1 ? `${u.requests} model calls` : '',
    u.cost !== null ? `About ${formatCost(u.cost)}` : 'Cost not reported'
  ]
    .filter(Boolean)
    .join(' · ')
}
