// Opening Settings at a given tab (the composer's tools say opens Settings › Bots).
import { app } from './store.svelte'

let wanted: string | null = null

export const openSettingsAt = (tab: string) => {
  wanted = tab
  app.settingsOpen = true
}

/** The tab Settings was asked to open on, once. */
export const takeSettingsTab = (): string | null => {
  const tab = wanted
  wanted = null
  return tab
}
