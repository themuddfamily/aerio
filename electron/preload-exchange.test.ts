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

describe('preload Exchange bridge', () => {
  beforeAll(async () => { await Promise.resolve() })

  it('maps every Exchange command to its IPC channel and forwards change events', async () => {
    const exchange = mocks.exposed.aerio.exchange
    const discover = { email: 'ada@contoso.test', password: 'secret', trustedHosts: ['mail.hoster.example'] }
    const connect = { email: 'ada@contoso.test', password: 'secret', ewsUrl: 'https://mail.contoso.test/EWS/Exchange.asmx', auth: 'auto' }
    await exchange.discover(discover)
    await exchange.connect(connect)
    await exchange.snapshot()
    await exchange.updateCredentials('account-1', { password: 'next' })
    await exchange.sync('account-1')
    await exchange.resolve('op-1', 'keep-local')
    for (const call of [
      ['exchange:discover', discover], ['exchange:connect', connect], ['exchange:snapshot'], ['exchange:update-credentials', 'account-1', { password: 'next' }],
      ['exchange:sync', 'account-1'], ['exchange:resolve', 'op-1', 'keep-local']
    ]) expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith(...call)

    const changed = vi.fn()
    const stop = exchange.onChanged(changed)
    mocks.listeners.get('exchange:changed')?.[0]({}, { accounts: [], review: [] })
    expect(changed).toHaveBeenCalledWith({ accounts: [], review: [] })
    stop()
    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledWith('exchange:changed', expect.any(Function))
  })
})
