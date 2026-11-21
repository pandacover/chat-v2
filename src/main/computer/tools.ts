import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { Cause, Effect } from 'effect'
import { z } from 'zod'
import type { ComputerDoing } from '@shared/computer'
import type { Step } from '@shared/steps'
import { ControlError, type Control } from './control'
import type { Interaction, Owner } from './interaction'
import type { FocusedControl, ScreenRect, Screenshot, UiElement, WindowInfo } from './platform/types'

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
  /**
   * Counts a tool call; false once the reply has made too many. Reads (looking, listing, waiting)
   * count separately, at a much higher cap: they only guard against a loop.
   */
  readonly count: (kind?: 'act' | 'read') => boolean
  /** How long an action's effect is given to show before the screenshot after it (default SETTLE_MS). */
  readonly settleMs?: number
  /** Takes the computer for this reply; the refusal to give the model if another chat has it. */
  readonly claim: () => string | null
}

export const SERVER = 'computer'
const SAFE = ['look_at_screen', 'ui_elements', 'list_windows', 'find_files', 'reveal_file', 'wait', 'teach_step', 'clear_highlight', 'ask_approval', 'remember'] as const
const ACT = ['click', 'type_text', 'press_keys', 'scroll', 'drag', 'move_mouse', 'open', 'focus_window'] as const

export const SAFE_TOOLS = new Set<string>(SAFE.map((n) => `mcp__${SERVER}__${n}`))
export const ACT_TOOLS = new Set<string>(ACT.map((n) => `mcp__${SERVER}__${n}`))

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) })

/** What every tool answers once the user has stopped the reply. */
export const STOPPED_TEXT = "The user stopped this task. Don't continue it and don't reply; wait for their next request."
/** A runaway reply is stopped after this many acting tool calls (clicks, typing, approvals, steps…). */
export const MAX_TASK_TOOLS = 80
/** …or this many reads (looks, control lists, window lists, searches, waits), which only guard against a loop. */
export const MAX_TASK_READS = 240
export const TOO_MANY_TEXT = `Stopped after ${MAX_TASK_TOOLS} steps on one request. Tell the user briefly where you got to and ask how to continue.`
export const TOO_MANY_READS_TEXT = `Stopped after ${MAX_TASK_READS} looks on one request. Tell the user briefly where you got to and ask how to continue.`
/** An action's effect gets this long to show before the screenshot after it. */
export const SETTLE_MS = 400

export const UI_DEFAULT = 80
const UI_SCAN = 400

/** The key names press_keys takes on each platform (see the hosts' key maps). */
const PUNCT = 'punctuation as the character (/ , . ; = - [ ] \\ \' `) or by name (slash, comma, period, semicolon, equal, minus, plus, backslash, quote, backquote, bracketleft, bracketright)'
export const KEY_NAMES: Record<'windows' | 'macos' | 'linux', string> = {
  windows: `Keys: a-z, 0-9, f1-f24, enter, tab, space, backspace, delete, esc, up, down, left, right, home, end, pageup, pagedown, insert, menu, printscreen, capslock; ${PUNCT}. Modifiers: ctrl, shift, alt, win. One chord per call.`,
  macos: `Keys: a-z, 0-9, f1-f12, enter, tab, space, backspace, delete, esc, up, down, left, right, home, end, pageup, pagedown; ${PUNCT}. Modifiers: cmd, ctrl, alt (option), shift. One chord per call.`,
  linux: `Keys: a-z, 0-9, f1-f24, enter, tab, space, backspace, delete, esc, up, down, left, right, home, end, pageup, pagedown, insert, menu, printscreen, capslock; ${PUNCT}. Modifiers: ctrl, shift, alt, super (win). Separate chords with spaces for a sequence, e.g. "ctrl+k ctrl+s".`
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** A control's state words: value="…", checked / unchecked / mixed, selected, expanded / collapsed, disabled. */
const stateOf = (e: UiElement): string => {
  const s: string[] = []
  if (e.value && e.value !== e.name) s.push(`value="${clip(e.value, 40)}"`)
  if (e.checked != null) s.push(e.checked === 'mixed' ? 'mixed' : e.checked ? 'checked' : 'unchecked')
  if (e.selected) s.push('selected')
  if (e.expanded != null) s.push(e.expanded ? 'expanded' : 'collapsed')
  if (e.disabled) s.push('disabled')
  return s.length ? ` ${s.join(' ')}` : ''
}

/**
 * The compact control list the model reads: one short line per element with its centre in
 * screenshot pixels and its state. `filter` keeps elements whose name has every word in it.
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
    const name = clip(e.name, 60)
    const at = r ? ` ${Math.round(r.x + r.width / 2)},${Math.round(r.y + r.height / 2)}` : ''
    return `${e.id} ${e.type}${name ? ` "${name}"` : ''}${at}${stateOf(e)}`
  })
  return { lines, total: hits.length }
}

/** The line that goes with a full screenshot: its size, the active window (and what it was), the pointer. */
export const shotText = (s: Screenshot, pointer: { x: number; y: number } | null, before?: WindowInfo | null): string => {
  const changed = before && (before.title !== s.window.title || before.process !== s.window.process)
  const was = changed ? `, changed from "${clip(before.title, 60)}" (${before.process})` : ''
  const blocked = s.window.blocked ? ' — runs as administrator; input to it is blocked' : ''
  const inside = pointer && pointer.x >= 0 && pointer.y >= 0 && pointer.x < s.imageWidth && pointer.y < s.imageHeight
  return `Screenshot ${s.imageWidth}x${s.imageHeight}px. Active window: "${s.window.title}" (${s.window.process})${was}${blocked}.${inside ? ` Pointer at ${pointer.x},${pointer.y}.` : ''}`
}

/** What has keyboard focus, as a short sentence. */
export const focusText = (f: FocusedControl | null): string =>
  f && (f.type || f.name) ? ` Focus: ${f.type || 'control'}${f.name ? ` "${clip(f.name, 50)}"` : ''}${f.value ? ` value="${clip(f.value, 60)}"` : ''}.` : ''

/** The text that goes with a zoomed region, with the mapping back to the full screenshot. */
export const zoomText = (z: { shot: Screenshot; area: ScreenRect; scale: number }): string => {
  const k = Math.round(z.scale * 100) / 100
  const { x, y, width, height } = z.area
  const cx = Math.round(z.shot.imageWidth / 2)
  const cy = Math.round(z.shot.imageHeight / 2)
  return (
    `Zoom of the screenshot's region x ${x}–${x + width}, y ${y}–${y + height}, at ${k}x (${z.shot.imageWidth}x${z.shot.imageHeight}px). ` +
    `Only for looking: coordinates you pass to tools stay in the full screenshot. A point (u, v) here is (${x} + u/${k}, ${y} + v/${k}) there; e.g. this image's centre ${cx},${cy} is ${Math.round(x + cx / z.scale)},${Math.round(y + cy / z.scale)}.`
  )
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
export const toolDefs = (d: ToolDeps) =>
  // Where controls can't be read (Linux), ui_elements would only ever fail: don't offer it.
  allToolDefs(d).filter((t) => d.control.controls || t.name !== 'ui_elements')

const allToolDefs = (d: ToolDeps) => {
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
    opts: {
      acting?: boolean
      quiet?: boolean
      read?: boolean
      live?: string | false
      ok?: (r: CallToolResult) => boolean
      detail?: () => string
      outcome?: () => 'denied' | null
    } = {}
  ): Promise<CallToolResult> => {
    if (d.signal.aborted) return Promise.resolve(text(STOPPED_TEXT, true))
    const busy = d.claim()
    if (busy) return Promise.resolve(text(busy, true))
    if (d.control.stopped()) return Promise.resolve(text(STOPPED_TEXT, true))
    if (!d.count(opts.read ? 'read' : 'act')) return Promise.resolve(text(opts.read ? TOO_MANY_READS_TEXT : TOO_MANY_TEXT, true))
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

  /** The pointer of a full screenshot, in its pixels (call after it became the frame). */
  const pointerIn = (s: Screenshot) => (s.cursor ? d.control.rectToImage({ ...s.cursor, width: 0, height: 0 }) : null)

  /**
   * What an acting tool answers: what it did, then (unless `look` is false) a fresh screenshot
   * after a short settle, which becomes the frame for coordinates, with the active window (and
   * whether it changed) and, for `focus`, the control that has keyboard focus.
   */
  const after = (did: string, o: { look?: boolean | undefined; focus?: boolean } = {}): Effect.Effect<CallToolResult> => {
    if (o.look === false) return Effect.succeed(text(did))
    return Effect.gen(function* () {
      const before = d.control.lastWindow()
      yield* Effect.sleep(d.settleMs ?? SETTLE_MS)
      const s = yield* d.control.screenshot().pipe(Effect.catch((e) => Effect.succeed(e)))
      const focus = o.focus ? focusText(yield* d.control.focused()) : ''
      if (s instanceof ControlError) return text(`${did}${focus} (No screenshot after it: ${s.message} Call look_at_screen.)`)
      return {
        content: [
          { type: 'text', text: `${did}${focus}` },
          { type: 'image', data: s.data, mimeType: s.mime },
          { type: 'text', text: `${shotText(s, pointerIn(s), before)} This is now the frame for coordinates.` }
        ]
      } satisfies CallToolResult
    })
  }

  const mod = d.control.platform === 'macos' ? 'cmd' : 'ctrl'
  const look = z.boolean().optional().describe('Return a screenshot taken just after (default true). Set false only when chaining quick actions you will check afterwards.')
  const pointerDrawn = d.control.platform !== 'linux'
  const zoomArea = z
    .object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })
    .describe('Zoom: a region of the latest full screenshot, in its pixels')

  return [
    tool(
      'look_at_screen',
      "Take a screenshot of the screen the user is working on (Tomo's own windows are left out on Windows and macOS). Call this first in any task that involves the screen. The acting tools (click, type_text, press_keys, scroll, drag, move_mouse) already answer with a fresh screenshot, so you don't need this after them. Coordinates you pass to the computer tools are pixels in the latest full screenshot, from this tool or an action." +
        (pointerDrawn ? ' The mouse pointer is drawn in.' : '') +
        ' To read small text or icons, pass region (a rect in the latest full screenshot\'s pixels): you get that part at up to the screen\'s full resolution. A zoom is only for looking and never changes the frame: keep giving coordinates in the full screenshot (the answer says how its pixels map back).',
      { region: zoomArea.optional() },
      ({ region }) =>
        run(
          'look_at_screen',
          'Look at screen',
          '',
          region
            ? d.control.zoom(region).pipe(
                Effect.map(
                  (z): CallToolResult => ({
                    content: [
                      { type: 'image', data: z.shot.data, mimeType: z.shot.mime },
                      { type: 'text', text: zoomText(z) }
                    ]
                  })
                )
              )
            : d.control.screenshot().pipe(
                Effect.map(
                  (s): CallToolResult => ({
                    content: [
                      { type: 'image', data: s.data, mimeType: s.mime },
                      { type: 'text', text: `${shotText(s, pointerIn(s))} Coordinates you give are pixels in this image.` }
                    ]
                  })
                )
              ),
          { quiet: true, read: true, live: region ? 'Looking closer' : 'Looking at the screen' }
        ),
      { searchHint: 'screenshot see view screen desktop what is on screen computer zoom closer small text' }
    ),

    tool(
      'ui_elements',
      "List the controls (buttons, fields, menu items, tabs, list items, labels) in the active window of the user's computer: id, type, name, centre in screenshot pixels, and state where the app reports it: value=\"…\" (a field's text, a combo box's choice, a slider's value), checked / unchecked / mixed, selected, expanded / collapsed, disabled. Prefer clicking and teaching by element id. Pass name to find specific controls instead of reading the whole list." +
        (d.control.otherWindows ? ' Pass window to read another open window without bringing it to the front.' : ''),
      {
        name: z.string().optional().describe('Only controls whose name contains these words, e.g. "save"'),
        max: z.number().int().min(10).max(300).optional().describe(`Max elements, default ${UI_DEFAULT}`),
        ...(d.control.otherWindows
          ? { window: z.string().optional().describe('Read this window instead of the active one: part of its title, or its app name (as list_windows shows them)') }
          : {})
      },
      (a: { name?: string | undefined; max?: number | undefined; window?: string | undefined }) =>
        run(
          'ui_elements',
          'Read controls',
          a.name ?? '',
          Effect.gen(function* () {
            const { name, max } = a
            const other = d.control.otherWindows ? a.window?.trim() || undefined : undefined
            const limit = max ?? UI_DEFAULT
            // Read more than is shown, so the note below can say how many there are.
            const t = yield* d.control.uiTree(Math.max(limit, UI_SCAN), other)
            const { lines, total } = formatElements(t.elements, d.control.rectToImage, { filter: name, max: limit })
            const head = `Window "${t.window.title}" (${t.window.process})${other ? ", which may not be in front: call focus_window before you click in it (centres are where it sits on screen, and other windows may cover it)" : ''}`
            // The host stopped early (time budget or size): what isn't listed may still be there.
            const cut = t.truncated ? 'The list was cut short (time or size limit), so more controls may exist: narrow by name or call again.' : ''
            if (!lines.length) {
              const none = name ? `${head}: no control named like "${name}"${t.truncated ? ' among those read' : ''}.` : `${head}: no controls found.`
              return text(cut ? `${none} ${cut}` : none)
            }
            const more = total > lines.length ? ` (first ${lines.length} of ${total}${t.truncated ? '+' : ''}; pass name to narrow)` : ''
            return text(`${head}${more}:\n${lines.join('\n')}${cut ? `\n${cut}` : ''}`)
          }),
          { quiet: true, read: true, live: a.name ? `Looking for “${a.name}”` : 'Reading the controls' }
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
          { quiet: true, read: true, live: 'Listing the windows' }
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
          }),
          { read: true }
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
      `Click in the active app on the user's computer. Give an element id from ui_elements (preferred), or x/y pixels in the latest full screenshot. double / triple click (triple selects a line or paragraph); modifiers are held during the click (${d.control.platform === 'macos' ? 'cmd+click adds to a selection' : 'ctrl+click adds to a selection, shift+click extends it'}). Answers with a screenshot taken just after.`,
      {
        element: z.number().int().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        button: z.enum(['left', 'right', 'middle']).optional(),
        double: z.boolean().optional(),
        triple: z.boolean().optional(),
        modifiers: z.array(z.enum(['ctrl', 'shift', 'alt', 'cmd'])).optional().describe(d.control.platform === 'macos' ? 'cmd is Command' : 'ctrl, shift or alt'),
        screenshot: look
      },
      (a) => {
        const mods = [...new Set(a.modifiers ?? [])]
        const kind = a.triple ? 'Triple-click' : a.double ? 'Double-click' : a.button === 'right' ? 'Right-click' : 'Click'
        return run(
          'click',
          mods.length ? `${mods.map((m) => m[0]!.toUpperCase() + m.slice(1)).join('+')}+${kind.toLowerCase()}` : kind,
          a.element != null ? describe(a.element) : `${Math.round(a.x ?? 0)}, ${Math.round(a.y ?? 0)}`,
          Effect.gen(function* () {
            const button = a.button ?? 'left'
            const count = a.triple ? 3 : a.double ? 2 : 1
            let did = 'Clicked.'
            if (a.element != null) {
              if (button === 'left' && count === 1 && !mods.length) {
                const how = yield* d.control.invoke(a.element)
                did = `Done (${how}).`
              } else {
                const r = yield* d.control.elementRect(a.element)
                yield* d.control.click(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2), button, count, mods)
              }
            } else {
              if (a.x == null || a.y == null) return text('Give an element id or x and y.', true)
              const p = yield* d.control.toScreen(a.x, a.y)
              yield* d.control.click(p.x, p.y, button, count, mods)
            }
            return yield* after(did, { look: a.screenshot, focus: true })
          }),
          { acting: true }
        )
      },
      { searchHint: 'click press button mouse double-click triple-click right-click ctrl-click shift-click desktop app' }
    ),

    tool(
      'move_mouse',
      'Move the mouse pointer without clicking, to hover: show a tooltip, open a hover menu, reveal controls that appear on hover. Give an element id from ui_elements, or x/y pixels in the latest full screenshot. Answers with a screenshot taken just after.',
      { element: z.number().int().optional(), x: z.number().optional(), y: z.number().optional(), screenshot: look },
      (a) =>
        run(
          'move_mouse',
          'Hover',
          a.element != null ? describe(a.element) : `${Math.round(a.x ?? 0)}, ${Math.round(a.y ?? 0)}`,
          Effect.gen(function* () {
            let p: { x: number; y: number }
            if (a.element != null) {
              const r = yield* d.control.elementRect(a.element)
              p = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
            } else {
              if (a.x == null || a.y == null) return text('Give an element id or x and y.', true)
              p = yield* d.control.toScreen(a.x, a.y)
            }
            yield* d.control.move(p.x, p.y)
            return yield* after('Moved the pointer.', { look: a.screenshot })
          }),
          { acting: true }
        ),
      { searchHint: 'hover mouse over move pointer tooltip hover menu mouseover' }
    ),

    tool(
      'type_text',
      "Type text in the active app. Without element, it's typed at the cursor of the focused field (added to what's there). With an element id of a text field, the field's text is replaced; other elements get it typed at their cursor. Set submit to press Enter afterwards. Answers with a screenshot taken just after and, where it can be read, the control that has focus.",
      { text: z.string(), element: z.number().int().optional(), submit: z.boolean().optional(), screenshot: look },
      (a) =>
        run(
          'type_text',
          'Type',
          (a.text.length > 48 ? `${a.text.slice(0, 48)}…` : a.text) + (a.element != null ? ` → ${describe(a.element)}` : ''),
          Effect.gen(function* () {
            let how = 'typed'
            if (a.element != null) {
              how = yield* d.control.setValue(a.element, a.text)
              // A value set through UI Automation doesn't move focus: put it in the field before Enter.
              if (a.submit && how === 'set') {
                const r = yield* d.control.elementRect(a.element)
                yield* d.control.click(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2), 'left', 1)
              }
            } else yield* d.control.type(a.text)
            if (a.submit) yield* d.control.keys('enter')
            const did = how === 'set' || how === 'replaced' ? "Replaced the field's text" : 'Typed'
            return yield* after(a.submit ? `${did} and pressed Enter.` : `${did}.`, { look: a.screenshot, focus: true })
          }),
          { acting: true }
        ),
      { searchHint: 'type text keyboard enter write into field input desktop app' }
    ),

    tool(
      'press_keys',
      `Press a key or chord in the active app, e.g. "enter", "${mod}+s", "${d.control.platform === 'macos' ? 'cmd+tab' : 'alt+tab'}", "${mod}+/", "${mod}+plus". ${KEY_NAMES[d.control.platform]} Answers with a screenshot taken just after.`,
      { combo: z.string(), screenshot: look },
      ({ combo, screenshot }) =>
        run(
          'press_keys',
          'Press',
          combo,
          d.control.keys(combo).pipe(Effect.andThen(after('Pressed.', { look: screenshot, focus: true }))),
          { acting: true }
        ),
      { searchHint: 'keyboard shortcut hotkey press key chord ctrl alt escape' }
    ),

    tool(
      'scroll',
      'Scroll at a point in the latest full screenshot. Positive amount scrolls down / right. Answers with a screenshot taken just after.',
      { x: z.number(), y: z.number(), amount: z.number().describe('Notches, e.g. 3 or -5'), horizontal: z.boolean().optional(), screenshot: look },
      (a) =>
        run(
          'scroll',
          'Scroll',
          `${a.horizontal ? (a.amount > 0 ? 'right' : 'left') : a.amount > 0 ? 'down' : 'up'} ${Math.abs(a.amount)}`,
          Effect.gen(function* () {
            const p = yield* d.control.toScreen(a.x, a.y)
            yield* d.control.scroll(p.x, p.y, a.horizontal ? 0 : a.amount, a.horizontal ? a.amount : 0)
            return yield* after('Scrolled.', { look: a.screenshot })
          }),
          { acting: true }
        ),
      { searchHint: 'scroll down up mouse wheel page desktop app' }
    ),

    tool(
      'drag',
      'Drag with the left button between two points in the latest full screenshot. Answers with a screenshot taken just after.',
      { from_x: z.number(), from_y: z.number(), to_x: z.number(), to_y: z.number(), screenshot: look },
      (a) =>
        run(
          'drag',
          'Drag',
          '',
          Effect.gen(function* () {
            const p1 = yield* d.control.toScreen(a.from_x, a.from_y)
            const p2 = yield* d.control.toScreen(a.to_x, a.to_y)
            yield* d.control.drag(p1.x, p1.y, p2.x, p2.y)
            return yield* after('Dragged.', { look: a.screenshot })
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
      ({ seconds }) => run('wait', 'Wait', `${seconds}s`, Effect.sleep(`${seconds} seconds`).pipe(Effect.as(text('Waited.'))), { quiet: true, read: true, live: 'Waiting for it to load' }),
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
            // After the user typed or pressed Done in the chat, Tomo is in front: bring the
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
      () => run('clear_highlight', 'Clear', '', d.interaction.clearTeach().pipe(Effect.as(text('Cleared.'))), { quiet: true, read: true, live: false }),
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
            // The user moved the mouse to answer; that isn't taking over.
            const ok = yield* d.interaction.requestApproval(d.owner, a.action, a.detail).pipe(Effect.ensuring(Effect.sync(() => d.control.resetTakeover())))
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
