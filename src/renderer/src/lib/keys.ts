// The app's shortcuts use Cmd on a Mac and Ctrl elsewhere.

export const isMac = /Mac/i.test(navigator.platform)

/** Whether the platform's shortcut modifier (Cmd on a Mac, Ctrl elsewhere) is held. */
export const modKey = (e: KeyboardEvent) => (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)

/** A shortcut's label for tooltips: "⌘ B" on a Mac, "Ctrl B" elsewhere. */
export const shortcut = (key: string) => `${isMac ? '⌘' : 'Ctrl'} ${key}`
