import { type ChildProcessWithoutNullStreams, execFile } from 'node:child_process'

// A long-lived helper process for computer use that answers one request per line. Requests are
// `<id> <op> <words...>`; replies are one JSON object per line, {"id":1,"ok":true,...} or
// {"id":1,"ok":false,"error":"..."}, after a first {"ready":true,...} line.

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }

export interface HelperProcess {
  request(...words: Array<string | number>): Promise<Record<string, unknown>>
  close(): void
}

/**
 * Starts the helper on first use, and again if it dies. `checkReady` sees the ready line and
 * returns why the helper can't be used, or null.
 */
export const helperProcess = (spawnHelper: () => ChildProcessWithoutNullStreams, checkReady: (ready: Record<string, unknown>) => string | null = () => null): HelperProcess => {
  let child: ChildProcessWithoutNullStreams | null = null
  let ready: Promise<void> | null = null
  let nextId = 1
  const pending = new Map<number, Pending>()

  const start = () => {
    const p = spawnHelper()
    child = p
    let buffer = ''
    let errors = ''
    ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the input helper did not start')), 20000)
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
            else resolve()
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
      p.on('exit', (_code, signal) => {
        clearTimeout(timer)
        if (child === p) child = null
        // Lines starting "at: " are the helper noting each step; the rest are its errors.
        const lines = errors.split('\n').map((l) => l.trim()).filter(Boolean)
        const step = lines.filter((l) => l.startsWith('at: ')).pop()?.slice(4)
        const said = lines.find((l) => !l.startsWith('at: '))
        const error = new Error(
          signal
            ? `the input helper crashed (${signal})${step ? ` while ${step}` : ''}`
            : `the input helper stopped${said ? `: ${said}` : step ? ` while ${step}` : ''}`
        )
        reject(error)
        for (const waiter of pending.values()) waiter.reject(error)
        pending.clear()
      })
    })
    // A failed start is retried on the next request rather than kept.
    ready.catch(() => {
      if (child === p) child = null
    })
  }

  return {
    request: async (...words) => {
      if (!child) start()
      await ready
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        child!.stdin.write(`${id} ${words.join(' ')}\n`)
      })
    },
    close: () => {
      child?.stdin.end()
      child = null
    }
  }
}

/** Runs a command to completion and returns its output. */
export const runCommand = (command: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile(command, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 30000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
  })
