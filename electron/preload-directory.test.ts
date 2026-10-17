// @vitest-environment jsdom

import { beforeAll, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: any[]) => void>>()
  return {
    exposed: {} as Record<string, any>,
    listeners,
    contextBridge: { exposeInMainWorld: vi.fn((name: string, value: any) => { mocks.exposed[name] = value }) },
    ipcRenderer: {
      invoke: vi.fn(async (channel: string, ...args: any[]) => ({ channel, args })),
      on: vi.fn((channel: string, listener: (...args: any[]) => void) => { listeners.set(channel, [...(listeners.get(channel) ?? []), listener]) }),
      removeListener: vi.fn()
    }
  }
})

vi.mock('electron', () => ({ contextBridge: mocks.contextBridge, ipcRenderer: mocks.ipcRenderer }))

import './preload'

describe('preload directory bridge', () => {
  beforeAll(async () => { await Promise.resolve() })

  it('maps every directory command to its IPC channel and forwards change events', async () => {
    const directory = mocks.exposed.aerio.directory
    const request = { query: 'ada', kinds: ['person'], limit: 5 }
    await directory.snapshot()
    await directory.search(request)
    await directory.expandGroup('account-1', 'team@contoso.test')
    await directory.refresh('account-1')
    await directory.grantAccess('account-1')
    await directory.grantAccess('account-1', 'resources')
    for (const call of [
      ['directory:snapshot'], ['directory:search', request], ['directory:expand-group', 'account-1', 'team@contoso.test'], ['directory:refresh', 'account-1'],
      ['directory:grant', 'account-1'], ['directory:grant', 'account-1', 'resources']
    ]) expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith(...call)

    const changed = vi.fn()
    const stop = directory.onChanged(changed)
    mocks.listeners.get('directory:changed')?.[0]({}, { accounts: [], online: true })
    expect(changed).toHaveBeenCalledWith({ accounts: [], online: true })
    stop()
    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledWith('directory:changed', expect.any(Function))
  })
})
