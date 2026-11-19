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
  screen: ScreenRect
  window: WindowInfo
}

export interface UiElement {
  id: number
  type: string
  name: string
  x: number
  y: number
  width: number
  height: number
  disabled?: boolean
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

export interface Platform {
  readonly name: 'windows' | 'macos' | 'linux'
  /** Remember the app the user was in before chat-v2's window came to the front. */
  remember(): Promise<WindowInfo>
  /** If chat-v2 has focus, give it back to the remembered app. */
  restoreFocus(): Promise<WindowInfo>
  foreground(): Promise<WindowInfo>
  windows(): Promise<ReadonlyArray<WindowInfo & { minimized?: boolean }>>
  focusWindow(title: string): Promise<WindowInfo>
  screenshot(maxWidth: number): Promise<Screenshot>
  cursor(): Promise<{ x: number; y: number }>
  click(x: number, y: number, button: 'left' | 'right' | 'middle', count: number): Promise<void>
  drag(x1: number, y1: number, x2: number, y2: number): Promise<void>
  scroll(x: number, y: number, dy: number, dx: number): Promise<void>
  type(text: string): Promise<void>
  keys(combo: string): Promise<void>
  /** `truncated`: the time budget or `max` cut the search short (Windows). */
  uiTree(max: number): Promise<{ window: WindowInfo; elements: ReadonlyArray<UiElement>; truncated?: boolean }>
  invoke(id: number): Promise<string>
  setValue(id: number, text: string): Promise<string>
  elementRect(id: number): Promise<ScreenRect>
  /** The interactive control under a point (input space), if there is a sensible one. */
  elementAt(x: number, y: number): Promise<ScreenRect | null>
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
