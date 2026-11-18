// What the computer-use overlay draws, and the small bridge its preload (computer.ts) exposes as
// `window.computerOverlay`. Shared by the main process and the overlay renderer.

/** A Show-me step, with its rect in DIPs relative to the overlay window. */
export interface OverlayTeach {
  rect: { x: number; y: number; width: number; height: number }
  instruction: string
  step: number
  total: number
}

export interface OverlayState {
  /** Computer use is driving: a hairline frame around the screen. */
  acting: boolean
  teach: OverlayTeach | null
}

export interface ComputerOverlayBridge {
  /** Returns a function that stops listening. */
  onState(listener: (state: OverlayState) => void): () => void
  /** True while the pointer is on the Show-me callout, so its Done button takes the click. */
  interactive(on: boolean): void
  /** The user pressed Done on the callout. */
  done(): void
}
