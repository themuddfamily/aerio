// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  exposed: {} as Record<string, any>,
  contextBridge: { exposeInMainWorld: vi.fn((name: string, value: any) => { mocks.exposed[name] = value }) },
  ipcRenderer: { invoke: vi.fn(async (..._args: unknown[]) => undefined), on: vi.fn(), removeListener: vi.fn() }
}))

vi.mock('electron', () => ({ contextBridge: mocks.contextBridge, ipcRenderer: mocks.ipcRenderer }))

import './preload'

describe('preload shared mailbox bridge', () => {
  it('maps every shared mailbox, public folder, delegate, and held-change command to its IPC channel', async () => {
    const api = mocks.exposed.aerio.mailboxOwners
    const attach = { accountId: 'a', address: 'team@contoso.test', kind: 'shared' }
    const delegate = { accountId: 'a', mode: 'add', delegate: { address: 'bob@contoso.test' } }
    await api.list('a')
    await api.discover('a')
    await api.attach(attach)
    await api.update({ accountId: 'a', ownerId: 'o', sendMode: 'send-as' })
    await api.remove('a', 'o')
    await api.sync('a', 'o')
    await api.publicFolders.browse('a', 'F1')
    await api.publicFolders.subscribe('a', 'F1', true)
    await api.delegates.get('a')
    await api.delegates.save(delegate)
    await api.delegates.remove('a', 'bob@contoso.test')
    await api.delegates.setMeetingDelivery('a', 'DelegatesOnly')
    await api.held.list('a')
    await api.held.resolve('op', 'retry')
    expect(mocks.ipcRenderer.invoke.mock.calls.filter(([channel]) => String(channel).startsWith('mailbox-owners:'))).toEqual([
      ['mailbox-owners:list', 'a'], ['mailbox-owners:discover', 'a'], ['mailbox-owners:attach', attach],
      ['mailbox-owners:update', { accountId: 'a', ownerId: 'o', sendMode: 'send-as' }], ['mailbox-owners:remove', 'a', 'o'], ['mailbox-owners:sync', 'a', 'o'],
      ['mailbox-owners:public-folders', 'a', 'F1'], ['mailbox-owners:subscribe', 'a', 'F1', true], ['mailbox-owners:delegates', 'a'],
      ['mailbox-owners:save-delegate', delegate], ['mailbox-owners:remove-delegate', 'a', 'bob@contoso.test'], ['mailbox-owners:meeting-delivery', 'a', 'DelegatesOnly'],
      ['mailbox-owners:held', 'a'], ['mailbox-owners:resolve-held', 'op', 'retry']
    ])
  })
})
