import type { TeachTarget } from './interaction'

/** What the notch says; `waiting` when the reply waits on the user (an approval, a Show-me step). */
export interface Activity {
  readonly text: string
  readonly waiting: boolean
  /** An approval waiting: the notch asks it, with Approve and Deny. */
  readonly approval?: { readonly id: string; readonly title: string; readonly detail: string }
}

/**
 * A press on the overlay that answers a wait, with the wait's id: the Show-me callout's Done,
 * Can't find it and Do it for me, or the notch's Approve and Deny.
 */
export type OverlayAnswer =
  | { readonly kind: 'done' | 'cant_find' | 'hand_over'; readonly id: string }
  | { readonly kind: 'approve' | 'deny'; readonly id: string }

/**
 * What computer use needs from the desktop besides the platform: the overlay window, content
 * protection and the Stop shortcut. The real one is Electron's (overlay.ts); tests and headless
 * runs use `noOverlay` or a fake.
 */
export interface OverlayPort {
  /**
   * Draw the acting frame, the Show-me spotlight (rect in input space), and the notch: what a
   * running computer reply is doing (`activity`, null when none runs), shown while no chat-v2
   * window has focus. Hidden when all are off.
   */
  readonly show: (acting: boolean, teach: TeachTarget | null, activity: Activity | null) => void
  /** Content protection on every chat-v2 window, so none of them appears in screenshots. */
  readonly protect: (on: boolean) => void
  /** Called when the user answers a wait on the overlay (the callout's buttons, the notch's Approve / Deny). */
  readonly onAnswer: (listener: (answer: OverlayAnswer) => void) => void
  /** Whether the pointer is on one of the overlay's own controls now (so a click there isn't a click on the app). */
  readonly pointerOnControl?: () => boolean
  /** Holds the global Stop shortcut (on) or lets it go (off). Held only while a computer reply runs. */
  readonly stopKey: (on: boolean) => void
  /** Called when the user presses the Stop shortcut, or Stop in the notch. */
  readonly onStopKey: (listener: () => void) => void
  readonly dispose: () => void
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * A MacBook's camera housing at the top centre of its built-in screen (DIPs), which the notch
 * wraps around. Electron doesn't report it, so it is read from the screen: notched ones have a
 * taller menu bar (about 37 pt where others have 24) and are about 1.54:1 where the others are
 * 1.6:1, which still tells when the menu bar is hidden.
 */
export const cameraHousing = (d: { internal: boolean; bounds: Rect; workArea: Rect }, platform: string = process.platform) => {
  if (platform !== 'darwin' || !d.internal) return null
  const bar = d.workArea.y - d.bounds.y
  if (bar < 30 && d.bounds.width / d.bounds.height >= 1.58) return null
  return { width: 200, height: Math.max(bar, 32) }
}

export const noOverlay: OverlayPort = {
  show: () => {},
  protect: () => {},
  onAnswer: () => {},
  stopKey: () => {},
  onStopKey: () => {},
  dispose: () => {}
}
