import type { MailActionKind, MailThreadSummary, PendingOperation } from '../mail-types'

/** Pin actions use a separate state path; verified IMAP conversations also queue a dedicated keyword. */
export const PIN_MAIL_ACTIONS: readonly MailActionKind[] = ['pin', 'unpin']

export const isPinMailAction = (kind: string): kind is 'pin' | 'unpin' => kind === 'pin' || kind === 'unpin'

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

/** Pin ordering is applied immediately; capable IMAP conversations additionally queue server synchronization. */
export function pendingOperationsMessage(operations: (Pick<PendingOperation, 'kind'> & Partial<Pick<PendingOperation, 'status'>>)[]) {
  const queued = operations.some((operation) => operation.status === 'queued' || operation.status === 'running') ? ' · IMAP pin sync queued' : ''
  if (operations.length > 0 && operations.every((operation) => operation.kind === 'pin')) return `Pinned to the top of the list${queued}`
  if (operations.length > 0 && operations.every((operation) => operation.kind === 'unpin')) return `Unpinned${queued}`
  return operations.length > 1 ? `${operations.length} mail changes queued` : 'Mail change queued'
}
