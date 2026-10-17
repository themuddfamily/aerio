import { createHash } from 'node:crypto'
import type { MailActionKind, MailLabel, MailSendOptions } from '../../src/mail-types'
import type { XmlElement } from '../productivity/dav-xml'
import { EwsClient, EwsError, MAIL_SYNC_PROPERTIES, setItemField, t, tBool, tText, type EwsFolder, type EwsHierarchyChange } from './ews-client'
import { element, ts, type FolderRef } from './ews-xml'

// Exchange mail synchronization into Aerio's mail store. It runs in the mail worker and keeps the
// same shape as the Graph route: folders become `folder:<FolderId>` labels, and messages are
// stored from raw MIME (GetItem with IncludeMimeContent) through the worker's parse-and-store path.
//
// Checkpoints live in the account's provider state:
//   - `hierarchy.syncState` is the SyncFolderHierarchy state and `hierarchy.folders` the folder map
//   - `folders[<FolderId>].syncState` is each folder's SyncFolderItems state, saved after every
//     page (MaxChangesReturned), so an interrupted first sync resumes where it stopped
// Messages found by a page are inventoried as pending before the checkpoint moves, so a restart
// downloads anything not yet fetched instead of losing it.

export const EXCHANGE_SYNC_PAGE_SIZE = 100
const DOWNLOAD_BATCH = 10
const SPECIAL_FOLDERS = ['inbox', 'sentitems', 'drafts', 'deleteditems', 'junkemail'] as const

export interface ExchangeFolderSummary {
  id: string
  parentId?: string
  displayName: string
  folderClass?: string
}

export interface ExchangeProviderState {
  hierarchy?: { syncState: string; folders: Record<string, ExchangeFolderSummary> }
  folders: Record<string, { syncState?: string }>
  /** Distinguished folder name (inbox, sentitems, drafts, deleteditems, junkemail, archive, msgfolderroot) → FolderId. */
  special: Record<string, string>
}

const hash = (value: string) => createHash('sha256').update(value).digest('base64url').slice(0, 32)
export const exchangeMessageId = (itemId: string) => `ews-${hash(itemId)}`
export const exchangeThreadId = (conversationId: string | undefined, itemId: string) => `ews-${hash(conversationId ? `conversation:${conversationId}` : `item:${itemId}`)}`

export const isMailFolder = (folder: { folderClass?: string }) => !folder.folderClass || folder.folderClass === 'IPF.Note' || folder.folderClass.startsWith('IPF.Note.')

const SPECIAL_LABELS: Record<string, string> = { inbox: 'INBOX', sentitems: 'SENT', drafts: 'DRAFT', junkemail: 'SPAM', deleteditems: 'TRASH', archive: 'ARCHIVE' }

export function exchangeLabels(accountId: string, folders: ExchangeFolderSummary[], special: Record<string, string>): MailLabel[] {
  const ids = new Set(folders.map((folder) => folder.id))
  const specialIds = new Set(Object.entries(special).filter(([name]) => name !== 'msgfolderroot').map(([, id]) => id))
  return folders.map((folder) => ({
    accountId,
    id: `folder:${folder.id}`,
    name: folder.displayName,
    type: specialIds.has(folder.id) ? 'system' as const : 'user' as const,
    ...(folder.parentId && ids.has(folder.parentId) ? { parentId: `folder:${folder.parentId}` } : {})
  }))
}

export function exchangeMessageLabels(folderId: string, special: Record<string, string>, item: XmlElement) {
  const labels = [`folder:${folderId}`]
  for (const [name, label] of Object.entries(SPECIAL_LABELS)) if (special[name] === folderId) labels.push(label)
  if (tBool(item, 'IsDraft') && special.drafts === folderId) labels.push('DRAFT')
  if (tBool(item, 'IsRead') === false) labels.push('UNREAD')
  if (tText(t(item, 'Flag'), 'FlagStatus') === 'Flagged') labels.push('STARRED')
  if (tText(item, 'Importance') === 'High') labels.push('IMPORTANT')
  for (const category of ts(t(item, 'Categories'), 'String')) if (category.text.trim()) labels.push(`category:${category.text.trim()}`)
  return [...new Set(labels)]
}

const itemDate = (item: XmlElement) => {
  const value = tText(item, 'DateTimeReceived') ?? tText(item, 'DateTimeSent')
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined
}

/** The subset of MailDatabase the Exchange sync needs (kept narrow for tests). */
export interface ExchangeMailDatabase {
  replaceLabels(accountId: string, labels: MailLabel[]): void
  getProviderState<T>(accountId: string, fallback: T): T
  setProviderState(accountId: string, state: unknown): void
  getAccountHistory(accountId: string): string | undefined
  resetInventory(accountId: string): void
  addInventory(accountId: string, items: { id: string; threadId: string; remoteFolderId?: string; remoteUid?: string }[]): void
  hasMessage(accountId: string, messageId: string): boolean
  updateMessageLabels(accountId: string, messageId: string, labelIds: string[], historyId: string, location?: { remoteFolderId: string; remoteUid: string }): void
  markSyncItem(accountId: string, messageId: string, status: 'complete' | 'pending' | 'failed', error?: string): void
  reconcileRemoteFolder(accountId: string, remoteFolderId: string, currentIds: Set<string>): number
  deleteMessage(accountId: string, messageId: string): void
  pendingMessageIds(accountId: string, limit: number): { id: string; threadId: string; remoteFolderId?: string; remoteUid?: string }[]
}

export interface StoredMessageInput {
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

export interface ExchangeMailSyncDeps<TRecord> {
  accountId: string
  database: ExchangeMailDatabase
  client: Pick<EwsClient, 'syncFolderHierarchy' | 'syncFolderItems' | 'getFolders' | 'getItems' | 'getMime'>
  store(message: StoredMessageInput): Promise<{ record: TRecord; isNew: boolean }>
  progress?(phase: 'inventory' | 'downloading', message: string): void
  /** Waits while paused/offline and throws when sync must stop. */
  checkpoint?(): Promise<void>
  pageSize?: number
}

export const emptyExchangeState = (): ExchangeProviderState => ({ folders: {}, special: {} })

/** Resolves distinguished folders; "archive" is asked separately because older schemas reject it. */
export async function resolveSpecialFolders(client: Pick<EwsClient, 'getFolders'>) {
  const special: Record<string, string> = {}
  const names = ['msgfolderroot', ...SPECIAL_FOLDERS]
  const found = await client.getFolders(names.map((id) => ({ id })))
  found.forEach((folder, index) => { if (!(folder instanceof EwsError) && folder) special[names[index]] = folder.id })
  try {
    const [archive] = await client.getFolders([{ id: 'archive' }])
    if (archive && !(archive instanceof EwsError)) special.archive = archive.id
  } catch { /* Exchange 2013 has no distinguished Archive folder. */ }
  return special
}

const summary = (folder: EwsFolder): ExchangeFolderSummary => ({ id: folder.id, displayName: folder.displayName, ...(folder.parentId ? { parentId: folder.parentId } : {}), ...(folder.folderClass ? { folderClass: folder.folderClass } : {}) })

/** Applies SyncFolderHierarchy changes to the cached folder map; an invalid state starts over. */
export async function syncHierarchy(client: Pick<EwsClient, 'syncFolderHierarchy'>, previous: ExchangeProviderState['hierarchy']) {
  let result: { syncState: string; changes: EwsHierarchyChange[] }
  let folders = { ...(previous?.folders ?? {}) }
  try {
    result = await client.syncFolderHierarchy(previous?.syncState || undefined)
  } catch (error) {
    if (!(error instanceof EwsError) || error.code !== 'ErrorInvalidSyncStateData' || !previous?.syncState) throw error
    folders = {}
    result = await client.syncFolderHierarchy(undefined)
  }
  for (const change of result.changes) {
    if (change.type === 'delete') delete folders[change.id]
    else folders[change.folder.id] = summary(change.folder)
  }
  return { syncState: result.syncState, folders }
}

/**
 * One full Exchange mail pass: folder hierarchy, every mail folder's SyncFolderItems pages, and
 * the download of pending messages. Returns the newly stored records for notifications/rules.
 */
export async function syncExchangeMail<TRecord>(deps: ExchangeMailSyncDeps<TRecord>) {
  const { accountId, database, client } = deps
  const firstSync = !database.getAccountHistory(accountId)
  const state = database.getProviderState<ExchangeProviderState>(accountId, emptyExchangeState())
  state.folders ??= {}
  // A first sync that was interrupted keeps its pending inventory and per-folder checkpoints.
  if (firstSync && !Object.keys(state.folders).length) database.resetInventory(accountId)
  state.special = await resolveSpecialFolders(client)
  deps.progress?.('inventory', 'Checking Exchange folders')
  state.hierarchy = await syncHierarchy(client, state.hierarchy)
  const root = state.special.msgfolderroot
  const mailFolders = Object.values(state.hierarchy.folders).filter(isMailFolder).map((folder) => folder.parentId === root ? { ...folder, parentId: undefined } : folder)
  // Distinguished folders are always present even if the hierarchy listing omitted them.
  for (const [name, id] of Object.entries(state.special)) {
    if (name === 'msgfolderroot' || mailFolders.some((folder) => folder.id === id)) continue
    mailFolders.push({ id, displayName: name === 'sentitems' ? 'Sent Items' : name === 'deleteditems' ? 'Deleted Items' : name === 'junkemail' ? 'Junk Email' : name[0].toUpperCase() + name.slice(1) })
  }
  database.replaceLabels(accountId, exchangeLabels(accountId, mailFolders, state.special))
  database.setProviderState(accountId, state)

  // Folders that disappeared take their cached messages with them.
  const current = new Set(mailFolders.map((folder) => folder.id))
  for (const folderId of Object.keys(state.folders)) {
    if (current.has(folderId)) continue
    database.reconcileRemoteFolder(accountId, folderId, new Set())
    delete state.folders[folderId]
  }

  const pageSize = deps.pageSize ?? EXCHANGE_SYNC_PAGE_SIZE
  const shape = { baseShape: 'IdOnly' as const, properties: MAIL_SYNC_PROPERTIES }
  for (const folder of mailFolders) {
    let syncState = state.folders[folder.id]?.syncState
    // After an invalid state the folder is listed again from scratch, and messages the new
    // listing does not include are removed once it completes; checkpoints wait for that.
    let resync = false
    const seen = new Set<string>()
    for (let page = 0; ; page++) {
      await deps.checkpoint?.()
      let result
      try {
        result = await client.syncFolderItems({ id: folder.id }, syncState, { maxChanges: pageSize, shape })
      } catch (error) {
        if (error instanceof EwsError && error.code === 'ErrorInvalidSyncStateData' && syncState) {
          syncState = undefined
          resync = true
          continue
        }
        if (error instanceof EwsError && (error.code === 'ErrorFolderNotFound' || error.code === 'ErrorItemNotFound')) break
        throw error
      }
      const refresh: string[] = []
      for (const change of result.changes) {
        if (change.type === 'delete') {
          database.deleteMessage(accountId, exchangeMessageId(change.id))
          continue
        }
        if (change.type === 'read-flag') { refresh.push(change.id); continue }
        applyItem(database, accountId, folder.id, state.special, change.item, change.id, seen)
      }
      if (refresh.length) {
        for (const item of await client.getItems(refresh, shape)) {
          if (item instanceof EwsError) continue
          const id = t(item, 'ItemId')?.attributes.Id
          if (id) applyItem(database, accountId, folder.id, state.special, item, id, seen)
        }
      }
      syncState = result.syncState
      if (!resync) {
        state.folders[folder.id] = { syncState }
        database.setProviderState(accountId, state)
      }
      if (result.includesLastItemInRange) break
    }
    if (resync) {
      database.reconcileRemoteFolder(accountId, folder.id, seen)
      state.folders[folder.id] = { syncState }
      database.setProviderState(accountId, state)
    }
    deps.progress?.('inventory', `Indexed ${folder.displayName}`)
  }

  deps.progress?.('downloading', 'Downloading Exchange messages')
  const newRecords: TRecord[] = []
  const folderIds = new Set(mailFolders.map((folder) => folder.id))
  while (true) {
    await deps.checkpoint?.()
    const pending = database.pendingMessageIds(accountId, DOWNLOAD_BATCH)
    if (!pending.length) break
    const valid = pending.filter((item) => item.remoteUid)
    for (const item of pending) if (!item.remoteUid) database.markSyncItem(accountId, item.id, 'failed', 'The Exchange item reference is missing')
    if (!valid.length) continue
    const results = await client.getMime(valid.map((item) => item.remoteUid!))
    for (const [index, result] of results.entries()) {
      const item = valid[index]
      if (result instanceof EwsError) {
        // Moved or deleted since it was listed; the destination folder's sync adds it again.
        if (result.code === 'ErrorItemNotFound') database.deleteMessage(accountId, item.id)
        else database.markSyncItem(accountId, item.id, 'failed', result.message)
        continue
      }
      const parent = t(result.item, 'ParentFolderId')?.attributes.Id
      const folderId = parent && folderIds.has(parent) ? parent : item.remoteFolderId ?? parent ?? ''
      try {
        const stored = await deps.store({
          id: item.id,
          threadId: item.threadId,
          historyId: `ews:${t(result.item, 'ItemId')?.attributes.ChangeKey ?? Date.now()}`,
          raw: result.raw,
          labelIds: exchangeMessageLabels(folderId, state.special, result.item),
          internalDate: itemDate(result.item),
          sizeEstimate: Number(tText(result.item, 'Size')) || result.raw.byteLength,
          remoteFolderId: folderId,
          remoteUid: item.remoteUid
        })
        if (stored.isNew) newRecords.push(stored.record)
      } catch (error) {
        database.markSyncItem(accountId, item.id, 'failed', error instanceof Error ? error.message : String(error))
      }
    }
  }
  database.setProviderState(accountId, state)
  return { firstSync, newRecords, state }
}

function applyItem(database: ExchangeMailDatabase, accountId: string, folderId: string, special: Record<string, string>, item: XmlElement, itemId: string, seen: Set<string>) {
  const id = exchangeMessageId(itemId)
  seen.add(id)
  const threadId = exchangeThreadId(t(item, 'ConversationId')?.attributes.Id, itemId)
  database.addInventory(accountId, [{ id, threadId, remoteFolderId: folderId, remoteUid: itemId }])
  if (database.hasMessage(accountId, id)) {
    database.updateMessageLabels(accountId, id, exchangeMessageLabels(folderId, special, item), `ews:${t(item, 'ItemId')?.attributes.ChangeKey ?? ''}`, { remoteFolderId: folderId, remoteUid: itemId })
    database.markSyncItem(accountId, id, 'complete')
  }
}

// --- Mail actions -------------------------------------------------------------------------------

const flagXml = (status: 'Flagged' | 'NotFlagged') => `<t:Flag><t:FlagStatus>${status}</t:FlagStatus></t:Flag>`

export function actionUpdate(kind: MailActionKind) {
  if (kind === 'read' || kind === 'unread') return setItemField('message:IsRead', 'Message', element('IsRead', kind === 'read'))
  if (kind === 'star' || kind === 'unstar') return setItemField('item:Flag', 'Message', flagXml(kind === 'star' ? 'Flagged' : 'NotFlagged'))
  if (kind === 'important' || kind === 'unimportant') return setItemField('item:Importance', 'Message', element('Importance', kind === 'important' ? 'High' : 'Normal'))
  return undefined
}

export function actionDestination(kind: MailActionKind, labelId: string | undefined, special: Record<string, string>): FolderRef | undefined | null {
  if (kind === 'trash' || labelId === 'TRASH') return { id: 'deleteditems' }
  if (kind === 'untrash' || kind === 'unarchive' || labelId === 'INBOX') return { id: 'inbox' }
  if (labelId === 'SPAM') return { id: 'junkemail' }
  if (kind === 'archive') return special.archive ? { id: special.archive, distinguished: false } : null
  if ((kind === 'move' || kind === 'label') && labelId?.startsWith('folder:')) return { id: labelId.slice(7), distinguished: false }
  return undefined
}

/** Applies one queued mail action to Exchange items (UpdateItem for flags, MoveItem for folders). */
export async function applyExchangeAction(client: Pick<EwsClient, 'updateItems' | 'moveItems'>, special: Record<string, string>, itemIds: string[], kind: MailActionKind, labelId?: string) {
  if (!itemIds.length) return
  const update = actionUpdate(kind)
  const results: (unknown)[] = []
  if (update) results.push(...await client.updateItems(itemIds.map((id) => ({ item: { id }, updates: update })), { conflictResolution: 'AutoResolve', messageDisposition: 'SaveOnly' }))
  else {
    const destination = actionDestination(kind, labelId, special)
    if (destination === null) throw new Error('This Exchange mailbox has no Archive folder. Create one or move the messages to a folder instead.')
    if (!destination) return
    results.push(...await client.moveItems(itemIds, destination))
  }
  // Items already moved or deleted elsewhere converge on the next sync.
  const failure = results.find((result): result is EwsError => result instanceof EwsError && result.code !== 'ErrorItemNotFound')
  if (failure) throw failure
}

// --- Sending and drafts -------------------------------------------------------------------------

export async function sendExchangeMime(client: Pick<EwsClient, 'sendMime'>, mime: Buffer, options?: MailSendOptions) {
  await client.sendMime(mime, { readReceipt: Boolean(options?.requestReadReceipt), deliveryReceipt: Boolean(options?.requestDeliveryReceipt) })
}

/** Saves a draft from MIME; the superseded server copy is removed only after the new one exists. */
export async function saveExchangeDraft(client: Pick<EwsClient, 'saveDraftMime' | 'deleteItems'>, mime: Buffer, existingId?: string) {
  const saved = await client.saveDraftMime(mime)
  if (existingId && existingId !== saved.id) await client.deleteItems([existingId], 'HardDelete').catch(() => undefined)
  return { id: saved.id, revision: saved.changeKey }
}

// --- Folder management (MailFolderManager) --------------------------------------------------------

export class ExchangeFolderApi {
  constructor(private readonly client: EwsClient) {}

  /** Every mail folder as labels, via FindFolder (Deep) under the message folder root. */
  async listLabels(accountId: string) {
    const special = await resolveSpecialFolders(this.client)
    const folders = (await this.client.findFolders({ id: 'msgfolderroot' }, 'Deep')).filter(isMailFolder)
      .map((folder) => summary(folder.parentId === special.msgfolderroot ? { ...folder, parentId: undefined } : folder))
    return exchangeLabels(accountId, folders, special)
  }

  async folder(id: string) {
    const [folder] = await this.client.getFolders([{ id, distinguished: false }])
    if (folder instanceof EwsError) throw folder
    return folder!
  }

  async createFolder(name: string, parentId?: string) {
    return this.client.createFolder(parentId ? { id: parentId, distinguished: false } : { id: 'msgfolderroot' }, name)
  }

  renameFolder(id: string, name: string) { return this.client.renameFolder({ id, distinguished: false }, name) }

  moveFolder(id: string, parentId?: string) { return this.client.moveFolder({ id, distinguished: false }, parentId ? { id: parentId, distinguished: false } : { id: 'msgfolderroot' }) }

  /** Deleted folders go to Deleted Items with their messages, as in Outlook. */
  deleteFolder(id: string) { return this.client.deleteFolder({ id, distinguished: false }, 'MoveToDeletedItems') }
}
