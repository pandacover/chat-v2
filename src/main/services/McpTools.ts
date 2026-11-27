// The user's MCP servers in replies, and the Test button of Settings › Connections. Every reply on
// a job gets the servers its bot may use (McpStore.serverForBot), each a tool set of its own whose
// calls ask on the same approval card as computer use. Never in the primary's own conversation:
// like the browser and the computer, that work is handed to a job's thread, so tool calls and their
// results stay out of the user's chat with Tomo (agent/team.ts tells the primary who has which).
import { Effect, Layer } from 'effect'
import type { McpCheck, McpServerView } from '@shared/mcp'
import type { Session } from '@shared/types'
import { Agent } from '../agent/driver'
import { checkFrom, diagnoseCommand, mcpConfig, mcpModule, toolsFrom } from '../agent/mcp'
import { ComputerUse } from '../computer'
import { errorMessage } from '../errors'
import { Chat } from './Chat'
import { McpStore, serverForBot } from './McpStore'

export const mcpToolsLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const chat = yield* Chat
    const store = yield* McpStore
    const computer = yield* ComputerUse
    const ask = (ctx: { sessionId: string; messageId: string }, title: string, detail: string, signal: AbortSignal, deputy: boolean) =>
      Effect.runPromise(computer.ask({ sessionId: ctx.sessionId, messageId: ctx.messageId }, title, detail, deputy ? 'mcp' : undefined), { signal })
    chat.provideTools((session: Session, bot) => {
      if (session.kind === 'primary') return []
      // mcp.json is read for each reply, so a change in Settings (or by hand) applies to the next one.
      const servers = Effect.runSync(store.servers.pipe(Effect.orElseSucceed(() => [])))
      return servers.filter((s) => serverForBot(s, bot.id)).map((s) => mcpModule(s, ask))
    })
  })
)

/**
 * Connects to a saved server as a reply would (through Claude Code, no model call), keeps how it
 * went and the tools it lists, and returns that with every server. A stdio server that fails is
 * started once more on its own, for a few seconds, to say why: Claude Code says only "Connection closed".
 */
export const testServer = (id: string) =>
  Effect.gen(function* () {
    const store = yield* McpStore
    const agent = yield* Agent
    const s = yield* store.server(id)
    const statuses = yield* Effect.tryPromise({ try: () => agent.mcpStatus({ [s.name]: mcpConfig(s) }), catch: (e) => e }).pipe(
      Effect.catch((e) => Effect.succeed(errorMessage(e)))
    )
    let check: McpCheck
    let tools = null as ReturnType<typeof toolsFrom> | null
    if (typeof statuses === 'string') check = { status: 'failed', error: `Claude Code couldn't check it: ${statuses}`, at: Date.now(), server: null }
    else {
      const status = statuses.find((x) => x.name === s.name)
      const failed = !status || status.status === 'failed' || status.status === 'pending'
      const why = failed && s.transport === 'stdio' ? yield* Effect.promise(() => diagnoseCommand(s)) : null
      check = checkFrom(status, why)
      if (status?.status === 'connected') tools = toolsFrom(status)
    }
    const servers: McpServerView[] = yield* store.record(id, check, tools)
    return { servers, check }
  })
