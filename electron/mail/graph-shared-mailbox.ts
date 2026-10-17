import type { MailActionKind, MailSendOptions } from '../../src/mail-types'
import { ownerFolderLabel, type MailboxFolderAccess } from '../../src/mailbox-owner-types'
import { MicrosoftGraphError, type GraphMessage, type MicrosoftGraphClient } from './microsoft-client'
import {
  accessRemovedMessage, downloadOwnerMessages, MailboxAccessRemovedError, ownerLabels, ownerMessageId, ownerMessageLabels, ownerThreadId, recordOwnerItem,
  type OwnerSyncContext
} from './mailbox-owner-sync'
import { SenderIdentityError } from './sender-identity'
import type { StoredOwnerFolder } from './mailbox-owner-store'

// Shared mailboxes through Microsoft Graph (E40): /users/{address}/mailFolders, /messages, and
// /calendars with the signed-in user's delegated token (Mail.ReadWrite.Shared, Calendars.ReadWrite.Shared).
// Graph exposes no effective folder rights, so folders start writable and drop to read-only when
// Graph refuses a change with 403; a 403 or 404 for the mailbox itself means access was removed.

type GraphClient = Pick<MicrosoftGraphClient, 'listFolders' | 'listCalendars' | 'delta' | 'messageRaw' | 'messageState' | 'applyAction'>

export const isGraphDenied = (error: unknown) => error instanceof MicrosoftGraphError && (error.status === 403 || error.status === 401 && /access ?denied/i.test(error.message))
export const isGraphMissing = (error: unknown) => error instanceof MicrosoftGraphError && error.status === 404
const removedCode = (error: MicrosoftGraphError) => error.status === 404 ? 'ErrorNonExistentMailbox' : error.code ?? 'ErrorAccessDenied'

/** Mail folders and calendars of a shared mailbox the signed-in user can open. */
export async function probeGraphMailbox(client: GraphClient, ownerId: string, displayName: string, previous: StoredOwnerFolder[] = []) {
  let folders
  try {
    folders = await client.listFolders()
  } catch (error) {
    if (error instanceof MicrosoftGraphError && (error.status === 403 || error.status === 404)) throw new MailboxAccessRemovedError(accessRemovedMessage(displayName, removedCode(error)), removedCode(error))
    throw error
  }
  const downgraded = new Map(previous.filter((folder) => folder.kind === 'mail').map((folder) => [folder.folderId, folder]))
  const ids = new Set(folders.map((folder) => folder.id))
  const access: MailboxFolderAccess[] = folders.map((folder) => {
    const before = downgraded.get(folder.id)
    // A folder that refused a change stays read-only until the mailbox is attached again.
    const readOnly = before?.access === 'read' && Boolean(before.error)
    return {
      folderId: folder.id,
      labelId: ownerFolderLabel(ownerId, folder.id),
      ...(folder.parentMailFolderId && ids.has(folder.parentMailFolderId) ? { parentFolderId: folder.parentMailFolderId } : {}),
      name: folder.displayName,
      kind: 'mail' as const,
      ...(folder.specialUse ? { distinguished: folder.specialUse } : {}),
      access: readOnly ? 'read' as const : 'write' as const,
      canCreate: !readOnly, canModify: !readOnly, canDelete: !readOnly,
      ...(readOnly && before?.error ? { error: before.error } : {})
    }
  })
  try {
    for (const calendar of await client.listCalendars()) {
      access.push({ folderId: calendar.id, name: calendar.name, kind: 'calendar', access: calendar.canEdit ? 'write' : 'read', canCreate: Boolean(calendar.canEdit), canModify: Boolean(calendar.canEdit), canDelete: Boolean(calendar.canEdit), ...(calendar.isDefaultCalendar ? { distinguished: 'calendar' } : {}) })
    }
  } catch (error) {
    if (!(error instanceof MicrosoftGraphError)) throw error
    // No calendar permission is normal for mail-only shared mailboxes.
  }
  return access
}

const messageState = (message: GraphMessage) => ({ isRead: message.isRead, flagged: message.flag?.flagStatus === 'flagged', important: message.importance === 'high', categories: message.categories })

export async function syncGraphOwner(ctx: OwnerSyncContext, client: GraphClient) {
  const previous = ctx.owners.folders(ctx.accountId, ctx.owner.id)
  const folders = await probeGraphMailbox(client, ctx.owner.id, ctx.owner.displayName, previous)
  ctx.owners.replaceFolders(ctx.accountId, ctx.owner.id, folders)
  ctx.owners.replaceLabels(ctx.accountId, ctx.owner.id, ownerLabels(ctx.owner, folders))
  const current = new Set(folders.map((folder) => folder.labelId).filter(Boolean))
  for (const folder of previous) if (folder.labelId && !current.has(folder.labelId)) ctx.database.reconcileRemoteFolder(ctx.accountId, folder.labelId, new Set())
  const failures: string[] = []
  const states = new Map<string, GraphMessage>()
  for (const folder of ctx.owners.folders(ctx.accountId, ctx.owner.id)) {
    if (folder.kind !== 'mail' || !folder.labelId) continue
    await ctx.checkpoint?.()
    let delta
    try {
      delta = await client.delta(folder.folderId, folder.syncState)
    } catch (error) {
      if (error instanceof MicrosoftGraphError && error.status === 410 && folder.syncState) {
        // An expired delta token starts the folder over; messages it no longer lists are removed.
        delta = await client.delta(folder.folderId)
        ctx.database.reconcileRemoteFolder(ctx.accountId, folder.labelId, new Set(delta.messages.filter((message) => !message['@removed']).map((message) => ownerMessageId('graph', ctx.owner.id, message.id))))
      } else if (isGraphMissing(error)) { ctx.database.reconcileRemoteFolder(ctx.accountId, folder.labelId, new Set()); continue }
      else if (isGraphDenied(error)) {
        ctx.owners.setFolderAccess(ctx.accountId, ctx.owner.id, folder.folderId, 'none', 'Microsoft 365 refused access to this folder')
        ctx.database.reconcileRemoteFolder(ctx.accountId, folder.labelId, new Set())
        failures.push(folder.name)
        continue
      } else throw error
    }
    for (const message of delta.messages) {
      const id = ownerMessageId('graph', ctx.owner.id, message.id)
      if (message['@removed']) { ctx.database.deleteMessage(ctx.accountId, id); continue }
      states.set(message.id, message)
      recordOwnerItem(ctx, {
        id, threadId: ownerThreadId('graph', ctx.owner.id, message.conversationId, message.id), labelId: folder.labelId, remoteUid: message.id,
        labels: ownerMessageLabels(folder.labelId, messageState(message)), historyId: `graph:${message.changeKey ?? ''}`
      })
    }
    if (delta.deltaLink) ctx.owners.setFolderCheckpoint(ctx.accountId, ctx.owner.id, folder.folderId, delta.deltaLink)
  }
  const downloaded = await downloadOwnerMessages(ctx, async (items) => Promise.all(items.map(async (item) => {
    try {
      const state = states.get(item.remoteUid) ?? await client.messageState(item.remoteUid)
      return {
        raw: await client.messageRaw(item.remoteUid),
        ...(item.remoteFolderId ? { labels: ownerMessageLabels(item.remoteFolderId, messageState(state)) } : {}),
        ...(state.receivedDateTime ? { internalDate: new Date(state.receivedDateTime).toISOString() } : {}),
        historyId: `graph:${state.changeKey ?? ''}`
      }
    } catch (error) {
      if (isGraphMissing(error)) return 'missing' as const
      return error instanceof Error ? error : new Error(String(error))
    }
  })), 5)
  return { downloaded, failures }
}

/** Applies a queued action to shared-mailbox messages; move destinations are folders of the same mailbox. */
export async function applyOwnerGraphAction(client: Pick<MicrosoftGraphClient, 'applyAction'>, ids: string[], kind: MailActionKind, destinationFolderId?: string) {
  await client.applyAction(ids, kind, destinationFolderId)
}

export interface GraphDelegatedSendInput {
  mode: 'send-as' | 'send-on-behalf'
  ownerAddress: string
  delegateAddress: string
  mime: Buffer
  options?: MailSendOptions
  remoteDraftId?: string
}

/**
 * Stages the message as a draft of the signed-in user, sets `from` (and `sender` for send on
 * behalf), and sends it. Graph saves the copy in the signed-in user's Sent Items. A refusal
 * (ErrorSendAsDenied, 403) deletes the staged copy and keeps the Aerio draft with an explanation.
 */
export async function sendGraphDelegated(client: Pick<MicrosoftGraphClient, 'saveDraft' | 'setMessageSender' | 'sendDraft' | 'deleteDraft'>, input: GraphDelegatedSendInput) {
  const staged = await client.saveDraft(input.mime, undefined, input.options)
  try {
    await client.setMessageSender(staged.id, input.ownerAddress, input.mode === 'send-on-behalf' ? input.delegateAddress : undefined)
    await client.sendDraft(staged.id)
  } catch (error) {
    await client.deleteDraft(staged.id).catch(() => undefined)
    if (error instanceof MicrosoftGraphError && (error.status === 403 || /ErrorSendAsDenied|ErrorSendOnBehalfOfDenied/i.test(`${error.code ?? ''} ${error.message}`))) {
      throw new SenderIdentityError(input.mode === 'send-as'
        ? `Microsoft 365 refused to send as ${input.ownerAddress}: this account does not have Send As permission for that mailbox. The message was kept as a draft. (${error.code ?? error.status}: ${error.message})`
        : `Microsoft 365 refused to send on behalf of ${input.ownerAddress}: this account does not have Send on Behalf permission for that mailbox. The message was kept as a draft. (${error.code ?? error.status}: ${error.message})`)
    }
    throw error
  }
  if (input.remoteDraftId) await client.deleteDraft(input.remoteDraftId).catch(() => undefined)
}
