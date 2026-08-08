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
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('productivity:contact-create', 'account-1', { id: 'contact-1', name: 'Ada' })
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('productivity:contact-update', { id: 'contact-1', name: 'Ada' })
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('productivity:contact-delete', 'contact-1')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('productivity:note-attachments-choose')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('productivity:note-attachment-open', 'C:\\aerio\\note.txt')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('productivity:local-export')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('productivity:local-import')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('window:open-message', { accountId: 'account-1', messageId: 'message-1' })
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
    await mail.sync.start('account-1')
    await mail.sync.pause('account-1')
    await mail.sync.resume('account-1')
    await mail.sync.rebuild('account-1')
    await mail.sync.progress()
    await mail.attachments.open('account-1', 'message-1', 'attachment-1', 'file.txt')
    await mail.attachments.save('account-1', 'message-1', 'attachment-1', 'file.txt')
    await mail.storage()
    await mail.diagnostics.health()
    await mail.diagnostics.export()

    const channels = mocks.ipcRenderer.invoke.mock.calls.map((call) => call[0])
    for (const expected of [
      'gmail:credentials:status', 'mail:credentials:microsoft-configure', 'mail:providers:presets',
      'mail:accounts:connect-imap', 'mail:accounts:imap-update', 'mail:threads:list', 'mail:folders:unread-counts', 'mail:accounts:unread-counts', 'mail:message:source',
      'mail:drafts:schedule', 'mail:rules:run', 'mail:sync:rebuild', 'mail:attachment:save', 'mail:diagnostics:export'
    ]) expect(channels).toContain(expected)
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('mail:snooze', 'account-1', ['thread-1'], '2026-08-09T10:00:00Z')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('mail:attachment:open', 'account-1', 'message-1', 'attachment-1', 'file.txt')
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
