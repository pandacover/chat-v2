import type { DesktopState } from '@shared/computer'

/**
 * Input and window state for computer use, one per platform (winHelper.ts, macHelper.ts).
 * Coordinates are physical screen pixels. Pointer actions go to the given top-level window (the
 * one the guard checked) without moving the user's mouse.
 */
export interface Driver {
  state(): Promise<DesktopState>
  click(hwnd: number, x: number, y: number, button: 'left' | 'right' | 'middle', count: number): Promise<void>
  hover(hwnd: number, x: number, y: number): Promise<void>
  drag(hwnd: number, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void>
  /** Wheel notches over a point; positive dy scrolls up, positive dx scrolls right. */
  wheel(hwnd: number, x: number, y: number, dx: number, dy: number): Promise<void>
  /** Text and keys go to the app in front. */
  text(text: string): Promise<void>
  /** A chord as Windows virtual-key codes (see parseKeys); other platforms translate them. */
  keys(vks: number[]): Promise<void>
  focus(hwnd: number): Promise<void>
  /** Installed apps, for opening one by name. */
  apps(): Promise<Array<{ name: string; id: string }>>
  launch(id: string): Promise<void>
  close(): void
}
