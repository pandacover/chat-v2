// `recall`: a read-only tool over Tomo's long-term memory (the profile, the bot's playbook and the
// archive of finished jobs and old conversations), searched with SQLite FTS5 (memoryStore.recall).
// Agents read long-term memory but never write it; background writers do.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { RecallHit, RecallScope } from '../services/memoryStore'
import { plainBody } from '../memory'
import type { RunContext, ToolModuleFactory } from './module'

export const RECALL_INSTRUCTIONS = `You can search Tomo's long-term memory with recall (mcp__memory__recall; load it with ToolSearch "select:mcp__memory__recall"). It holds what Tomo knows about the user and summaries of finished jobs and earlier conversations, found by the words in their names and text. Use it when the user refers to something from before that this conversation doesn't show ("the trip we planned", "my usual setup"), searching for the names and words they would have used. Memory is read-only to you and may be out of date; when you rely on something it says, mention that it comes from an earlier conversation.`

/** How much of one record's text a result shows. */
const BODY_CHARS = 1200

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s)

const kindOf = (h: RecallHit) =>
  h.scope === 'profile'
    ? 'About the user'
    : h.scope === 'bot'
      ? 'Playbook'
      : h.scope === 'job'
        ? 'Job note'
        : h.type === 'conversation'
          ? 'Earlier conversation'
          : 'Finished job'

const day = (at: number) => new Date(at).toISOString().slice(0, 10)

/** The tool result: each hit with what it is, its names, when it was written and its text. */
export const describeHits = (query: string, hits: readonly RecallHit[]) =>
  hits.length === 0
    ? `Nothing in memory matches "${query}". Try other words, such as a name the user would have used.`
    : [
        `${hits.length} record${hits.length === 1 ? '' : 's'} for "${query}", best first:`,
        ...hits.map((h) => {
          const names = [h.title, ...h.aliases].filter(Boolean)
          const head = `[${h.id}] ${kindOf(h)}${names.length ? `: ${names.join(' / ')}` : ''} (${day(h.updatedAt)})`
          return `${head}\n${clip(plainBody(h.body), BODY_CHARS)}`
        })
      ].join('\n\n')

/**
 * The tool set. `search` runs the query (Db.recall); `scopeOf` says which bot's playbook and which
 * job's notes this reply may search besides the profile and archive (none until bots and jobs exist).
 */
export const recallModule =
  (search: (query: string, scope: RecallScope) => Promise<readonly RecallHit[]>, scopeOf: (ctx: RunContext) => Omit<RecallScope, 'limit'> = () => ({})): ToolModuleFactory =>
  (ctx) => {
    const recall = tool(
      'recall',
      "Search Tomo's long-term memory: facts about the user, and summaries of finished jobs and earlier conversations. Matches names, other names and words in the text.",
      {
        query: z.string().describe('Words to look for, such as names, places or topics'),
        limit: z.number().int().min(1).max(20).optional().describe('How many records at most; default 8')
      },
      async (a) => {
        const query = a.query.replace(/\s+/g, ' ').trim()
        try {
          const hits = await search(query, { ...scopeOf(ctx), limit: a.limit ?? 8 })
          await ctx.step({ tool: 'memory_recall', label: `Recalled “${clip(query, 60)}”`, ok: true, detail: hits.length === 0 ? 'Nothing found' : `${hits.length} found` })
          return { content: [{ type: 'text' as const, text: describeHits(query, hits) }] }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          await ctx.step({ tool: 'memory_recall', label: 'Recall failed', ok: false, detail: clip(message, 160) })
          return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true }
        }
      },
      { searchHint: 'recall memory: search what the user said before, earlier conversations, past or finished jobs, people, projects, preferences', annotations: { readOnlyHint: true } }
    )
    return {
      name: 'memory',
      instructions: RECALL_INSTRUCTIONS,
      server: createSdkMcpServer({ name: 'memory', version: '1.0.0', tools: [recall] })
    }
  }
