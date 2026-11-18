import type { TeachTarget } from './interaction'

/**
 * What computer use needs from the screen besides the platform: the overlay window and content
 * protection. The real one is an Electron window (overlay.ts); tests and headless runs use
 * `noOverlay`.
 */
export interface OverlayPort {
  /** Draw the acting frame and/or the Show-me spotlight (rect in input space); hidden when both are off. */
  readonly show: (acting: boolean, teach: TeachTarget | null) => void
  /** Content protection on every chat-v2 window, so none of them appears in screenshots. */
  readonly protect: (on: boolean) => void
  /** Called when the user presses Done on the overlay's callout. */
  readonly onDone: (listener: () => void) => void
  readonly dispose: () => void
}

export const noOverlay: OverlayPort = {
  show: () => {},
  protect: () => {},
  onDone: () => {},
  dispose: () => {}
}
