import type { MailAccountSummary, SyncProgress } from '../mail-types'

const runningPhases = new Set<SyncProgress['phase']>(['inventory', 'downloading', 'catch-up', 'incremental'])

export function shouldShowDetailedSync(progress: SyncProgress, account?: MailAccountSummary) {
  if (progress.phase === 'idle' || progress.phase === 'complete') return false
  if (progress.phase === 'paused' || progress.phase === 'error') return true
  return !account?.lastSyncAt
}

export function isMailboxRefreshing(accounts: MailAccountSummary[], progress: SyncProgress[], selectedAccountId: string) {
  const accountsById = new Map(accounts.map((account) => [account.id, account]))
  return progress.some((item) => {
    const account = accountsById.get(item.accountId)
    const isSelected = selectedAccountId === 'all' || selectedAccountId === item.accountId
    return isSelected && Boolean(account?.lastSyncAt) && !account?.archived && runningPhases.has(item.phase)
  })
}
