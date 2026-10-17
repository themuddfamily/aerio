import { describe, expect, it, vi } from 'vitest'
import { registerMailInboxCategories, validateAssignInput } from './inbox-categories-ipc'

function setup() {
  const handlers = new Map<string, (...args: any[]) => any>()
  const request = vi.fn(async (command: any) => ({ command }))
  registerMailInboxCategories({ ipcMain: { handle: (channel: string, handler: any) => handlers.set(channel, handler) } as any, worker: () => ({ request }) as any })
  const invoke = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: {} }, ...args)
  return { handlers, invoke, request }
}

describe('inbox category IPC', () => {
  it('registers every channel and forwards validated payloads to the mail worker', async () => {
    const { handlers, invoke, request } = setup()
    expect([...handlers.keys()].sort()).toEqual(['mail:categories:assign', 'mail:categories:counts', 'mail:categories:delete-rule', 'mail:categories:rules', 'mail:categories:save-rule', 'mail:categories:save-tabs', 'mail:categories:tabs'])
    await invoke('mail:categories:tabs')
    await invoke('mail:categories:counts', ['account-1'])
    await invoke('mail:categories:counts')
    await invoke('mail:categories:rules')
    await invoke('mail:categories:save-rule', { kind: 'domain', pattern: '@Shop.Example', category: 'promotions', extra: true })
    await invoke('mail:categories:delete-rule', 'rule-1')
    await invoke('mail:categories:assign', { accountId: 'account-1', threadIds: ['t1'], category: 'social', remember: 'address', injected: 'x' })
    await invoke('mail:categories:save-tabs', { tabs: [{ id: 'primary', name: 'Main', enabled: false }] })
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      { type: 'categories:tabs' },
      { type: 'categories:counts', payload: { accountIds: ['account-1'] } },
      { type: 'categories:counts', payload: { accountIds: undefined } },
      { type: 'categories:rules' },
      { type: 'categories:save-rule', payload: { kind: 'domain', pattern: 'shop.example', category: 'promotions' } },
      { type: 'categories:delete-rule', payload: { id: 'rule-1' } },
      { type: 'categories:assign', payload: { accountId: 'account-1', threadIds: ['t1'], category: 'social', remember: 'address' } },
      { type: 'categories:save-tabs', payload: { tabs: expect.arrayContaining([{ id: 'primary', name: 'Main', enabled: true, builtIn: true }]) } }
    ])
  })

  it('rejects malformed input before it reaches the worker', async () => {
    const { invoke, request } = setup()
    await expect(invoke('mail:categories:counts', 'account-1')).rejects.toThrow('valid mail accounts')
    await expect(invoke('mail:categories:save-rule', { kind: 'domain', pattern: 'not a domain', category: 'social' })).rejects.toThrow('domain')
    await expect(invoke('mail:categories:delete-rule', '')).rejects.toThrow('valid classification rule')
    await expect(invoke('mail:categories:save-tabs', null)).rejects.toThrow('invalid')
    expect(request).not.toHaveBeenCalled()
    expect(() => validateAssignInput({ accountId: 'a', threadIds: [] })).toThrow('500 conversations')
    expect(() => validateAssignInput({ accountId: 'a', threadIds: Array.from({ length: 501 }, (_, index) => `t${index}`) })).toThrow('500 conversations')
    expect(() => validateAssignInput({ accountId: 'a', threadIds: ['t'], category: 'spam' })).toThrow('inbox tab')
    expect(() => validateAssignInput({ accountId: 'a', threadIds: ['t'], category: 'social', remember: 'everyone' })).toThrow('sender or the domain')
    expect(() => validateAssignInput({ accountId: 'a', threadIds: ['t'], remember: 'domain' })).toThrow('Choose a tab')
    expect(validateAssignInput({ accountId: 'a', threadIds: ['t'] })).toEqual({ accountId: 'a', threadIds: ['t'] })
  })
})
