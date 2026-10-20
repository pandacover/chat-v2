import { type ChildProcess, type ChildProcessWithoutNullStreams, execFile } from 'node:child_process'

// A long-lived helper process for computer use that answers one request per line. Requests are
// `<id> <op> <words...>`; replies are one JSON object per line, {"id":1,"ok":true,...} or
// {"id":1,"ok":false,"error":"..."}, after a first {"ready":true,...} line.

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }

export interface HelperProcess {
  request(...words: Array<string | number>): Promise<Record<string, unknown>>
  /** Stops the helper for good: it is asked to exit, then killed, and never started again. */
  close(): void
}

export interface HelperOptions {
  /**
   * A request unanswered for this long fails, and the helper is killed (it answers in order, so
   * everything after it would wait too); the next request starts a new one.
   */
  requestTimeoutMs?: number
  /** After this many starts in a row fail, requests fail without starting it for `retryAfterMs`. */
  maxFailedStarts?: number
  retryAfterMs?: number
}

/** Long enough for the slowest request (typing a long text a key at a time). */
export const HELPER_REQUEST_TIMEOUT_MS = 90_000
const MAX_FAILED_STARTS = 3
const RETRY_AFTER_MS = 60_000
/** How long a helper whose stdin was closed gets to exit before SIGTERM, and then SIGKILL. */
const EXIT_GRACE_MS = 500
const TERM_GRACE_MS = 1000

// Every child process the app starts (helpers and one-off commands), so quitting can stop them all.
const children = new Set<ChildProcess>()
const helpers = new Set<HelperProcess>()

const alive = (p: ChildProcess) => p.exitCode === null && p.signalCode === null

/** Keeps `p` in the registry until it exits. */
export const trackChild = <P extends ChildProcess>(p: P): P => {
  children.add(p)
  const forget = () => children.delete(p)
  p.once('exit', forget)
  p.once('error', () => {
    if (!alive(p) || p.pid === undefined) forget()
  })
  return p
}

/** Asks `p` to exit (closes its stdin), then sends SIGTERM, then SIGKILL, until it has. */
export const stopChild = (p: ChildProcess) => {
  if (!alive(p)) return
  try {
    p.stdin?.end()
  } catch {}
  const kill = (signal: NodeJS.Signals) => {
    if (!alive(p)) return false
    try {
      p.kill(signal)
    } catch {}
    return true
  }
  setTimeout(() => {
    if (kill('SIGTERM')) setTimeout(() => kill('SIGKILL'), TERM_GRACE_MS).unref()
  }, EXIT_GRACE_MS).unref()
}

/** Quitting: closes every helper (nothing restarts them) and asks every other child to exit. */
export const stopAllChildren = () => {
  for (const h of helpers) h.close()
  for (const p of children) stopChild(p)
}

/** The last resort on exit: SIGKILL whatever is still running. Synchronous, for process 'exit'. */
export const killAllChildren = () => {
  for (const p of children) {
    if (!alive(p)) continue
    try {
      p.kill('SIGKILL')
    } catch {}
  }
  children.clear()
}

/** How many child processes are running now (for tests and the quit log). */
export const runningChildren = () => [...children].filter(alive).length

/**
 * Starts the helper on first use, and again if it dies. `checkReady` sees the ready line and
 * returns why the helper can't be used, or null. `name` is what errors call it.
 */
export const helperProcess = (
  spawnHelper: () => ChildProcessWithoutNullStreams,
  checkReady: (ready: Record<string, unknown>) => string | null = () => null,
  name = 'the input helper',
  options: HelperOptions = {}
): HelperProcess => {
  const requestTimeoutMs = options.requestTimeoutMs ?? HELPER_REQUEST_TIMEOUT_MS
  const maxFailedStarts = options.maxFailedStarts ?? MAX_FAILED_STARTS
  const retryAfterMs = options.retryAfterMs ?? RETRY_AFTER_MS

  /** The running helper: its process, its ready line, and the requests it still owes. */
  type Running = { p: ChildProcessWithoutNullStreams; ready: Promise<void>; pending: Map<number, Pending> }
  let current: Running | null = null
  let closed = false
  let nextId = 1
  let failedStarts = 0
  let lastFailure: { at: number; error: Error } | null = null

  const failStart = (error: Error) => {
    failedStarts++
    lastFailure = { at: Date.now(), error }
  }

  const start = (): Running => {
    const p = trackChild(spawnHelper())
    const pending = new Map<number, Pending>()
    let buffer = ''
    let errors = ''
    let started = false
    const failAll = (error: Error) => {
      for (const waiter of pending.values()) waiter.reject(error)
      pending.clear()
    }
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name} did not start`)), 20000)
      p.stdout.setEncoding('utf8')
      p.stdout.on('data', (chunk: string) => {
        buffer += chunk
        let i: number
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i).trim()
          buffer = buffer.slice(i + 1)
          if (!line.startsWith('{')) continue
          let msg: Record<string, unknown>
          try {
            msg = JSON.parse(line) as Record<string, unknown>
          } catch {
            continue
          }
          if (msg.ready) {
            clearTimeout(timer)
            const problem = checkReady(msg)
            if (problem) reject(new Error(problem))
            else {
              started = true
              failedStarts = 0
              resolve()
            }
            continue
          }
          const waiter = pending.get(msg.id as number)
          if (!waiter) continue
          pending.delete(msg.id as number)
          if (msg.ok) waiter.resolve(msg)
          else waiter.reject(new Error(String(msg.error)))
        }
      })
      p.stderr.on('data', (chunk: Buffer) => (errors = (errors + chunk.toString()).slice(-2000)))
      // Writing to one that just died fails with EPIPE; its exit fails the requests.
      p.stdin.on('error', () => {})
      // One that can't be started at all (a missing binary) fails its requests instead of throwing.
      p.on('error', (e) => {
        clearTimeout(timer)
        if (current?.p === p) current = null
        const error = new Error(`${name} could not start: ${e.message}`)
        reject(error)
        failAll(error)
      })
      p.on('exit', (_code, signal) => {
        clearTimeout(timer)
        if (current?.p === p) current = null
        // Lines starting "at: " are the helper noting each step; the rest are its errors.
        const lines = errors.split('\n').map((l) => l.trim()).filter(Boolean)
        const step = lines.filter((l) => l.startsWith('at: ')).pop()?.slice(4)
        const said = lines.find((l) => !l.startsWith('at: '))
        const error = closed
          ? new Error(`${name} was closed`)
          : new Error(
              signal
                ? `${name} crashed (${signal})${step ? ` while ${step}` : ''}`
                : `${name} stopped${said ? `: ${said}` : step ? ` while ${step}` : ''}`
            )
        reject(error)
        failAll(error)
      })
    })
    // A failed start is retried on the next request rather than kept, and the process that
    // failed (still running when it said it can't be used, or never said it was ready) is stopped.
    ready.catch((e: unknown) => {
      if (!started) failStart(e instanceof Error ? e : new Error(String(e)))
      if (current?.p === p) current = null
      stopChild(p)
    })
    return { p, ready, pending }
  }

  const helper: HelperProcess = {
    request: async (...words) => {
      if (closed) throw new Error(`${name} was closed`)
      if (!current) {
        if (lastFailure && failedStarts >= maxFailedStarts && Date.now() - lastFailure.at < retryAfterMs) throw lastFailure.error
        current = start()
      }
      const run = current
      await run.ready
      if (closed) throw new Error(`${name} was closed`)
      // Died since it started: its exit already failed what it owed; don't wait out the timeout.
      if (!alive(run.p)) {
        if (current === run) current = null
        throw new Error(`${name} stopped`)
      }
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!run.pending.delete(id)) return
          reject(new Error(`${name} did not answer within ${requestTimeoutMs < 1000 ? `${requestTimeoutMs} ms` : `${Math.round(requestTimeoutMs / 1000)} s`}`))
          // Stuck: everything after this request would wait on it too. The next request starts another.
          if (current === run) current = null
          stopChild(run.p)
        }, requestTimeoutMs)
        const done = () => clearTimeout(timer)
        run.pending.set(id, {
          resolve: (v) => (done(), resolve(v)),
          reject: (e) => (done(), reject(e))
        })
        run.p.stdin.write(`${id} ${words.join(' ')}\n`)
      })
    },
    close: () => {
      closed = true
      helpers.delete(helper)
      const run = current
      current = null
      if (run) stopChild(run.p)
    }
  }
  helpers.add(helper)
  return helper
}

/** Runs a command to completion and returns its output. */
export const runCommand = (command: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    trackChild(
      execFile(command, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 30000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
    )
  })
