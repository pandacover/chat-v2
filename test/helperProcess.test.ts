// The helper process lifecycle (src/main/helperProcess.ts): starting, failing to start, stopping,
// timing out, and quitting, against small stand-in helpers run with bun.
import { describe, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { helperProcess, killAllChildren, runCommand, runningChildren, stopAllChildren, stopChild, trackChild } from '../src/main/helperProcess'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const waitGone = async (pid: number, ms = 3000) => {
  for (let t = 0; t < ms && alive(pid); t += 50) await sleep(50)
  return !alive(pid)
}

/** A stand-in helper: says it's ready, answers `echo` and `pid`, never answers `hang`. */
const HELPER = `
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
send({ ready: true, ok: process.env.NOT_OK !== '1' })
let buf = ''
process.stdin.on('data', (c) => {
  buf += c
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const [id, op, ...rest] = buf.slice(0, i).split(' ')
    buf = buf.slice(i + 1)
    if (op === 'echo') send({ id: Number(id), ok: true, words: rest })
    if (op === 'pid') send({ id: Number(id), ok: true, pid: process.pid })
  }
})
process.env.IGNORE_EOF === '1' ? setInterval(() => {}, 1e9) : process.stdin.on('end', () => process.exit(0))
`

/**
 * Resolves once Node has seen `p` exit. Not the same moment as the OS reporting it gone (waitGone):
 * the registry counts a child as running until its 'exit' event has been delivered.
 */
const exited = (p: ChildProcess, ms = 3000) =>
  p.exitCode !== null || p.signalCode !== null
    ? Promise.resolve(true)
    : Promise.race([new Promise<boolean>((r) => p.once('exit', () => r(true))), sleep(ms).then(() => false)])

const start = (env: Record<string, string> = {}) => {
  const pids: number[] = []
  const procs: ChildProcess[] = []
  const spawnHelper = () => {
    const p = spawn(process.execPath, ['-e', HELPER], { env: { ...process.env, ...env } })
    pids.push(p.pid!)
    procs.push(p)
    return p
  }
  return { spawnHelper, pids, procs }
}

describe('helper process', () => {
  test('answers requests in one process', async () => {
    const { spawnHelper, pids } = start()
    const helper = helperProcess(spawnHelper)
    expect((await helper.request('echo', 'a', 1)).words).toEqual(['a', '1'])
    expect((await helper.request('pid')).pid).toBe(pids[0])
    expect(pids).toHaveLength(1)
    helper.close()
    expect(await waitGone(pids[0]!)).toBe(true)
  })

  test('a helper that says it cannot be used is stopped, not left running', async () => {
    const { spawnHelper, pids } = start({ NOT_OK: '1' })
    const helper = helperProcess(spawnHelper, (ready) => (ready.ok ? null : 'no permission'))
    await expect(helper.request('echo')).rejects.toThrow('no permission')
    expect(await waitGone(pids[0]!)).toBe(true)
    helper.close()
  })

  test('after repeated failed starts it stops starting new ones for a while', async () => {
    const { spawnHelper, pids } = start({ NOT_OK: '1' })
    const helper = helperProcess(spawnHelper, (ready) => (ready.ok ? null : 'no permission'), 'the helper', { maxFailedStarts: 2, retryAfterMs: 60_000 })
    await expect(helper.request('echo')).rejects.toThrow('no permission')
    await expect(helper.request('echo')).rejects.toThrow('no permission')
    await expect(helper.request('echo')).rejects.toThrow('no permission')
    expect(pids).toHaveLength(2)
    helper.close()
  })

  test('closing stops one that ignores its stdin closing, and nothing starts it again', async () => {
    const { spawnHelper, pids } = start({ IGNORE_EOF: '1' })
    const helper = helperProcess(spawnHelper, () => null, 'the helper')
    await helper.request('echo')
    helper.close()
    expect(await waitGone(pids[0]!)).toBe(true)
    await expect(helper.request('echo')).rejects.toThrow('the helper was closed')
    expect(pids).toHaveLength(1)
  })

  test('a request that gets no answer fails, the stuck helper is killed, and the next request starts a new one', async () => {
    const { spawnHelper, pids } = start({ IGNORE_EOF: '1' })
    const helper = helperProcess(spawnHelper, () => null, 'the helper', { requestTimeoutMs: 300 })
    await expect(helper.request('hang')).rejects.toThrow('the helper did not answer within 300 ms')
    expect(await waitGone(pids[0]!)).toBe(true)
    expect((await helper.request('pid')).pid).toBe(pids[1])
    helper.close()
  })

  test("an old process exiting doesn't fail the new process's requests", async () => {
    const { spawnHelper, pids } = start({ IGNORE_EOF: '1' })
    const helper = helperProcess(spawnHelper, () => null, 'the helper', { requestTimeoutMs: 200 })
    await expect(helper.request('hang')).rejects.toThrow('did not answer')
    // The first one is still being stopped (SIGTERM after a grace period) while the second works.
    const answer = helper.request('echo', 'still')
    expect((await answer).words).toEqual(['still'])
    expect(await waitGone(pids[0]!)).toBe(true)
    helper.close()
  })

  test('quitting closes every helper and stops every tracked child, even ones ignoring stdin', async () => {
    const { spawnHelper, procs } = start({ IGNORE_EOF: '1' })
    const helper = helperProcess(spawnHelper, () => null, 'the helper')
    await helper.request('echo')
    const stray = trackChild(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)']))
    // The count is for the whole process: children of earlier tests may still be on their way out.
    const before = runningChildren()
    expect(before).toBeGreaterThanOrEqual(2)
    stopAllChildren()
    await expect(helper.request('echo')).rejects.toThrow('was closed')
    expect(await exited(procs[0]!)).toBe(true)
    expect(await exited(stray)).toBe(true)
    expect(runningChildren()).toBeLessThanOrEqual(before - 2)
  })

  test('the exit backstop kills every tracked child at once', async () => {
    const child = trackChild(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)']))
    await sleep(100)
    // Synchronous, for process 'exit': no grace period.
    killAllChildren()
    expect(await waitGone(child.pid!, 1000)).toBe(true)
  })

  test('stopChild on one already gone does nothing', async () => {
    const p = spawn(process.execPath, ['-e', ''])
    await new Promise((r) => p.once('exit', r))
    expect(() => stopChild(p)).not.toThrow()
  })

  test('runCommand still returns the output', async () => {
    expect((await runCommand(process.execPath, ['-e', 'process.stdout.write("hi")'])).trim()).toBe('hi')
  })
})
