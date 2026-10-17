import { contextBridge, ipcRenderer } from 'electron'
import type { AerioDesktopApi, AppPreferences } from '../src/types'
import type { ApplyMailActionInput, MailDraftInput, MailWorkerEvent, ImapAccountInput, MailQuery } from '../src/mail-types'

const api: AerioDesktopApi = {
  loadPreferences: () => ipcRenderer.invoke('preferences:load'),
  savePreferences: (preferences: AppPreferences) => ipcRenderer.invoke('preferences:save', preferences),
  chooseAttachments: () => ipcRenderer.invoke('files:choose'),
  chooseProfileImage: () => ipcRenderer.invoke('profile:image:choose'),
  notify: (title: string, body: string) => ipcRenderer.invoke('notification:show', { title, body }),
  appLock: {
    status: () => ipcRenderer.invoke('app-lock:status'),
    enable: (passphrase) => ipcRenderer.invoke('app-lock:enable', passphrase),
    disable: (passphrase) => ipcRenderer.invoke('app-lock:disable', passphrase),
    lock: () => ipcRenderer.invoke('app-lock:lock'),
    unlock: (passphrase) => ipcRenderer.invoke('app-lock:unlock', passphrase),
    onStatus: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, status: import('../src/types').AppLockStatus) => callback(status)
      ipcRenderer.on('app-lock:status-changed', listener)
      return () => ipcRenderer.removeListener('app-lock:status-changed', listener)
    }
  },
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
  profileBackup: {
    status: () => ipcRenderer.invoke('profile-backup:status'),
    saveSchedule: (schedule) => ipcRenderer.invoke('profile-backup:schedule', schedule),
    chooseDirectory: () => ipcRenderer.invoke('profile-backup:choose-directory'),
    backupNow: () => ipcRenderer.invoke('profile-backup:backup-now'),
    preview: (path) => ipcRenderer.invoke('profile-backup:preview', path),
    restore: (path) => ipcRenderer.invoke('profile-backup:restore', path),
    dismissRestoreOutcome: () => ipcRenderer.invoke('profile-backup:dismiss-restore')
  },
  tasks: {
    createList: (accountId, title) => ipcRenderer.invoke('tasks:list:create', accountId, title),
    renameList: (listId, title) => ipcRenderer.invoke('tasks:list:rename', listId, title),
    deleteList: (listId) => ipcRenderer.invoke('tasks:list:delete', listId),
    resolveList: (id, resolution) => ipcRenderer.invoke('tasks:list:resolve', id, resolution),
    exportData: () => ipcRenderer.invoke('tasks:export'),
    importData: () => ipcRenderer.invoke('tasks:import'),
    snapshot: () => ipcRenderer.invoke('tasks:snapshot'),
    sync: (accountId) => ipcRenderer.invoke('tasks:sync', accountId),
    create: (accountId, listId, input, parentId, local) => ipcRenderer.invoke('tasks:create', accountId, listId, input, parentId, local),
    update: (id, patch, local) => ipcRenderer.invoke('tasks:update', id, patch, local),
    delete: (id) => ipcRenderer.invoke('tasks:delete', id),
    move: (id, parentId) => ipcRenderer.invoke('tasks:move', id, parentId),
    setLocal: (id, local) => ipcRenderer.invoke('tasks:local', id, local),
    undo: (id) => ipcRenderer.invoke('tasks:undo', id),
    resolve: (id, resolution) => ipcRenderer.invoke('tasks:resolve', id, resolution),
    onChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof callback>[0]) => callback(snapshot)
      ipcRenderer.on('tasks:changed', listener)
      return () => ipcRenderer.removeListener('tasks:changed', listener)
    }
  },
  productivity: {
    onChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, data: Parameters<typeof callback>[0]) => callback(data)
      ipcRenderer.on('productivity:changed', listener)
      return () => ipcRenderer.removeListener('productivity:changed', listener)
    },
    snapshot: () => ipcRenderer.invoke('productivity:snapshot'),
    sync: (accountId) => ipcRenderer.invoke('productivity:sync', accountId),
    createEvent: (event) => ipcRenderer.invoke('productivity:event-create', event),
    updateEvent: (event, scope) => scope ? ipcRenderer.invoke('productivity:event-update', event, scope) : ipcRenderer.invoke('productivity:event-update', event),
    deleteEvent: (eventId, scope) => scope ? ipcRenderer.invoke('productivity:event-delete', eventId, scope) : ipcRenderer.invoke('productivity:event-delete', eventId),
    respondToEvent: (eventId, input) => ipcRenderer.invoke('productivity:event-respond', eventId, input),
    invitations: {
      inspect: (accountId, messageId) => ipcRenderer.invoke('invitations:inspect', accountId, messageId),
      respond: (input) => ipcRenderer.invoke('invitations:respond', input),
      applyCancellation: (accountId, messageId) => ipcRenderer.invoke('invitations:apply-cancellation', accountId, messageId)
    },
    createContact: (accountId, contact) => ipcRenderer.invoke('productivity:contact-create', accountId, contact),
    updateContact: (contact) => ipcRenderer.invoke('productivity:contact-update', contact),
    deleteContact: (contactId) => ipcRenderer.invoke('productivity:contact-delete', contactId),
    createContactGroup: (accountId, name) => ipcRenderer.invoke('productivity:contact-group-create', accountId, name),
    renameContactGroup: (groupId, name) => ipcRenderer.invoke('productivity:contact-group-rename', groupId, name),
    deleteContactGroup: (groupId) => ipcRenderer.invoke('productivity:contact-group-delete', groupId),
    updateContactGroupMembers: (groupId, add, remove) => ipcRenderer.invoke('productivity:contact-group-members', groupId, add, remove),
    chooseNoteAttachments: () => ipcRenderer.invoke('productivity:note-attachments-choose'),
    openNoteAttachment: (path) => ipcRenderer.invoke('productivity:note-attachment-open', path),
    localSnapshot: () => ipcRenderer.invoke('productivity:local-snapshot'),
    saveLocal: (snapshot) => ipcRenderer.invoke('productivity:local-save', snapshot),
    exportLocalData: () => ipcRenderer.invoke('productivity:local-export'),
    importLocalData: () => ipcRenderer.invoke('productivity:local-import'),
    availability: (request) => ipcRenderer.invoke('productivity:availability', request)
  },
  contactMerge: {
    merges: () => ipcRenderer.invoke('contacts:merges'),
    mergeProvider: (input) => ipcRenderer.invoke('contacts:merge-provider', input),
    recordLocalMerge: (record) => ipcRenderer.invoke('contacts:merge-local-record', record),
    undo: (entryId) => ipcRenderer.invoke('contacts:merge-undo', entryId),
    associations: () => ipcRenderer.invoke('contacts:associations'),
    associate: (kind, firstId, secondId) => ipcRenderer.invoke('contacts:associate', kind, firstId, secondId),
    removeAssociation: (id) => ipcRenderer.invoke('contacts:association-remove', id)
  },
  interchange: {
    snapshot: () => ipcRenderer.invoke('interchange:snapshot'),
    onChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: import('../src/interchange-types').InterchangeSnapshot) => callback(snapshot)
      ipcRenderer.on('interchange:changed', listener)
      return () => ipcRenderer.removeListener('interchange:changed', listener)
    },
    chooseCalendarFile: () => ipcRenderer.invoke('interchange:calendar-file-choose'),
    chooseContactsFile: () => ipcRenderer.invoke('interchange:contacts-file-choose'),
    exportCalendar: (calendarIds) => ipcRenderer.invoke('interchange:calendar-export', calendarIds),
    exportContacts: (contactIds, format) => ipcRenderer.invoke('interchange:contacts-export', contactIds, format),
    saveLocalEvents: (target, events) => ipcRenderer.invoke('interchange:local-events-save', target, events),
    saveLocalEvent: (event) => ipcRenderer.invoke('interchange:local-event-save', event),
    deleteLocalEvent: (eventId) => ipcRenderer.invoke('interchange:local-event-delete', eventId),
    subscribe: (input) => ipcRenderer.invoke('interchange:subscribe', input),
    refresh: (calendarId) => ipcRenderer.invoke('interchange:refresh', calendarId),
    removeCalendar: (calendarId) => ipcRenderer.invoke('interchange:calendar-remove', calendarId)
  },
  dav: {
    snapshot: () => ipcRenderer.invoke('dav:snapshot'),
    onChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: import('../src/dav-types').DavSnapshot) => callback(snapshot)
      ipcRenderer.on('dav:changed', listener)
      return () => ipcRenderer.removeListener('dav:changed', listener)
    },
    addAccount: (input) => ipcRenderer.invoke('dav:account-add', input),
    updatePassword: (accountId, password) => ipcRenderer.invoke('dav:account-password', accountId, password),
    removeAccount: (accountId) => ipcRenderer.invoke('dav:account-remove', accountId),
    sync: (accountId) => ipcRenderer.invoke('dav:sync', accountId),
    syncAll: () => ipcRenderer.invoke('dav:sync-all'),
    setCollectionEnabled: (collectionId, enabled) => ipcRenderer.invoke('dav:collection-enabled', collectionId, enabled),
    resolve: (reviewId, resolution) => ipcRenderer.invoke('dav:resolve', reviewId, resolution)
  },
  // Matrix chat: display snapshots and commands only; tokens and keys never cross this bridge.
  chat: {
    snapshot: () => ipcRenderer.invoke('chat:snapshot'),
    discover: (input) => ipcRenderer.invoke('chat:discover', input),
    login: (input) => ipcRenderer.invoke('chat:login', input),
    removeAccount: (accountId) => ipcRenderer.invoke('chat:account:remove', accountId),
    clearHistory: (accountId) => ipcRenderer.invoke('chat:account:clear-history', accountId),
    updatePreferences: (accountId, preferences) => ipcRenderer.invoke('chat:account:preferences', accountId, preferences),
    timeline: (accountId, roomId) => ipcRenderer.invoke('chat:timeline', accountId, roomId),
    loadOlder: (accountId, roomId) => ipcRenderer.invoke('chat:timeline:older', accountId, roomId),
    search: (accountId, query) => ipcRenderer.invoke('chat:search', accountId, query),
    send: (accountId, roomId, body, replyTo) => ipcRenderer.invoke('chat:send', accountId, roomId, body, replyTo),
    edit: (accountId, roomId, targetId, body) => ipcRenderer.invoke('chat:edit', accountId, roomId, targetId, body),
    redact: (accountId, roomId, targetId) => ipcRenderer.invoke('chat:redact', accountId, roomId, targetId),
    react: (accountId, roomId, targetId, key) => ipcRenderer.invoke('chat:react', accountId, roomId, targetId, key),
    cancelOutgoing: (outboxId) => ipcRenderer.invoke('chat:outbox:cancel', outboxId),
    retryOutgoing: (outboxId) => ipcRenderer.invoke('chat:outbox:retry', outboxId),
    attach: (accountId, roomId) => ipcRenderer.invoke('chat:attach', accountId, roomId),
    saveMedia: (accountId, mediaId) => ipcRenderer.invoke('chat:media:save', accountId, mediaId),
    markRead: (accountId, roomId) => ipcRenderer.invoke('chat:read', accountId, roomId),
    roomAction: (accountId, roomId, action) => ipcRenderer.invoke('chat:room', accountId, roomId, action),
    devices: (accountId) => ipcRenderer.invoke('chat:devices', accountId),
    verifyOwnDevice: (accountId) => ipcRenderer.invoke('chat:verify-own', accountId),
    verificationAction: (accountId, requestId, action) => ipcRenderer.invoke('chat:verification', accountId, requestId, action),
    restoreFromRecoveryKey: (accountId, recoveryKey) => ipcRenderer.invoke('chat:recovery:restore', accountId, recoveryKey),
    setupRecovery: (accountId) => ipcRenderer.invoke('chat:recovery:setup', accountId),
    onEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, value: import('../src/chat-types').ChatEvent) => callback(value)
      ipcRenderer.on('chat:event', listener)
      return () => ipcRenderer.removeListener('chat:event', listener)
    }
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
  ai: {
    status: () => ipcRenderer.invoke('ai:status'),
    configure: (input) => ipcRenderer.invoke('ai:configure', input),
    summarize: (requestId, ref) => ipcRenderer.invoke('ai:summarize', requestId, ref),
    suggestReplies: (requestId, ref) => ipcRenderer.invoke('ai:replies', requestId, ref),
    compose: (requestId, input) => ipcRenderer.invoke('ai:compose', requestId, input),
    search: (requestId, request) => ipcRenderer.invoke('ai:search', requestId, request),
    cancel: (requestId) => ipcRenderer.invoke('ai:cancel', requestId)
  },
  openPgp: {
    status: () => ipcRenderer.invoke('openpgp:status'),
    generate: (input) => ipcRenderer.invoke('openpgp:generate', input),
    importText: (armored, passphrase) => ipcRenderer.invoke('openpgp:import-text', armored, passphrase),
    importFile: (passphrase) => ipcRenderer.invoke('openpgp:import-file', passphrase),
    exportPublic: (fingerprint) => ipcRenderer.invoke('openpgp:export-public', fingerprint),
    exportPrivate: (fingerprint, passphrase) => ipcRenderer.invoke('openpgp:export-private', fingerprint, passphrase),
    delete: (fingerprint) => ipcRenderer.invoke('openpgp:delete', fingerprint),
    setVerification: (fingerprint, state) => ipcRenderer.invoke('openpgp:verification', fingerprint, state),
    unlock: (fingerprint, passphrase) => ipcRenderer.invoke('openpgp:unlock', fingerprint, passphrase),
    forgetPassphrases: () => ipcRenderer.invoke('openpgp:forget'),
    preflight: (input) => ipcRenderer.invoke('openpgp:preflight', input),
    inspect: (ref) => ipcRenderer.invoke('openpgp:inspect', ref),
    decrypt: (ref, passphrase) => ipcRenderer.invoke('openpgp:decrypt', ref, passphrase),
    saveAttachment: (ref, index) => ipcRenderer.invoke('openpgp:save-attachment', ref, index)
  },
  smime: {
    status: () => ipcRenderer.invoke('smime:status'),
    importFile: () => ipcRenderer.invoke('smime:import-file'),
    retryImport: (password, passphrase) => ipcRenderer.invoke('smime:retry-import', password, passphrase),
    importText: (pem) => ipcRenderer.invoke('smime:import-text', pem),
    exportCertificate: (fingerprint) => ipcRenderer.invoke('smime:export-certificate', fingerprint),
    exportPkcs12: (fingerprint, passphrase, exportPassword) => ipcRenderer.invoke('smime:export-pkcs12', fingerprint, passphrase, exportPassword),
    delete: (fingerprint) => ipcRenderer.invoke('smime:delete', fingerprint),
    setTrusted: (fingerprint, trusted) => ipcRenderer.invoke('smime:trust', fingerprint, trusted),
    unlock: (fingerprint, passphrase) => ipcRenderer.invoke('smime:unlock', fingerprint, passphrase),
    forgetPassphrases: () => ipcRenderer.invoke('smime:forget'),
    preflight: (input) => ipcRenderer.invoke('smime:preflight', input),
    identityDefault: (sender) => ipcRenderer.invoke('smime:identity-default', sender),
    setIdentityDefault: (sender, value) => ipcRenderer.invoke('smime:set-identity-default', sender, value),
    inspect: (ref) => ipcRenderer.invoke('smime:inspect', ref),
    decrypt: (ref, passphrase) => ipcRenderer.invoke('smime:decrypt', ref, passphrase),
    saveAttachment: (ref, index) => ipcRenderer.invoke('smime:save-attachment', ref, index)
  },
  mail: {
    messageTools: {
      updateLocal: (ref, updates) => ipcRenderer.invoke('mail:message:local', ref, updates),
      save: (ref) => ipcRenderer.invoke('mail:message:save', ref),
      saveAttachments: (ref) => ipcRenderer.invoke('mail:message:save-attachments', ref),
      copy: (ref, destination) => ipcRenderer.invoke('mail:message:copy', ref, destination),
      print: (ref, format) => ipcRenderer.invoke('mail:message:print', ref, format),
      createTask: (ref, input) => ipcRenderer.invoke('mail:message:create-task', ref, input),
      addNote: (ref, input) => ipcRenderer.invoke('mail:message:add-note', ref, input),
      notes: (ref) => ipcRenderer.invoke('mail:message:notes', ref),
      translate: (ref, input) => ipcRenderer.invoke('mail:message:translate', ref, input),
      unsubscribeInfo: (ref) => ipcRenderer.invoke('mail:message:unsubscribe-info', ref),
      unsubscribe: (ref, request) => ipcRenderer.invoke('mail:message:unsubscribe', ref, request)
    },
    automaticReplies: {
      get: (accountId) => ipcRenderer.invoke('mail:automatic-replies:get', accountId),
      update: (accountId, settings) => ipcRenderer.invoke('mail:automatic-replies:update', accountId, settings),
      disable: (accountId) => ipcRenderer.invoke('mail:automatic-replies:disable', accountId)
    },
    cloudAttachments: {
      status: (accountId) => ipcRenderer.invoke('mail:cloud:status', accountId),
      connect: (accountId) => ipcRenderer.invoke('mail:cloud:connect', accountId),
      upload: (uploadId, accountId, path, share) => ipcRenderer.invoke('mail:cloud:upload', uploadId, accountId, path, share),
      cancel: (uploadId) => ipcRenderer.invoke('mail:cloud:cancel', uploadId),
      pending: (accountId) => ipcRenderer.invoke('mail:cloud:pending', accountId),
      resume: (uploadId) => ipcRenderer.invoke('mail:cloud:resume', uploadId),
      discard: (uploadId) => ipcRenderer.invoke('mail:cloud:discard', uploadId),
      verify: (accountId, urls) => ipcRenderer.invoke('mail:cloud:verify', accountId, urls),
      onProgress: (callback) => {
        const listener = (_event: Electron.IpcRendererEvent, value: import('../src/cloud-attachment-types').CloudUploadProgress) => callback(value)
        ipcRenderer.on('mail:cloud:progress', listener)
        return () => ipcRenderer.removeListener('mail:cloud:progress', listener)
      }
    },
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
    templates: {
      list: (query) => ipcRenderer.invoke('mail:templates:list', query),
      save: (input) => ipcRenderer.invoke('mail:templates:save', input),
      delete: (id) => ipcRenderer.invoke('mail:templates:delete', id),
      use: (id) => ipcRenderer.invoke('mail:templates:use', id),
      exportBackup: () => ipcRenderer.invoke('mail:templates:export'),
      importBackup: () => ipcRenderer.invoke('mail:templates:import')
    },
    identities: {
      list: (accountIds) => ipcRenderer.invoke('mail:identities:list', accountIds),
      save: (input) => ipcRenderer.invoke('mail:identities:save', input),
      delete: (id) => ipcRenderer.invoke('mail:identities:delete', id),
      refresh: (accountId) => ipcRenderer.invoke('mail:identities:refresh', accountId),
      signatures: {
        list: () => ipcRenderer.invoke('mail:signatures:list'),
        save: (input) => ipcRenderer.invoke('mail:signatures:save', input),
        delete: (id) => ipcRenderer.invoke('mail:signatures:delete', id)
      }
    },
    merge: {
      list: () => ipcRenderer.invoke('mail:merge:list'),
      get: (id) => ipcRenderer.invoke('mail:merge:get', id),
      create: (input) => ipcRenderer.invoke('mail:merge:create', input),
      pause: (id) => ipcRenderer.invoke('mail:merge:pause', id),
      resume: (id) => ipcRenderer.invoke('mail:merge:resume', id),
      cancel: (id) => ipcRenderer.invoke('mail:merge:cancel', id),
      resolve: (id, positions, resolution) => ipcRenderer.invoke('mail:merge:resolve', id, positions, resolution),
      delete: (id) => ipcRenderer.invoke('mail:merge:delete', id)
    },
    replyWatches: {
      list: (accountIds) => ipcRenderer.invoke('mail:reply-watches:list', accountIds),
      create: (input) => ipcRenderer.invoke('mail:reply-watches:create', input),
      cancel: (id) => ipcRenderer.invoke('mail:reply-watches:cancel', id)
    },
    folders: {
      create: (input) => ipcRenderer.invoke('mail:folders:create', input),
      update: (input) => ipcRenderer.invoke('mail:folders:update', input),
      delete: (input) => ipcRenderer.invoke('mail:folders:delete', input),
      deletePreview: (accountId, labelId) => ipcRenderer.invoke('mail:folders:delete-preview', accountId, labelId)
    },
    folderPreferences: {
      get: () => ipcRenderer.invoke('mail:folder-preferences:get'),
      addFavorite: (accountId, labelId) => ipcRenderer.invoke('mail:folder-preferences:add-favorite', accountId, labelId),
      removeFavorite: (accountId, labelId) => ipcRenderer.invoke('mail:folder-preferences:remove-favorite', accountId, labelId),
      reorderFavorites: (order) => ipcRenderer.invoke('mail:folder-preferences:reorder', order),
      setFavoriteAlias: (accountId, labelId, alias) => ipcRenderer.invoke('mail:folder-preferences:set-alias', accountId, labelId, alias),
      setAppearance: (input) => ipcRenderer.invoke('mail:folder-preferences:set-appearance', input)
    },
    rules: {
      list: (accountIds) => ipcRenderer.invoke('mail:rules:list', accountIds),
      save: (input) => ipcRenderer.invoke('mail:rules:save', input),
      delete: (id) => ipcRenderer.invoke('mail:rules:delete', id),
      run: (id) => ipcRenderer.invoke('mail:rules:run', id)
    },
    serverRules: {
      capabilities: (accountId) => ipcRenderer.invoke('mail:server-rules:capabilities', accountId),
      list: (accountId) => ipcRenderer.invoke('mail:server-rules:list', accountId),
      upload: (ruleId) => ipcRenderer.invoke('mail:server-rules:upload', ruleId),
      delete: (accountId, serverRuleId) => ipcRenderer.invoke('mail:server-rules:delete', accountId, serverRuleId),
      setEnabled: (accountId, serverRuleId, enabled) => ipcRenderer.invoke('mail:server-rules:set-enabled', accountId, serverRuleId, enabled)
    },
    savedSearches: {
      list: () => ipcRenderer.invoke('mail:saved-searches:list'),
      save: (input) => ipcRenderer.invoke('mail:saved-searches:save', input),
      delete: (id) => ipcRenderer.invoke('mail:saved-searches:delete', id)
    },
    receipts: {
      inspect: (accountId, messageId) => ipcRenderer.invoke('mail:receipts:inspect', accountId, messageId),
      respond: (accountId, messageId, decision) => ipcRenderer.invoke('mail:receipts:respond', accountId, messageId, decision)
    },
    quickActions: {
      list: () => ipcRenderer.invoke('mail:quick-actions:list'),
      save: (input) => ipcRenderer.invoke('mail:quick-actions:save', input),
      delete: (id) => ipcRenderer.invoke('mail:quick-actions:delete', id),
      run: (id, targets) => ipcRenderer.invoke('mail:quick-actions:run', id, targets)
    },
    imports: {
      ensureLocalFolders: () => ipcRenderer.invoke('mail:local:ensure'),
      choose: (kind) => ipcRenderer.invoke('mail:import:choose', kind),
      start: (input) => ipcRenderer.invoke('mail:import:start', input),
      list: () => ipcRenderer.invoke('mail:import:list'),
      pause: (id) => ipcRenderer.invoke('mail:import:pause', id),
      resume: (id) => ipcRenderer.invoke('mail:import:resume', id),
      cancel: (id) => ipcRenderer.invoke('mail:import:cancel', id),
      dismiss: (id) => ipcRenderer.invoke('mail:import:dismiss', id),
      items: (jobId) => ipcRenderer.invoke('mail:import:items', jobId),
      resolve: (jobId, keys, decision) => ipcRenderer.invoke('mail:import:resolve', jobId, keys, decision),
      transfer: (input) => ipcRenderer.invoke('mail:local:transfer', input)
    },
    sync: {
      start: (accountId) => ipcRenderer.invoke('mail:sync:start', accountId),
      pause: (accountId) => ipcRenderer.invoke('mail:sync:pause', accountId),
      resume: (accountId) => ipcRenderer.invoke('mail:sync:resume', accountId),
      rebuild: (accountId) => ipcRenderer.invoke('mail:sync:rebuild', accountId),
      progress: () => ipcRenderer.invoke('mail:sync:progress')
    },
    attachments: {
      list: (query) => ipcRenderer.invoke('mail:attachments:list', query),
      open: (accountId, messageId, attachmentId, filename) => ipcRenderer.invoke('mail:attachment:open', accountId, messageId, attachmentId, filename),
      save: (accountId, messageId, attachmentId, filename) => ipcRenderer.invoke('mail:attachment:save', accountId, messageId, attachmentId, filename)
    },
    contactHistory: {
      messages: (query) => ipcRenderer.invoke('mail:contact-history:messages', query)
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
