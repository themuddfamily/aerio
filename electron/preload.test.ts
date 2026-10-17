// @vitest-environment jsdom

import { beforeAll, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: any[]) => void>>()
  return {
    exposed: {} as Record<string, any>,
    listeners,
    contextBridge: {
      exposeInMainWorld: vi.fn((name: string, value: any) => { mocks.exposed[name] = value })
    },
    ipcRenderer: {
      invoke: vi.fn(async (channel: string, ...args: any[]) => ({ channel, args })),
      on: vi.fn((channel: string, listener: (...args: any[]) => void) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), listener])
      }),
      removeListener: vi.fn((channel: string, listener: (...args: any[]) => void) => {
        listeners.set(channel, (listeners.get(channel) ?? []).filter((value) => value !== listener))
      })
    }
  }
})

vi.mock('electron', () => ({ contextBridge: mocks.contextBridge, ipcRenderer: mocks.ipcRenderer }))

import './preload'

const api = () => mocks.exposed.aerio

describe('preload bridge', () => {
  beforeAll(async () => { await Promise.resolve() })

  it('exposes app, update, productivity, and window commands with exact IPC channels', async () => {
    expect(mocks.contextBridge.exposeInMainWorld).toHaveBeenCalledWith('aerio', expect.any(Object))
    await api().loadPreferences()
    await api().savePreferences({ theme: 'dark' })
    await api().chooseAttachments()
    await api().chooseProfileImage()
    await api().notify('Title', 'Body')
    await api().appLock.status()
    await api().appLock.enable('long passphrase')
    await api().appLock.disable('long passphrase')
    await api().appLock.lock()
    await api().appLock.unlock('long passphrase')
    await api().updates.status()
    await api().updates.check()
    await api().updates.download()
    await api().updates.install()
    await api().productivity.snapshot()
    await api().productivity.sync('account-1')
    await api().productivity.createEvent({ title: 'Event' })
    await api().productivity.updateEvent({ id: 'event-1' })
    await api().productivity.deleteEvent('event-1')
    await api().productivity.createContact('account-1', { id: 'contact-1', name: 'Ada' })
    await api().productivity.updateContact({ id: 'contact-1', name: 'Ada' })
    await api().productivity.deleteContact('contact-1')
    await api().productivity.chooseNoteAttachments()
    await api().productivity.openNoteAttachment('C:\\aerio\\note.txt')
    await api().productivity.localSnapshot()
    await api().productivity.saveLocal({ notes: [] })
    await api().productivity.exportLocalData()
    await api().productivity.importLocalData()
    await api().productivity.availability({ calendarId: 'calendar-1', attendees: ['a@example.com'], start: '2026-10-20T00:00:00Z', end: '2026-10-21T00:00:00Z' })
    await api().window.minimize()
    await api().window.maximize()
    await api().window.close()
    await api().window.isMaximized()
    await api().window.openMessage({ accountId: 'account-1', messageId: 'message-1' })

    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('preferences:save', { theme: 'dark' })
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('notification:show', { title: 'Title', body: 'Body' })
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('app-lock:enable', 'long passphrase')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('app-lock:disable', 'long passphrase')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('app-lock:lock')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('app-lock:unlock', 'long passphrase')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('productivity:sync', 'account-1')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('productivity:availability', { calendarId: 'calendar-1', attendees: ['a@example.com'], start: '2026-10-20T00:00:00Z', end: '2026-10-21T00:00:00Z' })
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('productivity:contact-create', 'account-1', { id: 'contact-1', name: 'Ada' })
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('productivity:contact-update', { id: 'contact-1', name: 'Ada' })
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('productivity:contact-delete', 'contact-1')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('productivity:note-attachments-choose')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('productivity:note-attachment-open', 'C:\\aerio\\note.txt')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('productivity:local-export')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('productivity:local-import')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('window:open-message', { accountId: 'account-1', messageId: 'message-1' })
  })

  it('exposes full-profile backup commands with exact IPC channels', async () => {
    const schedule = { enabled: true, intervalHours: 24, keep: 7, directory: 'C:\Backups' }
    await api().profileBackup.status()
    await api().profileBackup.saveSchedule(schedule)
    await api().profileBackup.chooseDirectory()
    await api().profileBackup.backupNow()
    await api().profileBackup.preview()
    await api().profileBackup.preview('C:\Backups\aerio-profile-1')
    await api().profileBackup.restore('C:\Backups\aerio-profile-1')
    await api().profileBackup.dismissRestoreOutcome()
    for (const channel of ['profile-backup:status', 'profile-backup:choose-directory', 'profile-backup:backup-now', 'profile-backup:dismiss-restore']) expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith(channel)
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('profile-backup:schedule', schedule)
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('profile-backup:preview', undefined)
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('profile-backup:preview', 'C:\Backups\aerio-profile-1')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('profile-backup:restore', 'C:\Backups\aerio-profile-1')
  })

  it('forwards and unsubscribes update, lock, window, compose, and mail events', () => {
    const update = vi.fn()
    const lock = vi.fn()
    const windowState = vi.fn()
    const compose = vi.fn()
    const mail = vi.fn()
    const stopUpdate = api().updates.onStatus(update)
    const stopLock = api().appLock.onStatus(lock)
    const stopWindow = api().onWindowState(windowState)
    const stopCompose = api().onComposeCommand(compose)
    const stopMail = api().mail.onEvent(mail)

    mocks.listeners.get('app:update:status-changed')?.[0]({}, { phase: 'ready' })
    mocks.listeners.get('app-lock:status-changed')?.[0]({}, { enabled: true, locked: true })
    mocks.listeners.get('window:maximized-state')?.[0]({}, true)
    mocks.listeners.get('command:compose')?.[0]({})
    mocks.listeners.get('mail:event')?.[0]({}, { type: 'sync-progress' })
    expect(update).toHaveBeenCalledWith({ phase: 'ready' })
    expect(lock).toHaveBeenCalledWith({ enabled: true, locked: true })
    expect(windowState).toHaveBeenCalledWith(true)
    expect(compose).toHaveBeenCalledOnce()
    expect(mail).toHaveBeenCalledWith({ type: 'sync-progress' })

    stopUpdate(); stopLock(); stopWindow(); stopCompose(); stopMail()
    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledWith('app:update:status-changed', expect.any(Function))
    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledWith('app-lock:status-changed', expect.any(Function))
    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledWith('window:maximized-state', expect.any(Function))
    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledWith('command:compose', expect.any(Function))
    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledWith('mail:event', expect.any(Function))
  })

  it('exposes every mail credential, account, message, draft, rule, sync, attachment, and diagnostic operation', async () => {
    const mail = api().mail
    await mail.credentials.status()
    await mail.credentials.import()
    await mail.credentials.microsoftStatus()
    await mail.credentials.configureMicrosoft('client-id')
    await mail.presets()
    await mail.accounts.list()
    await mail.accounts.connect()
    await mail.accounts.connectMicrosoft()
    await mail.accounts.connectImap({ email: 'imap@example.test' })
    await mail.accounts.update({ accountId: 'account-1' })
    await mail.accounts.verify('account-1')
    await mail.accounts.reconnect('account-1')
    await mail.accounts.imapSettings('account-1')
    await mail.accounts.updateImap('account-1', { imapHost: 'host' })
    await mail.accounts.disconnect('account-1', 'archive')
    await mail.mail.labels(['account-1'])
    await mail.mail.suggestRecipients('ada', ['account-1'])
    await mail.mail.list({ folder: 'inbox' })
    await mail.mail.unreadCounts(['account-1'])
    await mail.mail.accountUnreadCounts()
    await mail.mail.thread('account-1', 'thread-1', true)
    await mail.mail.source('account-1', 'message-1')
    await mail.mail.action({ accountId: 'account-1', threadIds: ['thread-1'], action: 'archive' })
    await mail.mail.undo('operation-1')
    await mail.mail.snooze('account-1', ['thread-1'], '2026-08-09T10:00:00Z')
    await mail.mail.unsnooze('account-1', ['thread-1'])
    await mail.drafts.list(['account-1'])
    await mail.drafts.get('draft-1')
    await mail.drafts.save({ id: 'draft-1' })
    await mail.drafts.send({ id: 'draft-1' })
    await mail.drafts.schedule({ id: 'draft-1' }, '2026-08-09T10:00:00Z')
    await mail.drafts.cancelSend('draft-1')
    await mail.drafts.delete('draft-1')
    await mail.drafts.stageMessageAttachments('draft-1', 'account-1', 'message-1')
    await mail.rules.list(['account-1'])
    await mail.rules.save({ name: 'Rule' })
    await mail.rules.delete('rule-1')
    await mail.rules.run('rule-1')
    await mail.serverRules!.capabilities('account-1')
    await mail.serverRules!.list('account-1')
    await mail.serverRules!.upload('rule-1')
    await mail.serverRules!.delete('account-1', 'filter-1')
    await mail.serverRules!.setEnabled('account-1', 'filter-1', false)
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('mail:server-rules:upload', 'rule-1')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('mail:server-rules:delete', 'account-1', 'filter-1')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('mail:server-rules:set-enabled', 'account-1', 'filter-1', false)
    await mail.savedSearches.list()
    await mail.savedSearches.save({ name: 'Invoices', query: 'invoice', folder: 'all', filters: {} })
    await mail.savedSearches.delete('search-1')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('mail:saved-searches:list')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('mail:saved-searches:save', expect.objectContaining({ name: 'Invoices' }))
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('mail:saved-searches:delete', 'search-1')
    await mail.quickActions.list()
    await mail.quickActions.save({ name: 'Triage', steps: [{ action: 'read' }], showInToolbar: true })
    await mail.quickActions.delete('quick-1')
    await mail.quickActions.run('quick-1', [{ accountId: 'account-1', threadIds: ['thread-1'] }])
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('mail:quick-actions:list')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('mail:quick-actions:save', expect.objectContaining({ name: 'Triage' }))
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('mail:quick-actions:delete', 'quick-1')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('mail:quick-actions:run', 'quick-1', [{ accountId: 'account-1', threadIds: ['thread-1'] }])
    const imports = mail.imports!
    await imports.ensureLocalFolders()
    await imports.choose('folder')
    await imports.start({ paths: ['C:\\mail'], duplicates: 'review', mboxVariant: 'mboxrd' })
    await imports.list()
    await imports.pause('job-1')
    await imports.resume('job-1')
    await imports.cancel('job-1')
    await imports.dismiss('job-1')
    await imports.items('job-1')
    await imports.resolve('job-1', ['0:0'], 'discard')
    await imports.transfer({ sourceAccountId: 'account-1', threadIds: ['thread-1'], destinationLabelId: 'folder:local-1', mode: 'copy' })
    for (const channel of ['mail:local:ensure', 'mail:import:list']) expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith(channel)
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('mail:import:choose', 'folder')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('mail:import:start', expect.objectContaining({ paths: ['C:\\mail'] }))
    for (const action of ['pause', 'resume', 'cancel', 'dismiss', 'items']) expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith(`mail:import:${action}`, 'job-1')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('mail:import:resolve', 'job-1', ['0:0'], 'discard')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('mail:local:transfer', expect.objectContaining({ mode: 'copy' }))
    await mail.templates.list('welcome')
    await mail.templates.save({ kind: 'snippet', name: 'Hi', html: 'Hi' })
    await mail.templates.delete('template-1')
    await mail.templates.use('template-1')
    await mail.templates.exportBackup()
    await mail.templates.importBackup()
    await mail.identities.list(['account-1'])
    await mail.identities.save({ accountId: 'account-1', email: 'alias@example.com', name: 'Alias' })
    await mail.identities.delete('alias')
    await mail.identities.refresh('account-1')
    await mail.identities.signatures.list()
    await mail.identities.signatures.save({ name: 'Work', html: '<b>Work</b>' })
    await mail.identities.signatures.delete('signature')
    await mail.sync.start('account-1')
    await mail.sync.pause('account-1')
    await mail.sync.resume('account-1')
    await mail.sync.rebuild('account-1')
    await mail.sync.progress()
    await mail.attachments.list({ fileTypes: ['pdf'] })
    await mail.attachments.open('account-1', 'message-1', 'attachment-1', 'file.txt')
    await mail.attachments.save('account-1', 'message-1', 'attachment-1', 'file.txt')
    await mail.storage()
    await mail.diagnostics.health()
    await mail.diagnostics.export()

    const channels = mocks.ipcRenderer.invoke.mock.calls.map((call) => call[0])
    for (const expected of [
      'gmail:credentials:status', 'mail:credentials:microsoft-configure', 'mail:providers:presets',
      'mail:accounts:connect-imap', 'mail:accounts:imap-update', 'mail:threads:list', 'mail:folders:unread-counts', 'mail:accounts:unread-counts', 'mail:message:source',
      'mail:drafts:schedule', 'mail:rules:run', 'mail:server-rules:capabilities', 'mail:server-rules:list', 'mail:sync:rebuild', 'mail:attachment:save', 'mail:diagnostics:export',
      'mail:templates:list', 'mail:templates:save', 'mail:templates:delete', 'mail:templates:use', 'mail:templates:export', 'mail:templates:import',
      'mail:identities:list', 'mail:identities:save', 'mail:identities:delete', 'mail:identities:refresh', 'mail:signatures:list', 'mail:signatures:save', 'mail:signatures:delete'
    ]) expect(channels).toContain(expected)
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('mail:snooze', 'account-1', ['thread-1'], '2026-08-09T10:00:00Z')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('mail:attachments:list', { fileTypes: ['pdf'] })
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('mail:attachment:open', 'account-1', 'message-1', 'attachment-1', 'file.txt')
  })

  it('exposes the optional AI assistant without any send or mutate channel', async () => {
    const ai = api().ai
    const ref = { accountId: 'account-1', threadId: 'thread-1', messageId: 'message-1' }
    await ai.status()
    await ai.configure({ enabled: true })
    await ai.summarize('r1', ref)
    await ai.suggestReplies('r2', ref)
    await ai.compose('r3', { instruction: 'Shorter', draft: 'Hi' })
    await ai.search('r4', 'invoices')
    await ai.cancel('r4')
    for (const [channel, ...args] of [['ai:status'], ['ai:configure', { enabled: true }], ['ai:summarize', 'r1', ref], ['ai:replies', 'r2', ref], ['ai:compose', 'r3', { instruction: 'Shorter', draft: 'Hi' }], ['ai:search', 'r4', 'invoices'], ['ai:cancel', 'r4']] as const) {
      expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith(channel, ...args)
    }
    expect(Object.keys(ai).sort()).toEqual(['cancel', 'compose', 'configure', 'search', 'status', 'suggestReplies', 'summarize'])
  })

  it('exposes OpenPGP key management and message crypto with exact IPC channels', async () => {
    const openPgp = api().openPgp!
    const ref = { accountId: 'a', threadId: 't', messageId: 'm' }
    const calls: [string, ...unknown[]][] = []
    const call = async (promise: Promise<unknown>, channel: string, ...args: unknown[]) => { await promise; calls.push([channel, ...args]) }
    await call(openPgp.status(), 'openpgp:status')
    await call(openPgp.generate({ name: 'A', email: 'a@example.test', passphrase: 'p' }), 'openpgp:generate', { name: 'A', email: 'a@example.test', passphrase: 'p' })
    await call(openPgp.importText('key', 'pass'), 'openpgp:import-text', 'key', 'pass')
    await call(openPgp.importFile(), 'openpgp:import-file', undefined)
    await call(openPgp.exportPublic('F'), 'openpgp:export-public', 'F')
    await call(openPgp.exportPrivate('F', 'p'), 'openpgp:export-private', 'F', 'p')
    await call(openPgp.delete('F'), 'openpgp:delete', 'F')
    await call(openPgp.setVerification('F', 'verified'), 'openpgp:verification', 'F', 'verified')
    await call(openPgp.unlock('F', 'p'), 'openpgp:unlock', 'F', 'p')
    await call(openPgp.forgetPassphrases(), 'openpgp:forget')
    await call(openPgp.preflight({ accountId: 'a', recipients: [], options: {} }), 'openpgp:preflight', { accountId: 'a', recipients: [], options: {} })
    await call(openPgp.inspect(ref), 'openpgp:inspect', ref)
    await call(openPgp.decrypt(ref, 'p'), 'openpgp:decrypt', ref, 'p')
    await call(openPgp.saveAttachment(ref, 0), 'openpgp:save-attachment', ref, 0)
    for (const [channel, ...args] of calls) expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith(channel, ...args)
    expect(Object.keys(openPgp)).toHaveLength(calls.length)
  })

  it('exposes provider automatic replies with exact IPC channels', async () => {
    const replies = api().mail.automaticReplies
    const settings = { enabled: true, subject: 'Away', internalMessage: 'Back Monday', externalMessage: '', externalAudience: 'all' }
    await replies.get('account-1')
    await replies.update('account-1', settings)
    await replies.disable('account-1')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('mail:automatic-replies:get', 'account-1')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('mail:automatic-replies:update', 'account-1', settings)
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('mail:automatic-replies:disable', 'account-1')
  })

  it('exposes cloud attachments with exact IPC channels and a removable progress listener', async () => {
    const cloud = api().mail.cloudAttachments
    const share = { audience: 'anyone', role: 'view' }
    const calls: Array<[string, unknown[], () => Promise<unknown>]> = [
      ['mail:cloud:status', ['account-1'], () => cloud.status('account-1')],
      ['mail:cloud:connect', ['account-1'], () => cloud.connect('account-1')],
      ['mail:cloud:upload', ['upload-1', 'account-1', 'C:\\file.pdf', share], () => cloud.upload('upload-1', 'account-1', 'C:\\file.pdf', share)],
      ['mail:cloud:cancel', ['upload-1'], () => cloud.cancel('upload-1')],
      ['mail:cloud:pending', ['account-1'], () => cloud.pending('account-1')],
      ['mail:cloud:resume', ['upload-1'], () => cloud.resume('upload-1')],
      ['mail:cloud:discard', ['upload-1'], () => cloud.discard('upload-1')],
      ['mail:cloud:verify', ['account-1', ['https://x.test']], () => cloud.verify('account-1', ['https://x.test'])]
    ]
    for (const [channel, args, call] of calls) {
      await call()
      expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith(channel, ...args)
    }
    const progress = vi.fn()
    const stop = cloud.onProgress(progress)
    mocks.listeners.get('mail:cloud:progress')?.[0]({}, { uploadId: 'upload-1', sentBytes: 1 })
    expect(progress).toHaveBeenCalledWith({ uploadId: 'upload-1', sentBytes: 1 })
    stop()
    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledWith('mail:cloud:progress', expect.any(Function))
  })

  it('reports initial and changing network connectivity', async () => {
    window.dispatchEvent(new Event('offline'))
    window.dispatchEvent(new Event('online'))
    await Promise.resolve()
    const networkCalls = mocks.ipcRenderer.invoke.mock.calls.filter((call) => call[0] === 'mail:network')
    expect(networkCalls.length).toBeGreaterThanOrEqual(3)
    expect(networkCalls.every((call) => typeof call[1] === 'boolean')).toBe(true)
  })
})
