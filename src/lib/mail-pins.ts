import type { MailActionKind, MailThreadSummary, PendingOperation } from '../mail-types'

/** Mail actions that only change Aerio's local state and are never sent to a provider. */
export const LOCAL_ONLY_MAIL_ACTIONS: readonly MailActionKind[] = ['pin', 'unpin']

export const isLocalOnlyMailAction = (kind: string): kind is 'pin' | 'unpin' => kind === 'pin' || kind === 'unpin'

/** Pin when any target is unpinned; unpin only when every target is already pinned. */
export function pinActionFor(items: Pick<MailThreadSummary, 'pinned'>[]): 'pin' | 'unpin' {
  return items.length > 0 && items.every((item) => item.pinned) ? 'unpin' : 'pin'
}

/** Groups conversations by account, because each action request targets one account. */
export function threadIdsByAccount(items: Pick<MailThreadSummary, 'accountId' | 'id'>[]) {
  const groups = new Map<string, string[]>()
  for (const item of items) {
    const ids = groups.get(item.accountId) ?? []
    if (!ids.includes(item.id)) ids.push(item.id)
    groups.set(item.accountId, ids)
  }
  return groups
}

/**
 * Which heading, if any, starts before `item` in the conversation list. The
 * pinned group gets one "Pinned" heading; date headings resume after it.
 */
export function mailListGroupStart(
  previous: Pick<MailThreadSummary, 'pinned' | 'lastDate'> | undefined,
  item: Pick<MailThreadSummary, 'pinned' | 'lastDate'>,
  dateKey: (date: string) => string
): 'pinned' | 'date' | undefined {
  if (item.pinned) return previous?.pinned ? undefined : 'pinned'
  if (!previous || previous.pinned) return 'date'
  return dateKey(previous.lastDate) !== dateKey(item.lastDate) ? 'date' : undefined
}

/** Text for the undo toast; pin changes are already applied, not queued for a provider. */
export function pendingOperationsMessage(operations: Pick<PendingOperation, 'kind'>[]) {
  if (operations.length > 0 && operations.every((operation) => operation.kind === 'pin')) return 'Pinned to the top of the list'
  if (operations.length > 0 && operations.every((operation) => operation.kind === 'unpin')) return 'Unpinned'
  return operations.length > 1 ? `${operations.length} mail changes queued` : 'Mail change queued'
}
