import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { HOST_CS, HOST_PS1 } from './hostSource'
import type { FileHit, Platform, ScreenRect, SearchQuery, Screenshot, UiElement, WindowInfo } from './types'

interface HostWindow {
  title: string
  process: string
  elevated?: boolean
  hostElevated?: boolean
  minimized?: boolean
}

const toWindow = (w: HostWindow): WindowInfo => ({
  title: w.title,
  process: w.process,
  ...(w.elevated && !w.hostElevated ? { blocked: true } : {})
})

/** Escape a value for a Windows Search SQL string literal. */
const sqlString = (s: string) => s.replace(/'/g, "''")
/** Strip LIKE wildcards from user words so they match literally. */
const likeWord = (s: string) => sqlString(s.replace(/[%_[\]]/g, ''))

export const buildSearchSql = (q: SearchQuery, scope = homedir()): string => {
  const where: string[] = [`SCOPE='file:${sqlString(scope.replace(/\\/g, '/'))}'`]
  for (const word of (q.name ?? '').split(/\s+/).filter(Boolean)) {
    where.push(`System.FileName LIKE '%${likeWord(word)}%'`)
  }
  if (q.contains?.trim()) where.push(`FREETEXT('${sqlString(q.contains.trim())}')`)
  const exts = (q.extensions ?? []).map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase())
  if (exts.length) where.push(`(${exts.map((e) => `System.FileExtension = '${sqlString(e)}'`).join(' OR ')})`)
  if (q.kind === 'folder') where.push(`System.ItemType = 'Directory'`)
  if (q.kind === 'file') where.push(`System.ItemType <> 'Directory'`)
  if (q.modifiedWithinDays && q.modifiedWithinDays > 0) {
    const since = new Date(Date.now() - q.modifiedWithinDays * 86_400_000)
    where.push(`System.DateModified >= '${since.toISOString().slice(0, 19).replace('T', ' ')}'`)
  }
  // Keep results human: skip dependency caches, app data, and dot-folders.
  for (const noise of ['\\node_modules\\', '\\AppData\\', '\\.', '\\$Recycle.Bin\\']) {
    where.push(`System.ItemPathDisplay NOT LIKE '%${sqlString(noise)}%'`)
  }
  const limit = Math.min(Math.max(q.limit ?? 25, 1), 100)
  return (
    `SELECT TOP ${limit} System.ItemPathDisplay, System.DateModified, System.Size, System.ItemType ` +
    `FROM SYSTEMINDEX WHERE ${where.join(' AND ')} ORDER BY System.DateModified DESC`
  )
}

// ---------------------------------------------------------------- host channel

interface HostMsg {
  ready?: boolean
  id?: number
  ok?: boolean
  result?: unknown
  error?: string
}

/**
 * The JSON-line protocol to the host. The host answers cheap queries while a slow call is still
 * running, so responses arrive out of order and are matched to their request by id.
 */
export const makeHostChannel = (write: (line: string) => void) => {
  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let markReady!: () => void
  let failReady!: (e: Error) => void
  const ready = new Promise<void>((res, rej) => {
    markReady = res
    failReady = rej
  })
  ready.catch(() => {}) // surfaced through call()
  let dead: Error | null = null

  const onLine = (raw: string) => {
    const line = raw.trim()
    if (!line) return
    let msg: HostMsg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.ready) return void markReady()
    const p = msg.id != null ? pending.get(msg.id) : undefined
    if (!p) return
    pending.delete(msg.id!)
    if (msg.ok) return void p.resolve(msg.result)
    const err = new Error(msg.error ?? 'Host error')
    if (msg.error === 'Cancelled') err.name = 'Cancelled'
    p.reject(err)
  }

  /** The host is gone: fail everything waiting. */
  const fail = (e: Error) => {
    dead = e
    failReady(e)
    for (const p of pending.values()) p.reject(e)
    pending.clear()
  }

  const call = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    await ready
    if (dead) throw dead
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  return { call, onLine, fail, pending: () => pending.size }
}

/**
 * Write host.ps1 and host.cs to a folder named by their hash and return the script's path. The
 * compiled DLL is cached in the same folder, so a new version compiles once and old ones stay
 * out of its way.
 */
export const installHost = (base = join(process.env.LOCALAPPDATA ?? tmpdir(), 'chat-v2', 'computer-host')): string => {
  const hash = createHash('sha256').update(HOST_PS1).update(HOST_CS).digest('hex').slice(0, 16)
  const dir = join(base, hash)
  const script = join(dir, 'host.ps1')
  if (!existsSync(script)) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'host.cs'), HOST_CS)
    // Last, so a half-written folder is never taken for a finished one.
    writeFileSync(script, HOST_PS1)
  }
  return script
}

/** Start host.ps1 and connect a channel to it. */
export const startHost = (script: string, ownerPid: number, onExit: () => void = () => {}, track: (p: ChildProcessWithoutNullStreams) => void = () => {}) => {
  const proc: ChildProcessWithoutNullStreams = spawn(
    'powershell.exe',
    ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ElectronPid', String(ownerPid)],
    { stdio: 'pipe', windowsHide: true }
  )
  track(proc)
  const host = makeHostChannel((line) => {
    if (!proc.stdin.destroyed) proc.stdin.write(line)
  })
  let buf = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      host.onLine(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
    }
  })
  let err = ''
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk: string) => {
    if (err.length < 4000) err += chunk
  })
  proc.stdin.on('error', () => undefined)
  proc.on('error', (e) => host.fail(new Error(`Couldn't start the Windows control host: ${e.message}`)))
  proc.on('close', (code) => {
    host.fail(new Error(`Windows control host exited (${code}). ${err.trim().slice(0, 400)}`))
    onExit()
  })
  const stop = () => {
    try {
      proc.stdin.end()
    } catch {}
    proc.kill()
  }
  return { call: host.call, stop }
}

// ---------------------------------------------------------------- platform

/**
 * Windows: a persistent PowerShell host running compiled C# (SendInput, UI Automation, Windows
 * Search). It starts on the first call, not when the app starts. `ownerPid` is chat-v2's main
 * process: its windows are never targets, and when one of them is in front the host works in
 * the app the user was in before.
 */
export const makeWindowsPlatform = (opts: { ownerPid: number; hostDir?: string; track?: (p: ChildProcessWithoutNullStreams) => void }): Platform => {
  let host: ReturnType<typeof startHost> | null = null
  const call = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (!host) {
      // A host that exited is started again on the next call.
      const h = startHost(
        installHost(opts.hostDir),
        opts.ownerPid,
        () => {
          if (host === h) host = null
        },
        opts.track
      )
      host = h
    }
    return host.call<T>(method, params)
  }

  return {
    name: 'windows',
    remember: async () => toWindow(await call<HostWindow>('remember')),
    restoreFocus: async () => toWindow(await call<HostWindow>('restoreFocus')),
    foreground: async () => toWindow(await call<HostWindow>('foreground')),
    windows: async () => (await call<HostWindow[]>('windows')).map((w) => ({ ...toWindow(w), minimized: !!w.minimized })),
    focusWindow: async (title) => toWindow(await call<HostWindow>('focusWindow', { title })),
    screenshot: async (maxWidth) => {
      const s = await call<Omit<Screenshot, 'window'> & { window: HostWindow }>('screenshot', { maxWidth })
      return { ...s, window: toWindow(s.window) }
    },
    cursor: () => call('cursor'),
    pressed: () => call<boolean>('pressed'),
    click: async (x, y, button, count) => void (await call('click', { x, y, button, count })),
    drag: async (x1, y1, x2, y2) => void (await call('drag', { x1, y1, x2, y2 })),
    scroll: async (x, y, dy, dx) => void (await call('scroll', { x, y, dy, dx })),
    type: async (text) => void (await call('type', { text })),
    keys: async (combo) => void (await call('keys', { combo })),
    uiTree: async (max) => {
      const r = await call<{ window: HostWindow; elements: UiElement[]; truncated?: boolean }>('uiTree', { max })
      return { window: toWindow(r.window), elements: r.elements, ...(r.truncated ? { truncated: true } : {}) }
    },
    invoke: (id) => call('invoke', { id }),
    setValue: (id, text) => call('setValue', { id, text }),
    elementRect: (id) => call<ScreenRect>('elementRect', { id }),
    elementAt: (x, y) => call<ScreenRect | null>('elementAt', { x: Math.round(x), y: Math.round(y) }),
    search: async (q) => {
      const rows = await call<Array<Record<string, unknown>>>('sql', { query: buildSearchSql(q) })
      return rows.map((r): FileHit => {
        const path = String(r['SYSTEM.ITEMPATHDISPLAY'] ?? '')
        const folder = r['SYSTEM.ITEMTYPE'] === 'Directory'
        return {
          path,
          name: basename(path),
          kind: folder ? 'folder' : 'file',
          ext: folder ? '' : extname(path).slice(1).toLowerCase(),
          modified: (r['SYSTEM.DATEMODIFIED'] as string | null) ?? null,
          size: folder ? null : ((r['SYSTEM.SIZE'] as number | null) ?? null)
        }
      })
    },
    open: async (target) => void (await call('open', { target })),
    reveal: async (path) => void (await call('reveal', { path })),
    // No host yet means nothing is running to cancel.
    cancel: async () => void (host ? await host.call('cancel') : undefined),
    dispose: () => {
      host?.stop()
      host = null
    }
  }
}
