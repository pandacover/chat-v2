// Typical size of the app's background model calls, for the costs Settings shows next to the
// models that make them. test/memory.test.ts keeps the memory figure in step with its prompt.
import type { ModelInfo } from './types'

export const CALL_TOKENS = {
  /** Instructions (~470 tokens), a few saved facts, the assistant's last lines and the message. */
  memory: { input: 800, output: 50 },
  /** Instructions (~80 tokens) and the start of a chat's first message. */
  title: { input: 150, output: 10 }
} as const

/** Dollars for one typical call; null when OpenRouter doesn't give one price (routers). */
export const callCost = (pricing: ModelInfo['pricing'], kind: keyof typeof CALL_TOKENS): number | null => {
  if (pricing.input === null && pricing.output === null) return null
  const t = CALL_TOKENS[kind]
  return (t.input * (pricing.input ?? 0) + t.output * (pricing.output ?? 0)) / 1_000_000
}
