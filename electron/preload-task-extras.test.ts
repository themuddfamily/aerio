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
      removeListener: vi.fn((channel: string, listener: (...args: any[]) => void) => { listeners.set(channel, (listeners.get(channel) ?? []).filter((value) => value !== listener)) })
    }
  }
})

vi.mock('electron', () => ({ contextBridge: mocks.contextBridge, ipcRenderer: mocks.ipcRenderer }))

import './preload'

describe('preload task reminders and attachments bridge', () => {
  beforeAll(async () => { await Promise.resolve() })

  it('maps reminder and attachment commands to their IPC channels', async () => {
    const tasks = mocks.exposed.aerio.tasks
    await tasks.reminders.list()
    await tasks.reminders.dismiss('local:task:2026-10-17T09:00:00.000Z')
    await tasks.reminders.snooze('key', '2026-10-17T10:00:00.000Z')
    await tasks.attachments.choose()
    await tasks.attachments.open('C:/profile/task-attachments/a.pdf')
    await tasks.attachments.uploadNative('entity')
    await tasks.attachments.removeNative('entity', 'attachment')
    await tasks.attachments.openNative('entity', 'attachment')
    for (const call of [
      ['tasks:reminders:list'], ['tasks:reminders:dismiss', 'local:task:2026-10-17T09:00:00.000Z'], ['tasks:reminders:snooze', 'key', '2026-10-17T10:00:00.000Z'],
      ['tasks:attachments:choose'], ['tasks:attachments:open', 'C:/profile/task-attachments/a.pdf'], ['tasks:attachments:upload-native', 'entity'],
      ['tasks:attachments:remove-native', 'entity', 'attachment'], ['tasks:attachments:open-native', 'entity', 'attachment']
    ]) expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith(...call)
  })

  it('forwards reminder changes and unsubscribes', () => {
    const callback = vi.fn()
    const unsubscribe = mocks.exposed.aerio.tasks.reminders.onChanged(callback)
    const reminders = [{ key: 'k', title: 'Pay rent' }]
    for (const listener of mocks.listeners.get('tasks:reminders:changed') ?? []) listener({}, reminders)
    expect(callback).toHaveBeenCalledWith(reminders)
    unsubscribe()
    expect(mocks.listeners.get('tasks:reminders:changed')).toEqual([])
  })
})
