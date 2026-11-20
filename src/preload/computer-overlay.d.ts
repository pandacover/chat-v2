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
  /** The step's wait id: presses on the callout answer this step and no later one. */
  id?: string
}

/** What a running computer reply is doing, shown at the top of the screen while the chat is out of sight. */
export interface OverlayNotch {
  text: string
  /** It waits on the user: an approval, or a Show-me step. */
  waiting: boolean
  /** An approval waits: the notch asks it, with Approve (armed after a beat) and Deny. */
  approval?: { id: string; title: string; detail: string }
  /** A MacBook's camera housing at the top centre (DIPs): the notch wraps around it. */
  camera: { width: number; height: number } | null
}

export interface OverlayState {
  /** Computer use is driving: a hairline frame around the screen. */
  acting: boolean
  teach: OverlayTeach | null
  notch: OverlayNotch | null
}

export interface ComputerOverlayBridge {
  /** Returns a function that stops listening. */
  onState(listener: (state: OverlayState) => void): () => void
  /** Where the overlay's controls are (DIPs, window-relative); main lets it take the mouse while the pointer is on one. */
  hits(rects: OverlayRect[]): void
  /**
   * An answer to a wait, with its id: Done, Can't find it or Do it for me on the callout, Approve
   * or Deny in the notch. Or Stop, the notch itself (opens the chat), or the callout was dragged.
   */
  press(what: 'done' | 'cant_find' | 'hand_over' | 'approve' | 'deny', id: string): void
  press(what: 'stop' | 'chat' | 'moved'): void
}
