// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ exposed: {} as Record<string, any>, invoke: vi.fn(async () => undefined), on: vi.fn(), removeListener: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (name: string, value: unknown) => { mocks.exposed[name] = value } }, ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener } }))
import './preload'
describe('saved unified account views preload bridge', () => {
  it('routes structured membership and selection commands and unsubscribes from changes', async () => {
    mocks.invoke.mockClear()
    const api = mocks.exposed.aerio.mail.unifiedViews
    const view = { name: 'Work', accountIds: ['a', 'b'], folderAccountIds: { inbox: ['a'] } }
    await api.snapshot(); await api.save(view); await api.select('id'); await api.remove('id')
    expect(mocks.invoke.mock.calls).toEqual([['mail:unified-views:snapshot'], ['mail:unified-views:save', view], ['mail:unified-views:select', 'id'], ['mail:unified-views:remove', 'id']])
    const callback = vi.fn(), unsubscribe = api.onChanged(callback)
    const listener = mocks.on.mock.calls.find(([channel]) => channel === 'mail:unified-views:changed')![1]
    listener({}, { views: [] })
    expect(callback).toHaveBeenCalledWith({ views: [] })
    unsubscribe()
    expect(mocks.removeListener).toHaveBeenCalledWith('mail:unified-views:changed', listener)
  })
})
