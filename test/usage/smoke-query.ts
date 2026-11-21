// CHAT_V2_FAKE_QUERY for smoke.mjs (bundled to CommonJS): a scripted model on a Claude plan. A
// message with "limit" in it runs into the 5-hour limit after a warning (the first time the limit
// resets in a few seconds, the second time in a minute), and its continuation finishes. The usage
// meter answers as the SDK's usage control request would.
import { fakeQuery, type Script } from '../fakeQuery'

let limited = 0
const script: Script = async function* (t) {
  if (t.call.options.persistSession === false) {
    yield* t.text('Usage test')
    yield t.result()
    return
  }
  const prompt = t.call.prompt.map((b) => b.text ?? '').join('\n')
  const continuing = /continue/i.test(t.call.prompt.at(-1)?.text ?? '')
  if (prompt.includes('limit') && !continuing) {
    limited++
    yield t.rateLimit({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.85, resetsAt: Math.floor(Date.now() / 1000) + 3600, overageStatus: 'allowed' })
    yield* t.text('Part one.\n')
    yield t.rateLimit({ status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: Date.now() + (limited === 1 ? 3000 : 60_000), overageStatus: 'rejected' })
    yield* t.apiError('rate_limit', "You've hit your limit")
    return
  }
  yield* t.text(continuing ? 'Part two.' : 'Hello.')
  yield t.result({ cost: 0.012 })
}

const iso = (ms: number) => new Date(Date.now() + ms).toISOString()
export const { query } = fakeQuery(script, {
  usage: () => ({
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 42, resets_at: iso(2 * 3600_000) },
      seven_day: { utilization: 63, resets_at: iso(3 * 86_400_000) },
      model_scoped: [{ display_name: 'Fable', utilization: 12, resets_at: iso(3 * 86_400_000) }],
      extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1240, utilization: 24.8, currency: 'USD' }
    }
  })
})
