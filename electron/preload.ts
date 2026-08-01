import { contextBridge, ipcRenderer } from 'electron'
import type { AerioDesktopApi, AppState } from '../src/types'
import type { ApplyMailActionInput, GmailDraftInput, GmailWorkerEvent, ImapAccountInput, MailQuery } from '../src/gmail-types'

const api: AerioDesktopApi = {
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state: AppState) => ipcRenderer.invoke('state:save', state),
  resetState: () => ipcRenderer.invoke('state:reset'),
  chooseAttachments: () => ipcRenderer.invoke('files:choose'),
  notify: (title: string, body: string) => ipcRenderer.invoke('notification:show', { title, body }),
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized')
  },
  onWindowState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, maximized: boolean) => callback(maximized)
    ipcRenderer.on('window:maximized-state', listener)
    return () => ipcRenderer.removeListener('window:maximized-state', listener)
  },
  onComposeCommand: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('command:compose', listener)
    return () => ipcRenderer.removeListener('command:compose', listener)
  },
  mail: {
    credentials: {
      status: () => ipcRenderer.invoke('gmail:credentials:status'),
      import: () => ipcRenderer.invoke('gmail:credentials:import'),
      microsoftStatus: () => ipcRenderer.invoke('mail:credentials:microsoft-status'),
      configureMicrosoft: (clientId) => ipcRenderer.invoke('mail:credentials:microsoft-configure', clientId)
    },
    presets: () => ipcRenderer.invoke('mail:providers:presets'),
    accounts: {
      list: () => ipcRenderer.invoke('gmail:accounts:list'),
      connect: () => ipcRenderer.invoke('gmail:accounts:connect'),
      connectMicrosoft: () => ipcRenderer.invoke('mail:accounts:connect-microsoft'),
      connectImap: (input: ImapAccountInput) => ipcRenderer.invoke('mail:accounts:connect-imap', input),
      disconnect: (accountId, mode) => ipcRenderer.invoke('gmail:accounts:disconnect', accountId, mode)
    },
    mail: {
      labels: (accountIds) => ipcRenderer.invoke('gmail:labels:list', accountIds),
      list: (query: MailQuery) => ipcRenderer.invoke('gmail:mail:list', query),
      thread: (accountId, threadId, allowRemoteImages) => ipcRenderer.invoke('gmail:mail:thread', accountId, threadId, allowRemoteImages),
      action: (input: ApplyMailActionInput) => ipcRenderer.invoke('gmail:mail:action', input),
      undo: (operationId) => ipcRenderer.invoke('gmail:mail:undo', operationId)
    },
    drafts: {
      save: (input: GmailDraftInput) => ipcRenderer.invoke('gmail:drafts:save', input),
      send: (input: GmailDraftInput) => ipcRenderer.invoke('gmail:drafts:send', input)
    },
    sync: {
      start: (accountId) => ipcRenderer.invoke('gmail:sync:start', accountId),
      pause: (accountId) => ipcRenderer.invoke('gmail:sync:pause', accountId),
      resume: (accountId) => ipcRenderer.invoke('gmail:sync:resume', accountId),
      progress: () => ipcRenderer.invoke('gmail:sync:progress')
    },
    attachments: {
      open: (accountId, messageId, attachmentId, filename) => ipcRenderer.invoke('gmail:attachment:open', accountId, messageId, attachmentId, filename),
      save: (accountId, messageId, attachmentId, filename) => ipcRenderer.invoke('gmail:attachment:save', accountId, messageId, attachmentId, filename)
    },
    storage: () => ipcRenderer.invoke('gmail:storage'),
    onEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, value: GmailWorkerEvent) => callback(value)
      ipcRenderer.on('gmail:event', listener)
      return () => ipcRenderer.removeListener('gmail:event', listener)
    }
  }
}

contextBridge.exposeInMainWorld('aerio', api)

const reportConnectivity = () => void ipcRenderer.invoke('gmail:network', navigator.onLine)
window.addEventListener('online', reportConnectivity)
window.addEventListener('offline', reportConnectivity)
queueMicrotask(reportConnectivity)
