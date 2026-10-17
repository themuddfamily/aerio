import type { MailLabel } from '../mail-types'
import type { MailLabelOwner } from '../mailbox-owner-types'

// Renderer helpers for shared/delegated mailboxes and public folders (E40).

/** The owner of a conversation from its labels, when it belongs to another mailbox. */
export function conversationOwner(labels: MailLabel[], accountId: string, labelIds: string[]): MailLabelOwner | undefined {
  const ids = new Set(labelIds)
  return labels.find((label) => label.accountId === accountId && label.owner && ids.has(label.id))?.owner
}

/**
 * Why a conversation of another mailbox cannot be changed (read-only folder or access removed),
 * or undefined when it can. The worker enforces the same rules; this only disables the controls.
 */
export function mailboxRestriction(labels: MailLabel[], accountId: string, labelIds: string[]): string | undefined {
  const ids = new Set(labelIds)
  const owned = labels.filter((label) => label.accountId === accountId && label.owner && ids.has(label.id))
  if (!owned.length) return undefined
  const owner = owned[0].owner!
  if (owner.status === 'access-removed') return `Access to ${owner.displayName} was removed. Its cached mail is read-only.`
  const readOnly = owned.find((label) => !label.owner!.root && label.owner!.access !== 'write')
  return readOnly ? `Read-only: you can read but not change messages in ${readOnly.name} (${owner.displayName}).` : undefined
}

export function ownerBadgeText(owner: MailLabelOwner) {
  if (owner.status === 'access-removed') return 'Access removed'
  if (owner.access === 'read') return 'Read-only'
  if (owner.access === 'none') return 'No access'
  return owner.kind === 'public-folders' ? 'Public' : owner.kind === 'delegated' ? 'Delegate' : 'Shared'
}
