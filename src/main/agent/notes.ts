// `note`: how bots on a job keep its notes (decisions, where things stand, what's left, files
// touched, progress). Job notes are working state, so bots write them directly, unlike long-term
// memory; they are stored as records in the job's scope (memoryStore.writeNote) and loaded into
// the prompt of the bots on the job, and the primary's, while the job is active (jobNotesBlock).
//
// TODO(jobs): not registered yet. Once sessions have a job_id, the driver puts it in
// RunContext.jobId, and Chat.toolSets adds noteModule for replies on a job:
//   noteModule((jobId, note, origin) => Effect.runPromise(db.use((d) => d.writeNote(jobId, note, origin))))
// and the reply's instructions get jobNotesBlock(d.jobNotes(jobId)).
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { JobNoteKind, MemoryRecord } from '@shared/types'
import { NOTE_KINDS, SINGLE_NOTES } from '../services/memoryStore'
import type { ToolModuleFactory } from './module'

export const NOTE_INSTRUCTIONS = `You are working on a job, and you keep its notes with note (mcp__notes__note; load it with ToolSearch "select:mcp__notes__note"). The other bots on the job and the primary bot read them, so write down what someone picking the job up would need: each decision and why ("decision"), where things stand ("state"), what's left to do ("left"), the files you touched ("files"), and progress worth knowing ("progress"). A new state, left or files note replaces the last one, so write it whole. Keep notes short and specific, and never put passwords or keys in them.`

/** How long one note may be. */
export const NOTE_CHARS = 4000

const LABELS: Record<JobNoteKind, string> = {
  state: 'Where things stand',
  left: "What's left",
  files: 'Files touched',
  decision: 'Decisions',
  progress: 'Progress'
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10)

/** A job's notes for the prompt of the bots on it: the current state first, then the dated entries. */
export const jobNotesBlock = (notes: readonly MemoryRecord[]) => {
  if (notes.length === 0) return ''
  const sections = (['state', 'left', 'files', 'decision', 'progress'] as const).flatMap((kind) => {
    const of = notes.filter((n) => n.type === kind)
    if (of.length === 0) return []
    if (SINGLE_NOTES.includes(kind)) return [`${LABELS[kind]}:\n${of.map((n) => n.body).join('\n')}`]
    return [`${LABELS[kind]}:\n${of.map((n) => `- (${day(n.updatedAt)}) ${n.title ? `${n.title}: ` : ''}${n.body}`).join('\n')}`]
  })
  return `Notes on this job so far, kept by the bots working on it:\n\n${sections.join('\n\n')}`
}

export type WriteNote = (
  jobId: string,
  note: { kind: JobNoteKind; text: string; title?: string },
  origin: { sessionId: string }
) => Promise<{ id: number; rev: number | null; replaced: boolean }>

/** The tool set. It works only in a reply on a job (RunContext.jobId); elsewhere the tool says so. */
export const noteModule =
  (write: WriteNote): ToolModuleFactory =>
  (ctx) => {
    const note = tool(
      'note',
      "Write a note on the job you're working on, for the other bots on it and the primary bot. state, left and files replace the last note of their kind; decision and progress add one.",
      {
        kind: z.enum(NOTE_KINDS as [JobNoteKind, ...JobNoteKind[]]).describe('decision, state, left (what is left to do), files (files touched) or progress'),
        text: z.string().describe('The note. For state, left and files, the whole of it, as it replaces the last one'),
        title: z.string().optional().describe('A few words naming a decision or progress note')
      },
      async (a) => {
        const fail = async (message: string) => {
          await ctx.step({ tool: 'notes_note', label: "Couldn't write a note", ok: false, detail: message.slice(0, 160) })
          return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true }
        }
        if (!ctx.jobId) return fail("This chat isn't working on a job, so there is no job to keep notes on.")
        const text = a.text.trim()
        if (!text) return fail('The note is empty.')
        if (text.length > NOTE_CHARS) return fail(`The note is ${text.length} characters; keep it under ${NOTE_CHARS}.`)
        try {
          const title = a.title?.replace(/\s+/g, ' ').trim().slice(0, 80)
          const saved = await write(ctx.jobId, { kind: a.kind, text, ...(title ? { title } : {}) }, { sessionId: ctx.sessionId })
          await ctx.step({ tool: 'notes_note', label: `Noted ${LABELS[a.kind].toLowerCase()}`, ok: true, ...(title ? { detail: title } : {}) })
          const what = saved.rev === null ? 'The note already says that.' : saved.replaced ? `Replaced the ${a.kind} note.` : `Saved as note ${saved.id}.`
          return { content: [{ type: 'text' as const, text: what }] }
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e))
        }
      },
      { searchHint: 'note: write job notes, record a decision, the state, what is left, files touched, progress on the job' }
    )
    return {
      name: 'notes',
      instructions: NOTE_INSTRUCTIONS,
      server: createSdkMcpServer({ name: 'notes', version: '1.0.0', tools: [note] })
    }
  }
