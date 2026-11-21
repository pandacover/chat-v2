// Everything computer use can do to the computer. Coordinates are in the platform's input space:
// physical pixels on Windows (the host is per-monitor DPI aware), points on macOS, X screen pixels on Linux. Screenshots
// report the screen rect they cover so the model's image coordinates can be mapped back.

export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowInfo {
  title: string
  process: string
  /** Windows: the target runs elevated and the host does not, so input will be dropped. */
  blocked?: boolean
}

export interface Screenshot {
  /** Base64. */
  data: string
  mime: 'image/jpeg' | 'image/png'
  imageWidth: number
  imageHeight: number
  /** The rect captured, in input space: the monitor, or the region asked for. */
  screen: ScreenRect
  window: WindowInfo
  /** The pointer, in input space, where the platform reads it with the capture (it is drawn into the image). */
  cursor?: { x: number; y: number }
}

export interface ShotOptions {
  /** Capture only this rect (input space) instead of the target window's monitor. */
  region?: ScreenRect
  /** Shrink the image to fit this height too (the width always fits `maxWidth`). Never enlarged. */
  maxHeight?: number
}

/** Modifier keys held during a click. `cmd` is Command on macOS, Ctrl on Windows, Super on Linux (as in key combos). */
export type Modifier = 'ctrl' | 'shift' | 'alt' | 'cmd'

export interface UiElement {
  id: number
  type: string
  name: string
  x: number
  y: number
  width: number
  height: number
  disabled?: boolean
  /** The control's text or value (fields, combo boxes, sliders), cut short by the platform. Never for password fields. */
  value?: string
  /** Check boxes and toggles. */
  checked?: boolean | 'mixed'
  /** List items, tabs, radio buttons: only reported when selected. */
  selected?: boolean
  /** Menus, combo boxes, tree items: absent when the control can't expand. */
  expanded?: boolean
}

/** The control with keyboard focus. */
export interface FocusedControl {
  type: string
  name: string
  value?: string
}

export interface SearchQuery {
  /** Words that should appear in the name. */
  name?: string | undefined
  /** Words that should appear inside the document. */
  contains?: string | undefined
  extensions?: ReadonlyArray<string> | undefined
  kind?: 'file' | 'folder' | 'any' | undefined
  modifiedWithinDays?: number | undefined
  limit?: number | undefined
}

export interface FileHit {
  path: string
  name: string
  kind: 'file' | 'folder'
  ext: string
  /** ISO time, when the index knows it. */
  modified: string | null
  size: number | null
}

/** What is under a point the user marked: the app window, and the control there if there is one. */
export interface PointHit {
  window: WindowInfo
  control: (ScreenRect & { type: string; name: string }) | null
}

export interface Platform {
  readonly name: 'windows' | 'macos' | 'linux'
  /** False where controls can't be read (Linux): ui_elements isn't offered there. Absent means true. */
  readonly controls?: boolean
  /** Remember the app the user was in before Tomo's window came to the front. */
  remember(): Promise<WindowInfo>
  /** If Tomo has focus, give it back to the remembered app. */
  restoreFocus(): Promise<WindowInfo>
  foreground(): Promise<WindowInfo>
  windows(): Promise<ReadonlyArray<WindowInfo & { minimized?: boolean }>>
  focusWindow(title: string): Promise<WindowInfo>
  screenshot(maxWidth: number, opts?: ShotOptions): Promise<Screenshot>
  cursor(): Promise<{ x: number; y: number }>
  /**
   * Whether the user pressed the primary mouse button: it is down now, or went down since the
   * last call. A cheap read-only query of the button state (no hook), polled while a Show-me step
   * waits. Absent where it isn't cheap (macOS and Linux would spawn a process per read).
   */
  pressed?(): Promise<boolean>
  /** Move the pointer without pressing anything (hover). */
  move(x: number, y: number): Promise<void>
  /** `count` 1-3 (double, triple click); `modifiers` are held down for the clicks and always released. */
  click(x: number, y: number, button: 'left' | 'right' | 'middle', count: number, modifiers?: ReadonlyArray<Modifier>): Promise<void>
  drag(x1: number, y1: number, x2: number, y2: number): Promise<void>
  scroll(x: number, y: number, dy: number, dx: number): Promise<void>
  type(text: string): Promise<void>
  keys(combo: string): Promise<void>
  /**
   * `truncated`: the time budget or `max` cut the search short. Element ids are never reused
   * while the app runs: an id from an older list is the same control, or it fails as stale.
   */
  uiTree(max: number, opts?: { window?: string }): Promise<{ window: WindowInfo; elements: ReadonlyArray<UiElement>; truncated?: boolean }>
  /**
   * `uiTree`'s `window` (part of a window title, or an app name) picks a window other than the
   * active one. True where that works; absent means only the active window can be read.
   */
  readonly otherWindows?: boolean
  /** The control with keyboard focus in the target app, where it's cheap to read (absent: unknown). */
  focused?(): Promise<FocusedControl | null>
  invoke(id: number): Promise<string>
  /**
   * Put text in an element. A text field's text is replaced: "set" (UI Automation, focus didn't
   * move) or "replaced" (selected all and typed over). Other elements: "typed" at the caret.
   */
  setValue(id: number, text: string): Promise<string>
  elementRect(id: number): Promise<ScreenRect>
  /** The interactive control under a point (input space), if there is a sensible one. */
  elementAt(x: number, y: number): Promise<ScreenRect | null>
  /**
   * For the user's Point: the app window and control under a point (input space), looking past
   * Tomo's own windows, since the Point overlay covers the screen then. A fallback search
   * stops after about `budgetMs`. Absent where controls can't be read (macOS, Linux).
   */
  pointAt?(x: number, y: number, budgetMs?: number): Promise<PointHit | null>
  search(q: SearchQuery): Promise<ReadonlyArray<FileHit>>
  open(target: string): Promise<void>
  reveal(path: string): Promise<void>
  /**
   * Stop the input action in progress (typing, a drag, a multi-click) at its next safe point and
   * fail the platform calls queued before this one; those calls reject with an Error named
   * "Cancelled". Calls made afterwards run normally. Absent means the platform can't interrupt
   * (macOS).
   */
  cancel?(): Promise<void>
  dispose(): void
}
