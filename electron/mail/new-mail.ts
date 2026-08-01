import type { ParsedMailMessage } from './database'

export function buildNewMailNotification(accountId: string, records: ParsedMailMessage[]) {
  const visible = records.filter((record) => !record.labelIds.some((label) => ['SENT', 'DRAFT', 'SPAM', 'TRASH'].includes(label)))
  const unique = [...new Map(visible.map((record) => [record.messageIdHeader?.trim().toLowerCase() || record.id, record])).values()]
  if (!unique.length) return
  const latest = unique.sort((left, right) => right.internalDate.localeCompare(left.internalDate))[0]
  return {
    accountId,
    count: unique.length,
    threadId: unique.length === 1 ? latest.threadId : undefined,
    subject: unique.length === 1 ? latest.subject : undefined,
    sender: unique.length === 1 ? latest.fromName || latest.fromEmail : undefined
  }
}
