import type { Usage } from '@shared/types'

const n = (v: number) => v.toLocaleString('en-US')

/** OpenRouter credits, with enough precision for fractions of a cent. */
export const formatCredits = (cost: number) => {
  if (cost === 0) return '0'
  if (cost < 0.0001) return '<0.0001'
  return cost < 0.01 ? cost.toFixed(4) : cost < 1 ? cost.toFixed(3) : cost.toFixed(2)
}

export const usageLabel = (u: Usage) =>
  `${n(u.totalTokens)} tokens${u.cost !== null ? ` · ${formatCredits(u.cost)} credits` : ''}`

export const usageDetail = (u: Usage) =>
  [
    `Input ${n(u.promptTokens)}${u.cachedTokens ? ` (${n(u.cachedTokens)} cached)` : ''}`,
    `Output ${n(u.completionTokens)}${u.reasoningTokens ? ` (${n(u.reasoningTokens)} reasoning)` : ''}`,
    u.requests > 1 ? `${u.requests} requests` : '',
    u.cost !== null ? `${formatCredits(u.cost)} OpenRouter credits` : 'Cost not reported'
  ]
    .filter(Boolean)
    .join(' · ')
