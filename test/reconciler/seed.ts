// Seeds a chat.db for the reconciler smoke test: a profile with a repeat and a fact a job corrects,
// and two finished jobs with threads, notes and archive records.
//   bun test/reconciler/seed.ts <chat.db>
import { makeDb } from '../../src/main/services/Db'

const db = makeDb(process.argv[2]!)
db.changeMemory({ add: ['Likes cats.', 'Has a cat.', 'Prefers detailed answers.', 'Works as a teacher.'], update: [], remove: [] }, { kind: 'edited' })

const finished = (title: string, said: Array<[string, string]>, note: string) => {
  const { job, thread } = db.createJob({ title, botId: db.primaryBot().id })
  let parent = thread.rootId
  for (const [user, reply] of said) {
    const u = db.insertMessage({ sessionId: thread.id, parentId: parent, role: 'user', content: user, status: 'complete' })
    parent = db.insertMessage({ sessionId: thread.id, parentId: u.id, role: 'assistant', content: reply, status: 'complete' }).id
  }
  db.writeNote(job.id, { kind: 'decision', text: note }, { sessionId: thread.id })
  db.setJobStatus(job.id, 'done')
  db.archiveJob(job.id, `${title}: done.`, { title, sessionId: thread.id })
  return job
}

finished(
  'Invoice script',
  [
    ['Rewrite my invoice script.', 'Here it is, with a comment on every line.'],
    ['No, never add comments to code. And keep answers short, I prefer short answers now.', 'Got it: no comments, short answers.']
  ],
  'Rewrote it without comments.'
)
finished('Garden', [['My cat dug up the tomatoes again. I love cats, though.', 'Try a mesh over the bed.']], 'Suggested a mesh.')
db.close()
