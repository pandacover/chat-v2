// Writes a chat.db as Tomo left it before bots and jobs (every migration before that one), with a
// few chats in it: `bun test/bots/seed-old-db.ts <file>`. The smoke test opens the app on it.
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS } from '../../src/main/services/Db'
import { BOTS_AND_JOBS_MIGRATION } from '../../src/main/services/jobsDb'

const file = process.argv[2]
if (!file) throw new Error('usage: bun test/bots/seed-old-db.ts <file>')
const db = new DatabaseSync(file)
const upTo = MIGRATIONS.indexOf(BOTS_AND_JOBS_MIGRATION)
for (const [i, sql] of MIGRATIONS.slice(0, upTo).entries()) {
  db.exec(sql)
  db.exec(`pragma user_version = ${i + 1}`)
}

const DAY = 24 * 60 * 60 * 1000
const now = Date.now()
let n = 0
const chat = (title: string, at: number, turns: Array<[string, string]>, extra: { pinned?: boolean; forkOf?: string } = {}) => {
  const id = `old-${++n}`
  db.prepare(
    `insert into sessions (id, title, model, system_prompt, root_id, forked_from_session_id, created_at, updated_at, pinned_at)
     values (?, ?, 'claude-sonnet-5-5', null, ?, ?, ?, ?, ?)`
  ).run(id, title, `${id}-root`, extra.forkOf ?? null, at, at, extra.pinned ? at : null)
  db.prepare(`insert into messages (id, session_id, parent_id, role, content, status, created_at) values (?, ?, null, 'root', '', 'complete', ?)`).run(`${id}-root`, id, at)
  let parent = `${id}-root`
  turns.forEach(([user, reply], i) => {
    const u = `${id}-u${i}`
    const a = `${id}-a${i}`
    db.prepare(`insert into messages (id, session_id, parent_id, role, content, status, created_at) values (?, ?, ?, 'user', ?, 'complete', ?)`).run(u, id, parent, user, at + i * 2)
    db.prepare(
      `insert into messages (id, session_id, parent_id, role, content, status, model, usage, created_at) values (?, ?, ?, 'assistant', ?, 'complete', 'claude-sonnet-5-5', ?, ?)`
    ).run(a, id, u, reply, JSON.stringify({ promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedTokens: 0, reasoningTokens: 0, cost: 0.01, requests: 1 }), at + i * 2 + 1)
    db.prepare('update messages set active_child_id = ? where id = ?').run(u, parent)
    db.prepare('update messages set active_child_id = ? where id = ?').run(a, u)
    parent = a
  })
  return id
}

chat('Printer keeps jamming', now - 2 * 60 * 60 * 1000, [
  ['My printer keeps jamming on page two', 'Open the rear tray and check for torn paper.'],
  ['Found a scrap, thanks', 'Great. Run a test page to be sure.']
])
const soup = chat('Tomato soup recipe', now - DAY - 3600_000, [['How do I make tomato soup?', 'Roast tomatoes with garlic, then blend with stock.']], { pinned: true })
chat('Tomato soup recipe (fork)', now - DAY, [['How do I make tomato soup?', 'Roast tomatoes with garlic, then blend with stock.']], { forkOf: soup })
chat('Rust lifetimes', now - 4 * DAY, [['Explain lifetimes in Rust', "A lifetime says how long a reference is valid. The borrow checker uses them to make sure references never outlive what they point to."]])
chat('Old taxes question', now - 30 * DAY, [['When are taxes due?', 'Usually in April.']])
db.close()
console.log(`seeded ${n} chats at schema ${upTo} in ${file}`)
