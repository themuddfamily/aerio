import { createHash, randomUUID } from 'node:crypto'
import type { CalendarEvent, Contact, RecurrenceEditScope } from '../../src/types'
import type { ProviderProductivityData, SyncedCalendar, SyncedCalendarEvent, SyncedContact } from '../../src/productivity-types'
import type { ExchangeReviewItem, ExchangeResolution } from '../../src/exchange-types'
import { occurrencesBefore } from '../../src/lib/recurrence'
import { UnsupportedRecurrenceError } from '../../src/lib/provider-recurrence'
import type { XmlElement } from '../productivity/dav-xml'
import type { ProductivityStore } from '../productivity/store'
import { EwsClient, EwsError, TRANSIENT_CODES, type EwsFolder } from './ews-client'
import { EwsAuthError, EwsHttpError, EwsNetworkError } from './ews-transport'
import {
  CALENDAR_ITEM_PROPERTIES, CONTACT_PROPERTIES, calendarItemUpdates, calendarItemXml, contactUpdates, contactXml, itemTitle, mapCalendarItem,
  mapContact, modifiedOccurrenceIds, type ExchangeFolderRef
} from './ews-items'
import { attr, t } from './ews-xml'
import { findItems } from './ews-shared-mailbox'
import type { ExchangeAccountRecord, ExchangeFolderRecord, ExchangeItemRecord, ExchangeOperationRecord, ExchangeStore } from './exchange-store'

// Exchange Calendar and Contacts through the normalized productivity store (provider 'exchange').
//
// Reads: calendar and contacts folders are found with FindFolder (Deep) plus the distinguished
// calendar/contacts folders, then each folder is pulled with SyncFolderItems pages; created and
// changed items are read with GetItem. The sync state is saved after each page.
//
// Writes follow the CalDAV service's model (dav-service.ts): every change is saved in a durable
// queue and shown at once, then sent. Updates carry the cached ChangeKey with
// ConflictResolution=NeverOverwrite, so a change made elsewhere comes back as
// ErrorIrresolvableConflict and goes to review instead of being overwritten. Deletes check the
// ChangeKey first for the same reason. Offline and transient failures stay queued with back-off.

const COLORS = ['#2f6fb5', '#1f8a70', '#b5562f', '#7457c0', '#a8457a', '#57793a']
const RETRY_BASE_MS = 30_000
const RETRY_MAX_MS = 30 * 60_000
const GET_BATCH = 50

export interface ExchangeProductivityOptions {
  store: ExchangeStore
  productivity(): ProductivityStore
  /** An EWS client for the account's stored credentials; throws EwsAuthError when they are missing. */
  client(accountId: string): EwsClient
  online?(): boolean
  now?(): Date
  changed?(): void
  pageSize?: number
  /** Calendars/contacts of attached shared or delegated mailboxes and subscribed public folders (E40). */
  sharedFolders?(accountId: string): Promise<import('../mail/mailbox-owner-worker').OwnerProductivityFolder[]>
  diagnostic?(record: { level: 'info' | 'warn' | 'error'; event: string; accountId?: string; message?: string; details?: Record<string, unknown> }): void
}

export class ExchangeWriteBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExchangeWriteBlockedError'
  }
}

const folderKey = (accountId: string, folderId: string) => `${accountId}:exchange-folder:${createHash('sha256').update(folderId).digest('hex').slice(0, 16)}`
const message = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback).slice(0, 500)
const isAuth = (error: unknown) => error instanceof EwsAuthError
const isTransient = (error: unknown) => error instanceof EwsNetworkError || (error instanceof EwsHttpError && (error.status >= 500 || error.status === 429 || error.status === 408)) || (error instanceof EwsError && TRANSIENT_CODES.has(error.code))
const isConflict = (error: unknown) => error instanceof EwsError && (error.code === 'ErrorIrresolvableConflict' || error.code === 'ErrorChangeKeyRequiredForWriteOperations' || error.code === 'ErrorStaleObject')
const isMissing = (error: unknown) => error instanceof EwsError && (error.code === 'ErrorItemNotFound' || error.code === 'ErrorCalendarOccurrenceIsDeletedFromRecurrence')
const ref = (folder: ExchangeFolderRecord): ExchangeFolderRef => ({ key: folder.key, accountId: folder.accountId, name: folder.name, color: folder.color, canWrite: folder.canWrite })

/** `${masterId}::<epoch ms | date>` → the occurrence's original start. */
export function generatedOccurrence(eventId: string) {
  const split = eventId.lastIndexOf('::')
  if (split <= 0) return undefined
  const key = eventId.slice(split + 2)
  const originalStart = /^\d+$/.test(key) ? new Date(Number(key)).toISOString() : /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : undefined
  return originalStart ? { masterId: eventId.slice(0, split), originalStart } : undefined
}

export class ExchangeProductivityService {
  private readonly locks = new Map<string, Promise<unknown>>()
  /** Public folder routing headers by FolderId (refreshed with the folder list). */
  private readonly folderHeaders = new Map<string, Record<string, string>>()

  constructor(private readonly options: ExchangeProductivityOptions) {}

  private get store() { return this.options.store }
  private now() { return this.options.now?.() ?? new Date() }
  private changed() { this.options.changed?.() }

  hasAccount(accountId: string) { return Boolean(this.store.account(accountId)) }

  accounts() { return this.store.accounts() }

  private exclusive<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(accountId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(work)
    this.locks.set(accountId, next)
    void next.finally(() => { if (this.locks.get(accountId) === next) this.locks.delete(accountId) }).catch(() => undefined)
    return next
  }

  addAccount(accountId: string, serverVersion?: string) {
    if (!this.store.account(accountId)) this.store.saveAccount({ accountId, status: 'ready', ...(serverVersion ? { serverVersion } : {}) })
    else this.store.saveAccount({ ...this.store.account(accountId)!, ...(serverVersion ? { serverVersion } : {}) })
    this.changed()
  }

  removeAccount(accountId: string) {
    this.store.removeAccount(accountId)
    this.options.productivity().removeAccount(accountId)
    this.changed()
  }

  /** New credentials: clear needs-auth and synchronize again. */
  credentialsUpdated(accountId: string) {
    const account = this.store.account(accountId)
    if (account) this.store.saveAccount({ ...account, status: 'ready', error: undefined })
    return this.sync(accountId)
  }

  pendingWrites(accountId: string) {
    return this.store.operations({ accountId, status: ['queued'] }).length
  }

  review(): ExchangeReviewItem[] {
    return this.store.operations().filter((operation) => operation.status !== 'queued').map((operation) => ({
      id: operation.id,
      accountId: operation.accountId,
      kind: operation.kind,
      action: operation.action,
      status: operation.status as ExchangeReviewItem['status'],
      title: itemTitle(operation.kind, (operation.data ?? operation.base) as { title?: string; name?: string }) ?? (operation.kind === 'event' ? 'Untitled event' : 'Unnamed contact'),
      ...(operation.serverData ? { serverTitle: itemTitle(operation.kind, operation.serverData as { title?: string; name?: string }) } : {}),
      error: operation.error ?? 'This change needs review',
      serverDeleted: Boolean(operation.serverDeleted),
      updatedAt: operation.updatedAt
    }))
  }

  writableFolders(accountId: string) {
    return this.store.folders(accountId).filter((folder) => folder.canWrite)
  }

  // --- Synchronization ------------------------------------------------------------------------

  sync(accountId: string) {
    return this.exclusive(accountId, () => this.syncNow(accountId))
  }

  async syncAll() {
    for (const account of this.store.accounts()) {
      if (account.status === 'needs-auth') continue
      await this.sync(account.accountId).catch(() => undefined)
    }
  }

  async flushAll() {
    for (const account of this.store.accounts()) {
      if (account.status === 'needs-auth') continue
      await this.exclusive(account.accountId, async () => {
        await this.flush(account.accountId, this.options.client(account.accountId))
        this.project(account.accountId)
      }).catch(() => undefined)
    }
    this.changed()
  }

  private saveStatus(accountId: string, patch: Partial<ExchangeAccountRecord>) {
    const current = this.store.account(accountId) ?? { accountId, status: 'ready' as const }
    this.store.saveAccount({ ...current, ...patch })
  }

  private async syncNow(accountId: string) {
    if (!this.store.account(accountId)) throw new Error('That Exchange account is no longer connected')
    if (this.options.online && !this.options.online()) throw new EwsNetworkError('Aerio is offline; Exchange changes will be sent when the connection returns')
    this.saveStatus(accountId, { status: 'syncing' })
    this.options.productivity().setSyncing(accountId)
    this.changed()
    let client: EwsClient | undefined
    try {
      client = this.options.client(accountId)
      await this.flush(accountId, client)
      await this.refreshFolders(accountId, client)
      let pulled = 0
      for (const folder of this.store.folders(accountId)) {
        try {
          const headers = this.folderHeaders.get(folder.folderId)
          // Public folders cannot be synchronized incrementally; they are listed and compared by ChangeKey.
          pulled += headers ? await this.listFolder(client.withHttpHeaders(headers), folder) : await this.pullFolder(client, folder)
        } catch (error) {
          if (isAuth(error) || error instanceof EwsNetworkError) throw error
          this.store.saveFolder({ ...this.store.folder(folder.key) ?? folder, error: message(error, 'This folder could not be synchronized') })
          this.options.diagnostic?.({ level: 'warn', event: 'exchange-folder-sync-failed', accountId, message: message(error, ''), details: { kind: folder.kind } })
        }
      }
      this.saveStatus(accountId, { status: 'ready', error: undefined, lastSyncedAt: this.now().toISOString() })
      this.project(accountId)
      this.options.diagnostic?.({ level: 'info', event: 'exchange-productivity-sync-complete', accountId, details: { changes: pulled } })
    } catch (error) {
      const auth = isAuth(error)
      this.saveStatus(accountId, { status: auth ? 'needs-auth' : 'error', error: auth ? 'Exchange rejected the saved credentials. Enter the password (or a new token) again.' : message(error, 'Synchronization failed') })
      this.project(accountId)
      this.options.diagnostic?.({ level: 'error', event: 'exchange-productivity-sync-failed', accountId, message: message(error, '') })
      throw error
    } finally {
      this.changed()
    }
  }

  private async refreshFolders(accountId: string, client: EwsClient) {
    const distinguished = await client.getFolders([{ id: 'calendar' }, { id: 'contacts' }])
    const found = new Map<string, { folder: EwsFolder; kind: 'calendar' | 'contacts'; primary: boolean }>()
    distinguished.forEach((folder, index) => {
      if (folder instanceof EwsError) return
      found.set(folder.id, { folder, kind: index === 0 ? 'calendar' : 'contacts', primary: true })
    })
    try {
      for (const folder of await client.findFolders({ id: 'msgfolderroot' }, 'Deep')) {
        const kind = folder.folderClass?.startsWith('IPF.Appointment') ? 'calendar' : folder.folderClass?.startsWith('IPF.Contact') ? 'contacts' : undefined
        if (kind && !found.has(folder.id)) found.set(folder.id, { folder, kind, primary: false })
      }
    } catch (error) {
      if (isAuth(error) || error instanceof EwsNetworkError) throw error
      // Listing subfolders is optional; the default calendar and contacts still synchronize.
    }
    // Other mailboxes' folders (E40): a failure for one of them never stops the account's own sync.
    const shared = new Map<string, { name: string; readOnly: boolean }>()
    let sharedFolders: import('../mail/mailbox-owner-worker').OwnerProductivityFolder[] = []
    try { sharedFolders = await this.options.sharedFolders?.(accountId) ?? [] } catch { sharedFolders = [] }
    for (const entry of sharedFolders) {
      try {
        const [folder] = await (entry.headers ? client.withHttpHeaders(entry.headers) : client).getFolders([entry.ref])
        if (!folder || folder instanceof EwsError || found.has(folder.id) || folder.canRead === false) continue
        found.set(folder.id, { folder, kind: entry.kind, primary: false })
        shared.set(folder.id, { name: entry.name, readOnly: Boolean(entry.readOnly) })
        if (entry.headers) this.folderHeaders.set(folder.id, entry.headers)
      } catch (error) {
        if (isAuth(error) || error instanceof EwsNetworkError) throw error
      }
    }
    const existing = new Map(this.store.folders(accountId).map((folder) => [folder.folderId, folder]))
    let index = existing.size
    for (const { folder, kind, primary } of found.values()) {
      const previous = existing.get(folder.id)
      this.store.saveFolder({
        key: previous?.key ?? folderKey(accountId, folder.id), accountId, folderId: folder.id, kind,
        name: shared.get(folder.id)?.name ?? (folder.displayName || (kind === 'calendar' ? 'Calendar' : 'Contacts')),
        color: previous?.color ?? COLORS[index++ % COLORS.length],
        canWrite: !shared.get(folder.id)?.readOnly && folder.canCreateContents !== false && folder.canModify !== false, primary,
        ...(previous?.syncState ? { syncState: previous.syncState } : {}),
        ...(previous?.lastSyncedAt ? { lastSyncedAt: previous.lastSyncedAt } : {})
      })
    }
    for (const [folderId, folder] of existing) {
      if (found.has(folderId)) continue
      for (const operation of this.store.operations({ accountId }).filter((item) => item.folderKey === folder.key && item.status === 'queued')) {
        this.store.saveOperation({ ...operation, status: 'failed', error: 'This calendar or contacts folder was removed on the server', updatedAt: this.now().toISOString() })
      }
      this.store.removeFolder(folder.key)
    }
  }

  /** Reads full items and maps them; calendar masters bring their modified occurrences. */
  private async readItems(client: EwsClient, folder: ExchangeFolderRecord, ids: string[]) {
    const records: ExchangeItemRecord[] = []
    const missing: string[] = []
    const properties = folder.kind === 'calendar' ? CALENDAR_ITEM_PROPERTIES : CONTACT_PROPERTIES
    for (let index = 0; index < ids.length; index += GET_BATCH) {
      const batch = ids.slice(index, index + GET_BATCH)
      const items = await client.getItems(batch, { baseShape: 'IdOnly', properties, bodyType: 'Text' })
      for (const [position, item] of items.entries()) {
        if (item instanceof EwsError) { if (isMissing(item)) missing.push(batch[position]); continue }
        const record = await this.recordFor(client, folder, item)
        if (record) records.push(record)
      }
    }
    return { records, missing }
  }

  private async recordFor(client: EwsClient, folder: ExchangeFolderRecord, item: XmlElement): Promise<ExchangeItemRecord | undefined> {
    const id = t(item, 'ItemId')
    if (!id?.attributes.Id) return undefined
    const base = { accountId: folder.accountId, folderKey: folder.key, itemId: id.attributes.Id, ...(id.attributes.ChangeKey ? { changeKey: id.attributes.ChangeKey } : {}) }
    if (folder.kind === 'contacts') {
      if (item.name !== 'Contact') return undefined
      const contact = mapContact(ref(folder), item)
      return contact ? { ...base, kind: 'contact', contact } : undefined
    }
    if (item.name !== 'CalendarItem') return undefined
    const master = mapCalendarItem(ref(folder), item)
    if (!master) return { ...base, kind: 'event', events: [] }
    const events = [master]
    const changeKeys: Record<string, string> = id.attributes.ChangeKey ? { [id.attributes.Id]: id.attributes.ChangeKey } : {}
    const occurrenceIds = modifiedOccurrenceIds(item)
    if (occurrenceIds.length) {
      const occurrences = await client.getItems(occurrenceIds, { baseShape: 'IdOnly', properties: CALENDAR_ITEM_PROPERTIES, bodyType: 'Text' })
      for (const occurrence of occurrences) {
        if (occurrence instanceof EwsError) continue
        const mapped = mapCalendarItem(ref(folder), occurrence, { eventId: master.id, uid: master.sourceUid })
        if (mapped) events.push(mapped)
        const occurrenceId = t(occurrence, 'ItemId')
        if (occurrenceId?.attributes.Id && occurrenceId.attributes.ChangeKey) changeKeys[occurrenceId.attributes.Id] = occurrenceId.attributes.ChangeKey
      }
    }
    return { ...base, kind: 'event', events, changeKeys }
  }

  /** FindItem listing of a public folder (E40): new or changed ChangeKeys are read, vanished items removed. */
  private async listFolder(client: EwsClient, folder: ExchangeFolderRecord) {
    const listed = new Map<string, string | undefined>()
    for (const item of await findItems(client, { id: folder.folderId, distinguished: false }, [])) {
      const id = t(item, 'ItemId')
      if (id?.attributes.Id) listed.set(id.attributes.Id, id.attributes.ChangeKey)
    }
    const cached = new Map(this.store.items(folder.key).map((item) => [item.itemId, item.changeKey]))
    const changed = [...listed].filter(([id, changeKey]) => !cached.has(id) || cached.get(id) !== changeKey).map(([id]) => id)
    const removed = [...cached.keys()].filter((id) => !listed.has(id))
    const { records, missing } = await this.readItems(client, folder, changed)
    this.store.transaction(() => {
      for (const record of records) this.store.saveItem(record)
      for (const id of [...removed, ...missing]) this.store.removeItem(folder.accountId, id)
      this.store.saveFolder({ ...folder, lastSyncedAt: this.now().toISOString(), error: undefined })
    })
    return records.length + removed.length + missing.length
  }

  private async pullFolder(client: EwsClient, initial: ExchangeFolderRecord) {
    let folder = initial
    let syncState = folder.syncState
    let changes = 0
    for (let page = 0; page < 10_000; page++) {
      let result
      try {
        result = await client.syncFolderItems({ id: folder.folderId, distinguished: false }, syncState, { maxChanges: this.options.pageSize ?? 100, shape: { baseShape: 'IdOnly' } })
      } catch (error) {
        if (error instanceof EwsError && error.code === 'ErrorInvalidSyncStateData' && syncState) {
          // Start over: the full listing that follows replaces the cached copy of this folder.
          this.store.clearFolderItems(folder.key)
          syncState = undefined
          continue
        }
        throw error
      }
      const changed: string[] = []
      for (const change of result.changes) {
        if (change.type === 'delete') { this.store.removeItem(folder.accountId, change.id); changes++ }
        else if (change.type === 'create' || change.type === 'update') changed.push(change.id)
      }
      const { records, missing } = await this.readItems(client, folder, [...new Set(changed)])
      this.store.transaction(() => {
        for (const record of records) this.store.saveItem(record)
        for (const id of missing) this.store.removeItem(folder.accountId, id)
        syncState = result.syncState
        folder = { ...folder, syncState, lastSyncedAt: this.now().toISOString(), error: undefined }
        this.store.saveFolder(folder)
      })
      changes += records.length + missing.length
      if (result.includesLastItemInRange) break
    }
    return changes
  }

  /** Projects synchronized items plus pending local writes into the shared productivity cache. */
  project(accountId: string) {
    const account = this.store.account(accountId)
    if (!account) return
    const data: ProviderProductivityData = { calendars: [], events: [], contacts: [] }
    const operations = this.store.operations({ accountId })
    const folders = this.store.folders(accountId).sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name))
    let primaryCalendar = true
    for (const folder of folders) {
      if (folder.kind === 'calendar') {
        data.calendars.push({ id: folder.key, remoteId: folder.folderId, accountId, provider: 'exchange', name: folder.name, color: folder.color, primary: primaryCalendar && folder.primary, canWrite: folder.canWrite } satisfies SyncedCalendar)
        if (folder.primary) primaryCalendar = false
      }
      const events = new Map<string, SyncedCalendarEvent>()
      const contacts = new Map<string, SyncedContact>()
      for (const item of this.store.items(folder.key)) {
        for (const event of item.events ?? []) events.set(event.id, event)
        if (item.contact) contacts.set(item.contact.id, item.contact)
      }
      for (const operation of operations.filter((item) => item.folderKey === folder.key)) {
        if (operation.kind === 'event') {
          if (operation.occurrence && operation.action === 'delete') {
            const master = events.get(operation.localId)
            if (master) events.set(master.id, { ...master, recurrenceExceptions: [...new Set([...(master.recurrenceExceptions ?? []), operation.occurrence.originalStart])] })
          } else if (operation.occurrence && operation.data) {
            const master = events.get(operation.occurrence.masterEventId)
            if (master) events.set(operation.localId, { ...master, ...(operation.data as CalendarEvent), id: operation.localId, remoteId: master.remoteId, accountId, provider: 'exchange', calendarId: folder.key, readOnly: false, seriesId: master.id, recurrenceId: operation.occurrence.originalStart, originalStart: operation.occurrence.originalStart, ...(master.sourceUid ? { sourceUid: master.sourceUid } : {}), recurrenceRule: undefined, recurrence: 'none' })
          } else if (operation.action === 'delete') events.delete(operation.localId)
          else if (operation.data) {
            const previous = events.get(operation.localId)
            events.set(operation.localId, { ...previous, ...(operation.data as CalendarEvent), id: operation.localId, remoteId: operation.itemId ?? previous?.remoteId ?? '', accountId, provider: 'exchange', calendarId: folder.key, readOnly: false, color: (operation.data as CalendarEvent).color || folder.color })
          }
        } else if (operation.action === 'delete') contacts.delete(operation.localId)
        else if (operation.data) {
          const previous = contacts.get(operation.localId)
          contacts.set(operation.localId, { ...previous, ...(operation.data as Contact), id: operation.localId, remoteId: operation.itemId ?? previous?.remoteId ?? '', accountId, provider: 'exchange', folderId: folder.key, readOnly: false, ...(previous?.revision ? { revision: previous.revision } : {}) })
        }
      }
      data.events.push(...events.values())
      data.contacts.push(...contacts.values())
    }
    const productivity = this.options.productivity()
    productivity.replaceAccount(accountId, 'exchange', data, {})
    if (account.status === 'error' || account.status === 'needs-auth') productivity.setError(accountId, account.error ?? 'This Exchange account needs attention')
  }

  // --- Durable write queue --------------------------------------------------------------------

  private async flush(accountId: string, client: EwsClient) {
    if (this.options.online && !this.options.online()) return
    const now = this.now()
    for (const operation of this.store.operations({ accountId, status: ['queued'] })) {
      if (operation.nextAttemptAt && Date.parse(operation.nextAttemptAt) > now.getTime()) continue
      try {
        await this.send(client, operation)
      } catch (error) {
        if (isAuth(error)) throw error
        const transient = isTransient(error)
        const attempts = operation.attempts + 1
        this.store.saveOperation({
          ...operation, attempts, updatedAt: now.toISOString(), error: message(error, 'The change could not be sent'),
          ...(transient
            ? { nextAttemptAt: new Date(now.getTime() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 10))).toISOString() }
            : { status: 'failed' as const, error: error instanceof EwsError && error.code === 'ErrorAccessDenied' ? 'Exchange refused this change; the folder may be read-only' : message(error, 'Exchange refused this change') })
        })
        // Offline: keep every later write queued in order.
        if (error instanceof EwsNetworkError) return
      }
    }
  }

  private folderFor(operation: ExchangeOperationRecord) {
    const folder = this.store.folder(operation.folderKey)
    if (!folder) throw new EwsError('This calendar or contacts folder no longer exists on the server', 'ErrorFolderNotFound')
    return folder
  }

  /** Re-reads one item (or a series master) after a write so the cache holds the server copy. */
  private async refresh(client: EwsClient, folder: ExchangeFolderRecord, itemId: string) {
    const { records, missing } = await this.readItems(client, folder, [itemId])
    this.store.transaction(() => {
      for (const record of records) this.store.saveItem(record)
      for (const id of missing) this.store.removeItem(folder.accountId, id)
    })
    return records[0]
  }

  private occurrenceXml(operation: ExchangeOperationRecord) {
    return `<t:OccurrenceItemId RecurringMasterId="${attr(operation.occurrence!.masterItemId)}" InstanceIndex="${operation.occurrence!.instanceIndex}"/>`
  }

  private async send(client: EwsClient, operation: ExchangeOperationRecord) {
    const folder = this.folderFor(operation)
    if (operation.kind === 'event') await this.sendEvent(client, folder, operation)
    else await this.sendContact(client, folder, operation)
  }

  private complete(operation: ExchangeOperationRecord) {
    this.store.deleteOperation(operation.id)
  }

  private async sendEvent(client: EwsClient, folder: ExchangeFolderRecord, operation: ExchangeOperationRecord) {
    const data = operation.data as CalendarEvent | undefined
    const base = operation.base as SyncedCalendarEvent | undefined
    const meeting = (event: CalendarEvent | undefined) => Boolean(event?.attendees.length)
    if (operation.action === 'create') {
      const item = calendarItemXml(data!)
      const [created] = await client.createItems(item.xml, { folder: { id: folder.folderId, distinguished: false }, sendMeetingInvitations: item.hasAttendees ? 'SendToAllAndSaveCopy' : 'SendToNone', timeZone: item.zone })
      if (!created) throw new EwsError('Exchange did not return the new event', 'ErrorInternalServerError')
      await this.refresh(client, folder, created.id)
      this.complete(operation)
      return
    }
    if (operation.occurrence) {
      // A generated occurrence is addressed by its master and InstanceIndex.
      if (operation.action === 'delete') {
        const [failure] = await client.deleteItems([], 'MoveToDeletedItems', { sendMeetingCancellations: meeting(base) ? 'SendToAllAndSaveCopy' : 'SendToNone', affectedTaskOccurrences: 'SpecifiedOccurrenceOnly', rawIds: this.occurrenceXml(operation) })
        if (failure && !isMissing(failure)) throw failure
      } else {
        const update = calendarItemUpdates(base!, data!)
        if (update.updates.length) {
          const messages = await client.call('UpdateItem', `<m:UpdateItem ConflictResolution="AutoResolve" SendMeetingInvitationsOrCancellations="${meeting(data) ? 'SendToChangedAndSaveCopy' : 'SendToNone'}"><m:ItemChanges><t:ItemChange>${this.occurrenceXml(operation)}<t:Updates>${update.updates.join('')}</t:Updates></t:ItemChange></m:ItemChanges></m:UpdateItem>`, { timeZone: update.zone })
          const failure = messages.find((item) => item.responseClass === 'Error')
          if (failure) throw new EwsError(failure.message ?? 'Exchange could not update the occurrence', failure.code)
        }
      }
      await this.refresh(client, folder, operation.occurrence.masterItemId)
      this.complete(operation)
      return
    }
    const masterRecord = this.recordContaining(folder.key, operation.localId)
    if (operation.action === 'delete') {
      // EWS deletes do not check the ChangeKey, so the revision is compared first.
      if (operation.changeKey) {
        try {
          const current = await client.changeKey(operation.itemId!)
          if (current !== operation.changeKey) return this.conflict(client, folder, operation, 'Changed on the server since you deleted it')
        } catch (error) {
          if (isMissing(error)) { this.store.removeItem(folder.accountId, operation.itemId!); this.complete(operation); return }
          throw error
        }
      }
      const [failure] = await client.deleteItems([{ id: operation.itemId! }], 'MoveToDeletedItems', { sendMeetingCancellations: meeting(base) && base?.organizer?.self ? 'SendToAllAndSaveCopy' : 'SendToNone', affectedTaskOccurrences: 'AllOccurrences' })
      if (failure && !isMissing(failure)) throw failure
      if (masterRecord && masterRecord.itemId !== operation.itemId) await this.refresh(client, folder, masterRecord.itemId)
      else this.store.removeItem(folder.accountId, operation.itemId!)
      this.complete(operation)
      return
    }
    const update = calendarItemUpdates(base!, data!)
    if (update.updates.length) {
      const [result] = await client.updateItems([{ item: { id: operation.itemId!, ...(operation.changeKey ? { changeKey: operation.changeKey } : {}) }, updates: update.updates.join('') }], {
        conflictResolution: 'NeverOverwrite', sendMeetingUpdates: meeting(data) || meeting(base) ? 'SendToChangedAndSaveCopy' : 'SendToNone', timeZone: update.zone
      })
      if (result instanceof EwsError) {
        if (isConflict(result)) return this.conflict(client, folder, operation, 'Changed on the server since you edited it')
        if (isMissing(result)) return this.conflict(client, folder, operation, 'Deleted on the server since you edited it')
        throw result
      }
    }
    await this.refresh(client, folder, masterRecord?.itemId ?? operation.itemId!)
    this.complete(operation)
  }

  private async sendContact(client: EwsClient, folder: ExchangeFolderRecord, operation: ExchangeOperationRecord) {
    const data = operation.data as Contact | undefined
    if (operation.action === 'create') {
      const [created] = await client.createItems(contactXml(data!, folder.name), { folder: { id: folder.folderId, distinguished: false } })
      if (!created) throw new EwsError('Exchange did not return the new contact', 'ErrorInternalServerError')
      await this.refresh(client, folder, created.id)
      this.complete(operation)
      return
    }
    if (operation.action === 'delete') {
      if (operation.changeKey) {
        try {
          if (await client.changeKey(operation.itemId!) !== operation.changeKey) return this.conflict(client, folder, operation, 'Changed on the server since you deleted it')
        } catch (error) {
          if (isMissing(error)) { this.store.removeItem(folder.accountId, operation.itemId!); this.complete(operation); return }
          throw error
        }
      }
      const [failure] = await client.deleteItems([{ id: operation.itemId! }], 'MoveToDeletedItems')
      if (failure && !isMissing(failure)) throw failure
      this.store.removeItem(folder.accountId, operation.itemId!)
      this.complete(operation)
      return
    }
    const updates = contactUpdates(operation.base as SyncedContact, data!, folder.name)
    if (updates.length) {
      const [result] = await client.updateItems([{ item: { id: operation.itemId!, ...(operation.changeKey ? { changeKey: operation.changeKey } : {}) }, updates: updates.join('') }], { conflictResolution: 'NeverOverwrite' })
      if (result instanceof EwsError) {
        if (isConflict(result)) return this.conflict(client, folder, operation, 'Changed on the server since you edited it')
        if (isMissing(result)) return this.conflict(client, folder, operation, 'Deleted on the server since you edited it')
        throw result
      }
    }
    await this.refresh(client, folder, operation.itemId!)
    this.complete(operation)
  }

  private recordContaining(folderKey: string, localId: string) {
    return this.store.items(folderKey).find((item) => item.events?.some((event) => event.id === localId) || item.contact?.id === localId)
  }

  // ErrorIrresolvableConflict, a changed ChangeKey, or a vanished item: record what the server
  // holds now and wait for the user's decision. Nothing is overwritten.
  private async conflict(client: EwsClient, folder: ExchangeFolderRecord, operation: ExchangeOperationRecord, reason: string) {
    const master = this.recordContaining(folder.key, operation.localId)
    const record = await this.refresh(client, folder, master?.itemId ?? operation.itemId!)
    const serverData = operation.kind === 'contact' ? record?.contact : record?.events?.find((event) => event.id === operation.localId)
    const serverChangeKey = operation.kind === 'contact' ? record?.changeKey : record?.changeKeys?.[operation.itemId!] ?? record?.changeKey
    const deleted = !serverData
    this.store.saveOperation({
      ...operation, status: 'conflict', error: deleted && operation.action !== 'delete' ? 'Deleted on the server since you edited it' : reason,
      serverDeleted: deleted, ...(serverData ? { serverData } : { serverData: undefined }), ...(serverChangeKey ? { serverChangeKey } : {}), updatedAt: this.now().toISOString()
    })
    this.options.diagnostic?.({ level: 'warn', event: 'exchange-write-conflict', accountId: operation.accountId, details: { kind: operation.kind, action: operation.action, serverDeleted: deleted } })
  }

  private enqueue(input: Omit<ExchangeOperationRecord, 'id' | 'status' | 'attempts' | 'createdAt' | 'updatedAt'>) {
    const timestamp = this.now().toISOString()
    const pending = this.store.operationFor(input.accountId, input.localId)
    if (pending && pending.status !== 'queued') throw new ExchangeWriteBlockedError('This item has a synchronization conflict. Resolve it in the Exchange account settings first.')
    if (pending) {
      // Coalesce: a never-sent create that is deleted simply disappears; edits merge into it.
      if (input.action === 'delete' && pending.action === 'create') { this.store.deleteOperation(pending.id); return }
      this.store.saveOperation({
        ...pending, action: pending.action === 'create' ? 'create' : input.action, data: input.action === 'delete' ? undefined : input.data,
        ...(input.occurrence ? { occurrence: input.occurrence } : {}), attempts: 0, nextAttemptAt: undefined, error: undefined, updatedAt: timestamp
      })
      return
    }
    this.store.saveOperation({ ...input, id: `exchange-op-${randomUUID()}`, status: 'queued', attempts: 0, createdAt: timestamp, updatedAt: timestamp })
  }

  private async commit(accountId: string) {
    this.project(accountId)
    this.changed()
    const account = this.store.account(accountId)
    if (!account || account.status === 'needs-auth') return
    try {
      await this.flush(accountId, this.options.client(accountId))
    } catch (error) {
      if (isAuth(error)) this.saveStatus(accountId, { status: 'needs-auth', error: 'Exchange rejected the saved credentials. Enter the password (or a new token) again.' })
    }
    this.project(accountId)
    this.changed()
  }

  private writableFolder(key: string | undefined, kind: 'calendar' | 'contacts') {
    const folder = key ? this.store.folder(key) : undefined
    if (!folder || folder.kind !== kind) throw new Error(kind === 'calendar' ? 'That calendar is no longer available' : 'That contacts folder is no longer available')
    if (!folder.canWrite) throw new Error(kind === 'calendar' ? 'This calendar is read-only' : 'This contacts folder is read-only')
    return folder
  }

  /** The synchronized copy plus its revision for an edit, refusing items under review. */
  private baseFor(folder: ExchangeFolderRecord, localId: string) {
    const pending = this.store.operationFor(folder.accountId, localId)
    if (pending && pending.status !== 'queued') throw new ExchangeWriteBlockedError('This item has a synchronization conflict. Resolve it in the Exchange account settings first.')
    if (pending?.action === 'delete') throw new ExchangeWriteBlockedError('This item is being deleted')
    const record = this.recordContaining(folder.key, localId)
    const synced = folder.kind === 'calendar' ? record?.events?.find((event) => event.id === localId) : record?.contact
    if (!synced && pending?.action !== 'create') throw new ExchangeWriteBlockedError('That item is no longer available; synchronize and try again')
    const itemId = synced?.remoteId
    const changeKey = itemId ? record?.changeKeys?.[itemId] ?? (record?.itemId === itemId ? record?.changeKey : undefined) : undefined
    return { pending, record, synced, itemId, changeKey }
  }

  createEvent(calendar: SyncedCalendar, input: CalendarEvent) {
    return this.exclusive(calendar.accountId, async () => {
      const folder = this.writableFolder(calendar.id, 'calendar')
      // Fail early for repeat rules Exchange cannot store.
      try { calendarItemXml(input) } catch (error) { if (error instanceof UnsupportedRecurrenceError) throw error }
      this.enqueue({ accountId: folder.accountId, folderKey: folder.key, kind: 'event', action: 'create', localId: `${folder.accountId}:exchange-pending:${randomUUID()}`, data: { ...input, calendarId: folder.key } })
      await this.commit(folder.accountId)
    })
  }

  updateEvent(current: SyncedCalendarEvent, input: CalendarEvent) {
    return this.exclusive(current.accountId, async () => {
      const folder = this.writableFolder(current.calendarId, 'calendar')
      const { pending, synced, itemId, changeKey } = this.baseFor(folder, current.id)
      if (!pending || pending.action !== 'create') calendarItemUpdates(synced as SyncedCalendarEvent, input)
      this.enqueue({ accountId: folder.accountId, folderKey: folder.key, kind: 'event', action: 'update', localId: current.id, ...(itemId ? { itemId } : {}), ...(changeKey ? { changeKey } : {}), data: { ...input, calendarId: folder.key }, ...(synced ? { base: synced } : {}) })
      await this.commit(folder.accountId)
    })
  }

  deleteEvent(current: SyncedCalendarEvent) {
    return this.exclusive(current.accountId, async () => {
      const folder = this.writableFolder(current.calendarId, 'calendar')
      const { synced, itemId, changeKey } = this.baseFor(folder, current.id)
      this.enqueue({ accountId: folder.accountId, folderKey: folder.key, kind: 'event', action: 'delete', localId: current.id, ...(itemId ? { itemId } : {}), ...(changeKey ? { changeKey } : {}), ...(synced ? { base: synced } : {}) })
      await this.commit(folder.accountId)
    })
  }

  /** The stored series master behind a generated occurrence id (`<masterId>::<key>`). */
  occurrenceTarget(eventId: string) {
    const parsed = generatedOccurrence(eventId)
    if (!parsed) return undefined
    const master = this.options.productivity().snapshot().events.find((event) => event.id === parsed.masterId && event.provider === 'exchange')
    return master ? { master, originalStart: parsed.originalStart } : undefined
  }

  /** Edits or deletes one generated occurrence through OccurrenceItemId (master + InstanceIndex). */
  changeOccurrence(master: SyncedCalendarEvent, originalStart: string, input?: CalendarEvent) {
    return this.exclusive(master.accountId, async () => {
      const folder = this.writableFolder(master.calendarId, 'calendar')
      if (master.readOnly) throw new Error(input ? 'This event cannot be edited' : 'This event cannot be deleted')
      const synced = this.baseFor(folder, master.id).synced as SyncedCalendarEvent
      const instanceIndex = occurrencesBefore(master, originalStart) + 1
      const duration = Date.parse(master.end) - Date.parse(master.start)
      const occurrenceStart = /^\d{4}-\d{2}-\d{2}$/.test(originalStart) ? originalStart : new Date(originalStart).toISOString()
      const base: SyncedCalendarEvent = { ...synced, start: occurrenceStart, end: /^\d{4}-\d{2}-\d{2}$/.test(originalStart) ? master.end : new Date(Date.parse(originalStart) + duration).toISOString(), recurrenceRule: undefined, recurrence: 'none', seriesId: master.id }
      const occurrence = { masterItemId: master.remoteId, masterEventId: master.id, instanceIndex, originalStart: occurrenceStart }
      if (input) this.enqueue({ accountId: folder.accountId, folderKey: folder.key, kind: 'event', action: 'update', localId: `${master.id}::occurrence:${instanceIndex}`, occurrence, base, data: { ...input, calendarId: folder.key, seriesId: master.id, recurrenceRule: undefined, recurrence: 'none' } })
      else this.enqueue({ accountId: folder.accountId, folderKey: folder.key, kind: 'event', action: 'delete', localId: master.id, occurrence, base })
      await this.commit(folder.accountId)
    })
  }

  /**
   * Series-wide edits from an occurrence: the master takes the edited fields and moves by the same
   * start/end offset. "This and following" splits are not supported for Exchange.
   */
  async writeSeries(current: SyncedCalendarEvent, scope: Exclude<RecurrenceEditScope, 'occurrence'>, input?: CalendarEvent) {
    if (scope === 'following') throw new Error('Exchange accounts cannot split a repeating series. Change this event only, or the whole series.')
    const master = this.options.productivity().snapshot().events.find((event) => event.id === (current.seriesId ?? current.id) && event.provider === 'exchange')
    if (!master) throw new Error('The repeating series is no longer available; synchronize and try again')
    if (!input) return this.deleteEvent(master)
    const startShift = Date.parse(input.start) - Date.parse(current.start)
    const endShift = Date.parse(input.end) - Date.parse(current.end)
    const shift = (value: string, offset: number) => /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(Date.parse(`${value}T00:00:00Z`) + offset).toISOString().slice(0, 10) : new Date(Date.parse(value) + offset).toISOString()
    return this.updateEvent(master, {
      ...master, title: input.title, location: input.location, description: input.description, reminderMinutes: input.reminderMinutes, reminders: input.reminders,
      attendees: input.attendees, ...(input.attendeeDetails ? { attendeeDetails: input.attendeeDetails } : {}),
      start: shift(master.start, startShift), end: shift(master.end, endShift)
    })
  }

  defaultContactsFolder(accountId: string) {
    return this.store.folders(accountId).filter((folder) => folder.kind === 'contacts' && folder.canWrite).sort((a, b) => Number(b.primary) - Number(a.primary))[0]
  }

  createContact(accountId: string, input: Contact) {
    return this.exclusive(accountId, async () => {
      const folder = this.defaultContactsFolder(accountId)
      if (!folder) throw new Error('This Exchange account has no contacts folder Aerio can write to')
      const localId = `${accountId}:exchange-pending:${randomUUID()}`
      this.enqueue({ accountId, folderKey: folder.key, kind: 'contact', action: 'create', localId, data: input })
      await this.commit(accountId)
      return this.projectedContact(accountId, localId, input)
    })
  }

  updateContact(current: SyncedContact, input: Contact) {
    return this.exclusive(current.accountId, async () => {
      const folder = this.writableFolder(current.folderId, 'contacts')
      const { synced, itemId, changeKey } = this.baseFor(folder, current.id)
      // An edit made against an older copy than the one Aerio now holds is refused, as for Graph.
      const edited = input as Contact & { revision?: unknown }
      if (typeof edited.revision === 'string' && synced && 'revision' in synced && synced.revision && edited.revision !== synced.revision) {
        throw new ExchangeWriteBlockedError('This contact changed since you opened it. Review the synchronized version and make your edit again.')
      }
      this.enqueue({ accountId: folder.accountId, folderKey: folder.key, kind: 'contact', action: 'update', localId: current.id, ...(itemId ? { itemId } : {}), ...(changeKey ? { changeKey } : {}), data: input, ...(synced ? { base: synced } : {}) })
      await this.commit(folder.accountId)
      return this.projectedContact(folder.accountId, current.id, input)
    })
  }

  deleteContact(current: SyncedContact) {
    return this.exclusive(current.accountId, async () => {
      const folder = this.writableFolder(current.folderId, 'contacts')
      const { synced, itemId, changeKey } = this.baseFor(folder, current.id)
      this.enqueue({ accountId: folder.accountId, folderKey: folder.key, kind: 'contact', action: 'delete', localId: current.id, ...(itemId ? { itemId } : {}), ...(changeKey ? { changeKey } : {}), ...(synced ? { base: synced } : {}) })
      await this.commit(folder.accountId)
    })
  }

  private projectedContact(accountId: string, localId: string, input: Contact) {
    const contacts = this.options.productivity().accountData(accountId).contacts
    // A create that was sent now has its server id; match it by name when the pending id is gone.
    return contacts.find((item) => item.id === localId) ?? contacts.find((item) => item.name === input.name && item.email === input.email) ?? contacts.find((item) => item.name === input.name)
      ?? (() => { throw new Error('The contact was saved but could not be read back') })()
  }

  // --- Conflict review ------------------------------------------------------------------------

  resolve(reviewId: string, resolution: ExchangeResolution) {
    const initial = this.store.operation(reviewId)
    if (!initial || initial.status === 'queued') throw new Error('That change no longer needs review')
    if (resolution !== 'keep-server' && resolution !== 'keep-local') throw new Error('Choose how to resolve the change')
    return this.exclusive(initial.accountId, async () => {
      const operation = this.store.operation(reviewId)
      if (!operation || operation.status === 'queued') return
      if (resolution === 'keep-server') {
        this.store.deleteOperation(operation.id)
        this.options.diagnostic?.({ level: 'info', event: 'exchange-conflict-kept-server', accountId: operation.accountId, details: { kind: operation.kind } })
      } else {
        if (!this.store.folder(operation.folderKey)) throw new Error('This calendar or contacts folder no longer exists on the server')
        if (operation.serverDeleted && operation.action === 'delete') this.store.deleteOperation(operation.id)
        else {
          // Sent again against the revision just reviewed, still with NeverOverwrite: a newer
          // change made meanwhile produces another conflict instead of being overwritten.
          const recreate = Boolean(operation.serverDeleted) && operation.action !== 'create'
          this.store.saveOperation({
            ...operation, status: 'queued', action: recreate ? 'create' : operation.action, itemId: recreate ? undefined : operation.itemId,
            changeKey: recreate ? undefined : operation.serverChangeKey ?? operation.changeKey, base: recreate ? undefined : operation.serverData ?? operation.base,
            error: undefined, attempts: 0, nextAttemptAt: undefined, serverData: undefined, serverChangeKey: undefined, serverDeleted: false, updatedAt: this.now().toISOString()
          })
        }
        this.options.diagnostic?.({ level: 'info', event: 'exchange-conflict-kept-local', accountId: operation.accountId, details: { kind: operation.kind } })
      }
      await this.commit(operation.accountId)
    })
  }

  /** Session expiry seen by the mail worker or IPC: stop sending until new credentials arrive. */
  markNeedsAuth(accountId: string, error = 'Exchange rejected the saved credentials. Enter the password (or a new token) again.') {
    if (!this.store.account(accountId)) return
    this.saveStatus(accountId, { status: 'needs-auth', error })
    this.project(accountId)
    this.changed()
  }
}
