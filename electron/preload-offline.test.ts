// @vitest-environment jsdom

import { beforeAll, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  exposed: {} as Record<string, any>,
  contextBridge: { exposeInMainWorld: vi.fn((name: string, value: any) => { mocks.exposed[name] = value }) },
  ipcRenderer: {
    invoke: vi.fn(async (channel: string, ...args: any[]) => ({ channel, args })),
    on: vi.fn(),
    removeListener: vi.fn()
  }
}))

vi.mock('electron', () => ({ contextBridge: mocks.contextBridge, ipcRenderer: mocks.ipcRenderer }))

import './preload'

describe('preload offline scope bridge (E36)', () => {
  beforeAll(async () => { await Promise.resolve() })

  it('maps every offline command to its IPC channel with its arguments', async () => {
    const offline = mocks.exposed.aerio.mail.offline
    const policy = { downloadMode: 'headers', window: { unit: 'days', amount: 30 } }
    await offline.settings('account-1')
    await offline.setAccountPolicy('account-1', policy)
    await offline.setFolderOverride('account-1', 'INBOX', { downloadMode: 'full' })
    await offline.setFolderOverride('account-1', 'INBOX', null)
    await offline.extend({ accountIds: ['account-1'], folder: 'inbox', mode: 'more' })
    await offline.availability('account-1', 'INBOX')
    await offline.searchCoverage(['account-1'])
    await offline.serverSearch({ accountIds: ['account-1'], query: 'invoice' })
    await offline.reclaim('account-1')
    const invoke = mocks.ipcRenderer.invoke
    expect(invoke).toHaveBeenCalledWith('mail:offline:settings', 'account-1')
    expect(invoke).toHaveBeenCalledWith('mail:offline:set-account-policy', 'account-1', policy)
    expect(invoke).toHaveBeenCalledWith('mail:offline:set-folder-override', 'account-1', 'INBOX', { downloadMode: 'full' })
    expect(invoke).toHaveBeenCalledWith('mail:offline:set-folder-override', 'account-1', 'INBOX', null)
    expect(invoke).toHaveBeenCalledWith('mail:offline:extend', { accountIds: ['account-1'], folder: 'inbox', mode: 'more' })
    expect(invoke).toHaveBeenCalledWith('mail:offline:availability', 'account-1', 'INBOX')
    expect(invoke).toHaveBeenCalledWith('mail:offline:search-coverage', ['account-1'])
    expect(invoke).toHaveBeenCalledWith('mail:offline:server-search', { accountIds: ['account-1'], query: 'invoice' })
    expect(invoke).toHaveBeenCalledWith('mail:offline:reclaim', 'account-1')
  })
})
