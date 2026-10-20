// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ api: {} as any, invoke: vi.fn(async () => undefined), on: vi.fn(), removeListener: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => { mocks.api = api } }, ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener } }))
import '../../preload'
it('exposes only normalized provider commands and removes event listeners', async () => {
  const api = mocks.api.providerChat
  await api.connect('teams', { channels: true }, 'a'); expect(mocks.invoke).toHaveBeenLastCalledWith('provider-chat:connect', 'teams', { channels: true }, 'a')
  await api.messages('a', 'r', { threadId: 'root' }); expect(mocks.invoke).toHaveBeenLastCalledWith('provider-chat:messages', 'a', 'r', { threadId: 'root' })
  await api.send('a', 'r', 'body', 'root'); expect(mocks.invoke).toHaveBeenLastCalledWith('provider-chat:send', 'a', 'r', 'body', 'root')
  await api.markRead('a', 'r'); expect(mocks.invoke).toHaveBeenLastCalledWith('provider-chat:read', 'a', 'r')
  const callback = vi.fn(), unsubscribe = api.onEvent(callback)
  const [channel, listener] = mocks.on.mock.calls.at(-1)!
  listener({}, { type: 'snapshot' }); expect(callback).toHaveBeenCalledWith({ type: 'snapshot' })
  unsubscribe(); expect(mocks.removeListener).toHaveBeenCalledWith(channel, listener)
})
