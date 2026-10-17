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

describe('preload Zoom and Webex bridge', () => {
  beforeAll(async () => { await Promise.resolve() })

  it('maps every meeting-host command to its IPC channel and forwards status changes', async () => {
    const hosts = mocks.exposed.aerio.meetingHosts
    await hosts.status()
    await hosts.configure('zoom', 'client-id', 'client-secret')
    await hosts.connect('webex')
    await hosts.disconnect('zoom')
    await hosts.meetingOptions('0123456789abcdef')
    await hosts.setCancelOnDelete('0123456789abcdef', false)
    for (const call of [
      ['meeting-hosts:status'], ['meeting-hosts:configure', 'zoom', 'client-id', 'client-secret'], ['meeting-hosts:connect', 'webex'],
      ['meeting-hosts:disconnect', 'zoom'], ['meeting-hosts:meeting-options', '0123456789abcdef'], ['meeting-hosts:set-cancel-on-delete', '0123456789abcdef', false]
    ]) expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith(...call)

    const changed = vi.fn()
    const stop = hosts.onChanged(changed)
    mocks.listeners.get('meeting-hosts:changed')?.[0]({}, { accounts: [] })
    expect(changed).toHaveBeenCalledWith({ accounts: [] })
    stop()
    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledWith('meeting-hosts:changed', expect.any(Function))
  })
})
