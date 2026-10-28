import type { DesktopState } from '@shared/computer'

/** What a driver says about how an action went, if anything. */
export type Note = string | null | void

/**
 * Whether the real pointer may be borrowed for a moment (and put back) where nothing else works:
 * drags, and on macOS clicks that nothing responds to. See Settings.computerBorrowPointer.
 */
export interface Borrow {
  borrow?: boolean
}

/** How a click goes: `pointer` asks for the real pointer (allowed only with `borrow`), since the same click sent another way did nothing. */
export interface ClickOptions extends Borrow {
  pointer?: boolean
}

/**
 * Input and window state for computer use, one per platform (winHelper.ts, macHelper.ts).
 * Coordinates are physical screen pixels. Pointer actions go to the given top-level window (the
 * one the guard checked) without moving the user's mouse.
 */
export interface Driver {
  state(): Promise<DesktopState>
  /**
   * Pointer actions may say how they were done, for the model: whether a click went through
   * Accessibility (it happened), with the real pointer, or as posted events (it may not have).
   */
  click(hwnd: number, x: number, y: number, button: 'left' | 'right' | 'middle', count: number, opts?: ClickOptions): Promise<Note>
  hover(hwnd: number, x: number, y: number): Promise<void>
  drag(hwnd: number, from: { x: number; y: number }, to: { x: number; y: number }, opts?: Borrow): Promise<Note>
  /** Wheel notches over a point; positive dy scrolls up, positive dx scrolls right. */
  wheel(hwnd: number, x: number, y: number, dx: number, dy: number, opts?: Borrow): Promise<Note>
  /** Text and keys go to the app in front. */
  text(text: string): Promise<void>
  /** A chord as Windows virtual-key codes (see parseKeys); other platforms translate them. */
  keys(vks: number[]): Promise<void>
  focus(hwnd: number): Promise<void>
  /** Chooses a menu-bar command by its path, in the app that owns the window (macOS only). */
  menu?(hwnd: number, path: string[]): Promise<Note>
  /** Installed apps, for opening one by name. */
  apps(): Promise<Array<{ name: string; id: string }>>
  launch(id: string): Promise<void>
  /** Ends the helper process while computer use is idle; the next call starts it again. */
  stop?(): void
  close(): void
}
