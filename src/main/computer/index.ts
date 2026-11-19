// Computer use: the model looks at the screen, reads and drives the user's apps, finds files, and
// in Show-me mode spotlights each control and waits for the user to do it. This is the one entry
// point; the driver adds `module(ctx, { mode })` to a reply, and the chat shows `subscribe`'s
// waits (approvals and Show-me steps) and answers them with `approve` and `teachDone`.
import { Context, Effect, Layer } from 'effect'
import type { Step } from '@shared/steps'
import type { RunContext, ToolModule } from '../agent/module'
import { makeControl } from './control'
import { makeInteraction, type Owner, type TeachOutcome, type TeachTarget, type Waiting } from './interaction'
import type { Platform } from './platform/types'
import { makePolicy, builtinStep, BUILTIN_TOOLS } from './policy'
import type { Activity, OverlayPort } from './port'
import { instructions } from './prompt'
import { MAX_TASK_TOOLS, SERVER, makeServer, type Mode } from './tools'

export { supported, makePlatform } from './platform'
export { noOverlay, type Activity, type OverlayPort } from './port'
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
   * The tool set for one reply. The mode is read at every tool call. `stop` is the chat's Stop for
   * this reply, which the Stop shortcut runs.
   */
  readonly module: (ctx: RunContext, opts: { mode: () => Mode; stop?: () => void }) => ToolModule
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

const make = (o: ComputerUseOptions): ComputerUseApi => {
  const p = o.platform
  const overlay = o.overlay
  let acting: Owner | null = null
  let spot: TeachTarget | null = null
  let live = 0
  /** The label of the last step a computer reply took, for the notch. */
  let lastStep: string | null = null
  /** The chat's Stop of each computer reply running now. */
  const stops = new Set<() => void>()
  /** What the notch says while a computer reply runs. */
  const activity = (): Activity | null => {
    if (live === 0) return null
    const w = interaction.current()
    if (w?.kind === 'approval') return { text: 'Waiting for your OK', waiting: true }
    if (w?.kind === 'teach') return { text: `Your turn · Step ${w.step} of ${w.total}`, waiting: true }
    return { text: lastStep ? `Working · ${lastStep}` : 'Working', waiting: false }
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
  overlay.onDone(() => void Effect.runFork(interaction.resolveTeach({ kind: 'done' })))
  interaction.subscribe(draw)

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

  const module = (ctx: RunContext, opts: { mode: () => Mode; stop?: () => void }): ToolModule => {
    if (!control || !p) throw new Error('Computer use needs Windows, macOS, or Linux with an X11 display.')
    const owner: Owner = { sessionId: ctx.sessionId, messageId: ctx.messageId }
    let ended = false
    let calls = 0
    const stopReply = opts.stop ?? (() => {})
    const step = (s: Step) => {
      lastStep = s.label
      draw()
      void ctx.step(s).catch(() => undefined)
    }
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
