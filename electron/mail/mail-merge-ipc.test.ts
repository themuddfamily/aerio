import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  request: vi.fn(async (command: any) => command),
  validateMessage: vi.fn((draft: any) => {
    if (draft.attachmentPaths.some((path: string) => path !== 'approved.pdf')) throw new Error('A draft referenced a file that was not selected through Aerio')
    return draft
  })
}))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn((channel: string, handler: (...args: any[]) => any) => mocks.handlers.set(channel, handler)) } }))

import { registerMailMerge } from './mail-merge-ipc'

const invoke = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({}, ...args)
const input = (overrides: Record<string, unknown> = {}) => ({
  accountId: 'a', subject: 'Hi {{firstName}}', text: 'Body', attachmentPaths: ['approved.pdf'],
  recipients: [{ email: 'ada@example.com', firstName: 'Ada', fields: { plan: 'Pro' } }],
  limits: { perMinute: 10, dailyCap: 100 },
  ...overrides
})

beforeEach(() => {
  mocks.handlers.clear()
  mocks.request.mockClear()
  mocks.validateMessage.mockClear()
  registerMailMerge({ worker: () => ({ request: mocks.request as any }), validateMessage: mocks.validateMessage })
})

describe('mail merge IPC', () => {
  it('validates the shared message as a recipient-less draft and forwards the job', async () => {
    const command = await invoke('mail:merge:create', { ...input(), cc: ['leak@example.com'], bcc: ['leak@example.com'] })
    expect(mocks.validateMessage).toHaveBeenCalledWith(expect.objectContaining({ to: [], cc: [], bcc: [], attachmentPaths: ['approved.pdf'] }))
    expect(command).toEqual({ type: 'merge:create', payload: {
      accountId: 'a', subject: 'Hi {{firstName}}', text: 'Body', attachmentPaths: ['approved.pdf'],
      recipients: [{ email: 'ada@example.com', firstName: 'Ada', fields: { plan: 'Pro' } }],
      limits: { perMinute: 10, dailyCap: 100 }
    } })
    // Cc/Bcc are not part of a merge and never reach the worker.
    expect(JSON.stringify(command)).not.toContain('leak@example.com')
  })

  it('forwards job controls to the worker', async () => {
    await invoke('mail:merge:list')
    await invoke('mail:merge:get', 'job')
    await invoke('mail:merge:pause', 'job')
    await invoke('mail:merge:resume', 'job')
    await invoke('mail:merge:cancel', 'job')
    await invoke('mail:merge:resolve', 'job', [0, 2], 'skip')
    await invoke('mail:merge:delete', 'job')
    expect(mocks.request.mock.calls.map(([command]) => command.type)).toEqual([
      'merge:list', 'merge:get', 'merge:pause', 'merge:resume', 'merge:cancel', 'merge:resolve', 'merge:delete'
    ])
  })

  it('rejects malformed renderer input before it reaches the worker', () => {
    expect(() => invoke('mail:merge:create', null)).toThrow(/invalid/)
    expect(() => invoke('mail:merge:create', input({ recipients: [] }))).toThrow(/at least one/)
    expect(() => invoke('mail:merge:create', input({ recipients: Array.from({ length: 5_001 }, () => ({ email: 'a@example.com' })) }))).toThrow(/at most 5,000/)
    expect(() => invoke('mail:merge:create', input({ recipients: [{ email: 7 }] }))).toThrow(/recipient is invalid/)
    expect(() => invoke('mail:merge:create', input({ recipients: [{ email: 'a@example.com', fields: { x: 'y'.repeat(1_001) } }] }))).toThrow(/too long/)
    expect(() => invoke('mail:merge:create', input({ limits: undefined }))).toThrow(/sending limits/)
    expect(() => invoke('mail:merge:create', input({ attachmentPaths: ['C:/secret.txt'] }))).toThrow(/not selected through Aerio/)
    expect(() => invoke('mail:merge:create', input({ replyTo: ['half'] }))).toThrow(/Reply-To/)
    expect(() => invoke('mail:merge:get', '')).toThrow(/valid mail merge/)
    expect(() => invoke('mail:merge:resolve', 'job', [-1], 'skip')).toThrow(/recipients to review/)
    expect(() => invoke('mail:merge:resolve', 'job', [1], 'send-all')).toThrow(/resend or skip/)
    expect(mocks.request).not.toHaveBeenCalled()
  })
})
