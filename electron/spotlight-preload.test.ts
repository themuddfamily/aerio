// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ api: {} as any, invoke: vi.fn(async () => undefined), on: vi.fn(), removeListener: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => { mocks.api = api } }, ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener } }))
import './preload'
it('exposes scoped Spotlight settings/status and removes status subscriptions', async () => {
  const api = mocks.api.spotlight, settings = { enabled: true, accountIds: ['selected'], includePreview: false }
  await api.status(); expect(mocks.invoke).toHaveBeenLastCalledWith('spotlight:status')
  await api.save(settings); expect(mocks.invoke).toHaveBeenLastCalledWith('spotlight:save', settings)
  await api.refresh(); expect(mocks.invoke).toHaveBeenLastCalledWith('spotlight:refresh')
  const callback = vi.fn(), unsubscribe = api.onChanged(callback), [channel, listener] = mocks.on.mock.calls.at(-1)!
  listener({}, { available: true }); expect(callback).toHaveBeenCalledWith({ available: true })
  unsubscribe(); expect(mocks.removeListener).toHaveBeenCalledWith(channel, listener)
})
