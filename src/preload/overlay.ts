// The bridge for the computer-use overlay: it hears what to draw, asks for the user's pointer
// while its cursor follows it, and can only say Stop, Show chat or Clear. It never gets the
// app's full API.
import { contextBridge, ipcRenderer } from 'electron'
import type { OverlayCommand, OverlayEvent } from '@shared/computer'

export interface OverlayBridge {
  onEvent(listener: (event: OverlayEvent) => void): void
  /** True while the pointer is over the pill, so its buttons take clicks. */
  setInteractive(on: boolean): void
  /** True while the cursor follows the user's pointer, so the main process sends where it is. */
  follow(on: boolean): void
  command(command: OverlayCommand): void
}

const bridge: OverlayBridge = {
  onEvent: (listener) => void ipcRenderer.on('overlay:event', (_event, payload: OverlayEvent) => listener(payload)),
  setInteractive: (on) => ipcRenderer.send('overlay:interactive', on),
  follow: (on) => ipcRenderer.send('overlay:follow', on),
  command: (command) => ipcRenderer.send('overlay:command', command)
}

contextBridge.exposeInMainWorld('overlay', bridge)
