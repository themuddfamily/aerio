import { expect, it, vi } from 'vitest'
import { registerProviderChatIpc } from './ipc'
import type { ProviderChatRuntime } from './runtime'
function setup() {
  const handlers = new Map<string, (...args: any[]) => any>()
  let locked = false
  const runtime = { snapshot: vi.fn(() => ({ providers: [{ id: 'teams' }], accounts: [], rooms: [] })), connect: vi.fn(), send: vi.fn(), messages: vi.fn(), remove: vi.fn(), refresh: vi.fn(), markRead: vi.fn(), preferences: vi.fn() }
  registerProviderChatIpc({ ipc: { handle: (name, handler) => { handlers.set(name, handler) } }, runtime: runtime as unknown as ProviderChatRuntime, locked: () => locked, isServiceSender: (id) => id === 99 })
  return { runtime, setLocked: () => { locked = true }, invoke: (name: string, ...args: unknown[]) => handlers.get(`provider-chat:${name}`)!({ sender: { id: 1 } }, ...args), service: () => handlers.get('provider-chat:snapshot')!({ sender: { id: 99 } }) }
}
it('keeps provider chat inaccessible to Matrix isolated service and locked mutations', () => {
  const f = setup(); expect(f.service).toThrow('isolated services'); f.setLocked()
  expect(f.invoke('snapshot')).toMatchObject({ accounts: [] })
  expect(() => f.invoke('send', 'a', 'r', 'hello')).toThrow('Unlock')
  expect(f.runtime.send).not.toHaveBeenCalled()
})
it('validates connection fields, paging, body and preferences before dispatch', () => {
  const f = setup()
  expect(() => f.invoke('connect', 'unknown', {})).toThrow('Unsupported')
  expect(() => f.invoke('connect', 'teams', { token: {} })).toThrow('fields')
  expect(() => f.invoke('messages', 'a', 'r', { cursor: 123 })).toThrow('identity')
  expect(() => f.invoke('send', 'a', 'r', 'x'.repeat(28_001))).toThrow('28,000')
  expect(() => f.invoke('preferences', 'a', 'true')).toThrow('preference')
  f.invoke('connect', 'teams', { channels: true }, 'a'); expect(f.runtime.connect).toHaveBeenCalledWith('teams', { channels: true }, 'a')
  f.invoke('messages', 'a', 'r', { cursor: 'next', threadId: 'root' }); expect(f.runtime.messages).toHaveBeenCalledWith('a', 'r', { cursor: 'next', threadId: 'root' })
  f.invoke('send', 'a', 'r', 'hello', 'root'); expect(f.runtime.send).toHaveBeenCalledWith('a', 'r', 'hello', 'root')
})
