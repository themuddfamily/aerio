import { createHash } from 'node:crypto'
import type { MailLabel } from '../../src/mail-types'
import { ownerFolderLabel, ownerRootLabel, type MailboxFolderAccess, type MailboxFolderKind } from '../../src/mailbox-owner-types'
import type { MailDatabase } from './database'
import type { MailboxOwnerStore, StoredMailboxOwner } from './mailbox-owner-store'

// Provider-neutral pieces of shared-mailbox synchronization (E40): owner-scoped message and thread
// ids, owner labels, and the error that marks a mailbox's access as removed.

const hash = (value: string) => createHash('sha256').update(value).digest('base64url').slice(0, 32)

/** Message ids include the owner, so the same server item seen through two owners never collides. */
export const ownerMessageId = (prefix: 'ews' | 'graph', ownerId: string, remoteId: string) => `${prefix}-${hash(`owner:${ownerId}:${remoteId}`)}`
export const ownerThreadId = (prefix: 'ews' | 'graph', ownerId: string, conversationId: string | undefined, remoteId: string) =>
  `${prefix}-${hash(`owner:${ownerId}:${conversationId ? `conversation:${conversationId}` : `item:${remoteId}`}`)}`

/** The server refused the whole mailbox: access revoked, mailbox deleted, or never granted. */
export class MailboxAccessRemovedError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'MailboxAccessRemovedError'
  }
}

export const accessRemovedMessage = (displayName: string, code: string) =>
  code === 'ErrorNonExistentMailbox' || code === 'ErrorMailboxNotFound' || code === 'ResourceNotFound' || code === 'ErrorInvalidUser'
    ? `${displayName} no longer exists on the server or its address changed. Its cached mail is read-only until you remove it.`
    : `Your access to ${displayName} was removed. Synchronization stopped, queued changes are held for review, and the cached mail is read-only until you remove it.`

export const folderKind = (folderClass: string | undefined): MailboxFolderKind =>
  !folderClass || folderClass === 'IPF.Note' || folderClass.startsWith('IPF.Note.') || folderClass === 'IPF.Post' ? 'mail'
    : folderClass.startsWith('IPF.Appointment') ? 'calendar'
      : folderClass.startsWith('IPF.Contact') ? 'contacts'
        : folderClass.startsWith('IPF.Task') ? 'tasks'
          : folderClass.startsWith('IPF.StickyNote') ? 'notes' : 'other'

/** The sidebar tree of one owner: a root entry named after the mailbox and its mail folders. */
export function ownerLabels(owner: StoredMailboxOwner, folders: MailboxFolderAccess[]): MailLabel[] {
  const mail = folders.filter((folder) => folder.kind === 'mail' && folder.labelId && (owner.kind !== 'public-folders' || folder.subscribed))
  const byId = new Map(mail.map((folder) => [folder.folderId, folder]))
  const root = ownerRootLabel(owner.id)
  return [
    { accountId: owner.accountId, id: root, name: owner.displayName, type: 'user' as const },
    ...mail.map((folder) => ({
      accountId: owner.accountId,
      id: folder.labelId!,
      name: folder.name,
      type: 'user' as const,
      parentId: folder.parentFolderId && byId.get(folder.parentFolderId)?.labelId ? byId.get(folder.parentFolderId)!.labelId! : root
    }))
  ]
}

export function ownerMessageLabels(labelId: string, state: { isRead?: boolean; flagged?: boolean; important?: boolean; categories?: string[] }) {
  const labels = [labelId]
  if (state.isRead === false) labels.push('UNREAD')
  if (state.flagged) labels.push('STARRED')
  if (state.important) labels.push('IMPORTANT')
  for (const category of state.categories ?? []) if (category.trim()) labels.push(`category:${category.trim()}`)
  return [...new Set(labels)]
}

export interface StoredOwnerMessage {
  id: string
  threadId: string
  historyId: string
  raw: Buffer
  labelIds: string[]
  internalDate?: string
  sizeEstimate?: number
  remoteFolderId?: string
  remoteUid?: string
}

export interface OwnerSyncContext {
  accountId: string
  owner: StoredMailboxOwner
  owners: MailboxOwnerStore
  database: Pick<MailDatabase, 'hasMessage' | 'updateMessageLabels' | 'markSyncItem' | 'deleteMessage' | 'reconcileRemoteFolder'>
  /** The worker's parse-and-store path. */
  store(message: StoredOwnerMessage): Promise<{ isNew: boolean }>
  /** Waits while paused/offline and throws when sync must stop. */
  checkpoint?(): Promise<void>
  pageSize?: number
}

/** Adds a listed item to the owner's inventory, or refreshes the labels of one already stored. */
export function recordOwnerItem(ctx: OwnerSyncContext, item: { id: string; threadId: string; labelId: string; remoteUid: string; labels: string[]; historyId: string }) {
  ctx.owners.addInventory(ctx.accountId, ctx.owner.id, [{ id: item.id, threadId: item.threadId, remoteFolderId: item.labelId, remoteUid: item.remoteUid }])
  if (ctx.database.hasMessage(ctx.accountId, item.id)) {
    ctx.database.updateMessageLabels(ctx.accountId, item.id, item.labels, item.historyId, { remoteFolderId: item.labelId, remoteUid: item.remoteUid })
    ctx.database.markSyncItem(ctx.accountId, item.id, 'complete')
  }
}

/**
 * Downloads the owner's pending messages in batches. `fetch` returns raw MIME (or an error) per
 * item plus the labels/date to store with it. Failed items stay pending for the next pass.
 */
export async function downloadOwnerMessages(ctx: OwnerSyncContext, fetch: (items: { id: string; remoteUid: string; remoteFolderId?: string }[]) => Promise<({ raw: Buffer; labels?: string[]; internalDate?: string; historyId?: string } | Error | 'missing')[]>, batch = 10) {
  let stored = 0
  const failed = new Set<string>()
  for (let round = 0; round < 10_000; round++) {
    await ctx.checkpoint?.()
    const pending = ctx.owners.pending(ctx.accountId, ctx.owner.id, batch + failed.size).filter((item) => !failed.has(item.id)).slice(0, batch)
    if (!pending.length) break
    const valid = pending.filter((item) => item.remoteUid)
    for (const item of pending) if (!item.remoteUid) { ctx.database.markSyncItem(ctx.accountId, item.id, 'failed', 'The server item reference is missing'); failed.add(item.id) }
    if (!valid.length) continue
    const results = await fetch(valid.map((item) => ({ id: item.id, remoteUid: item.remoteUid!, ...(item.remoteFolderId ? { remoteFolderId: item.remoteFolderId } : {}) })))
    for (const [index, result] of results.entries()) {
      const item = valid[index]
      if (result === 'missing') { ctx.database.deleteMessage(ctx.accountId, item.id); continue }
      if (result instanceof Error) { ctx.database.markSyncItem(ctx.accountId, item.id, 'failed', result.message); failed.add(item.id); continue }
      try {
        await ctx.store({
          id: item.id, threadId: item.threadId, historyId: result.historyId ?? `owner:${Date.now()}`, raw: result.raw,
          labelIds: result.labels ?? [item.remoteFolderId ?? ownerRootLabel(ctx.owner.id)],
          ...(result.internalDate ? { internalDate: result.internalDate } : {}), sizeEstimate: result.raw.byteLength,
          ...(item.remoteFolderId ? { remoteFolderId: item.remoteFolderId } : {}), remoteUid: item.remoteUid
        })
        ctx.owners.tagMessage(ctx.accountId, ctx.owner.id, item.id)
        stored += 1
      } catch (error) {
        ctx.database.markSyncItem(ctx.accountId, item.id, 'failed', error instanceof Error ? error.message : String(error))
        failed.add(item.id)
      }
    }
  }
  return stored
}

export { ownerFolderLabel, ownerRootLabel }
