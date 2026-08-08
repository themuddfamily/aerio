import { contextBridge, ipcRenderer } from 'electron'
import type { AerioDesktopApi, AppPreferences } from '../src/types'
import type { ApplyMailActionInput, MailDraftInput, MailWorkerEvent, ImapAccountInput, MailQuery } from '../src/mail-types'

const api: AerioDesktopApi = {
  loadPreferences: () => ipcRenderer.invoke('preferences:load'),
  savePreferences: (preferences: AppPreferences) => ipcRenderer.invoke('preferences:save', preferences),
  chooseAttachments: () => ipcRenderer.invoke('files:choose'),
  chooseProfileImage: () => ipcRenderer.invoke('profile:image:choose'),
  notify: (title: string, body: string) => ipcRenderer.invoke('notification:show', { title, body }),
  updates: {
    status: () => ipcRenderer.invoke('app:update:status'),
    check: () => ipcRenderer.invoke('app:update:check'),
    download: () => ipcRenderer.invoke('app:update:download'),
    install: () => ipcRenderer.invoke('app:update:install'),
    onStatus: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, status: import('../src/types').AppUpdateStatus) => callback(status)
      ipcRenderer.on('app:update:status-changed', listener)
      return () => ipcRenderer.removeListener('app:update:status-changed', listener)
    }
  },
  productivity: {
    snapshot: () => ipcRenderer.invoke('productivity:snapshot'),
    sync: (accountId) => ipcRenderer.invoke('productivity:sync', accountId),
    createEvent: (event) => ipcRenderer.invoke('productivity:event-create', event),
    updateEvent: (event) => ipcRenderer.invoke('productivity:event-update', event),
    deleteEvent: (eventId) => ipcRenderer.invoke('productivity:event-delete', eventId),
    createContact: (accountId, contact) => ipcRenderer.invoke('productivity:contact-create', accountId, contact),
    updateContact: (contact) => ipcRenderer.invoke('productivity:contact-update', contact),
    deleteContact: (contactId) => ipcRenderer.invoke('productivity:contact-delete', contactId),
    localSnapshot: () => ipcRenderer.invoke('productivity:local-snapshot'),
    saveLocal: (snapshot) => ipcRenderer.invoke('productivity:local-save', snapshot),
    exportLocalData: () => ipcRenderer.invoke('productivity:local-export'),
    importLocalData: () => ipcRenderer.invoke('productivity:local-import')
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    openMessage: (input) => ipcRenderer.invoke('window:open-message', input)
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
      list: () => ipcRenderer.invoke('mail:accounts:list'),
      connect: () => ipcRenderer.invoke('mail:accounts:connect'),
      connectMicrosoft: () => ipcRenderer.invoke('mail:accounts:connect-microsoft'),
      connectImap: (input: ImapAccountInput) => ipcRenderer.invoke('mail:accounts:connect-imap', input),
      update: (input) => ipcRenderer.invoke('mail:accounts:update', input),
      verify: (accountId) => ipcRenderer.invoke('mail:accounts:verify', accountId),
      reconnect: (accountId) => ipcRenderer.invoke('mail:accounts:reconnect', accountId),
      imapSettings: (accountId) => ipcRenderer.invoke('mail:accounts:imap-settings', accountId),
      updateImap: (accountId, input) => ipcRenderer.invoke('mail:accounts:imap-update', accountId, input),
      disconnect: (accountId, mode) => ipcRenderer.invoke('mail:accounts:disconnect', accountId, mode)
    },
    mail: {
      labels: (accountIds) => ipcRenderer.invoke('mail:labels:list', accountIds),
      suggestRecipients: (query, accountIds) => ipcRenderer.invoke('mail:recipients:suggest', query, accountIds),
      list: (query: MailQuery) => ipcRenderer.invoke('mail:threads:list', query),
      unreadCounts: (accountIds) => ipcRenderer.invoke('mail:folders:unread-counts', accountIds),
      accountUnreadCounts: () => ipcRenderer.invoke('mail:accounts:unread-counts'),
      thread: (accountId, threadId, allowRemoteImages) => ipcRenderer.invoke('mail:threads:get', accountId, threadId, allowRemoteImages),
      source: (accountId, messageId) => ipcRenderer.invoke('mail:message:source', accountId, messageId),
      action: (input: ApplyMailActionInput) => ipcRenderer.invoke('mail:actions:apply', input),
      undo: (operationId) => ipcRenderer.invoke('mail:actions:undo', operationId),
      snooze: (accountId, threadIds, until) => ipcRenderer.invoke('mail:snooze', accountId, threadIds, until),
      unsnooze: (accountId, threadIds) => ipcRenderer.invoke('mail:unsnooze', accountId, threadIds)
    },
    drafts: {
      list: (accountIds) => ipcRenderer.invoke('mail:drafts:list', accountIds),
      get: (id) => ipcRenderer.invoke('mail:drafts:get', id),
      save: (input: MailDraftInput) => ipcRenderer.invoke('mail:drafts:save', input),
      send: (input: MailDraftInput) => ipcRenderer.invoke('mail:drafts:send', input),
      schedule: (input: MailDraftInput, deliveryAt) => ipcRenderer.invoke('mail:drafts:schedule', input, deliveryAt),
      cancelSend: (id) => ipcRenderer.invoke('mail:drafts:cancel-send', id),
      delete: (id) => ipcRenderer.invoke('mail:drafts:delete', id),
      stageMessageAttachments: (draftId, accountId, messageId) => ipcRenderer.invoke('mail:drafts:stage-message-attachments', draftId, accountId, messageId)
    },
    rules: {
      list: (accountIds) => ipcRenderer.invoke('mail:rules:list', accountIds),
      save: (input) => ipcRenderer.invoke('mail:rules:save', input),
      delete: (id) => ipcRenderer.invoke('mail:rules:delete', id),
      run: (id) => ipcRenderer.invoke('mail:rules:run', id)
    },
    sync: {
      start: (accountId) => ipcRenderer.invoke('mail:sync:start', accountId),
      pause: (accountId) => ipcRenderer.invoke('mail:sync:pause', accountId),
      resume: (accountId) => ipcRenderer.invoke('mail:sync:resume', accountId),
      rebuild: (accountId) => ipcRenderer.invoke('mail:sync:rebuild', accountId),
      progress: () => ipcRenderer.invoke('mail:sync:progress')
    },
    attachments: {
      open: (accountId, messageId, attachmentId, filename) => ipcRenderer.invoke('mail:attachment:open', accountId, messageId, attachmentId, filename),
      save: (accountId, messageId, attachmentId, filename) => ipcRenderer.invoke('mail:attachment:save', accountId, messageId, attachmentId, filename)
    },
    storage: () => ipcRenderer.invoke('mail:storage'),
    diagnostics: {
      health: () => ipcRenderer.invoke('mail:diagnostics:health'),
      export: () => ipcRenderer.invoke('mail:diagnostics:export')
    },
    onEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, value: MailWorkerEvent) => callback(value)
      ipcRenderer.on('mail:event', listener)
      return () => ipcRenderer.removeListener('mail:event', listener)
    }
  }
}

contextBridge.exposeInMainWorld('aerio', api)

const reportConnectivity = () => void ipcRenderer.invoke('mail:network', navigator.onLine)
window.addEventListener('online', reportConnectivity)
window.addEventListener('offline', reportConnectivity)
queueMicrotask(reportConnectivity)
