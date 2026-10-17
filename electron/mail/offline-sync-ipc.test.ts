import { describe, expect, it, vi } from 'vitest'
import { registerOfflineSync, validateExtend, validateServerSearch } from './offline-sync-ipc'

function setup(locked = false) {
  const handlers = new Map<string, (...args: any[]) => any>()
  const request = vi.fn(async (command: any) => ({ command }))
  let isLocked = locked
  registerOfflineSync({ ipcMain: { handle: (channel: string, handler: any) => handlers.set(channel, handler) } as any, worker: () => ({ request }) as any, isLocked: () => isLocked })
  const invoke = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
  return { invoke, request, handlers, unlock: () => { isLocked = false } }
}

describe('offline scope IPC (E36)', () => {
  it('validates and forwards every command to the mail worker', async () => {
    const { invoke, request, handlers } = setup()
    expect([...handlers.keys()].sort()).toEqual(['mail:offline:availability', 'mail:offline:extend', 'mail:offline:reclaim', 'mail:offline:search-coverage', 'mail:offline:server-search', 'mail:offline:set-account-policy', 'mail:offline:set-folder-override', 'mail:offline:settings'])
    await invoke('mail:offline:settings', 'account-1')
    await invoke('mail:offline:set-account-policy', 'account-1', { downloadMode: 'bodies', window: { unit: 'months', amount: 3 }, extra: true })
    await invoke('mail:offline:set-folder-override', 'account-1', 'INBOX', { window: { unit: 'days', amount: 7 } })
    await invoke('mail:offline:set-folder-override', 'account-1', 'INBOX', null)
    await invoke('mail:offline:availability', 'account-1')
    await invoke('mail:offline:search-coverage')
    await invoke('mail:offline:reclaim', 'account-1')
    expect(request.mock.calls.map(([command]) => command)).toEqual([
      { type: 'offline:settings', payload: { accountId: 'account-1' } },
      { type: 'offline:set-account-policy', payload: { accountId: 'account-1', policy: { downloadMode: 'bodies', window: { unit: 'months', amount: 3 } } } },
      { type: 'offline:set-folder-override', payload: { accountId: 'account-1', labelId: 'INBOX', override: { window: { unit: 'days', amount: 7 } } } },
      { type: 'offline:set-folder-override', payload: { accountId: 'account-1', labelId: 'INBOX', override: null } },
      { type: 'offline:availability', payload: { accountId: 'account-1' } },
      { type: 'offline:search-coverage', payload: { accountIds: undefined } },
      { type: 'offline:reclaim', payload: { accountId: 'account-1' } }
    ])
    await expect(invoke('mail:offline:set-account-policy', 'account-1', { downloadMode: 'all', window: { unit: 'all' } })).rejects.toThrow('Choose what to download')
    await expect(invoke('mail:offline:set-folder-override', 'account-1', '', { downloadMode: 'full' })).rejects.toThrow('Invalid folder')
    await expect(invoke('mail:offline:settings', 42)).rejects.toThrow('Invalid account id')
    await expect(invoke('mail:offline:search-coverage', 'account-1')).rejects.toThrow('Choose up to 100 accounts')
  })

  it('refuses policy changes and server searches while Aerio is locked', async () => {
    const { invoke, request, unlock } = setup(true)
    await expect(invoke('mail:offline:set-account-policy', 'account-1', { downloadMode: 'full', window: { unit: 'all' } })).rejects.toThrow('Unlock Aerio')
    await expect(invoke('mail:offline:server-search', { accountIds: ['account-1'], query: 'x' })).rejects.toThrow('Unlock Aerio')
    await expect(invoke('mail:offline:extend', { accountIds: ['account-1'], folder: 'inbox', mode: 'more' })).rejects.toThrow('Unlock Aerio')
    expect(request).not.toHaveBeenCalled()
    unlock()
    await invoke('mail:offline:server-search', { accountIds: ['account-1'], query: '  invoices  ' })
    expect(request).toHaveBeenCalledWith({ type: 'offline:server-search', payload: { accountIds: ['account-1'], query: 'invoices' } })
  })

  it('validates Load more/Load all and server search input', () => {
    expect(validateExtend({ accountIds: ['a'], folder: 'sent', labelId: 'Label_1', mode: 'all' })).toEqual({ accountIds: ['a'], folder: 'sent', labelId: 'Label_1', mode: 'all' })
    expect(() => validateExtend({ accountIds: ['a'], folder: 'everything', mode: 'more' })).toThrow('Choose a valid mailbox')
    expect(() => validateExtend({ accountIds: [], folder: 'inbox', mode: 'more' })).toThrow('Choose up to 100 accounts')
    expect(() => validateExtend({ accountIds: ['a'], folder: 'inbox', mode: 'some' })).toThrow('Choose Load more or Load all')
    expect(() => validateServerSearch({ accountIds: ['a'], query: '   ' })).toThrow('Enter something to search for')
    expect(() => validateServerSearch({ accountIds: ['a'], query: 'x'.repeat(501) })).toThrow('The search is too long')
  })
})
