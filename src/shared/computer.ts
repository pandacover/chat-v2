// What the chat window and the main process share about computer use.

/**
 * The global shortcut that stops a computer reply. It is held only while one runs, so it takes no
 * key from other apps the rest of the time. Control, not Cmd, on a Mac too: Cmd+Option+Esc is
 * Force Quit there.
 */
export const STOP_SHORTCUT = 'Control+Alt+Escape'

/** The shortcut as the chat shows it. */
export const stopShortcutLabel = (mac: boolean) => (mac ? '⌃ ⌥ Esc' : 'Ctrl Alt Esc')

/** Approve takes clicks only this long after it appears (in the chat and the notch), so a click or key meant for something else can't say yes. */
export const APPROVE_ARM_MS = 700

/** The model operates the computer (do), or shows the user each step to do themselves (teach). */
export type ComputerMode = 'do' | 'teach'

/**
 * The computer tool running now in a reply, shown live in its step list until it ends. Quiet ones
 * (looking at the screen, reading controls) leave no step behind, so they are shown subtly.
 */
export interface ComputerDoing {
  label: string
  detail?: string
  quiet: boolean
}

/** What computer use is waiting on the user for, in which chat and reply; null when nothing. */
export type ComputerWait =
  | { kind: 'approval'; id: string; title: string; detail: string; sessionId: string; messageId: string }
  | { kind: 'teach'; id: string; instruction: string; step: number; total: number; sessionId: string; messageId: string }
  | null
