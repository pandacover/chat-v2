// What the chat window and the main process share about computer use.

/**
 * The global shortcut that stops a computer reply. It is held only while one runs, so it takes no
 * key from other apps the rest of the time. Control, not Cmd, on a Mac too: Cmd+Option+Esc is
 * Force Quit there.
 */
export const STOP_SHORTCUT = 'Control+Alt+Escape'

/** The shortcut as the chat shows it. */
export const stopShortcutLabel = (mac: boolean) => (mac ? '⌃ ⌥ Esc' : 'Ctrl Alt Esc')

/** The model operates the computer (do), or shows the user each step to do themselves (teach). */
export type ComputerMode = 'do' | 'teach'

/** What computer use is waiting on the user for, in which chat and reply; null when nothing. */
export type ComputerWait =
  | { kind: 'approval'; id: string; title: string; detail: string; sessionId: string; messageId: string }
  | { kind: 'teach'; id: string; instruction: string; step: number; total: number; sessionId: string; messageId: string }
  | null
