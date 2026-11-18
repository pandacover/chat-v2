import type { TeachTarget } from './interaction'

/**
 * What computer use needs from the desktop besides the platform: the overlay window, content
 * protection and the Stop shortcut. The real one is Electron's (overlay.ts); tests and headless
 * runs use `noOverlay` or a fake.
 */
export interface OverlayPort {
  /** Draw the acting frame and/or the Show-me spotlight (rect in input space); hidden when both are off. */
  readonly show: (acting: boolean, teach: TeachTarget | null) => void
  /** Content protection on every chat-v2 window, so none of them appears in screenshots. */
  readonly protect: (on: boolean) => void
  /** Called when the user presses Done on the overlay's callout. */
  readonly onDone: (listener: () => void) => void
  /** Holds the global Stop shortcut (on) or lets it go (off). Held only while a computer reply runs. */
  readonly stopKey: (on: boolean) => void
  /** Called when the user presses the Stop shortcut. */
  readonly onStopKey: (listener: () => void) => void
  readonly dispose: () => void
}

export const noOverlay: OverlayPort = {
  show: () => {},
  protect: () => {},
  onDone: () => {},
  stopKey: () => {},
  onStopKey: () => {},
  dispose: () => {}
}
