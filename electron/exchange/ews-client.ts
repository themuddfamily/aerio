import type { XmlElement } from '../productivity/dav-xml'
import { EwsHttpError, EwsNetworkError, EwsTransport, type EwsCredentials, type HttpResult } from './ews-transport'
import {
  attr, DISTINGUISHED_FOLDERS, element, escapeXml, fieldUris, folderIdXml, itemIdXml, m, parseEnvelope, readFolderId, readItemId, responseMessages, soapEnvelope, t, tBool,
  tNumber, ts, tText, EwsSoapFault, type EnvelopeOptions, type EwsResponseMessage, type EwsServerVersion, type FolderRef, type ItemRef
} from './ews-xml'

/*
 * Exchange Web Services SOAP client.
 *
 * This is the shared EWS layer for Aerio's Exchange provider: mail synchronization
 * (exchange/ews-mail.ts), Calendar and Contacts (exchange/exchange-productivity.ts), and later
 * delegation/public folders (E40), directory lookup (E41), and Notes (E43). It is deliberately
 * small and layered:
 *
 *   - `call(operation, body)` sends any EWS operation and returns its response messages; it
 *     handles authentication (via EwsTransport), SOAP faults, ErrorServerBusy back-off, and the
 *     server version reported in each response header. New operations (ResolveNames,
 *     GetDelegate, FindFolder on publicfoldersroot, ...) can be built on it without changes here.
 *   - Typed helpers for the operations Aerio uses today (folders, sync, items).
 *
 * Every helper takes `FolderRef`s, so a distinguished folder of another mailbox
 * (`{ id: 'inbox', mailbox: 'shared@example.com' }`) works the same as the signed-in mailbox.
 * Item-level failures are returned as `EwsItemError` values instead of throwing, because EWS
 * reports success or failure per item in batch requests.
 */

export class EwsError extends Error {
  constructor(message: string, readonly code: string, readonly responseClass: 'Warning' | 'Error' = 'Error') {
    super(message)
    this.name = 'EwsError'
  }
}

export const isEwsError = (value: unknown): value is EwsError => value instanceof EwsError

/** Response codes that mean "retry later" rather than "this request is wrong". */
export const TRANSIENT_CODES = new Set(['ErrorServerBusy', 'ErrorTimeoutExpired', 'ErrorInternalServerTransientError', 'ErrorMailboxStoreUnavailable', 'ErrorConnectionFailed', 'ErrorMailboxMoveInProgress'])

export interface EwsFolder {
  id: string
  changeKey?: string
  parentId?: string
  displayName: string
  folderClass?: string
  totalCount?: number
  childFolderCount?: number
  unreadCount?: number
  /** Set when the folder was requested by distinguished name. */
  distinguished?: string
  canCreateContents?: boolean
  canModify?: boolean
  canDelete?: boolean
}

export type EwsItemChange =
  | { type: 'create' | 'update'; id: string; changeKey?: string; item: XmlElement }
  | { type: 'delete'; id: string }
  | { type: 'read-flag'; id: string; isRead: boolean }

export interface EwsSyncPage {
  syncState: string
  includesLastItemInRange: boolean
  changes: EwsItemChange[]
}

export type EwsHierarchyChange =
  | { type: 'create' | 'update'; folder: EwsFolder }
  | { type: 'delete'; id: string }

export interface EwsClientOptions {
  url: string
  credentials: EwsCredentials
  transport?: EwsTransport
  sleep?(ms: number): Promise<void>
  /** Extra SOAP headers for every request, e.g. ExchangeImpersonation. */
  headers?: string
}

export interface ItemShapeOptions {
  baseShape?: 'IdOnly' | 'Default' | 'AllProperties'
  properties?: string[]
  /** Extra raw property paths (ExtendedFieldURI, IndexedFieldURI), already serialized. */
  rawProperties?: string
  includeMime?: boolean
  bodyType?: 'Text' | 'HTML' | 'Best'
}

export const MAIL_SYNC_PROPERTIES = ['item:ItemClass', 'message:IsRead', 'item:Importance', 'item:Flag', 'item:Categories', 'item:DateTimeReceived', 'item:DateTimeSent', 'item:ConversationId', 'item:Size', 'item:IsDraft', 'item:ParentFolderId']
const FOLDER_PROPERTIES = ['folder:DisplayName', 'folder:FolderClass', 'folder:ParentFolderId', 'folder:TotalCount', 'folder:ChildFolderCount', 'folder:UnreadCount', 'folder:EffectiveRights']

function itemShape(options: ItemShapeOptions = {}) {
  const props = options.properties?.length || options.rawProperties ? `<t:AdditionalProperties>${fieldUris(options.properties ?? [])}${options.rawProperties ?? ''}</t:AdditionalProperties>` : ''
  return `<m:ItemShape><t:BaseShape>${options.baseShape ?? 'IdOnly'}</t:BaseShape>${options.includeMime ? '<t:IncludeMimeContent>true</t:IncludeMimeContent>' : ''}${options.bodyType ? `<t:BodyType>${options.bodyType}</t:BodyType>` : ''}${props}</m:ItemShape>`
}

const folderShape = () => `<m:FolderShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties>${fieldUris(FOLDER_PROPERTIES)}</t:AdditionalProperties></m:FolderShape>`

/** The single folder element (Folder, CalendarFolder, ContactsFolder, SearchFolder, TasksFolder) in a container. */
const folderElement = (container: XmlElement | undefined) => container?.children.find((child) => /Folder$/.test(child.name))

export function parseFolder(element: XmlElement, distinguished?: string): EwsFolder | undefined {
  const id = readFolderId(element)
  if (!id) return undefined
  const rights = t(element, 'EffectiveRights')
  const parent = t(element, 'ParentFolderId')?.attributes.Id
  return {
    id: id.id,
    ...(id.changeKey ? { changeKey: id.changeKey } : {}),
    ...(parent ? { parentId: parent } : {}),
    displayName: tText(element, 'DisplayName') ?? '',
    ...(tText(element, 'FolderClass') ? { folderClass: tText(element, 'FolderClass') } : {}),
    ...(tNumber(element, 'TotalCount') !== undefined ? { totalCount: tNumber(element, 'TotalCount') } : {}),
    ...(tNumber(element, 'ChildFolderCount') !== undefined ? { childFolderCount: tNumber(element, 'ChildFolderCount') } : {}),
    ...(tNumber(element, 'UnreadCount') !== undefined ? { unreadCount: tNumber(element, 'UnreadCount') } : {}),
    ...(distinguished ? { distinguished } : {}),
    ...(rights ? { canCreateContents: tBool(rights, 'CreateContents') ?? true, canModify: tBool(rights, 'Modify') ?? true, canDelete: tBool(rights, 'Delete') ?? true } : {})
  }
}

/** The item element (Message, CalendarItem, Contact, MeetingRequest, Item, ...) inside a change or Items container. */
export const itemElement = (container: XmlElement | undefined) => container?.children.find((child) => child.name !== 'ItemId' && child.name !== 'IsRead')

export const formatServerVersion = (version: EwsServerVersion | undefined) => {
  if (!version) return undefined
  const product = version.major === 15 && version.minor === 0 ? 'Exchange 2013'
    : version.major === 15 && version.minor === 1 ? 'Exchange 2016'
      : version.major === 15 && version.minor === 2 ? (version.build >= 2562 ? 'Exchange Server Subscription Edition or 2019 CU15+' : 'Exchange 2019')
        : version.major === 14 ? 'Exchange 2010' : `Exchange ${version.major}.${version.minor}`
  return `${version.major}.${version.minor}.${version.build}.${version.revision} (${product})`
}

/** Exchange 2013 SP1 is build 15.0.847; older servers are refused with an explicit message. */
export function assertSupportedServer(version: EwsServerVersion | undefined) {
  if (!version || !version.major) return
  if (version.major < 15 || (version.major === 15 && version.minor === 0 && version.build < 847)) {
    throw new EwsError(`This server reports ${formatServerVersion(version)}. Aerio supports Exchange Server 2013 SP1 or later (2016, 2019, Subscription Edition).`, 'ErrorUnsupportedServerVersion')
  }
}

export class EwsClient {
  readonly transport: EwsTransport
  serverVersion?: EwsServerVersion
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly options: EwsClientOptions) {
    this.transport = options.transport ?? new EwsTransport({ url: options.url, credentials: options.credentials })
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  get authMethod() { return this.transport.authMethod }

  close() { this.transport.close() }

  /**
   * Sends one EWS operation. Returns its response messages; item-level errors are left to the
   * caller. SOAP faults and transport failures throw.
   */
  async call(operation: string, body: string, envelope: EnvelopeOptions = {}): Promise<EwsResponseMessage[]> {
    const xml = soapEnvelope(body, { ...envelope, headers: `${this.options.headers ?? ''}${envelope.headers ?? ''}` || undefined })
    for (let attempt = 0; ; attempt++) {
      let result: HttpResult
      try {
        result = await this.transport.post(xml, { SOAPAction: `"http://schemas.microsoft.com/exchange/services/2006/messages/${operation}"` })
      } catch (error) {
        if (error instanceof EwsNetworkError && attempt < 2) { await this.sleep(1_000 * (attempt + 1)); continue }
        throw error
      }
      if ((result.status === 503 || result.status === 429) && attempt < 4) {
        const retryAfter = Number(result.headers['retry-after'])
        await this.sleep(Math.min(60_000, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 2_000 * 2 ** attempt))
        continue
      }
      const text = result.body.toString('utf8')
      // EWS reports SOAP faults with HTTP 500; anything else that is not XML is a transport problem.
      if (result.status !== 200 && !(result.status === 500 && text.includes('Envelope'))) {
        throw new EwsHttpError(result.status === 404 ? 'No EWS service was found at this address (404). Check the EWS URL.' : `Exchange responded with HTTP ${result.status}`, result.status, text.slice(0, 2_000))
      }
      let parsed
      try { parsed = parseEnvelope(text) } catch (error) {
        if (error instanceof EwsSoapFault) {
          if (error.code === 'ErrorServerBusy' && attempt < 4) { await this.sleep(2_000 * 2 ** attempt); continue }
          throw new EwsError(error.message, error.code ?? 'ErrorSoapFault')
        }
        throw error
      }
      if (parsed.serverVersion) this.serverVersion = parsed.serverVersion
      const messages = responseMessages(parsed.body, operation)
      const busy = messages.find((message) => message.code === 'ErrorServerBusy')
      if (busy && attempt < 4) { await this.sleep(Math.min(60_000, busy.backOffMs ?? 2_000 * 2 ** attempt)); continue }
      return messages
    }
  }

  /** Like `call` for single-target operations: throws the first error response. */
  private async callOne(operation: string, body: string, envelope?: EnvelopeOptions) {
    const messages = await this.call(operation, body, envelope)
    const failure = messages.find((message) => message.responseClass === 'Error')
    if (failure) throw new EwsError(failure.message ?? `${operation} failed (${failure.code})`, failure.code)
    if (!messages[0]) throw new EwsError(`Exchange returned an empty ${operation} response`, 'ErrorInternalServerError')
    return messages[0]
  }

  // --- Folders -------------------------------------------------------------------------------

  async getFolders(folders: FolderRef[]): Promise<(EwsFolder | EwsError)[]> {
    const messages = await this.call('GetFolder', `<m:GetFolder>${folderShape()}<m:FolderIds>${folders.map(folderIdXml).join('')}</m:FolderIds></m:GetFolder>`)
    return folders.map((folder, index) => {
      const message = messages[index]
      if (!message || message.responseClass === 'Error') return new EwsError(message?.message ?? 'The folder was not found', message?.code ?? 'ErrorFolderNotFound')
      const found = folderElement(m(message.element, 'Folders'))
      const distinguished = (folder.distinguished ?? DISTINGUISHED_FOLDERS.has(folder.id)) ? folder.id : undefined
      return (found && parseFolder(found, distinguished)) || new EwsError('The folder was not found', 'ErrorFolderNotFound')
    })
  }

  /** FindFolder with paging (IndexedPageFolderView). */
  async findFolders(parent: FolderRef, traversal: 'Shallow' | 'Deep' = 'Deep') {
    const folders: EwsFolder[] = []
    for (let offset = 0; ;) {
      const message = await this.callOne('FindFolder', `<m:FindFolder Traversal="${traversal}">${folderShape()}<m:IndexedPageFolderView MaxEntriesReturned="500" Offset="${offset}" BasePoint="Beginning"/><m:ParentFolderIds>${folderIdXml(parent)}</m:ParentFolderIds></m:FindFolder>`)
      const root = m(message.element, 'RootFolder')
      for (const child of t(root, 'Folders')?.children ?? []) {
        const folder = parseFolder(child)
        if (folder) folders.push(folder)
      }
      if (root?.attributes.IncludesLastItemInRange !== 'false') return folders
      const next = Number(root.attributes.IndexedPagingOffset)
      if (!Number.isFinite(next) || next <= offset) return folders
      offset = next
    }
  }

  /** SyncFolderHierarchy until the server reports the last folder; returns the new sync state. */
  async syncFolderHierarchy(syncState?: string, root?: FolderRef) {
    const changes: EwsHierarchyChange[] = []
    let state = syncState
    for (let page = 0; page < 1_000; page++) {
      const message = await this.callOne('SyncFolderHierarchy', `<m:SyncFolderHierarchy>${folderShape()}${root ? `<m:SyncFolderId>${folderIdXml(root)}</m:SyncFolderId>` : ''}${state ? `<m:SyncState>${escapeXml(state)}</m:SyncState>` : ''}</m:SyncFolderHierarchy>`)
      state = (m(message.element, 'SyncState')?.text ?? state ?? '').trim()
      for (const change of m(message.element, 'Changes')?.children ?? []) {
        if (change.name === 'Delete') {
          const id = t(change, 'FolderId')?.attributes.Id
          if (id) changes.push({ type: 'delete', id })
          continue
        }
        const folder = folderElement(change) ? parseFolder(folderElement(change)!) : undefined
        if (folder) changes.push({ type: change.name === 'Create' ? 'create' : 'update', folder })
      }
      if (m(message.element, 'IncludesLastFolderInRange')?.text.trim() !== 'false') return { syncState: state ?? '', changes }
    }
    throw new EwsError('Exchange returned too many folder hierarchy pages', 'ErrorTooManyPages')
  }

  async createFolder(parent: FolderRef, displayName: string, folderClass = 'IPF.Note') {
    const message = await this.callOne('CreateFolder', `<m:CreateFolder><m:ParentFolderId>${folderIdXml(parent)}</m:ParentFolderId><m:Folders><t:Folder>${element('FolderClass', folderClass)}${element('DisplayName', displayName)}</t:Folder></m:Folders></m:CreateFolder>`)
    const id = readFolderId(folderElement(m(message.element, 'Folders')))
    if (!id) throw new EwsError('Exchange did not return the new folder', 'ErrorInternalServerError')
    return id
  }

  async renameFolder(folder: FolderRef, displayName: string) {
    await this.callOne('UpdateFolder', `<m:UpdateFolder><m:FolderChanges><t:FolderChange>${folderIdXml(folder)}<t:Updates><t:SetFolderField><t:FieldURI FieldURI="folder:DisplayName"/><t:Folder>${element('DisplayName', displayName)}</t:Folder></t:SetFolderField></t:Updates></t:FolderChange></m:FolderChanges></m:UpdateFolder>`)
  }

  async moveFolder(folder: FolderRef, parent: FolderRef) {
    const message = await this.callOne('MoveFolder', `<m:MoveFolder><m:ToFolderId>${folderIdXml(parent)}</m:ToFolderId><m:FolderIds>${folderIdXml(folder)}</m:FolderIds></m:MoveFolder>`)
    return readFolderId(folderElement(m(message.element, 'Folders')))
  }

  async deleteFolder(folder: FolderRef, deleteType: 'MoveToDeletedItems' | 'SoftDelete' | 'HardDelete' = 'MoveToDeletedItems') {
    await this.callOne('DeleteFolder', `<m:DeleteFolder DeleteType="${deleteType}"><m:FolderIds>${folderIdXml(folder)}</m:FolderIds></m:DeleteFolder>`)
  }

  // --- Items ---------------------------------------------------------------------------------

  /**
   * One SyncFolderItems page. `maxChanges` is MaxChangesReturned (1-512); keep calling with the
   * returned sync state until `includesLastItemInRange`. Throws EwsError('ErrorInvalidSyncStateData')
   * when the stored state is no longer valid, so callers can restart from an empty state.
   */
  async syncFolderItems(folder: FolderRef, syncState: string | undefined, options: { maxChanges?: number; shape?: ItemShapeOptions } = {}): Promise<EwsSyncPage> {
    const max = Math.min(512, Math.max(1, Math.round(options.maxChanges ?? 100)))
    const message = await this.callOne('SyncFolderItems', `<m:SyncFolderItems>${itemShape(options.shape)}<m:SyncFolderId>${folderIdXml(folder)}</m:SyncFolderId>${syncState ? `<m:SyncState>${escapeXml(syncState)}</m:SyncState>` : ''}<m:MaxChangesReturned>${max}</m:MaxChangesReturned><m:SyncScope>NormalItems</m:SyncScope></m:SyncFolderItems>`)
    const changes: EwsItemChange[] = []
    for (const change of m(message.element, 'Changes')?.children ?? []) {
      if (change.name === 'Delete') {
        const id = t(change, 'ItemId')?.attributes.Id
        if (id) changes.push({ type: 'delete', id })
      } else if (change.name === 'ReadFlagChange') {
        const id = t(change, 'ItemId')?.attributes.Id
        if (id) changes.push({ type: 'read-flag', id, isRead: tBool(change, 'IsRead') ?? false })
      } else {
        const item = itemElement(change)
        const id = readItemId(item)
        if (item && id) changes.push({ type: change.name === 'Create' ? 'create' : 'update', id: id.id, ...(id.changeKey ? { changeKey: id.changeKey } : {}), item })
      }
    }
    return {
      syncState: (m(message.element, 'SyncState')?.text ?? '').trim(),
      includesLastItemInRange: m(message.element, 'IncludesLastItemInRange')?.text.trim() !== 'false',
      changes
    }
  }

  /** GetItem for a batch; each result is the item element or the item's EwsError. */
  async getItems(items: (ItemRef | string)[], shape: ItemShapeOptions = {}, envelope?: EnvelopeOptions): Promise<(XmlElement | EwsError)[]> {
    if (!items.length) return []
    const refs = items.map((item) => typeof item === 'string' ? { id: item } : item)
    const messages = await this.call('GetItem', `<m:GetItem>${itemShape(shape)}<m:ItemIds>${refs.map(itemIdXml).join('')}</m:ItemIds></m:GetItem>`, envelope)
    return refs.map((_, index) => {
      const message = messages[index]
      if (!message || message.responseClass === 'Error') return new EwsError(message?.message ?? 'The item was not found', message?.code ?? 'ErrorItemNotFound')
      return itemElement(m(message.element, 'Items')) ?? new EwsError('The item was not found', 'ErrorItemNotFound')
    })
  }

  /** Raw MIME for messages (GetItem with IncludeMimeContent). */
  async getMime(ids: string[]) {
    const results = await this.getItems(ids, { includeMime: true, properties: MAIL_SYNC_PROPERTIES })
    return results.map((result) => {
      if (result instanceof EwsError) return result
      const mime = t(result, 'MimeContent')?.text.replace(/\s+/g, '')
      if (!mime) return new EwsError('Exchange did not return the message content', 'ErrorMimeContentConversionFailed')
      return { raw: Buffer.from(mime, 'base64'), item: result }
    })
  }

  /**
   * UpdateItem. `updates` are serialized <t:SetItemField>/<t:DeleteItemField> elements. With a
   * ChangeKey and NeverOverwrite, Exchange refuses a stale write with ErrorIrresolvableConflict.
   */
  async updateItems(changes: { item: ItemRef; updates: string }[], options: { conflictResolution?: 'NeverOverwrite' | 'AutoResolve' | 'AlwaysOverwrite'; messageDisposition?: 'SaveOnly'; sendMeetingUpdates?: 'SendToNone' | 'SendOnlyToAll' | 'SendToAllAndSaveCopy' | 'SendToChangedAndSaveCopy'; timeZone?: string } = {}) {
    if (!changes.length) return []
    const attributes = [
      `ConflictResolution="${options.conflictResolution ?? 'AutoResolve'}"`,
      options.messageDisposition ? `MessageDisposition="${options.messageDisposition}"` : '',
      options.sendMeetingUpdates ? `SendMeetingInvitationsOrCancellations="${options.sendMeetingUpdates}"` : ''
    ].filter(Boolean).join(' ')
    const messages = await this.call('UpdateItem', `<m:UpdateItem ${attributes}><m:ItemChanges>${changes.map((change) => `<t:ItemChange>${itemIdXml(change.item)}<t:Updates>${change.updates}</t:Updates></t:ItemChange>`).join('')}</m:ItemChanges></m:UpdateItem>`, options.timeZone ? { timeZone: options.timeZone } : undefined)
    return changes.map((_, index) => {
      const message = messages[index]
      if (!message || message.responseClass === 'Error') return new EwsError(message?.message ?? 'The item could not be updated', message?.code ?? 'ErrorInternalServerError')
      return readItemId(itemElement(m(message.element, 'Items'))) ?? { id: changes[index].item.id }
    })
  }

  async moveItems(ids: string[], destination: FolderRef) {
    if (!ids.length) return []
    const messages = await this.call('MoveItem', `<m:MoveItem><m:ToFolderId>${folderIdXml(destination)}</m:ToFolderId><m:ItemIds>${ids.map((id) => itemIdXml({ id })).join('')}</m:ItemIds></m:MoveItem>`)
    return ids.map((_, index) => {
      const message = messages[index]
      if (!message || message.responseClass === 'Error') return new EwsError(message?.message ?? 'The message could not be moved', message?.code ?? 'ErrorMoveCopyFailed')
      return readItemId(itemElement(m(message.element, 'Items')))
    })
  }

  async copyItems(ids: string[], destination: FolderRef) {
    const messages = await this.call('CopyItem', `<m:CopyItem><m:ToFolderId>${folderIdXml(destination)}</m:ToFolderId><m:ItemIds>${ids.map((id) => itemIdXml({ id })).join('')}</m:ItemIds></m:CopyItem>`)
    const failure = messages.find((message) => message.responseClass === 'Error')
    if (failure) throw new EwsError(failure.message ?? 'The message could not be copied', failure.code)
  }

  async deleteItems(items: (ItemRef | string)[], deleteType: 'MoveToDeletedItems' | 'SoftDelete' | 'HardDelete', options: { sendMeetingCancellations?: 'SendToNone' | 'SendOnlyToAll' | 'SendToAllAndSaveCopy'; affectedTaskOccurrences?: 'AllOccurrences' | 'SpecifiedOccurrenceOnly'; rawIds?: string } = {}) {
    const refs = items.map((item) => typeof item === 'string' ? { id: item } : item)
    const attributes = [`DeleteType="${deleteType}"`, options.sendMeetingCancellations ? `SendMeetingCancellations="${options.sendMeetingCancellations}"` : '', options.affectedTaskOccurrences ? `AffectedTaskOccurrences="${options.affectedTaskOccurrences}"` : ''].filter(Boolean).join(' ')
    const messages = await this.call('DeleteItem', `<m:DeleteItem ${attributes}><m:ItemIds>${refs.map(itemIdXml).join('')}${options.rawIds ?? ''}</m:ItemIds></m:DeleteItem>`)
    return messages.map((message) => message.responseClass === 'Error' ? new EwsError(message.message ?? 'The item could not be deleted', message.code) : undefined)
  }

  /** CreateItem with serialized item elements; returns the created ItemIds. */
  async createItems(itemsXml: string, options: { messageDisposition?: 'SaveOnly' | 'SendOnly' | 'SendAndSaveCopy'; savedItemFolder?: FolderRef; folder?: FolderRef; sendMeetingInvitations?: 'SendToNone' | 'SendOnlyToAll' | 'SendToAllAndSaveCopy'; timeZone?: string } = {}) {
    const attributes = [options.messageDisposition ? `MessageDisposition="${options.messageDisposition}"` : '', options.sendMeetingInvitations ? `SendMeetingInvitations="${options.sendMeetingInvitations}"` : ''].filter(Boolean).join(' ')
    const target = options.savedItemFolder ? `<m:SavedItemFolderId>${folderIdXml(options.savedItemFolder)}</m:SavedItemFolderId>` : options.folder ? `<m:SavedItemFolderId>${folderIdXml(options.folder)}</m:SavedItemFolderId>` : ''
    const messages = await this.call('CreateItem', `<m:CreateItem${attributes ? ` ${attributes}` : ''}>${target}<m:Items>${itemsXml}</m:Items></m:CreateItem>`, options.timeZone ? { timeZone: options.timeZone } : undefined)
    const failure = messages.find((message) => message.responseClass === 'Error')
    if (failure) throw new EwsError(failure.message ?? 'Exchange could not create the item', failure.code)
    return messages.map((message) => readItemId(itemElement(m(message.element, 'Items'))))
  }

  /** Sends raw MIME and saves a copy in Sent Items (CreateItem, SendAndSaveCopy). */
  async sendMime(mime: Buffer, options: { readReceipt?: boolean; deliveryReceipt?: boolean } = {}) {
    await this.createItems(`<t:Message><t:MimeContent CharacterSet="UTF-8">${mime.toString('base64')}</t:MimeContent>${options.readReceipt ? element('IsReadReceiptRequested', true) : ''}${options.deliveryReceipt ? element('IsDeliveryReceiptRequested', true) : ''}</t:Message>`, { messageDisposition: 'SendAndSaveCopy', savedItemFolder: { id: 'sentitems' } })
  }

  /**
   * Saves raw MIME as an unsent draft. PR_MESSAGE_FLAGS (0x0E07) = MSGFLAG_UNSENT keeps
   * Outlook from treating a MIME-imported item as received mail.
   */
  async saveDraftMime(mime: Buffer) {
    const [id] = await this.createItems(`<t:Message><t:MimeContent CharacterSet="UTF-8">${mime.toString('base64')}</t:MimeContent><t:ExtendedProperty><t:ExtendedFieldURI PropertyTag="3591" PropertyType="Integer"/><t:Value>8</t:Value></t:ExtendedProperty></t:Message>`, { messageDisposition: 'SaveOnly', savedItemFolder: { id: 'drafts' } })
    if (!id) throw new EwsError('Exchange did not return the saved draft', 'ErrorInternalServerError')
    return id
  }

  /** The current ChangeKey of an item, or ErrorItemNotFound. */
  async changeKey(id: string) {
    const [result] = await this.getItems([id], { baseShape: 'IdOnly' })
    if (result instanceof EwsError) throw result
    const parsed = readItemId(result!)
    if (!parsed?.changeKey) throw new EwsError('Exchange did not report the item revision', 'ErrorItemNotFound')
    return parsed.changeKey
  }

  /** Verifies the endpoint and credentials by reading the Inbox, and checks the server version. */
  async probe() {
    const [inbox] = await this.getFolders([{ id: 'inbox' }])
    if (inbox instanceof EwsError) throw inbox
    assertSupportedServer(this.serverVersion)
    return inbox
  }
}

export const setItemField = (fieldUri: string, itemType: string, value: string) =>
  `<t:SetItemField><t:FieldURI FieldURI="${attr(fieldUri)}"/><t:${itemType}>${value}</t:${itemType}></t:SetItemField>`
export const deleteItemField = (fieldUri: string) => `<t:DeleteItemField><t:FieldURI FieldURI="${attr(fieldUri)}"/></t:DeleteItemField>`
export const setIndexedField = (fieldUri: string, index: string, itemType: string, value: string) =>
  `<t:SetItemField><t:IndexedFieldURI FieldURI="${attr(fieldUri)}" FieldIndex="${attr(index)}"/><t:${itemType}>${value}</t:${itemType}></t:SetItemField>`
export const deleteIndexedField = (fieldUri: string, index: string) => `<t:DeleteItemField><t:IndexedFieldURI FieldURI="${attr(fieldUri)}" FieldIndex="${attr(index)}"/></t:DeleteItemField>`

export { ts, t, tText, tBool, tNumber }
