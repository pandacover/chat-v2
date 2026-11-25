import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Api, BrowserEvent, IpcResult, StreamEvent, UpdateState } from '@shared/types'
import type { UsageEvent } from '@shared/usage'

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
    markRead: (id) => call('sessions:markRead', id),
    create: () => call('sessions:create'),
    get: (id) => call('sessions:get', id),
    rename: (id, title) => call('sessions:rename', id, title),
    remove: (id) => call('sessions:remove', id),
    update: (id, patch) => call('sessions:update', id, patch),
    fork: (sessionId, messageId) => call('sessions:fork', sessionId, messageId),
    exportLog: (id) => call('sessions:exportLog', id)
  },
  bots: {
    list: () => call('bots:list'),
    update: (id, patch) => call('bots:update', id, patch),
    create: (patch) => call('bots:create', patch),
    remove: (id) => call('bots:remove', id),
    setPrimary: (id) => call('bots:setPrimary', id),
    presence: () => call('bots:presence')
  },
  jobs: {
    list: () => call('jobs:list'),
    primary: () => call('jobs:primary'),
    send: (input) => call('jobs:send', input),
    newTopic: () => call('jobs:newTopic'),
    setStatus: (id, status) => call('jobs:setStatus', id, status),
    detail: (id) => call('jobs:detail', id),
    rename: (id, title) => call('jobs:rename', id, title),
    stopApproving: (id) => call('jobs:stopApproving', id),
    remove: (id) => call('jobs:remove', id)
  },
  memory: {
    get: () => call('memory:get'),
    add: (fact) => call('memory:add', fact),
    edit: (id, fact) => call('memory:edit', id, fact),
    purge: (id) => call('memory:purge', id),
    versions: (id) => call('memory:versions', id),
    clear: () => call('memory:clear'),
    restore: (rev) => call('memory:restore', rev),
    reconcile: () => call('memory:reconcile')
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
    addVideoFile: async (file) => {
      const path = webUtils.getPathForFile(file)
      return path ? call('attachments:addVideoFile', { path, name: file.name, mime: file.type }) : null
    },
    discard: (id) => call('attachments:discard', id),
    saveAs: (id, name) => call('attachments:saveAs', id, name),
    setAnalysis: (id, analysis) => call('attachments:setAnalysis', id, analysis),
    url: (id) => `attachment://${id}/`
  },
  settings: {
    get: () => call('settings:get'),
    update: (patch) => call('settings:update', patch),
    openConfigFile: () => call('settings:openConfigFile')
  },
  stt: {
    microphone: () => call('stt:microphone'),
    transcribe: (audio, mime) => call('stt:transcribe', audio, mime)
  },
  artifacts: {
    publish: (html) => call('artifacts:publish', html)
  },
  appWindow: {
    setTheme: (theme, dimmed) => ipcRenderer.send('window:theme', theme, dimmed)
  },
  updates: {
    get: () => call('updates:get'),
    check: () => call('updates:check'),
    download: () => call('updates:download'),
    install: () => call('updates:install'),
    onEvent: (listener) => {
      const handler = (_event: unknown, state: UpdateState) => listener(state)
      ipcRenderer.on('updates:event', handler)
      return () => ipcRenderer.removeListener('updates:event', handler)
    }
  },
  usage: {
    get: () => call('usage:get'),
    refresh: () => call('usage:refresh'),
    cancelPause: (messageId) => call('usage:cancelPause', messageId),
    share: (keys, window) => call('usage:share', keys, window),
    jobShare: (jobId) => call('usage:jobShare', jobId),
    onEvent: (listener) => {
      const handler = (_event: unknown, payload: UsageEvent) => listener(payload)
      ipcRenderer.on('usage:event', handler)
      return () => ipcRenderer.removeListener('usage:event', handler)
    }
  },
  computer: {
    supported: () => call('computer:supported'),
    waiting: () => call('computer:waiting'),
    approve: (id, approved) => call('computer:approve', id, approved),
    teachDone: (id) => call('computer:teachDone', id),
    setMode: (sessionId, messageId, mode) => call('computer:setMode', sessionId, messageId, mode),
    point: () => call('computer:point')
  },
  browser: {
    attach: (id) => call('browser:attach', id),
    screenshot: (rect) => call('browser:screenshot', rect),
    capture: (rect) => call('browser:capture', rect),
    elementAt: (x, y) => call('browser:elementAt', x, y),
    screencast: (on) => call('browser:screencast', on),
    saveRecording: (data) => call('browser:saveRecording', data),
    recordReply: (reply) => call('browser:recordReply', reply),
    reveal: (path) => call('browser:reveal', path),
    onEvent: (listener) => {
      const handler = (_event: unknown, payload: BrowserEvent) => listener(payload)
      ipcRenderer.on('browser:event', handler)
      return () => ipcRenderer.removeListener('browser:event', handler)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
