import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  request: vi.fn(async (command: any) => command)
}))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn((channel: string, handler: (...args: any[]) => any) => mocks.handlers.set(channel, handler)) } }))

import { registerMailIdentities, validateDraftSender } from './identity-ipc'

const invoke = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({}, ...args)

beforeEach(() => {
  mocks.handlers.clear()
  mocks.request.mockClear()
  registerMailIdentities({ worker: () => ({ request: mocks.request as any }) })
})

describe('mail identity IPC', () => {
  it('forwards valid identity and signature requests to the mail worker', async () => {
    await expect(invoke('mail:identities:list')).resolves.toEqual({ type: 'identities:list', payload: { accountIds: undefined } })
    await expect(invoke('mail:identities:list', ['a'])).resolves.toEqual({ type: 'identities:list', payload: { accountIds: ['a'] } })
    await invoke('mail:identities:save', { accountId: 'a', email: 'x@example.com', name: 'X' })
    await invoke('mail:identities:delete', 'id')
    await invoke('mail:identities:refresh', 'a')
    await invoke('mail:signatures:list')
    await invoke('mail:signatures:save', { name: 'Work', html: '' })
    await invoke('mail:signatures:delete', 'sig')
    expect(mocks.request.mock.calls.map(([command]) => command.type)).toEqual([
      'identities:list', 'identities:list', 'identities:save', 'identities:delete', 'identities:refresh', 'signatures:list', 'signatures:save', 'signatures:delete'
    ])
  })

  it('rejects malformed renderer input before it reaches the worker', () => {
    expect(() => invoke('mail:identities:list', 'a')).toThrow(/valid mail accounts/)
    expect(() => invoke('mail:identities:list', [''])).toThrow(/valid mail accounts/)
    expect(() => invoke('mail:identities:save', null)).toThrow(/valid mail account/)
    expect(() => invoke('mail:identities:delete', '')).toThrow(/valid sender/)
    expect(() => invoke('mail:identities:refresh', 3)).toThrow(/valid mail account/)
    expect(() => invoke('mail:signatures:save', 'html')).toThrow(/invalid/)
    expect(() => invoke('mail:signatures:delete', 'x'.repeat(301))).toThrow(/valid signature/)
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('validates draft sender fields, requiring complete Reply-To addresses only for sending', () => {
    expect(() => validateDraftSender({}, true)).not.toThrow()
    expect(() => validateDraftSender({ fromIdentityId: 'alias', replyTo: ['typing'] }, false)).not.toThrow()
    expect(() => validateDraftSender({ replyTo: ['typing'] }, true)).toThrow(/Reply-To/)
    expect(() => validateDraftSender({ replyTo: ['desk@example.com'] }, true)).not.toThrow()
    expect(() => validateDraftSender({ fromIdentityId: '' }, false)).toThrow(/From address/)
    expect(() => validateDraftSender({ replyTo: 'desk@example.com' as never }, false)).toThrow(/at most 10/)
    expect(() => validateDraftSender({ replyTo: Array(11).fill('a@example.com') }, false)).toThrow(/at most 10/)
  })
})
