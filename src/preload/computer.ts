// The bridge for the computer-use overlay: it hears what to draw, says when the pointer is on the
// Show-me callout, and can only press Done. It never gets the app's full API.
import { contextBridge, ipcRenderer } from 'electron'
import type { ComputerOverlayBridge, OverlayState } from './computer-overlay'

const bridge: ComputerOverlayBridge = {
  onState: (listener) => {
    const on = (_e: unknown, state: OverlayState) => listener(state)
    ipcRenderer.on('computer-overlay:state', on)
    return () => void ipcRenderer.off('computer-overlay:state', on)
  },
  interactive: (on) => ipcRenderer.send('computer-overlay:interactive', on),
  done: () => ipcRenderer.send('computer-overlay:done')
}

contextBridge.exposeInMainWorld('computerOverlay', bridge)
