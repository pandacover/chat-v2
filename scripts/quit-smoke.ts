// Checks that the app quits: run after `bun run build`. Starts the app hidden (CHAT_V2_HEADLESS=1,
// no window is ever shown) with a fresh data folder and CHAT_V2_QUIT_TEST, which makes it start a
// stand-in helper process that never exits on its own and then call app.quit() (src/main/index.ts).
// Twice: once as is, once with closing the services made to hang forever. Each time the app must
// exit within the limit, and the stand-in helper must be gone after it.
//
//   bun scripts/quit-smoke.ts
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electron from 'electron'

const root = join(import.meta.dir, '..')
if (!existsSync(join(root, 'out/main/index.js'))) {
  console.error('Build the app first: bun run build')
  process.exit(1)
}

/** From app.quit() to the process gone. The hang case waits out DISPOSE_TIMEOUT_MS (3 s) first. */
const LIMITS = { normal: 4000, hang: 7000 } as const

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const run = (mode: keyof typeof LIMITS) =>
  new Promise<void>((resolve, reject) => {
    const data = mkdtempSync(join(tmpdir(), 'chat-v2-quit-'))
    const env: Record<string, string | undefined> = { ...process.env, CHAT_V2_HEADLESS: '1', CHAT_V2_QUIT_TEST: mode }
    delete env.ELECTRON_RUN_AS_NODE
    const app = spawn(electron as unknown as string, [root, `--user-data-dir=${data}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let child = 0
    let quitAt = 0
    const fail = (why: string) => {
      app.kill('SIGKILL')
      if (child && alive(child)) process.kill(child, 'SIGKILL')
      reject(new Error(`${mode}: ${why}\n--- app output ---\n${output}`))
    }
    const startLimit = setTimeout(() => fail('never got as far as quitting'), 60_000)
    let quitLimit: ReturnType<typeof setTimeout> | null = null
    const read = (chunk: Buffer) => {
      output += chunk.toString()
      const pid = /\[quit-test\] child (\d+)/.exec(output)
      if (pid) child = Number(pid[1])
      if (!quitAt && output.includes('[quit-test] quitting')) {
        quitAt = performance.now()
        clearTimeout(startLimit)
        quitLimit = setTimeout(() => fail(`still running ${LIMITS[mode]} ms after app.quit()`), LIMITS[mode])
      }
    }
    app.stdout.on('data', read)
    app.stderr.on('data', read)
    app.on('exit', async (code, signal) => {
      clearTimeout(startLimit)
      if (quitLimit) clearTimeout(quitLimit)
      if (!quitAt) return fail(`exited before quitting (code ${code}, signal ${signal})`)
      const ms = Math.round(performance.now() - quitAt)
      if (!child) return fail('never reported its helper process')
      // The helper is killed on the way out; give the OS a moment to reap it.
      for (let i = 0; i < 20 && alive(child); i++) await new Promise((r) => setTimeout(r, 50))
      if (alive(child)) return fail(`its helper process ${child} outlived it`)
      const steps = output.split('\n').filter((l) => l.startsWith('[quit]'))
      console.log(`${mode}: exited ${ms} ms after app.quit() (code ${code}), helper gone\n  ${steps.join('\n  ')}`)
      try {
        rmSync(data, { recursive: true, force: true })
      } catch {}
      resolve()
    })
  })

await run('normal')
await run('hang')
console.log('Quit smoke passed.')
