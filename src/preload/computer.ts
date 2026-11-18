// The bridge for the computer-use overlay: it hears what to draw, says where the Show-me callout
// is, and can only press Done. It never gets the app's full API.
import { contextBridge, ipcRenderer } from 'electron'
import type { ComputerOverlayBridge, OverlayState } from './computer-overlay'

const bridge: ComputerOverlayBridge = {
  onState: (listener) => {
    const on = (_e: unknown, state: OverlayState) => listener(state)
    ipcRenderer.on('computer-overlay:state', on)
    return () => void ipcRenderer.off('computer-overlay:state', on)
  },
  callout: (rect) => ipcRenderer.send('computer-overlay:callout', rect),
  done: () => ipcRenderer.send('computer-overlay:done')
}

contextBridge.exposeInMainWorld('computerOverlay', bridge)
