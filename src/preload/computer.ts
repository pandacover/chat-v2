// The bridge for the computer-use overlay: it hears what to draw, says where its controls are, and
// can only press them. It never gets the app's full API.
import { contextBridge, ipcRenderer } from 'electron'
import type { ComputerOverlayBridge, OverlayPoint, OverlayPointHit, OverlayState } from './computer-overlay'

const bridge: ComputerOverlayBridge = {
  onState: (listener) => {
    const on = (_e: unknown, state: OverlayState) => listener(state)
    ipcRenderer.on('computer-overlay:state', on)
    return () => void ipcRenderer.off('computer-overlay:state', on)
  },
  hits: (rects) => ipcRenderer.send('computer-overlay:hits', rects),
  press: (what: string, id?: string) => ipcRenderer.send('computer-overlay:press', what, id),
  onPoint: (listener) => {
    const on = (_e: unknown, point: OverlayPoint | null) => listener(point)
    ipcRenderer.on('computer-overlay:point', on)
    return () => void ipcRenderer.off('computer-overlay:point', on)
  },
  pointHover: (at) => ipcRenderer.send('computer-overlay:point-hover', at),
  onPointHit: (listener) => {
    const on = (_e: unknown, hit: OverlayPointHit) => listener(hit)
    ipcRenderer.on('computer-overlay:point-hit', on)
    return () => void ipcRenderer.off('computer-overlay:point-hit', on)
  },
  pointDragging: (on) => ipcRenderer.send('computer-overlay:point-dragging', on),
  pointDone: (mark) => ipcRenderer.send('computer-overlay:point-done', mark),
  pointCancel: () => ipcRenderer.send('computer-overlay:point-cancel')
}

contextBridge.exposeInMainWorld('computerOverlay', bridge)
