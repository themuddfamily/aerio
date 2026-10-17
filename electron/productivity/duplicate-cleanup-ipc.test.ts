import { describe, expect, it, vi } from 'vitest'
import type { DuplicateCleanupService } from './duplicate-cleanup'
import { registerDuplicateCleanup, validRemovalRequest, validScanRequest } from './duplicate-cleanup-ipc'

function setup(locked = false) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const service = {
    scopes: vi.fn(async () => []), scan: vi.fn(async () => ({})), remove: vi.fn(async () => ({ results: [] })), dismiss: vi.fn(() => []),
    dismissals: vi.fn(() => []), removeDismissal: vi.fn(() => []), history: vi.fn(() => []), undo: vi.fn(async () => ({}))
  }
  let isLocked = locked
  registerDuplicateCleanup({ handle: (channel, listener) => { handlers.set(channel, listener) } }, () => service as unknown as DuplicateCleanupService, () => isLocked)
  const call = (channel: string, ...args: unknown[]) => Promise.resolve().then(() => handlers.get(channel)!({}, ...args))
  return { handlers, service, call, lock: (value: boolean) => { isLocked = value } }
}

describe('duplicate cleanup IPC', () => {
  it('registers every channel and forwards valid requests', async () => {
    const { handlers, service, call } = setup()
    expect([...handlers.keys()].sort()).toEqual([
      'duplicates:dismiss', 'duplicates:dismissal-remove', 'duplicates:dismissals', 'duplicates:history', 'duplicates:remove', 'duplicates:scan', 'duplicates:scopes', 'duplicates:undo'
    ])
    await call('duplicates:scopes', 'task')
    await call('duplicates:scan', { kind: 'mail', scopes: [{ accountId: 'a', labelIds: ['INBOX'] }] })
    await call('duplicates:remove', { scanId: 's', groups: [{ groupId: 'g', keeperId: 'k', removeIds: ['r'] }] })
    await call('duplicates:dismiss', 's', 'g')
    await call('duplicates:undo', 'entry')
    expect(service.scopes).toHaveBeenCalledWith('task')
    expect(service.scan).toHaveBeenCalledWith({ kind: 'mail', scopes: [{ accountId: 'a', labelIds: ['INBOX'] }] })
    expect(service.remove).toHaveBeenCalledWith({ scanId: 's', groups: [{ groupId: 'g', keeperId: 'k', removeIds: ['r'] }] })
    expect(service.dismiss).toHaveBeenCalledWith('s', 'g')
    expect(service.undo).toHaveBeenCalledWith('entry')
  })

  it('rejects malformed input before it reaches the service', async () => {
    const { service, call } = setup()
    await expect(call('duplicates:scopes', 'contacts')).rejects.toThrow(/mail, calendar, or tasks/)
    await expect(call('duplicates:scan', { kind: 'event', calendarIds: [] })).rejects.toThrow(/at least one/)
    await expect(call('duplicates:remove', { scanId: 's', groups: [{ groupId: 'g', keeperId: 'k', removeIds: [] }] })).rejects.toThrow(/copies to remove/)
    await expect(call('duplicates:undo', 42)).rejects.toThrow(/cleanup to undo/)
    expect(service.scan).not.toHaveBeenCalled()
    expect(service.remove).not.toHaveBeenCalled()
    expect(validScanRequest({ kind: 'mail', scopes: [{ accountId: 'a', labelIds: 'INBOX' }] })).toBe(false)
    expect(validScanRequest({ kind: 'task', listIds: ['x'.repeat(2_000)] })).toBe(false)
    expect(validRemovalRequest({ scanId: 's', groups: [{ groupId: 'g', keeperId: 'k', removeIds: [7] }] })).toBe(false)
  })

  it('refuses every request while Aerio is locked', async () => {
    const { handlers, service, call, lock } = setup(true)
    for (const channel of handlers.keys()) await expect(call(channel, 'mail')).rejects.toThrow(/Unlock Aerio/)
    expect(service.scopes).not.toHaveBeenCalled()
    lock(false)
    await call('duplicates:history')
    expect(service.history).toHaveBeenCalled()
  })
})
