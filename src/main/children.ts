import type { ChildProcess } from 'node:child_process'

// Every child process the app starts (the Claude Code processes behind replies), so quitting can
// stop them all.

/** How long a child whose stdin was closed gets to exit before SIGTERM, and then SIGKILL. */
const EXIT_GRACE_MS = 500
const TERM_GRACE_MS = 1000

const children = new Set<ChildProcess>()

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
const stopChild = (p: ChildProcess) => {
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

/** Quitting: asks every child to exit. */
export const stopAllChildren = () => {
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

/** How many child processes are running now (for the quit log). */
export const runningChildren = () => [...children].filter(alive).length
