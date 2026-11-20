// A fake platform and overlay for computer-use tests: nothing touches the real mouse, keyboard or screen.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Effect, ManagedRuntime } from 'effect'
import type { Step } from '@shared/steps'
import type { RunContext, ToolModule } from '../../src/main/agent/module'
import { ComputerUse, type Mode } from '../../src/main/computer'
import type { TeachTarget } from '../../src/main/computer/interaction'
import type { Activity, OverlayAnswer, OverlayPort } from '../../src/main/computer/port'
import type { Platform } from '../../src/main/computer/platform/types'

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const until = async (f: () => boolean, ms = 1000) => {
  const t0 = Date.now()
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting')
    await sleep(5)
  }
}

export const fakePlatform = (over: Partial<Platform> = {}) => {
  const calls: string[] = []
  let cursor = { x: 0, y: 0 }
  const p: Platform = {
    name: 'windows',
    remember: async () => {
      calls.push('remember')
      return { title: 'Notepad', process: 'notepad' }
    },
    restoreFocus: async () => ({ title: 'Notepad', process: 'notepad' }),
    foreground: async () => ({ title: 'Notepad', process: 'notepad' }),
    windows: async () => [],
    focusWindow: async () => ({ title: '', process: '' }),
    // A 2048x1152 monitor captured down to 1024x576.
    screenshot: async () => ({
      data: '',
      mime: 'image/jpeg',
      imageWidth: 1024,
      imageHeight: 576,
      screen: { x: 0, y: 0, width: 2048, height: 1152 },
      window: { title: 'Notepad', process: 'notepad' }
    }),
    cursor: async () => cursor,
    click: async (x, y) => {
      calls.push(`click ${x},${y}`)
      cursor = { x, y }
    },
    drag: async () => {},
    scroll: async () => {},
    // ~4 ms a character, like the Windows host.
    type: async (t) => {
      await sleep(t.length * 4)
      calls.push(`type ${t}`)
    },
    keys: async (k) => void calls.push(`keys ${k}`),
    uiTree: async () => ({ window: { title: '', process: '' }, elements: [] }),
    invoke: async () => 'invoked',
    setValue: async (id, t) => {
      calls.push(`set ${id} ${t}`)
      return 'set'
    },
    elementRect: async () => ({ x: 100, y: 100, width: 40, height: 20 }),
    elementAt: async () => null,
    search: async () => [],
    open: async () => {},
    reveal: async () => {},
    dispose: () => {},
    ...over
  }
  return { p, calls, moveMouse: (x: number, y: number) => (cursor = { x, y }) }
}

/** An overlay that records what it was told to draw. */
export const fakeOverlay = () => {
  const shown: Array<{ acting: boolean; teach: TeachTarget | null; activity: Activity | null }> = []
  const protect: boolean[] = []
  /** Whether the Stop shortcut is held, after each change. */
  const stopKey: boolean[] = []
  let answer: ((a: OverlayAnswer) => void) | null = null
  let stop: (() => void) | null = null
  /** Whether the pointer is on the overlay's own controls. */
  let onControl = false
  const port: OverlayPort = {
    show: (acting, teach, activity) => void shown.push({ acting, teach, activity }),
    protect: (on) => void protect.push(on),
    onAnswer: (f) => void (answer = f),
    pointerOnControl: () => onControl,
    stopKey: (on) => void stopKey.push(on),
    onStopKey: (f) => void (stop = f),
    dispose: () => {}
  }
  return {
    port,
    shown,
    protect,
    stopKey,
    last: () => shown.at(-1) ?? { acting: false, teach: null, activity: null },
    /** A press on the callout, for the step it shows now (or an explicit id). */
    press: (kind: 'done' | 'cant_find' | 'hand_over', id = shown.at(-1)?.teach?.id ?? '') => answer?.({ kind, id }),
    pressDone: () => answer?.({ kind: 'done', id: shown.at(-1)?.teach?.id ?? '' }),
    /** Approve or Deny in the notch, for the approval it shows now (or an explicit id). */
    answerApproval: (ok: boolean, id = shown.at(-1)?.activity?.approval?.id ?? '') => answer?.({ kind: ok ? 'approve' : 'deny', id }),
    setOnControl: (on: boolean) => void (onControl = on),
    pressStopKey: () => stop?.()
  }
}

const open: Array<{ dispose: () => Promise<void> }> = []
export const disposeAll = async () => {
  for (const rt of open.splice(0)) await rt.dispose()
}

export const harness = async (over: Partial<Platform> = {}) => {
  const { p, calls, moveMouse } = fakePlatform(over)
  const overlay = fakeOverlay()
  const facts: string[] = []
  const rt = ManagedRuntime.make(
    ComputerUse.layer({ platform: p, overlay: overlay.port, remember: async (fact) => void facts.push(fact) })
  )
  open.push(rt)
  const cu = await rt.runPromise(ComputerUse.use((c) => Effect.succeed(c)))
  let mode: Mode = 'do'
  let seq = 0

  /** One reply: its module, the steps it showed, and an MCP client wired to its server. */
  const reply = async () => {
    const steps: Step[] = []
    const abort = new AbortController()
    const ctx: RunContext = {
      sessionId: 's1',
      messageId: `m${++seq}`,
      step: async (s) => void steps.push(s),
      attach: async () => {},
      signal: abort.signal
    }
    const mod: ToolModule = cu.module(ctx, { mode: () => mode, setMode: (m) => void (mode = m) })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await mod.server.instance.connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    /** The permission check, then the tool itself, as the CLI would run it. */
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      const perm = await mod.canUseTool!(`mcp__computer__${name}`, args, new AbortController().signal)
      if (perm?.behavior === 'deny') return { denied: perm.message }
      return rawTool(name, args)
    }
    /** The tool alone, as if the CLI skipped the permission check. */
    const rawTool = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args })
    return { mod, ctx, steps, abort, tool, rawTool, client }
  }

  return {
    cu,
    calls,
    facts,
    overlay,
    moveMouse,
    reply,
    setMode: (m: Mode) => void (mode = m),
    mode: () => mode,
    run: <A>(e: Effect.Effect<A>) => rt.runPromise(e)
  }
}

export const textOf = (r: unknown) => ((r as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join('')
