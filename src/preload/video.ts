// The bridge for the video worker (main/video.ts): it can only read byte ranges of the one video
// the main process is taking frames from. It never gets the app's API.
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('tomoVideo', {
  read: (start: number, end: number): Promise<Uint8Array> => ipcRenderer.invoke('video:read', start, end)
})
