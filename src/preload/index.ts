import { contextBridge, ipcRenderer } from 'electron'
import type { Api, BrowserEvent, IpcResult, StreamEvent, UpdateState } from '@shared/types'

/** Unwraps the main process's `IpcResult`, rethrowing failures with their tag. */
const call = async <A>(channel: string, ...args: unknown[]): Promise<A> => {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<A>
  if (result.ok) return result.value
  const error = new Error(result.error.message)
  error.name = result.error.tag
  throw error
}

const api: Api = {
  sessions: {
    list: () => call('sessions:list'),
    create: () => call('sessions:create'),
    get: (id) => call('sessions:get', id),
    rename: (id, title) => call('sessions:rename', id, title),
    remove: (id) => call('sessions:remove', id),
    update: (id, patch) => call('sessions:update', id, patch),
    fork: (sessionId, messageId) => call('sessions:fork', sessionId, messageId)
  },
  chat: {
    send: (input) => call('chat:send', input),
    edit: (input) => call('chat:edit', input),
    regenerate: (input) => call('chat:regenerate', input),
    continue: (input) => call('chat:continue', input),
    stop: (messageId) => call('chat:stop', messageId),
    switchBranch: (input) => call('chat:switchBranch', input),
    linesSince: (messageId, fromIndex) => call('chat:linesSince', messageId, fromIndex),
    onEvent: (listener) => {
      const handler = (_event: unknown, payload: StreamEvent) => listener(payload)
      ipcRenderer.on('chat:event', handler)
      return () => ipcRenderer.removeListener('chat:event', handler)
    }
  },
  attachments: {
    add: (input) => call('attachments:add', input),
    discard: (id) => call('attachments:discard', id),
    setAnalysis: (id, analysis) => call('attachments:setAnalysis', id, analysis),
    url: (id) => `attachment://${id}/`
  },
  settings: {
    get: () => call('settings:get'),
    update: (patch) => call('settings:update', patch),
    openConfigFile: () => call('settings:openConfigFile')
  },
  models: {
    list: () => call('models:list')
  },
  stt: {
    microphone: () => call('stt:microphone'),
    transcribe: (audio, mime) => call('stt:transcribe', audio, mime)
  },
  artifacts: {
    publish: (html) => call('artifacts:publish', html)
  },
  updates: {
    get: () => call('updates:get'),
    check: () => call('updates:check'),
    install: () => call('updates:install'),
    onEvent: (listener) => {
      const handler = (_event: unknown, state: UpdateState) => listener(state)
      ipcRenderer.on('updates:event', handler)
      return () => ipcRenderer.removeListener('updates:event', handler)
    }
  },
  browser: {
    attach: (id) => call('browser:attach', id),
    screenshot: (rect) => call('browser:screenshot', rect),
    capture: (rect) => call('browser:capture', rect),
    elementAt: (x, y) => call('browser:elementAt', x, y),
    screencast: (on) => call('browser:screencast', on),
    saveRecording: (data) => call('browser:saveRecording', data),
    reveal: (path) => call('browser:reveal', path),
    onEvent: (listener) => {
      const handler = (_event: unknown, payload: BrowserEvent) => listener(payload)
      ipcRenderer.on('browser:event', handler)
      return () => ipcRenderer.removeListener('browser:event', handler)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
