// Computer use: the model looks at the screen, reads and drives the user's apps, finds files, and
// in Show-me mode spotlights each control and waits for the user to do it. This is the one entry
// point; the driver adds `module(ctx, { mode })` to a reply, and the chat shows `subscribe`'s
// waits (approvals and Show-me steps) and answers them with `approve` and `teachDone`.
import { Context, Effect, Layer } from 'effect'
import { APPROVE_ARM_MS, type ComputerDoing } from '@shared/computer'
import { type Step, stepText } from '@shared/steps'
import type { RunContext, ToolModule } from '../agent/module'
import { makeControl } from './control'
import { makeInteraction, type Owner, type TeachOutcome, type TeachTarget, type Waiting } from './interaction'
import type { Platform } from './platform/types'
import { makePolicy, builtinStep, BUILTIN_TOOLS } from './policy'
import type { Activity, OverlayPort } from './port'
import { instructions } from './prompt'
import { MAX_TASK_TOOLS, SERVER, makeServer, type Mode } from './tools'

export { supported, makePlatform } from './platform'
export { noOverlay, type Activity, type OverlayAnswer, type OverlayPort } from './port'
export { builtinStep, isReadOnlyCommand, BUILTIN_TOOLS } from './policy'
export { modeTag, teachAnswer } from './prompt'
export { decideMode, handsOver } from './intent'
export { MAX_TASK_TOOLS, STOPPED_TEXT, type Mode } from './tools'
export type { Waiting, TeachOutcome } from './interaction'
export type { Platform } from './platform/types'

/** Fast models think little on each click-and-look step; the thorough one a bit more. */
export const effortFor = (model: string): 'low' | 'medium' => (/haiku|sonnet/i.test(model) ? 'low' : 'medium')

export interface ComputerUseApi {
  /** False where computer use can't run (e.g. Linux on Wayland), or when the layer was built without a platform. */
  readonly supported: boolean
  /**
   * The tool set for one reply. The mode is read at every tool call; `setMode` switches it (the
   * overlay's "Do it for me"). `stop` is the chat's Stop for this reply, which the Stop shortcut runs.
   */
  readonly module: (ctx: RunContext, opts: { mode: () => Mode; setMode?: (mode: Mode) => void; stop?: () => void }) => ToolModule
  /** Called with the computer tool each reply runs now, live (null once it ends); returns a function that stops listening. */
  readonly onDoing: (listener: (e: { sessionId: string; messageId: string; doing: ComputerDoing | null }) => void) => () => void
  /** Cuts off input in progress and releases every wait. Input stays off until `userTurn`. The chat's Stop runs it. */
  readonly stop: Effect.Effect<void>
  /**
   * A new user message (a new reply, or steering one that runs): input is allowed again, the
   * takeover check starts afresh, and the app the user was in is remembered. `module` calls it too.
   */
  readonly userTurn: Effect.Effect<void>
  /** What computer use is waiting on the human for right now. */
  readonly waiting: () => Waiting
  /** Called with every change of `waiting`; returns a function that stops listening. */
  readonly subscribe: (listener: (waiting: Waiting) => void) => () => void
  /** Answers the approval `id`; an id that is no longer waiting is ignored. */
  readonly approve: (id: string, approved: boolean) => Effect.Effect<void>
  /** Ends the Show-me step `id`: done (the default), or what the user typed instead. */
  readonly teachDone: (id: string, outcome?: Exclude<TeachOutcome, { kind: 'stopped' }>) => Effect.Effect<void>
}

export interface ComputerUseOptions {
  /** The real platform (`makePlatform()`), a fake in tests, or null where computer use isn't supported. */
  readonly platform: Platform | null
  /** The Electron overlay and Stop shortcut (`makeElectronOverlay()` from ./overlay), or `noOverlay`. */
  readonly overlay: OverlayPort
  /** Saves a fact the model was told to remember (chat-v2's memory). */
  readonly remember: (fact: string, ctx: RunContext) => Promise<void>
}

/** The notch is narrow: longer step lines are cut (it ellipsizes any remainder itself). */
const NOTCH_MAX = 60

/** Show-me steps a click on the control completes ("Click Display", "Turn on Night light"); not "Type…" or "Drag…". */
export const CLICK_STEP = /^\s*(click|double-click|right-click|tap|select|choose|pick|open|toggle|turn (on|off)|switch (on|off)|check|uncheck|tick|untick|expand)\b/i
/** How often the mouse button is read while a click step waits. */
export const CLICK_POLL_MS = 100
/** After a click inside the spotlight, the app gets this long to react before the step counts as done. */
export const CLICK_SETTLE_MS = 600
/** A click this close outside the control (input pixels) still counts: the spotlight's own padding. */
const CLICK_SLOP = 6

const make = (o: ComputerUseOptions): ComputerUseApi => {
  const p = o.platform
  const overlay = o.overlay
  let acting: Owner | null = null
  let spot: TeachTarget | null = null
  let live = 0
  /** The last step a computer reply took (what and to what), for the notch. */
  let lastStep: string | null = null
  /** The tool a computer reply runs now, for the notch (the newest, if several run). */
  let now: { messageId: string; text: string } | null = null
  /** The chat's Stop of each computer reply running now. */
  const stops = new Set<() => void>()
  /** How each running reply switches its mode, by message id. */
  const modeSetters = new Map<string, (mode: Mode) => void>()
  const doingListeners = new Set<(e: { sessionId: string; messageId: string; doing: ComputerDoing | null }) => void>()
  /** When the approval waiting now was asked; Approve from the notch only counts once it has armed. */
  let approvalAt = { id: '', at: 0 }
  /** What the notch says while a computer reply runs. */
  const activity = (): Activity | null => {
    if (live === 0) return null
    const w = interaction.current()
    if (w?.kind === 'approval') return { text: 'Needs your OK', waiting: true, approval: { id: w.id, title: w.title, detail: w.detail } }
    if (w?.kind === 'teach') return { text: `Your turn · ${stepText({ label: `Step ${w.step} of ${w.total}`, detail: w.instruction }, NOTCH_MAX)}`, waiting: true }
    const doing = now?.text ?? lastStep
    return { text: doing ? `Working · ${doing}` : 'Working', waiting: false }
  }
  const draw = () => overlay.show(acting !== null, spot, activity())
  const control = p ? makeControl(p) : null
  const interaction = makeInteraction({
    spotlight: (t) => {
      spot = t
      draw()
    },
    notActing: () => {
      acting = null
      draw()
    }
  })
  // The overlay answers a wait by its id, through the same calls as the chat's card, so both stay in step.
  overlay.onAnswer((a) => {
    if (a.kind === 'approve' || a.kind === 'deny') {
      if (a.kind === 'approve' && (approvalAt.id !== a.id || Date.now() - approvalAt.at < APPROVE_ARM_MS)) return
      void Effect.runFork(interaction.resolveApproval(a.id, a.kind === 'approve'))
      return
    }
    const w = interaction.teachWait()
    if (w?.id !== a.id) return
    // "Do it for me" is "just do it" typed: the reply may act from the next tool call on.
    if (a.kind === 'hand_over') modeSetters.get(w.messageId)?.('do')
    void Effect.runFork(interaction.resolveTeach({ kind: a.kind }, a.id))
  })
  interaction.subscribe((w) => {
    if (w?.kind === 'approval' && w.id !== approvalAt.id) approvalAt = { id: w.id, at: Date.now() }
    watchClicks()
    draw()
  })

  /**
   * A click step also ends when the user clicks inside the spotlight: the platform's button state
   * is read every CLICK_POLL_MS (Windows; no hook), and a press with the pointer on the control
   * (not on the overlay's callout) counts as done once the app has had CLICK_SETTLE_MS to react.
   */
  let clicks: { id: string; timer: ReturnType<typeof setInterval> } | null = null
  const unwatchClicks = () => {
    if (clicks) clearInterval(clicks.timer)
    clicks = null
  }
  const watchClicks = () => {
    const t = interaction.teachTarget()
    const id = t?.id && p?.pressed && CLICK_STEP.test(t.instruction) ? t.id : null
    if (id === (clicks?.id ?? null)) return
    unwatchClicks()
    if (!id || !p?.pressed) return
    const pressed = () => p.pressed!().catch(() => false)
    // A press from before the step (the "since the last read" bit) doesn't count.
    let busy = true
    void pressed().finally(() => (busy = false))
    const timer = setInterval(() => {
      if (busy) return
      busy = true
      void (async () => {
        if (!(await pressed()) || overlay.pointerOnControl?.()) return
        const c = await p.cursor()
        const r = interaction.teachTarget()
        if (r?.id !== id || clicks?.id !== id) return
        const inside =
          c.x >= r.rect.x - CLICK_SLOP && c.x < r.rect.x + r.rect.width + CLICK_SLOP && c.y >= r.rect.y - CLICK_SLOP && c.y < r.rect.y + r.rect.height + CLICK_SLOP
        if (!inside) return
        unwatchClicks()
        setTimeout(() => void Effect.runFork(interaction.resolveTeach({ kind: 'clicked' }, id)), CLICK_SETTLE_MS)
      })()
        .catch(() => undefined)
        .finally(() => (busy = false))
    }, CLICK_POLL_MS)
    timer.unref?.()
    clicks = { id, timer }
  }

  const userTurn = Effect.suspend(() => {
    if (!control) return Effect.void
    control.resetTakeover()
    control.resume()
    return control.remember().pipe(Effect.ignore)
  })

  const stop = Effect.suspend(() => {
    control?.cancel()
    acting = null
    draw()
    return interaction.cancelAll()
  })

  // The Stop shortcut stops every computer reply, as the chat's Stop would.
  overlay.onStopKey(() => {
    void Effect.runFork(stop)
    for (const f of [...stops]) f()
  })

  const module = (ctx: RunContext, opts: { mode: () => Mode; setMode?: (mode: Mode) => void; stop?: () => void }): ToolModule => {
    if (!control || !p) throw new Error('Computer use needs Windows, macOS, or Linux with an X11 display.')
    const owner: Owner = { sessionId: ctx.sessionId, messageId: ctx.messageId }
    let ended = false
    let calls = 0
    const stopReply = opts.stop ?? (() => {})
    /** The last finished step's line, saved and shown; the live line goes only after it. */
    let lastLine: Promise<void> = Promise.resolve()
    const step = (s: Step) => {
      lastStep = stepText(s, NOTCH_MAX)
      draw()
      lastLine = ctx.step(s).catch(() => undefined)
    }
    let doingSeq = 0
    let showing = false
    const doing = (d: ComputerDoing | null) => {
      const n = ++doingSeq
      const send = () => {
        // A newer tool started meanwhile: its line stays.
        if (n !== doingSeq || (!d && !showing)) return
        showing = d !== null
        if (d) now = { messageId: owner.messageId, text: stepText(d, NOTCH_MAX) }
        else if (now?.messageId === owner.messageId) now = null
        draw()
        for (const f of doingListeners) f({ ...owner, doing: d })
      }
      if (d) send()
      else void lastLine.then(send)
    }
    if (opts.setMode) modeSetters.set(owner.messageId, opts.setMode)
    const setActing = (on: boolean) => {
      if (on) acting = owner
      else if (acting === owner) acting = null
      draw()
    }
    // A runaway reply is stopped after MAX_TASK_TOOLS calls.
    const count = () => {
      if (++calls <= MAX_TASK_TOOLS) return true
      if (calls === MAX_TASK_TOOLS + 1) {
        step({ tool: 'computer_stop', label: `Stopped after ${MAX_TASK_TOOLS} steps`, ok: false })
        control.cancel()
        setActing(false)
        void Effect.runPromise(interaction.cancelAll(owner))
      }
      return false
    }
    const end = async () => {
      if (ended) return
      ended = true
      setActing(false)
      await Effect.runPromise(interaction.cancelAll(owner))
      // A spotlight left on screen by this reply goes with it.
      if (!interaction.teachPending() && spot) {
        spot = null
        draw()
      }
      stops.delete(stopReply)
      modeSetters.delete(owner.messageId)
      doing(null)
      if (--live === 0) {
        overlay.protect(false)
        overlay.stopKey(false)
        lastStep = null
      }
      draw()
    }
    if (live++ === 0) {
      overlay.protect(true)
      overlay.stopKey(true)
    }
    draw()
    stops.add(stopReply)
    // The reply's waits resolve as denied or stopped the moment it ends, even before `end` is called.
    ctx.signal.addEventListener('abort', () => void end(), { once: true })
    void Effect.runPromise(userTurn)
    return {
      name: SERVER,
      instructions: instructions(p.name),
      server: makeServer({
        control,
        interaction,
        owner,
        setActing,
        remember: (fact) => o.remember(fact, ctx),
        step,
        doing,
        mode: opts.mode,
        signal: ctx.signal,
        count
      }),
      builtins: BUILTIN_TOOLS,
      stepFor: builtinStep,
      canUseTool: makePolicy({ control, interaction, owner, mode: opts.mode, ended: () => ended || ctx.signal.aborted, count }),
      end
    }
  }

  return {
    supported: p !== null,
    module,
    stop,
    userTurn,
    waiting: interaction.current,
    subscribe: interaction.subscribe,
    onDoing: (f) => {
      doingListeners.add(f)
      return () => void doingListeners.delete(f)
    },
    approve: (id, approved) => Effect.asVoid(interaction.resolveApproval(id, approved)),
    teachDone: (id, outcome = { kind: 'done' }) => Effect.asVoid(interaction.resolveTeach(outcome, id))
  }
}

export class ComputerUse extends Context.Service<ComputerUse, ComputerUseApi>()('chat-v2/ComputerUse') {
  /** The platform's host process and the overlay window go when the layer is released. */
  static readonly layer = (o: ComputerUseOptions) =>
    Layer.effect(
      ComputerUse,
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            o.platform?.dispose()
            o.overlay.dispose()
          })
        )
        return ComputerUse.of(make(o))
      })
    )
}
