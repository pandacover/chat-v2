// A live run with the real Claude Agent SDK that only looks: the real platform, Show-me mode (so
// mouse and keyboard tools are refused), no overlay. It uses the machine's Claude Code login.
//   bun test/computer/live-look.ts ["request"]
// Show-me steps are answered "said" and approvals denied, so nothing waits on a human.
import { query } from '@anthropic-ai/claude-agent-sdk'
import { Effect, ManagedRuntime } from 'effect'
import type { Step } from '@shared/steps'
import { ComputerUse, makePlatform, modeTag, noOverlay } from '../../src/main/computer'

const request =
  process.argv[2] ??
  "What's on my screen right now, which windows are open, and which PDF did I change most recently? Just tell me; don't change anything."

const rt = ManagedRuntime.make(ComputerUse.layer({ platform: makePlatform(), overlay: noOverlay, remember: async (f) => console.log('[remember]', f) }))
const cu = await rt.runPromise(ComputerUse.use((c) => Effect.succeed(c)))
cu.subscribe((w) => {
  if (w?.kind === 'teach') void rt.runPromise(cu.teachDone(w.id, { kind: 'said', text: 'No need to show me, just tell me in the chat.' }))
  if (w?.kind === 'approval') void rt.runPromise(cu.approve(w.id, false))
})

const abort = new AbortController()
const steps: Step[] = []
const mod = cu.module(
  { sessionId: 'live', messageId: 'live-1', step: async (s) => void steps.push(s), attach: async () => {}, signal: abort.signal },
  { mode: () => 'teach' }
)

const env: Record<string, string | undefined> = { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }
delete env.ANTHROPIC_API_KEY
const calls: string[] = []
const t0 = Date.now()
const q = query({
  prompt: modeTag('teach', request),
  options: {
    model: 'claude-haiku-5-5',
    env,
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
    maxTurns: 14,
    systemPrompt: `You are the assistant in chat-v2, a desktop chat app. Write short Markdown.\n\n${mod.instructions}`,
    tools: [...(mod.builtins ?? []), 'ToolSearch'],
    mcpServers: { [mod.name]: mod.server },
    abortController: abort,
    canUseTool: async (name, input, { signal }) => {
      calls.push(name)
      // Allowed in Show-me mode, but it opens an Explorer window: not on the user's desktop during a test.
      if (name === 'mcp__computer__reveal_file') return { behavior: 'deny', message: 'Not in this test.' }
      const r = await mod.canUseTool!(name, input, signal)
      if (r) return r
      return name === 'ToolSearch' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Not in this test.' }
    }
  }
})

for await (const m of q) {
  if (m.type === 'assistant') {
    for (const b of m.message.content) {
      if (b.type === 'tool_use') console.log(`[tool] ${b.name} ${JSON.stringify(b.input).slice(0, 140)}`)
      if (b.type === 'text') console.log(`[text] ${b.text}`)
    }
  }
  if (m.type === 'user' && Array.isArray(m.message.content)) {
    for (const b of m.message.content as Array<{ type: string; content?: unknown; is_error?: boolean }>) {
      if (b.type !== 'tool_result') continue
      const text = Array.isArray(b.content) ? b.content.map((c: { type: string; text?: string }) => (c.type === 'text' ? c.text : `[${c.type}]`)).join(' ') : String(b.content ?? '')
      console.log(`[result${b.is_error ? ' error' : ''}] ${text.replace(/\s+/g, ' ').slice(0, 200)}`)
    }
  }
  if (m.type === 'result') {
    console.log(`[done] ${m.subtype}, ${m.num_turns} turns, $${m.total_cost_usd.toFixed(4)}, ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    console.log(`[usage] ${JSON.stringify(m.usage)}`)
  }
}
console.log(`[permission checks] ${calls.join(', ')}`)
console.log(`[steps] ${JSON.stringify(steps)}`)
await mod.end!()
await rt.dispose()
