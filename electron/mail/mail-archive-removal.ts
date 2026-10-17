import type { MailProviderId } from '../../src/mail-types'
import type { MailArchiveRemoval } from '../../src/mail-archive-types'
import { mailArchiveDeleteUnavailable } from '../../src/lib/mail-archive'

export interface ArchiveRemovalRequest {
  accountId: string
  mode: MailArchiveRemoval
  messages: { id: string; remoteFolderId?: string; remoteUid?: string }[]
}

export interface ArchiveRemovalClients {
  provider: MailProviderId
  gmail(): { trashMessages(ids: string[]): Promise<unknown> }
  microsoft(): {
    applyAction(ids: string[], action: 'trash', folderId?: string): Promise<unknown>
    permanentDeleteMessages(ids: string[]): Promise<unknown>
  }
  imap(): Promise<{
    applyAction(messages: { folder: string; uid: number }[], action: 'trash'): Promise<unknown>
    deleteMessages(messages: { folder: string; uid: number }[]): Promise<unknown>
  }>
  /** Microsoft's Deleted Items folder id, from the synchronized special folders. */
  microsoftDeletedItems?: string
}

/**
 * Removes exactly the archived messages from the server: never whole
 * conversations, so newer or excluded messages of the same thread stay put.
 * Messages no longer in the local cache were already moved or deleted by a
 * synchronization and are skipped.
 */
export async function removeArchivedMessages(clients: ArchiveRemovalClients, request: ArchiveRemovalRequest) {
  if (!request.messages.length) return
  const ids = request.messages.map((message) => message.id)
  if (clients.provider === 'gmail') {
    if (request.mode === 'delete') throw new Error(mailArchiveDeleteUnavailable('gmail'))
    await clients.gmail().trashMessages(ids)
    return
  }
  if (clients.provider === 'microsoft') {
    if (request.mode === 'delete') await clients.microsoft().permanentDeleteMessages(ids)
    else {
      if (!clients.microsoftDeletedItems) throw new Error('Microsoft did not expose the Deleted Items folder')
      await clients.microsoft().applyAction(ids, 'trash', clients.microsoftDeletedItems)
    }
    return
  }
  const located = request.messages.flatMap((message) => message.remoteFolderId && message.remoteUid && Number.isSafeInteger(Number(message.remoteUid))
    ? [{ folder: message.remoteFolderId, uid: Number(message.remoteUid) }] : [])
  if (!located.length) return
  const client = await clients.imap()
  if (request.mode === 'delete') await client.deleteMessages(located)
  else await client.applyAction(located, 'trash')
}
