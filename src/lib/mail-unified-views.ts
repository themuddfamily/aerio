import type { MailFolder } from '../mail-types'
import type { MailUnifiedView } from '../mail-unified-view-types'

export const UNIFIED_MAIL_FOLDERS: { id: MailFolder; name: string }[] = [
  { id: 'inbox', name: 'Inbox' }, { id: 'starred', name: 'Starred' }, { id: 'important', name: 'Important' },
  { id: 'snoozed', name: 'Snoozed' }, { id: 'drafts', name: 'Drafts' }, { id: 'scheduled', name: 'Scheduled' },
  { id: 'sent', name: 'Sent' }, { id: 'archive', name: 'Archive' }, { id: 'spam', name: 'Spam' }, { id: 'trash', name: 'Trash' }, { id: 'all', name: 'All mail' }
]

/** Undefined means all; an explicit empty list always means no matching accounts. */
export function unifiedViewAccountIds(view: MailUnifiedView | undefined, folder: MailFolder, availableIds: readonly string[]): string[] | undefined {
  if (!view) return undefined
  const members = view.folderAccountIds?.[folder] ?? view.accountIds
  return members.filter((id) => view.accountIds.includes(id) && availableIds.includes(id))
}
