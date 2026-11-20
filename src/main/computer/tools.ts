import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { Cause, Effect } from 'effect'
import { z } from 'zod'
import type { ComputerDoing } from '@shared/computer'
import type { Step } from '@shared/steps'
import { ControlError, type Control } from './control'
import type { Interaction, Owner } from './interaction'
import type { ScreenRect, UiElement } from './platform/types'

type CallToolResult = Awaited<ReturnType<Parameters<typeof tool>[3]>>

export type Mode = 'do' | 'teach'

export interface ToolDeps {
  readonly control: Control
  readonly interaction: Interaction
  /** The reply these tools run in. */
  readonly owner: Owner
  readonly setActing: (on: boolean) => void
  readonly remember: (fact: string) => Promise<void>
  /** Shows a finished step in the reply. */
  readonly step: (step: Step) => void
  /** Shows the tool running now in the reply's step list (null once it ends). */
  readonly doing: (doing: ComputerDoing | null) => void
  /** The reply's mode now; the user can switch it mid-reply. */
  readonly mode: () => Mode
  /** Aborted when the reply ends. */
  readonly signal: AbortSignal
  /** Counts a tool call; false once the reply has made too many. */
  readonly count: () => boolean
}

export const SERVER = 'computer'
const SAFE = ['look_at_screen', 'ui_elements', 'list_windows', 'find_files', 'reveal_file', 'wait', 'teach_step', 'clear_highlight', 'ask_approval', 'remember'] as const
const ACT = ['click', 'type_text', 'press_keys', 'scroll', 'drag', 'open', 'focus_window'] as const

export const SAFE_TOOLS = new Set<string>(SAFE.map((n) => `mcp__${SERVER}__${n}`))
export const ACT_TOOLS = new Set<string>(ACT.map((n) => `mcp__${SERVER}__${n}`))

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) })

/** What every tool answers once the user has stopped the reply. */
export const STOPPED_TEXT = "The user stopped this task. Don't continue it and don't reply; wait for their next request."
/** A runaway reply is stopped after this many tool calls. */
export const MAX_TASK_TOOLS = 80
export const TOO_MANY_TEXT = `Stopped after ${MAX_TASK_TOOLS} steps on one request. Tell the user briefly where you got to and ask how to continue.`

export const UI_DEFAULT = 80
const UI_SCAN = 400

/**
 * The compact control list the model reads: one short line per element with its centre in
 * screenshot pixels. `filter` keeps elements whose name has every word in it.
 */
export const formatElements = (
  elements: ReadonlyArray<UiElement>,
  toImage: (r: ScreenRect) => ScreenRect | null,
  opts: { filter?: string | undefined; max: number }
): { lines: string[]; total: number } => {
  const words = (opts.filter ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const hits = words.length ? elements.filter((e) => words.every((w) => e.name.toLowerCase().includes(w))) : elements
  const lines = hits.slice(0, opts.max).map((e) => {
    const r = toImage(e)
    const name = e.name.length > 60 ? `${e.name.slice(0, 60)}…` : e.name
    const at = r ? ` ${Math.round(r.x + r.width / 2)},${Math.round(r.y + r.height / 2)}` : ''
    return `${e.id} ${e.type}${name ? ` "${name}"` : ''}${at}${e.disabled ? ' disabled' : ''}`
  })
  return { lines, total: hits.length }
}

/** Completes when the reply ends. */
const whenAborted = (signal: AbortSignal): Effect.Effect<void> =>
  signal.aborted
    ? Effect.void
    : Effect.callback<void>((resume) => {
        const on = () => resume(Effect.void)
        signal.addEventListener('abort', on, { once: true })
        return Effect.sync(() => signal.removeEventListener('abort', on))
      })

/** What the model is told the first time a tool returns after the user switched the mode mid-reply. */
export const MODE_SWITCHED: Record<Mode, string> = {
  do: 'The user switched to do mode: from now on, do the rest yourself instead of showing them.',
  teach: "The user switched to show-me mode: from now on, don't act for them; guide them with teach_step."
}

/** How often a waiting Show-me step re-reads where its control is. */
export const FOLLOW_MS = 1000
/** A control that moved or resized by more than this (input pixels) moves the spotlight. */
const FOLLOW_PX = 2

const movedRect = (a: ScreenRect, b: ScreenRect) =>
  Math.abs(a.x - b.x) > FOLLOW_PX || Math.abs(a.y - b.y) > FOLLOW_PX || Math.abs(a.width - b.width) > FOLLOW_PX || Math.abs(a.height - b.height) > FOLLOW_PX

/** The computer tools, as definitions (tests call their handlers directly). */
export const toolDefs = (d: ToolDeps) => {
  /** The mode the model last heard of; a switch since is told with the next tool result. */
  let told = d.mode()
  const withModeNote = (r: CallToolResult): CallToolResult => {
    const now = d.mode()
    if (now === told) return r
    told = now
    return { ...r, content: [...r.content, { type: 'text', text: MODE_SWITCHED[now] }] }
  }

  /**
   * Run one tool's effect and show it as a step in the reply: live while it runs (`live` is the
   * line quiet tools show then; false for none), then as a finished step. Once the user stops the
   * reply, a tool that hasn't started does nothing, and one that is running (a typing run, a slow
   * control read, a wait, an approval) is cut off.
   */
  const run = (
    name: string,
    label: string,
    detail: string,
    eff: Effect.Effect<CallToolResult, { readonly _tag: string; readonly message?: string }>,
    opts: { acting?: boolean; quiet?: boolean; live?: string | false; detail?: () => string; outcome?: () => 'denied' | null } = {}
  ): Promise<CallToolResult> => {
    if (d.control.stopped() || d.signal.aborted) return Promise.resolve(text(STOPPED_TEXT, true))
    if (!d.count()) return Promise.resolve(text(TOO_MANY_TEXT, true))
    if (opts.live !== false)
      d.doing(opts.quiet ? { label: opts.live ?? label, quiet: true } : { label, ...(detail ? { detail } : {}), quiet: false })
    let marked = false
    const mark = (ok: boolean) => {
      if (opts.quiet || marked) return
      marked = true
      const shown = opts.detail?.() ?? detail
      const step: Step = { tool: `computer_${name}`, label, ok, ...(shown ? { detail: shown } : {}) }
      // The user said no: shown neutrally, not as a failure.
      d.step(ok && opts.outcome?.() === 'denied' ? { ...step, label: 'Denied', denied: true } : step)
    }
    if (opts.acting) d.setActing(true)
    const stopped = Effect.sync(() => {
      mark(false)
      return text(STOPPED_TEXT, true)
    })
    return Effect.runPromise(
      eff.pipe(
        Effect.map((r) => {
          mark(!r.isError)
          return withModeNote(r)
        }),
        Effect.catch((e) =>
          Effect.sync(() => {
            mark(false)
            if (e._tag === 'Stopped') return text(STOPPED_TEXT, true)
            if (e._tag === 'UserTookOver') {
              d.setActing(false)
              return text(
                "The user just moved the mouse: they have taken over. Stop acting now. Say briefly that you've paused and wait for them to tell you to continue.",
                true
              )
            }
            return text(e.message ?? String(e), true)
          })
        ),
        Effect.raceFirst(Effect.andThen(d.control.whenStopped, stopped)),
        Effect.raceFirst(Effect.andThen(whenAborted(d.signal), stopped)),
        // A bug in a tool must reach the model as an error it can work around, not hang or crash the reply.
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            mark(false)
            const e = Cause.squash(cause)
            return text(`That failed unexpectedly: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300), true)
          })
        ),
        // The live line goes once the tool is over (after its finished step, which replaces it).
        Effect.ensuring(Effect.sync(() => d.doing(null)))
      )
    )
  }

  const toScreenRect = (r: { x: number; y: number; width?: number | undefined; height?: number | undefined }) => {
    const w = r.width ?? 36
    const h = r.height ?? 36
    return d.control.rectToScreen({ x: r.width ? r.x : r.x - w / 2, y: r.height ? r.y : r.y - h / 2, width: w, height: h })
  }

  /** A pixel target: snap to the real control under the point, else a box centred on it. */
  const pointTarget = (x: number, y: number, width?: number, height?: number) =>
    d.control
      .elementAtImagePoint(x, y)
      .pipe(
        Effect.flatMap(({ rect }) =>
          rect
            ? Effect.succeed({ rect, snapped: true })
            : toScreenRect({ x: x - (width ?? 36) / 2, y: y - (height ?? 36) / 2, width: width ?? 36, height: height ?? 36 }).pipe(
                Effect.map((rect) => ({ rect, snapped: false }))
              )
        )
      )

  /**
   * While a Show-me step waits, its spotlight follows the control: about once a second it reads
   * the control's rect again (by element id, or the control now at the middle of a snapped one)
   * and moves the spotlight if the control moved. A failed read keeps the spotlight where it is.
   */
  const follow = (reread: (last: ScreenRect) => Effect.Effect<ScreenRect | null, ControlError>, first: ScreenRect): Effect.Effect<never> =>
    Effect.gen(function* () {
      let last = first
      let id: string | undefined
      for (;;) {
        yield* Effect.sleep(FOLLOW_MS)
        id ??= d.interaction.teachTarget()?.id
        if (!id) continue
        const r = yield* reread(last).pipe(Effect.orElseSucceed(() => null))
        if (!r || r.width <= 0 || r.height <= 0 || !movedRect(last, r)) continue
        if (!(yield* d.interaction.moveTeach(id, r))) continue
        last = r
      }
    })

  const describe = (id: number) => {
    const n = d.control.elementName(id)
    return n ? `“${n.length > 40 ? `${n.slice(0, 40)}…` : n}”` : `element ${id}`
  }

  return [
    tool(
      'look_at_screen',
      "Take a screenshot of the screen the user is working on (chat-v2's own windows are left out on Windows and macOS). Call this first in any task that involves the screen, and again after anything that changes it. Coordinates you pass to the other computer tools are pixels in the latest screenshot.",
      {},
      () =>
        run(
          'look_at_screen',
          'Look at screen',
          '',
          d.control.screenshot().pipe(
            Effect.map(
              (s): CallToolResult => ({
                content: [
                  { type: 'image', data: s.data, mimeType: s.mime },
                  {
                    type: 'text',
                    text: `Screenshot ${s.imageWidth}x${s.imageHeight}px. Active window: "${s.window.title}" (${s.window.process})${s.window.blocked ? ' — runs as administrator; input to it is blocked' : ''}. Coordinates you give are pixels in this image.`
                  }
                ]
              })
            )
          ),
          { quiet: true, live: 'Looking at the screen' }
        ),
      { searchHint: 'screenshot see view screen desktop what is on screen computer' }
    ),

    tool(
      'ui_elements',
      'List the controls (buttons, fields, menu items, tabs, list items, labels) in the active window of the user\'s computer: id, type, name and centre in screenshot pixels. Prefer clicking and teaching by element id. Pass name to find specific controls instead of reading the whole list.',
      {
        name: z.string().optional().describe('Only controls whose name contains these words, e.g. "save"'),
        max: z.number().int().min(10).max(300).optional().describe(`Max elements, default ${UI_DEFAULT}`)
      },
      ({ name, max }) =>
        run(
          'ui_elements',
          'Read controls',
          name ?? '',
          Effect.gen(function* () {
            const limit = max ?? UI_DEFAULT
            const t = yield* d.control.uiTree(name ? UI_SCAN : limit)
            const { lines, total } = formatElements(t.elements, d.control.rectToImage, { filter: name, max: limit })
            const head = `Window "${t.window.title}" (${t.window.process})`
            if (!lines.length) return text(name ? `${head}: no control named like "${name}".` : `${head}: no controls found.`)
            const more = total > lines.length ? ` (first ${lines.length} of ${total}; pass name to narrow)` : ''
            return text(`${head}${more}:\n${lines.join('\n')}`)
          }),
          { quiet: true, live: name ? `Looking for “${name}”` : 'Reading the controls' }
        ),
      { searchHint: 'accessibility tree buttons controls elements find button by name ui automation' }
    ),

    tool(
      'list_windows',
      'List the open top-level windows on the user\'s computer (title and app).',
      {},
      () =>
        run(
          'list_windows',
          'List windows',
          '',
          d.control
            .windows()
            .pipe(Effect.map((ws) => text(ws.map((w) => `"${w.title}" — ${w.process}${w.minimized ? ' (minimized)' : ''}`).join('\n') || 'No windows.'))),
          { quiet: true, live: 'Listing the windows' }
        ),
      { searchHint: 'open windows apps running programs taskbar switch' }
    ),

    tool(
      'find_files',
      "Search the user's files and folders with the system search index (Windows Search or Spotlight; a scan of the home folder on Linux). Give at least one of name / contains / extensions. Name the results that matter in your reply.",
      {
        name: z.string().optional().describe('Words in the file or folder name'),
        contains: z.string().optional().describe('Words inside the document'),
        extensions: z.array(z.string()).optional().describe('e.g. ["pdf","docx"]'),
        kind: z.enum(['file', 'folder', 'any']).optional(),
        modified_within_days: z.number().optional(),
        limit: z.number().int().min(1).max(60).optional()
      },
      (a) =>
        run(
          'find_files',
          'Search files',
          [a.name, a.contains && `“${a.contains}”`, a.extensions?.join(', ')].filter(Boolean).join(' · '),
          Effect.gen(function* () {
            const hits = yield* d.control.search({
              name: a.name,
              contains: a.contains,
              extensions: a.extensions,
              kind: a.kind,
              modifiedWithinDays: a.modified_within_days,
              limit: a.limit ?? 25
            })
            if (!hits.length) return text('No matches in the search index.')
            return text(
              hits.map((h, i) => `${i + 1}. ${h.name} (${h.kind}) — ${h.path}${h.modified ? ` — modified ${h.modified.slice(0, 10)}` : ''}`).join('\n')
            )
          })
        ),
      { searchHint: 'find search locate files folders documents recent pdf spotlight windows search' }
    ),

    tool(
      'reveal_file',
      'Show a file or folder selected in the system file manager (Explorer or Finder).',
      { path: z.string() },
      ({ path }) => run('reveal_file', 'Reveal', path, d.control.reveal(path).pipe(Effect.as(text('Revealed.')))),
      { searchHint: 'show in folder explorer finder reveal file location' }
    ),

    tool(
      'click',
      "Click in the active app on the user's computer. Give an element id from ui_elements (preferred), or x/y pixels in the latest screenshot.",
      {
        element: z.number().int().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        button: z.enum(['left', 'right', 'middle']).optional(),
        double: z.boolean().optional()
      },
      (a) =>
        run(
          'click',
          a.double ? 'Double-click' : a.button === 'right' ? 'Right-click' : 'Click',
          a.element != null ? describe(a.element) : `${Math.round(a.x ?? 0)}, ${Math.round(a.y ?? 0)}`,
          Effect.gen(function* () {
            const button = a.button ?? 'left'
            const count = a.double ? 2 : 1
            if (a.element != null) {
              if (button === 'left' && count === 1) {
                const how = yield* d.control.invoke(a.element)
                return text(`Done (${how}).`)
              }
              const r = yield* d.control.elementRect(a.element)
              yield* d.control.click(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2), button, count)
              return text('Clicked.')
            }
            if (a.x == null || a.y == null) return text('Give an element id or x and y.', true)
            const p = yield* d.control.toScreen(a.x, a.y)
            yield* d.control.click(p.x, p.y, button, count)
            return text('Clicked.')
          }),
          { acting: true }
        ),
      { searchHint: 'click press button mouse double-click right-click desktop app' }
    ),

    tool(
      'type_text',
      'Type text into the focused field of the active app, or into an element by id. Set submit to press Enter afterwards.',
      { text: z.string(), element: z.number().int().optional(), submit: z.boolean().optional() },
      (a) =>
        run(
          'type_text',
          'Type',
          (a.text.length > 48 ? `${a.text.slice(0, 48)}…` : a.text) + (a.element != null ? ` → ${describe(a.element)}` : ''),
          Effect.gen(function* () {
            if (a.element != null) {
              const how = yield* d.control.setValue(a.element, a.text)
              // A value set through UI Automation doesn't move focus: put it in the field before Enter.
              if (a.submit && how === 'set') {
                const r = yield* d.control.elementRect(a.element)
                yield* d.control.click(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2), 'left', 1)
              }
            } else yield* d.control.type(a.text)
            if (a.submit) yield* d.control.keys('enter')
            return text(a.submit ? 'Typed and pressed Enter.' : 'Typed.')
          }),
          { acting: true }
        ),
      { searchHint: 'type text keyboard enter write into field input desktop app' }
    ),

    tool(
      'press_keys',
      'Press a key or chord in the active app, e.g. "enter", "ctrl+s", "alt+tab", "win+d".',
      { combo: z.string() },
      ({ combo }) => run('press_keys', 'Press', combo, d.control.keys(combo).pipe(Effect.as(text('Pressed.'))), { acting: true }),
      { searchHint: 'keyboard shortcut hotkey press key chord ctrl alt escape' }
    ),

    tool(
      'scroll',
      'Scroll at a point in the latest screenshot. Positive amount scrolls down / right.',
      { x: z.number(), y: z.number(), amount: z.number().describe('Notches, e.g. 3 or -5'), horizontal: z.boolean().optional() },
      (a) =>
        run(
          'scroll',
          'Scroll',
          `${a.horizontal ? (a.amount > 0 ? 'right' : 'left') : a.amount > 0 ? 'down' : 'up'} ${Math.abs(a.amount)}`,
          Effect.gen(function* () {
            const p = yield* d.control.toScreen(a.x, a.y)
            yield* d.control.scroll(p.x, p.y, a.horizontal ? 0 : a.amount, a.horizontal ? a.amount : 0)
            return text('Scrolled.')
          }),
          { acting: true }
        ),
      { searchHint: 'scroll down up mouse wheel page desktop app' }
    ),

    tool(
      'drag',
      'Drag with the left button between two points in the latest screenshot.',
      { from_x: z.number(), from_y: z.number(), to_x: z.number(), to_y: z.number() },
      (a) =>
        run(
          'drag',
          'Drag',
          '',
          Effect.gen(function* () {
            const p1 = yield* d.control.toScreen(a.from_x, a.from_y)
            const p2 = yield* d.control.toScreen(a.to_x, a.to_y)
            yield* d.control.drag(p1.x, p1.y, p2.x, p2.y)
            return text('Dragged.')
          }),
          { acting: true }
        ),
      { searchHint: 'drag drop move slider mouse desktop' }
    ),

    tool(
      'open',
      'Open an app by name, a URL, a file or folder path, or a settings URI on the user\'s computer.',
      { target: z.string() },
      ({ target }) =>
        run('open', 'Open', target, d.control.open(target).pipe(Effect.as(text('Opened. Look at the screen once it has loaded.'))), { acting: true }),
      { searchHint: 'open launch start app program file folder url settings page' }
    ),

    tool(
      'focus_window',
      'Bring an open window to the front by part of its title or its app name.',
      { title: z.string() },
      ({ title }) =>
        run(
          'focus_window',
          'Switch to',
          title,
          d.control.focusWindow(title).pipe(Effect.map((w) => text(`Now in "${w.title}" (${w.process}).`))),
          { acting: true }
        ),
      { searchHint: 'switch to window bring to front focus activate app' }
    ),

    tool(
      'wait',
      'Wait for something on the user\'s computer to load.',
      { seconds: z.number().min(0.2).max(10) },
      ({ seconds }) => run('wait', 'Wait', `${seconds}s`, Effect.sleep(`${seconds} seconds`).pipe(Effect.as(text('Waited.'))), { quiet: true, live: 'Waiting for it to load' }),
      { searchHint: 'wait pause sleep let it load' }
    ),

    tool(
      'teach_step',
      'Show-me mode: highlight one control on screen with an instruction and wait until the user has done it (they press Done or click the control, press “Can’t find it” or “Do it for me”, or reply). Target an element id from ui_elements (most precise), or else the CENTER point of the control in the latest screenshot (x, y); the highlight snaps to the control found there.',
      {
        instruction: z.string().describe('One short action, e.g. "Click Display"'),
        step: z.number().int().min(1),
        total: z.number().int().min(1),
        element: z.number().int().optional(),
        x: z.number().optional().describe('Center of the control, screenshot pixels'),
        y: z.number().optional().describe('Center of the control, screenshot pixels'),
        width: z.number().optional().describe('Approximate control size, used only if no control is found at x,y'),
        height: z.number().optional()
      },
      (a) => {
        // What the user typed or pressed instead of Done goes into the step line.
        let after = ''
        return run(
          'teach_step',
          `Step ${a.step} of ${a.total}`,
          a.instruction,
          Effect.gen(function* () {
            d.setActing(false)
            const target =
              a.element != null
                ? { rect: yield* d.control.elementRect(a.element), snapped: true }
                : a.x != null && a.y != null
                  ? yield* pointTarget(a.x, a.y, a.width, a.height)
                  : null
            if (!target) return text('Give an element id or x/y.', true)
            const { rect } = target
            // After the user typed or pressed Done in the chat, chat-v2 is in front: bring the
            // target app back so the spotlit control isn't under the chat window.
            yield* Effect.ignore(d.control.restoreFocus())
            const element = a.element
            // The spotlight follows a control it knows (an element id, or a snapped control of
            // about the same size found again at its middle); a bare pixel box stays put.
            const near = (n: number, m: number) => Math.abs(n - m) <= Math.max(4, m / 4)
            const reread =
              element != null
                ? () => d.control.elementRect(element)
                : target.snapped
                  ? (last: ScreenRect) =>
                      d.control
                        .elementAt(Math.round(last.x + last.width / 2), Math.round(last.y + last.height / 2))
                        .pipe(Effect.map((r) => (r && near(r.width, rect.width) && near(r.height, rect.height) ? r : null)))
                  : null
            const waiting = d.interaction.teach(d.owner, { rect, instruction: a.instruction, step: a.step, total: a.total })
            const outcome = yield* reread ? Effect.raceFirst(waiting, follow(reread, rect)) : waiting
            d.control.resetTakeover()
            yield* d.interaction.clearTeach()
            switch (outcome.kind) {
              case 'done':
                return text('The user did it. Look at the screen before the next step.')
              case 'clicked':
                return text('The user clicked the highlighted control. Look at the screen before the next step.')
              case 'cant_find':
                after = "Couldn't find it"
                return text(
                  "The user pressed \"Can't find it\": they don't see that control. Look at the screen again, then point to it more precisely (say where it is) or show another way to get there (a menu, a search box, a shortcut)."
                )
              case 'hand_over':
                after = 'Handed over'
                // The mode note would repeat this.
                told = 'do'
                return text('The user pressed "Do it for me": the mode is do from now on. Do this step and the rest yourself.')
              case 'said':
                after = `You said “${outcome.text}”`
                return text(`The user said: "${outcome.text}"`)
              default:
                return text('The user stopped the lesson.')
            }
          }),
          { detail: () => (after ? `${a.instruction} · ${after}` : a.instruction) }
        )
      },
      { searchHint: 'show me teach guide highlight spotlight step tutorial how to' }
    ),

    tool(
      'clear_highlight',
      'Remove any on-screen highlight.',
      {},
      () => run('clear_highlight', 'Clear', '', d.interaction.clearTeach().pipe(Effect.as(text('Cleared.'))), { quiet: true, live: false }),
      { searchHint: 'clear remove highlight spotlight' }
    ),

    tool(
      'ask_approval',
      'Ask the user to approve an irreversible or outward-facing action right before doing it. Shows Approve / Deny in the chat and blocks until they choose.',
      {
        action: z.string().describe('One plain sentence, e.g. "Delete 3 files from Downloads"'),
        detail: z.string().describe('The exact target: file names, recipient, command')
      },
      (a) => {
        let denied = false
        return run(
          'ask_approval',
          'Approval',
          a.action,
          Effect.gen(function* () {
            d.setActing(false)
            const ok = yield* d.interaction.requestApproval(d.owner, a.action, a.detail)
            denied = !ok
            return text(ok ? 'Approved. Go ahead.' : "Denied. Don't do it; ask what they'd like instead.")
          }),
          // A denial is the user's choice, not a failure: a neutral "Denied" step.
          { outcome: () => (denied ? 'denied' : null) }
        )
      },
      { searchHint: 'approve confirm permission ask before delete send buy install' }
    ),

    tool(
      'remember',
      'Save a lasting preference or fact about the user to their memory.',
      { fact: z.string() },
      ({ fact }) =>
        run(
          'remember',
          'Remember',
          fact,
          Effect.tryPromise({
            try: () => d.remember(fact),
            catch: (e) => new ControlError({ message: `Couldn't save that: ${e instanceof Error ? e.message : String(e)}` })
          }).pipe(Effect.as(text('Saved.')))
        ),
      { searchHint: 'remember save preference fact memory about the user' }
    )
  ]
}

export const makeServer = (d: ToolDeps) => createSdkMcpServer({ name: SERVER, version: '0.1.0', tools: toolDefs(d) })
