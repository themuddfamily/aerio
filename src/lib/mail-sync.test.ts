import { describe, expect, it } from 'vitest'
import type { MailAccountSummary, SyncProgress } from '../mail-types'
import { isMailboxRefreshing, shouldShowDetailedSync } from './mail-sync'

function account(overrides: Partial<MailAccountSummary> = {}): MailAccountSummary {
  return {
    id: 'mail-1',
    provider: 'gmail',
    email: 'mail@example.com',
    displayName: 'Mail',
    color: '#6558e8',
    status: 'syncing',
    archived: false,
    signature: '',
    notifications: true,
    syncEnabled: true,
    ...overrides
  }
}

function progress(phase: SyncProgress['phase']): SyncProgress {
  return {
    accountId: 'mail-1',
    phase,
    completed: 40,
    total: 100,
    transferredBytes: 1024,
    updatedAt: '2026-08-08T12:00:00.000Z'
  }
}

describe('mail sync presentation', () => {
  it('shows detailed progress while a new account catches up', () => {
    const newAccount = account()
    expect(shouldShowDetailedSync(progress('downloading'), newAccount)).toBe(true)
    expect(isMailboxRefreshing([newAccount], [progress('downloading')], 'all')).toBe(false)
  })

  it('uses only the refresh spinner after the first completed sync', () => {
    const caughtUp = account({ lastSyncAt: '2026-08-08T11:00:00.000Z' })
    expect(shouldShowDetailedSync(progress('incremental'), caughtUp)).toBe(false)
    expect(isMailboxRefreshing([caughtUp], [progress('incremental')], 'mail-1')).toBe(true)
  })

  it('still surfaces paused and failed refreshes after catch-up', () => {
    const caughtUp = account({ lastSyncAt: '2026-08-08T11:00:00.000Z' })
    expect(shouldShowDetailedSync(progress('paused'), caughtUp)).toBe(true)
    expect(shouldShowDetailedSync(progress('error'), caughtUp)).toBe(true)
    expect(isMailboxRefreshing([caughtUp], [progress('error')], 'all')).toBe(false)
  })
})
