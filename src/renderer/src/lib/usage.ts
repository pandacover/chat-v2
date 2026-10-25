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

/** Replies on the Claude API are priced from Anthropic's list prices rather than reported by OpenRouter. */
export const usageDetail = (u: Usage, model: string | null = null) =>
  [
    `Input ${n(u.promptTokens)}${u.cachedTokens ? ` (${n(u.cachedTokens)} cached)` : ''}`,
    `Output ${n(u.completionTokens)}${u.reasoningTokens ? ` (${n(u.reasoningTokens)} reasoning)` : ''}`,
    u.requests > 1 ? `${u.requests} requests` : '',
    u.cost === null ? 'Cost not reported' : model?.startsWith('claude/') ? `$${formatCredits(u.cost)} at Claude API list prices` : `${formatCredits(u.cost)} OpenRouter credits`
  ]
    .filter(Boolean)
    .join(' · ')
