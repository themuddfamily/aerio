import { describe, expect, it, vi } from 'vitest'
import { registerMailboxOwnerIpc, validateAttachMailbox, validateSaveDelegate } from './mailbox-owner-ipc'

function harness(locked = false) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const request = vi.fn(async (command: { type: string; payload?: unknown }) => command.type === 'owners:list' ? [] : { ok: command.type })
  const productivityChanged = vi.fn()
  let isLocked = locked
  registerMailboxOwnerIpc({
    ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(channel, handler) } } as never,
    worker: () => ({ request }) as never,
    isLocked: () => isLocked,
    productivityChanged
  })
  const invoke = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
  return { handlers, request, productivityChanged, invoke, lock: (value: boolean) => { isLocked = value } }
}

const delegate = { address: 'Bob@Contoso.test', permissions: { calendar: 'Editor', tasks: 'None', inbox: 'Reviewer', contacts: 'None', notes: 'None' }, receiveCopiesOfMeetingMessages: true, viewPrivateItems: false }

describe('shared mailbox IPC', () => {
  it('validates attach and delegate payloads before they reach the worker', () => {
    expect(validateAttachMailbox({ accountId: 'a', address: ' Team@Contoso.TEST ', kind: 'shared', sendMode: 'send-as', displayName: ' Team ' }))
      .toEqual({ accountId: 'a', address: 'team@contoso.test', kind: 'shared', sendMode: 'send-as', displayName: 'Team' })
    expect(() => validateAttachMailbox({ accountId: 'a', address: 'not-an-address', kind: 'shared' })).toThrow(/valid mailbox address/)
    expect(() => validateAttachMailbox({ accountId: 'a', address: 'team@contoso.test', kind: 'owner' })).toThrow(/shared or delegated/)
    expect(() => validateAttachMailbox({ accountId: 'a', address: 'team@contoso.test', kind: 'shared', sendMode: 'impersonate' })).toThrow(/how to send/)
    expect(() => validateAttachMailbox({ accountId: 'a', address: 'team@contoso.test', kind: 'shared', displayName: 'a\u0000b' })).toThrow(/display name/)
    expect(validateSaveDelegate({ accountId: 'a', mode: 'add', delegate, deliverMeetingRequests: 'DelegatesAndMe' }).delegate.address).toBe('bob@contoso.test')
    expect(() => validateSaveDelegate({ accountId: 'a', mode: 'add', delegate: { ...delegate, permissions: { ...delegate.permissions, calendar: 'Owner' } } })).toThrow(/None, Reviewer, Author, or Editor/)
    expect(() => validateSaveDelegate({ accountId: 'a', mode: 'add', delegate: { ...delegate, viewPrivateItems: 'yes' } })).toThrow(/private item/)
    expect(() => validateSaveDelegate({ accountId: 'a', mode: 'add', delegate, deliverMeetingRequests: 'Everyone' })).toThrow(/who receives meeting requests/)
    expect(() => validateSaveDelegate({ accountId: 'a', mode: 'replace', delegate })).toThrow(/add or update/)
  })

  it('maps each channel to its worker command and refreshes shared calendars after changes', async () => {
    const h = harness()
    await h.invoke('mailbox-owners:list', 'a')
    await h.invoke('mailbox-owners:discover', 'a')
    await h.invoke('mailbox-owners:attach', { accountId: 'a', address: 'team@contoso.test', kind: 'delegated' })
    await h.invoke('mailbox-owners:update', { accountId: 'a', ownerId: 'mbx-1', sendMode: 'none' })
    await h.invoke('mailbox-owners:remove', 'a', 'mbx-1')
    await h.invoke('mailbox-owners:sync', 'a')
    await h.invoke('mailbox-owners:public-folders', 'a', 'F1')
    await h.invoke('mailbox-owners:subscribe', 'a', 'F1', true)
    await h.invoke('mailbox-owners:delegates', 'a')
    await h.invoke('mailbox-owners:save-delegate', { accountId: 'a', mode: 'update', delegate })
    await h.invoke('mailbox-owners:remove-delegate', 'a', 'bob@contoso.test')
    await h.invoke('mailbox-owners:meeting-delivery', 'a', 'DelegatesOnly')
    await h.invoke('mailbox-owners:held')
    await h.invoke('mailbox-owners:resolve-held', 'op-1', 'discard')
    expect(h.request.mock.calls.map(([command]) => command)).toEqual([
      { type: 'owners:list', payload: { accountId: 'a' } },
      { type: 'owners:discover', payload: { accountId: 'a' } },
      { type: 'owners:attach', payload: { accountId: 'a', address: 'team@contoso.test', kind: 'delegated' } },
      { type: 'owners:update', payload: { accountId: 'a', ownerId: 'mbx-1', sendMode: 'none' } },
      { type: 'owners:remove', payload: { accountId: 'a', ownerId: 'mbx-1' } },
      { type: 'owners:sync', payload: { accountId: 'a' } },
      { type: 'owners:public-folders', payload: { accountId: 'a', parentFolderId: 'F1' } },
      { type: 'owners:subscribe', payload: { accountId: 'a', folderId: 'F1', subscribed: true } },
      { type: 'owners:delegates', payload: { accountId: 'a' } },
      { type: 'owners:save-delegate', payload: { accountId: 'a', mode: 'update', delegate: { ...delegate, address: 'bob@contoso.test', permissions: delegate.permissions } } },
      { type: 'owners:remove-delegate', payload: { accountId: 'a', address: 'bob@contoso.test' } },
      { type: 'owners:meeting-delivery', payload: { accountId: 'a', delivery: 'DelegatesOnly' } },
      { type: 'owners:held', payload: {} },
      { type: 'owners:resolve-held', payload: { operationId: 'op-1', decision: 'discard' } }
    ])
    expect(h.productivityChanged.mock.calls.map(([accountId]) => accountId)).toEqual(['a', 'a', 'a', 'a'])
    await expect(h.invoke('mailbox-owners:subscribe', 'a', 'F1', 'yes')).rejects.toThrow(/whether to show/)
    await expect(h.invoke('mailbox-owners:resolve-held', 'op-1', 'ignore')).rejects.toThrow(/retry or discard/)
  })

  it('refuses every request while Aerio is locked', async () => {
    const h = harness(true)
    for (const channel of h.handlers.keys()) await expect(Promise.resolve().then(() => h.invoke(channel, 'a'))).rejects.toThrow(/Unlock Aerio/)
    expect(h.request).not.toHaveBeenCalled()
    h.lock(false)
    await expect(h.invoke('mailbox-owners:list')).resolves.toEqual([])
  })
})
