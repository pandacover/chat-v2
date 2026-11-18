// The bridge for the computer-use overlay: it hears what to draw, says where its controls are, and
// can only press them. It never gets the app's full API.
import { contextBridge, ipcRenderer } from 'electron'
import type { ComputerOverlayBridge, OverlayState } from './computer-overlay'

const bridge: ComputerOverlayBridge = {
  onState: (listener) => {
    const on = (_e: unknown, state: OverlayState) => listener(state)
    ipcRenderer.on('computer-overlay:state', on)
    return () => void ipcRenderer.off('computer-overlay:state', on)
  },
  hits: (rects) => ipcRenderer.send('computer-overlay:hits', rects),
  press: (what) => ipcRenderer.send('computer-overlay:press', what)
}

contextBridge.exposeInMainWorld('computerOverlay', bridge)
