// What the computer-use overlay draws, and the small bridge its preload (computer.ts) exposes as
// `window.computerOverlay`. Shared by the main process and the overlay renderer.

export interface OverlayRect {
  x: number
  y: number
  width: number
  height: number
}

/** A Show-me step, with its rect in DIPs relative to the overlay window. */
export interface OverlayTeach {
  rect: OverlayRect
  instruction: string
  step: number
  total: number
}

/** What a running computer reply is doing, shown at the top of the screen while the chat is out of sight. */
export interface OverlayNotch {
  text: string
  /** It waits on the user: an approval, or a Show-me step. */
  waiting: boolean
  /** A MacBook's camera housing at the top centre (DIPs): the notch wraps around it. */
  camera: { width: number; height: number } | null
}

export interface OverlayState {
  /** Computer use is driving: a hairline frame around the screen. */
  acting: boolean
  teach: OverlayTeach | null
  notch: OverlayNotch | null
}

/** Point mode: the overlay covers one display and takes every click while the user marks a spot or a box. */
export interface OverlayPoint {
  /** The display it is on; a new one when the overlay follows the pointer to another display. */
  display: number
}

/** The control under the pointer in Point mode (DIPs, window-relative), for the hover highlight. */
export interface OverlayPointHit {
  x: number
  y: number
  control: { rect: OverlayRect; label: string } | null
}

/** What the user marked in Point mode (DIPs, window-relative): a click, or a dragged box. */
export interface OverlayPointMark {
  point: { x: number; y: number }
  rect: OverlayRect | null
}

export interface ComputerOverlayBridge {
  /** Returns a function that stops listening. */
  onState(listener: (state: OverlayState) => void): () => void
  /** Where the overlay's controls are (DIPs, window-relative); main lets it take the mouse while the pointer is on one. */
  hits(rects: OverlayRect[]): void
  /** Done on the callout, Stop or the notch itself (opens the chat), or the callout was dragged somewhere. */
  press(what: 'done' | 'stop' | 'chat' | 'moved' | 'point'): void
  /** Point mode starts (with its settings) or ends (null). */
  onPoint(listener: (point: OverlayPoint | null) => void): () => void
  /** Where the pointer rests in Point mode; main answers with `onPointHit`. Not sent while dragging. */
  pointHover(at: { x: number; y: number }): void
  /** The control under a point `pointHover` asked about. */
  onPointHit(listener: (hit: OverlayPointHit) => void): () => void
  /** A drag started or ended, so main keeps the overlay on this display meanwhile. */
  pointDragging(on: boolean): void
  pointDone(mark: OverlayPointMark): void
  pointCancel(): void
}
