import type { MailActionKind } from '../../src/mail-types'
import { ownerFolderLabel, type MailboxFolderAccess, type PublicFolderNode } from '../../src/mailbox-owner-types'
import { accessFromRights } from '../mail/mailbox-owner-store'
import {
  accessRemovedMessage, downloadOwnerMessages, folderKind, MailboxAccessRemovedError, ownerLabels, ownerMessageId, ownerMessageLabels, ownerThreadId,
  recordOwnerItem, type OwnerSyncContext
} from '../mail/mailbox-owner-sync'
import { SenderIdentityError } from '../mail/sender-identity'
import { autodiscoverRequest, parsePoxResponse, type PoxAlternativeMailbox } from './autodiscover'
import { EwsClient, EwsError, MAIL_SYNC_PROPERTIES, type EwsFolder } from './ews-client'
import { actionUpdate } from './ews-mail'
import { EwsTransport, assertSecureEndpoint, type EwsCredentials } from './ews-transport'
import { element, escapeXml, fieldUris, folderIdXml, m, t, tBool, tText, ts, type FolderRef, type XmlElement } from './ews-xml'

// Delegated/shared mailboxes and public folders over EWS (E40).
//
//   - Another mailbox is addressed with <DistinguishedFolderId><Mailbox> (FolderRef.mailbox) and,
//     once its folders are known, by their FolderIds. EffectiveRights on each folder decide whether
//     it is read-only (Reviewer) or writable.
//   - Public folders are browsed from `publicfoldersroot` with the X-AnchorMailbox and
//     X-PublicFolderMailbox routing headers (Exchange 2013+ public folder mailboxes). EWS cannot
//     SyncFolderItems a public folder, so subscribed public mail folders are listed with FindItem
//     and compared with the cache by ChangeKey.
//   - Sending as (From = shared mailbox) or on behalf of (From = owner, Sender = delegate) another
//     mailbox uses CreateItem with explicit From/Sender and saves to the owner's Sent Items when
//     that folder is writable.

/** EWS codes that mean the mailbox as a whole is no longer available to this user. */
export const MAILBOX_REVOKED_CODES = new Set(['ErrorAccessDenied', 'ErrorNonExistentMailbox', 'ErrorMailboxNotFound', 'ErrorInvalidUser', 'ErrorNotDelegate', 'ErrorImpersonationDenied'])
const PROBE_FOLDERS = ['msgfolderroot', 'inbox', 'sentitems', 'drafts', 'deleteditems', 'junkemail', 'calendar', 'contacts', 'tasks', 'notes'] as const
const ITEM_PAGE = 100

const toAccess = (ownerId: string, folder: EwsFolder, distinguished?: string, parentIds?: Set<string>): MailboxFolderAccess => {
  const kind = folderKind(folder.folderClass ?? (distinguished === 'calendar' ? 'IPF.Appointment' : distinguished === 'contacts' ? 'IPF.Contact' : distinguished === 'tasks' ? 'IPF.Task' : distinguished === 'notes' ? 'IPF.StickyNote' : undefined))
  const rights = { canRead: folder.canRead, canCreate: folder.canCreateContents ?? false, canModify: folder.canModify ?? false }
  return {
    folderId: folder.id,
    ...(kind === 'mail' ? { labelId: ownerFolderLabel(ownerId, folder.id) } : {}),
    ...(folder.parentId && (!parentIds || parentIds.has(folder.parentId)) ? { parentFolderId: folder.parentId } : {}),
    name: folder.displayName || distinguished || 'Folder',
    kind,
    ...(distinguished ? { distinguished } : {}),
    access: accessFromRights(rights),
    canCreate: Boolean(folder.canCreateContents),
    canModify: Boolean(folder.canModify),
    canDelete: Boolean(folder.canDelete)
  }
}

/**
 * Reads which folders of `address` the signed-in user can open, with effective rights. A delegate
 * often sees only some distinguished folders (Inbox, Calendar) and gets ErrorAccessDenied on the
 * mailbox root; those folders are still returned. Throws MailboxAccessRemovedError when no folder
 * of the mailbox is reachable.
 */
export async function probeExchangeMailbox(client: Pick<EwsClient, 'getFolders' | 'findFolders'>, ownerId: string, address: string, displayName = address) {
  const results = await client.getFolders(PROBE_FOLDERS.map((id) => ({ id, mailbox: address })))
  let archive: EwsFolder | EwsError | undefined
  try { [archive] = await client.getFolders([{ id: 'archive', mailbox: address }]) } catch { /* Exchange 2013 rejects the distinguished Archive folder. */ }
  const found = new Map<string, { folder: EwsFolder; distinguished?: string }>()
  const errors: EwsError[] = []
  results.forEach((result, index) => {
    if (result instanceof EwsError) { errors.push(result); return }
    found.set(result.id, { folder: result, distinguished: PROBE_FOLDERS[index] })
  })
  if (archive && !(archive instanceof EwsError)) found.set(archive.id, { folder: archive, distinguished: 'archive' })
  if (!found.size) {
    const code = errors.find((error) => error.code === 'ErrorNonExistentMailbox' || error.code === 'ErrorMailboxNotFound' || error.code === 'ErrorInvalidUser')?.code
      ?? errors.find((error) => MAILBOX_REVOKED_CODES.has(error.code))?.code ?? errors[0]?.code ?? 'ErrorAccessDenied'
    throw new MailboxAccessRemovedError(accessRemovedMessage(displayName, code), code)
  }
  const root = [...found.values()].find((entry) => entry.distinguished === 'msgfolderroot')?.folder
  if (root && root.canRead !== false) {
    try {
      for (const folder of await client.findFolders({ id: root.id, distinguished: false }, 'Deep')) if (!found.has(folder.id)) found.set(folder.id, { folder })
    } catch (error) {
      // The root is visible but its subfolders are not listable: keep the distinguished folders.
      if (!(error instanceof EwsError)) throw error
    }
  }
  const ids = new Set([...found.keys()].filter((id) => id !== root?.id))
  return [...found.values()].filter((entry) => entry.folder.id !== root?.id).map((entry) => toAccess(ownerId, entry.folder, entry.distinguished, ids))
}

const itemShapeXml = (properties: string[]) =>
  `<m:ItemShape><t:BaseShape>IdOnly</t:BaseShape>${properties.length ? `<t:AdditionalProperties>${fieldUris(properties)}</t:AdditionalProperties>` : ''}</m:ItemShape>`

/** FindItem (shallow, paged): every item of a folder, for folders without SyncFolderItems (public folders). */
export async function findItems(client: Pick<EwsClient, 'call'>, folder: FolderRef, properties = MAIL_SYNC_PROPERTIES) {
  const items: XmlElement[] = []
  for (let offset = 0, page = 0; page < 10_000; page++) {
    const [message] = await client.call('FindItem', `<m:FindItem Traversal="Shallow">${itemShapeXml(properties)}<m:IndexedPageItemView MaxEntriesReturned="${ITEM_PAGE}" Offset="${offset}" BasePoint="Beginning"/><m:ParentFolderIds>${folderIdXml(folder)}</m:ParentFolderIds></m:FindItem>`)
    if (!message) break
    if (message.responseClass === 'Error') throw new EwsError(message.message ?? `FindItem failed (${message.code})`, message.code)
    const root = m(message.element, 'RootFolder')
    items.push(...(t(root, 'Items')?.children ?? []))
    if (root?.attributes.IncludesLastItemInRange !== 'false') break
    const next = Number(root.attributes.IndexedPagingOffset)
    if (!Number.isFinite(next) || next <= offset) break
    offset = next
  }
  return items
}

const itemState = (item: XmlElement) => ({
  isRead: tBool(item, 'IsRead'),
  flagged: tText(t(item, 'Flag'), 'FlagStatus') === 'Flagged',
  important: tText(item, 'Importance') === 'High',
  categories: ts(t(item, 'Categories'), 'String').map((category) => category.text.trim()).filter(Boolean)
})
const itemDate = (item: XmlElement) => {
  const value = tText(item, 'DateTimeReceived') ?? tText(item, 'DateTimeSent')
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined
}

function recordItem(ctx: OwnerSyncContext, labelId: string, item: XmlElement, itemId: string, seen: Set<string>) {
  const id = ownerMessageId('ews', ctx.owner.id, itemId)
  seen.add(id)
  recordOwnerItem(ctx, {
    id, threadId: ownerThreadId('ews', ctx.owner.id, t(item, 'ConversationId')?.attributes.Id, itemId), labelId, remoteUid: itemId,
    labels: ownerMessageLabels(labelId, itemState(item)), historyId: `ews:${t(item, 'ItemId')?.attributes.ChangeKey ?? ''}`
  })
}

const isAccessDenied = (error: unknown) => error instanceof EwsError && (error.code === 'ErrorAccessDenied' || error.code === 'ErrorNoPublicFolderReplicaAvailable')

/** SyncFolderItems pages for one mail folder of another mailbox, with a checkpoint per page. */
async function syncMailFolder(ctx: OwnerSyncContext, client: EwsClient, folder: MailboxFolderAccess & { syncState?: string }) {
  const labelId = folder.labelId!
  const shape = { baseShape: 'IdOnly' as const, properties: MAIL_SYNC_PROPERTIES }
  let syncState = folder.syncState
  let resync = false
  const seen = new Set<string>()
  for (let page = 0; page < 10_000; page++) {
    await ctx.checkpoint?.()
    let result
    try {
      result = await client.syncFolderItems({ id: folder.folderId, distinguished: false }, syncState, { maxChanges: ctx.pageSize ?? 100, shape })
    } catch (error) {
      if (error instanceof EwsError && error.code === 'ErrorInvalidSyncStateData' && syncState) { syncState = undefined; resync = true; continue }
      throw error
    }
    const refresh: string[] = []
    for (const change of result.changes) {
      if (change.type === 'delete') ctx.database.deleteMessage(ctx.accountId, ownerMessageId('ews', ctx.owner.id, change.id))
      else if (change.type === 'read-flag') refresh.push(change.id)
      else recordItem(ctx, labelId, change.item, change.id, seen)
    }
    if (refresh.length) {
      for (const item of await client.getItems(refresh, shape)) {
        const id = item instanceof EwsError ? undefined : t(item, 'ItemId')?.attributes.Id
        if (id && !(item instanceof EwsError)) recordItem(ctx, labelId, item, id, seen)
      }
    }
    syncState = result.syncState
    if (!resync) ctx.owners.setFolderCheckpoint(ctx.accountId, ctx.owner.id, folder.folderId, syncState)
    if (result.includesLastItemInRange) break
  }
  if (resync) {
    ctx.database.reconcileRemoteFolder(ctx.accountId, labelId, seen)
    ctx.owners.setFolderCheckpoint(ctx.accountId, ctx.owner.id, folder.folderId, syncState)
  }
}

/** FindItem listing compared with the cache (public folders cannot be synchronized incrementally). */
async function listMailFolder(ctx: OwnerSyncContext, client: EwsClient, folder: MailboxFolderAccess) {
  const labelId = folder.labelId!
  const seen = new Set<string>()
  for (const item of await findItems(client, { id: folder.folderId, distinguished: false })) {
    const id = t(item, 'ItemId')?.attributes.Id
    if (id) recordItem(ctx, labelId, item, id, seen)
  }
  ctx.database.reconcileRemoteFolder(ctx.accountId, labelId, seen)
  ctx.owners.setFolderCheckpoint(ctx.accountId, ctx.owner.id, folder.folderId, `listed:${new Date().toISOString()}`)
}

async function syncOwnerFolders(ctx: OwnerSyncContext, client: EwsClient, mode: 'sync' | 'list') {
  const folders = ctx.owners.folders(ctx.accountId, ctx.owner.id)
  const failures: string[] = []
  for (const folder of folders) {
    if (folder.kind !== 'mail' || !folder.labelId || folder.access === 'none') continue
    if (ctx.owner.kind === 'public-folders' && !folder.subscribed) continue
    try {
      if (mode === 'sync') await syncMailFolder(ctx, client, folder)
      else await listMailFolder(ctx, client, folder)
    } catch (error) {
      if (error instanceof EwsError && error.code === 'ErrorFolderNotFound') { ctx.database.reconcileRemoteFolder(ctx.accountId, folder.labelId, new Set()); continue }
      if (!isAccessDenied(error)) throw error
      // One refused folder does not stop the rest of the mailbox (partial failure).
      ctx.owners.setFolderAccess(ctx.accountId, ctx.owner.id, folder.folderId, 'none', 'Exchange refused access to this folder')
      ctx.database.reconcileRemoteFolder(ctx.accountId, folder.labelId, new Set())
      failures.push(folder.name)
    }
  }
  const downloaded = await downloadOwnerMessages(ctx, async (items) => {
    const results = await client.getMime(items.map((item) => item.remoteUid))
    return results.map((result, index) => {
      if (result instanceof EwsError) return result.code === 'ErrorItemNotFound' ? 'missing' as const : result
      const labelId = items[index].remoteFolderId
      return {
        raw: result.raw, internalDate: itemDate(result.item), historyId: `ews:${t(result.item, 'ItemId')?.attributes.ChangeKey ?? Date.now()}`,
        ...(labelId ? { labels: ownerMessageLabels(labelId, itemState(result.item)) } : {})
      }
    })
  })
  return { downloaded, failures }
}

/** Refreshes the folder list and rights of a delegated/shared mailbox and synchronizes its mail folders. */
export async function syncExchangeOwner(ctx: OwnerSyncContext, client: EwsClient) {
  const previous = ctx.owners.folders(ctx.accountId, ctx.owner.id)
  const folders = await probeExchangeMailbox(client, ctx.owner.id, ctx.owner.address, ctx.owner.displayName)
  ctx.owners.replaceFolders(ctx.accountId, ctx.owner.id, folders)
  ctx.owners.replaceLabels(ctx.accountId, ctx.owner.id, ownerLabels(ctx.owner, folders))
  const current = new Set(folders.map((folder) => folder.labelId).filter(Boolean))
  for (const folder of previous) if (folder.labelId && (!current.has(folder.labelId) || folders.find((item) => item.labelId === folder.labelId)?.access === 'none')) ctx.database.reconcileRemoteFolder(ctx.accountId, folder.labelId, new Set())
  return syncOwnerFolders(ctx, client, 'sync')
}

// --- Public folders ---------------------------------------------------------------------------------

/** A client that routes requests to the public folder hierarchy mailbox. */
export const publicFolderClient = (client: EwsClient, mailbox: string) => client.withHttpHeaders({ 'X-AnchorMailbox': mailbox, 'X-PublicFolderMailbox': mailbox })

/** One level of the public folder tree (FindFolder Shallow under publicfoldersroot or a folder). */
export async function browsePublicFolders(client: Pick<EwsClient, 'findFolders'>, parentFolderId: string | undefined, subscribed: Set<string>): Promise<PublicFolderNode[]> {
  const folders = await client.findFolders(parentFolderId ? { id: parentFolderId, distinguished: false } : { id: 'publicfoldersroot' }, 'Shallow')
  return folders.map((folder) => ({
    folderId: folder.id,
    ...(parentFolderId ? { parentFolderId } : {}),
    name: folder.displayName || 'Folder',
    folderClass: folder.folderClass ?? 'IPF.Note',
    kind: folderKind(folder.folderClass),
    childCount: folder.childFolderCount ?? 0,
    access: accessFromRights({ canRead: folder.canRead, canCreate: folder.canCreateContents, canModify: folder.canModify }),
    subscribed: subscribed.has(folder.id)
  })).sort((a, b) => a.name.localeCompare(b.name))
}

/** Reads one public folder's rights (for a new subscription). */
export async function publicFolderAccess(client: Pick<EwsClient, 'getFolders'>, ownerId: string, folderId: string, parentFolderId?: string) {
  const [folder] = await client.getFolders([{ id: folderId, distinguished: false }])
  if (!folder || folder instanceof EwsError) throw folder ?? new EwsError('The public folder was not found', 'ErrorFolderNotFound')
  return { ...toAccess(ownerId, folder), ...(parentFolderId ? { parentFolderId } : {}), subscribed: true }
}

/** Refreshes rights of subscribed public folders and lists their mail. */
export async function syncPublicFolders(ctx: OwnerSyncContext, client: EwsClient) {
  const subscribed = ctx.owners.folders(ctx.accountId, ctx.owner.id).filter((folder) => folder.subscribed)
  if (subscribed.length) {
    const results = await client.getFolders(subscribed.map((folder) => ({ id: folder.folderId, distinguished: false })))
    results.forEach((result, index) => {
      const folder = subscribed[index]
      if (result instanceof EwsError) {
        ctx.owners.saveFolder(ctx.accountId, ctx.owner.id, { ...folder, access: 'none', canCreate: false, canModify: false, canDelete: false, error: result.code === 'ErrorFolderNotFound' ? 'This public folder was deleted or moved' : 'Exchange refused access to this public folder' })
        if (folder.labelId) ctx.database.reconcileRemoteFolder(ctx.accountId, folder.labelId, new Set())
        return
      }
      ctx.owners.saveFolder(ctx.accountId, ctx.owner.id, { ...toAccess(ctx.owner.id, result), ...(folder.parentFolderId ? { parentFolderId: folder.parentFolderId } : {}), subscribed: true, syncState: folder.syncState })
    })
  }
  const all = ctx.owners.folders(ctx.accountId, ctx.owner.id)
  ctx.owners.replaceLabels(ctx.accountId, ctx.owner.id, ownerLabels(ctx.owner, all))
  return syncOwnerFolders(ctx, client, 'list')
}

// --- Actions and sending -----------------------------------------------------------------------------

/** Applies a queued action to another owner's items; returns the first item-level refusal, if any. */
export async function applyOwnerExchangeAction(client: Pick<EwsClient, 'updateItems' | 'moveItems'>, itemIds: string[], kind: MailActionKind, destinationFolderId?: string) {
  if (!itemIds.length) return undefined
  const update = actionUpdate(kind)
  let results: unknown[]
  if (update) results = await client.updateItems(itemIds.map((id) => ({ item: { id }, updates: update })), { conflictResolution: 'AutoResolve', messageDisposition: 'SaveOnly' })
  else if (destinationFolderId) results = await client.moveItems(itemIds, { id: destinationFolderId, distinguished: false })
  else throw new Error('Choose a folder of the same mailbox as the destination')
  return results.find((result): result is EwsError => result instanceof EwsError && result.code !== 'ErrorItemNotFound')
}

/** Inserts a Sender header (send on behalf) into the top-level header block of a MIME message. */
export function withSenderHeader(mime: Buffer, sender: string) {
  const text = mime.toString('latin1')
  const end = text.search(/\r?\n\r?\n/)
  const head = end < 0 ? text : text.slice(0, end)
  const body = end < 0 ? '' : text.slice(end)
  const cleaned = head.split(/\r?\n(?![ \t])/).filter((line) => !/^sender:/i.test(line)).join('\r\n')
  return Buffer.from(`${cleaned}\r\nSender: ${sender.replace(/[\r\n]+/g, ' ')}${body}`, 'latin1')
}

export interface DelegatedSendInput {
  mode: 'send-as' | 'send-on-behalf'
  ownerAddress: string
  delegateAddress: string
  /** Formatted `Name <address>` of the signed-in user for the Sender header. */
  delegateSender: string
  mime: Buffer
  saveToOwnerSentItems: boolean
  readReceipt?: boolean
  deliveryReceipt?: boolean
}

export const SEND_DENIED_CODES = new Set(['ErrorSendAsDenied', 'ErrorAccessDenied', 'ErrorNotDelegate', 'ErrorSendOnBehalfOfDenied', 'ErrorMessageSubmissionBlocked'])

const deniedMessage = (input: DelegatedSendInput, detail: string) => input.mode === 'send-as'
  ? `Exchange refused to send as ${input.ownerAddress}: this account does not have Send As permission for that mailbox. The message was kept as a draft. (${detail})`
  : `Exchange refused to send on behalf of ${input.ownerAddress}: this account does not have Send on Behalf permission for that mailbox. The message was kept as a draft. (${detail})`

/**
 * Sends with From = the shared mailbox (send as) or From = owner and Sender = delegate (send on
 * behalf). The copy goes to the owner's Sent Items when permitted; if Exchange refuses that folder,
 * the send is retried once with the delegate's own Sent Items. Refusals become SenderIdentityError
 * so the draft is kept with an explanation.
 */
export async function sendExchangeDelegated(client: Pick<EwsClient, 'createItems'>, input: DelegatedSendInput) {
  const mime = input.mode === 'send-on-behalf' ? withSenderHeader(input.mime, input.delegateSender) : input.mime
  const mailbox = (address: string) => `<t:Mailbox><t:EmailAddress>${escapeXml(address)}</t:EmailAddress></t:Mailbox>`
  // Item fields first, then MessageType order: Sender, ..., IsReadReceiptRequested, IsDeliveryReceiptRequested, ..., From.
  const xml = `<t:Message><t:MimeContent CharacterSet="UTF-8">${mime.toString('base64')}</t:MimeContent>` +
    (input.mode === 'send-on-behalf' ? `<t:Sender>${mailbox(input.delegateAddress)}</t:Sender>` : '') +
    (input.readReceipt ? element('IsReadReceiptRequested', true) : '') + (input.deliveryReceipt ? element('IsDeliveryReceiptRequested', true) : '') +
    `<t:From>${mailbox(input.ownerAddress)}</t:From></t:Message>`
  const attempt = (saved: FolderRef) => client.createItems(xml, { messageDisposition: 'SendAndSaveCopy', savedItemFolder: saved })
  try {
    try {
      await attempt(input.saveToOwnerSentItems ? { id: 'sentitems', mailbox: input.ownerAddress } : { id: 'sentitems' })
      return { savedTo: input.saveToOwnerSentItems ? 'owner' as const : 'delegate' as const }
    } catch (error) {
      if (!input.saveToOwnerSentItems || !(error instanceof EwsError) || error.code !== 'ErrorAccessDenied') throw error
      await attempt({ id: 'sentitems' })
      return { savedTo: 'delegate' as const }
    }
  } catch (error) {
    if (error instanceof EwsError && SEND_DENIED_CODES.has(error.code)) throw new SenderIdentityError(deniedMessage(input, `${error.code}: ${error.message}`))
    throw error
  }
}

// --- Discovery ------------------------------------------------------------------------------------------

export interface ExchangeMailboxDiscovery {
  alternativeMailboxes: PoxAlternativeMailbox[]
  publicFolderMailbox?: string
}

/**
 * Asks the Autodiscover service on the EWS host (already trusted with these credentials) for
 * AlternativeMailbox entries (delegate and team/shared mailboxes) and the public folder mailbox.
 */
export async function discoverExchangeMailboxes(config: { email: string; ewsUrl: string; credentials: EwsCredentials }, transport?: Pick<EwsTransport, 'post' | 'close'>): Promise<ExchangeMailboxDiscovery> {
  const url = new URL('/autodiscover/autodiscover.xml', assertSecureEndpoint(config.ewsUrl)).toString()
  const http = transport ?? new EwsTransport({ url, credentials: config.credentials, timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024 })
  try {
    const result = await http.post(autodiscoverRequest(config.email))
    if (result.status !== 200) throw new Error(`Autodiscover on the Exchange server answered HTTP ${result.status}`)
    const pox = parsePoxResponse(result.body.toString('utf8'))
    if (pox.action !== 'settings') return { alternativeMailboxes: [] }
    return {
      alternativeMailboxes: (pox.alternativeMailboxes ?? []).filter((entry) => entry.type !== 'Archive' && entry.smtpAddress.toLowerCase() !== config.email.toLowerCase()),
      ...(pox.publicFolderMailbox ? { publicFolderMailbox: pox.publicFolderMailbox } : {})
    }
  } finally {
    if (!transport) http.close()
  }
}
