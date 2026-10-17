import { describe, expect, it, vi } from 'vitest'
import { defaultMailArchivePolicy } from '../../src/lib/mail-archive'
import { registerMailArchiving } from './mail-archive-ipc'

function setup(locked = false) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const request = vi.fn(async (command: unknown) => command)
  let isLocked = locked
  registerMailArchiving({
    ipcMain: { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler) }) } as never,
    worker: () => ({ request }) as never,
    isLocked: () => isLocked
  })
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
  return { handlers, request, invoke, lock: (value: boolean) => { isLocked = value } }
}

const policy = { ...defaultMailArchivePolicy('account-1'), enabled: true, destinationLabelId: 'folder:local-1' }

describe('automatic archiving IPC', () => {
  it('registers every channel and forwards validated requests to the mail worker', async () => {
    const { handlers, request, invoke } = setup()
    expect([...handlers.keys()].sort()).toEqual(['mail:archive:cancel', 'mail:archive:get', 'mail:archive:items', 'mail:archive:preview', 'mail:archive:resume', 'mail:archive:run', 'mail:archive:save'])
    await invoke('mail:archive:get', 'account-1')
    await invoke('mail:archive:save', { ...policy, extra: 'ignored' })
    await invoke('mail:archive:preview', policy)
    await invoke('mail:archive:run', 'account-1')
    await invoke('mail:archive:resume', 'job-1')
    await invoke('mail:archive:cancel', 'job-1')
    await invoke('mail:archive:items', 'job-1')
    expect(request).toHaveBeenCalledWith({ type: 'archive:get', payload: { accountId: 'account-1' } })
    expect(request).toHaveBeenCalledWith({ type: 'archive:save', payload: policy })
    expect(request).toHaveBeenCalledWith({ type: 'archive:preview', payload: policy })
    expect(request).toHaveBeenCalledWith({ type: 'archive:run', payload: { accountId: 'account-1' } })
    for (const type of ['archive:resume', 'archive:cancel', 'archive:items']) expect(request).toHaveBeenCalledWith({ type, payload: { jobId: 'job-1' } })
  })

  it('rejects malformed input before it reaches the worker', () => {
    const { request, invoke } = setup()
    expect(() => invoke('mail:archive:get', '')).toThrow(/Invalid account id/)
    expect(() => invoke('mail:archive:resume', { id: 'job' })).toThrow(/Invalid archive run id/)
    expect(() => invoke('mail:archive:save', { ...policy, olderThan: 2.5 })).toThrow(/Enter an age/)
    expect(() => invoke('mail:archive:save', { ...policy, removal: 'shred' })).toThrow(/server copy/)
    expect(() => invoke('mail:archive:preview', { ...policy, folderIds: 'INBOX' })).toThrow(/valid folders/)
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses every archive channel while Aerio is locked', () => {
    const { request, invoke, lock } = setup(true)
    for (const [channel, arg] of [['mail:archive:get', 'account-1'], ['mail:archive:save', policy], ['mail:archive:preview', policy], ['mail:archive:run', 'account-1'], ['mail:archive:items', 'job-1']] as const) {
      expect(() => invoke(channel, arg)).toThrow(/Unlock Aerio/)
    }
    expect(request).not.toHaveBeenCalled()
    lock(false)
    void invoke('mail:archive:get', 'account-1')
    expect(request).toHaveBeenCalledTimes(1)
  })
})
