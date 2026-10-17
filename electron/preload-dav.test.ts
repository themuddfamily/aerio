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

describe('preload CalDAV/CardDAV bridge', () => {
  beforeAll(async () => { await Promise.resolve() })

  it('maps every account command to its IPC channel and forwards change events', async () => {
    const dav = mocks.exposed.aerio.dav
    const input = { preset: 'icloud', username: 'ada@icloud.com', password: 'app-password' }
    await dav.snapshot()
    await dav.addAccount(input)
    await dav.updatePassword('dav-1', 'next')
    await dav.removeAccount('dav-1')
    await dav.sync('dav-1')
    await dav.syncAll()
    await dav.setCollectionEnabled('collection-1', false)
    await dav.resolve('op-1', 'keep-server')
    for (const call of [
      ['dav:snapshot'], ['dav:account-add', input], ['dav:account-password', 'dav-1', 'next'], ['dav:account-remove', 'dav-1'],
      ['dav:sync', 'dav-1'], ['dav:sync-all'], ['dav:collection-enabled', 'collection-1', false], ['dav:resolve', 'op-1', 'keep-server']
    ]) expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith(...call)

    const changed = vi.fn()
    const stop = dav.onChanged(changed)
    mocks.listeners.get('dav:changed')?.[0]({}, { accounts: [], collections: [], review: [] })
    expect(changed).toHaveBeenCalledWith({ accounts: [], collections: [], review: [] })
    stop()
    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledWith('dav:changed', expect.any(Function))
  })
})
