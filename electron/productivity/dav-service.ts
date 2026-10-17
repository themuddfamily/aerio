import { createHash, randomUUID } from 'node:crypto'
import type { CalendarEvent, Contact } from '../../src/types'
import type { ProviderProductivityData, SyncedCalendar, SyncedCalendarEvent, SyncedContact } from '../../src/productivity-types'
import type { DavAccountInput, DavCollectionSummary, DavPresetId, DavResolution, DavReviewItem, DavSnapshot } from '../../src/dav-types'
import { DAV_PRESETS, davPreset, davServiceRoots } from '../../src/lib/dav-presets'
import { DavClient, DavHttpError, DavNetworkError, type DavFetch } from './dav-client'
import { discoverAccount, listCollections, type DiscoveredCollection } from './dav-discovery'
import { pullCollection } from './dav-sync'
import {
  contactFromResource, eventsFromResource, mergeContactResource, mergeEventResource, newContactResource, newEventResource,
  removeEventInstance, resourceTitle, type DavCollectionRef
} from './dav-payload'
import type { DavAccountRecord, DavCollectionRecord, DavOperationRecord, DavStore } from './dav-store'
import type { DavCredentialVault } from './dav-credentials'
import type { ProductivityStore } from './store'

const COLORS = ['#3f74c9', '#2f7d6d', '#c06a3a', '#7b5cc4', '#b44f7a', '#5d7f3a']
const RETRY_BASE_MS = 30_000
const RETRY_MAX_MS = 30 * 60_000

export interface DavServiceOptions {
  store: DavStore
  productivity(): ProductivityStore
  credentials: DavCredentialVault
  fetch?: DavFetch
  timeoutMs?: number
  sleep?(ms: number): Promise<void>
  online?(): boolean
  now?(): Date
  changed?(): void
  diagnostic?(record: { level: 'info' | 'warn' | 'error'; event: string; accountId?: string; message?: string; details?: Record<string, unknown> }): void
}

export class DavWriteBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DavWriteBlockedError'
  }
}

const collectionId = (accountId: string, url: string) => `${accountId}:${createHash('sha256').update(url.replace(/\/+$/, '')).digest('hex').slice(0, 16)}`
const message = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback).slice(0, 500)
const isEventCalendar = (collection: DavCollectionRecord) => collection.kind === 'calendar' && collection.components.includes('VEVENT')
const syncable = (collection: DavCollectionRecord) => collection.enabled && (collection.kind === 'addressbook' || isEventCalendar(collection))
const memberUrl = (collection: DavCollectionRecord, name: string) => new URL(encodeURIComponent(name), collection.url.endsWith('/') ? collection.url : `${collection.url}/`).toString()
const ref = (collection: DavCollectionRecord): DavCollectionRef => ({ id: collection.id, accountId: collection.accountId, name: collection.name, color: collection.color, readOnly: collection.readOnly })
const host = (url: string | undefined) => { try { return url ? new URL(url).host : undefined } catch { return undefined } }

export class DavService {
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(private readonly options: DavServiceOptions) {}

  private get store() { return this.options.store }
  private now() { return this.options.now?.() ?? new Date() }
  private changed() { this.options.changed?.() }

  hasAccount(accountId: string) {
    return Boolean(this.store.account(accountId))
  }

  // Writes and synchronization for one account run one at a time so the queue is never sent twice.
  private exclusive<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(accountId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(work)
    this.locks.set(accountId, next)
    void next.finally(() => { if (this.locks.get(accountId) === next) this.locks.delete(accountId) }).catch(() => undefined)
    return next
  }

  private clientOptions() {
    return { fetch: this.options.fetch, timeoutMs: this.options.timeoutMs, sleep: this.options.sleep }
  }

  private client(account: DavAccountRecord) {
    const password = this.options.credentials.password(account.id)
    if (!password) {
      this.store.saveAccount({ ...account, status: 'needs-auth', error: 'Enter the app password for this account again' })
      throw new DavHttpError('Enter the app password for this account again', 401)
    }
    return new DavClient({ username: account.username, password }, { ...this.clientOptions(), allowedRoots: [...account.calendarRoots, ...account.contactsRoots] })
  }

  snapshot(): DavSnapshot {
    const operations = this.store.operations()
    const collections = this.store.collections()
    const review: DavReviewItem[] = operations.filter((operation) => operation.status !== 'queued').map((operation) => {
      const cached = this.store.resource(operation.collectionId, operation.href)
      const title = resourceTitle(operation.kind, operation.data ?? cached?.data) ?? (operation.kind === 'event' ? 'Untitled event' : 'Unnamed contact')
      const serverTitle = resourceTitle(operation.kind, operation.serverData)
      return {
        id: operation.id, accountId: operation.accountId, collectionId: operation.collectionId, kind: operation.kind, action: operation.action,
        status: operation.status as DavReviewItem['status'], title, error: operation.error ?? 'This change needs review',
        serverDeleted: Boolean(operation.serverDeleted), ...(serverTitle ? { serverTitle } : {}), updatedAt: operation.updatedAt
      }
    })
    return {
      accounts: this.store.accounts().map((account) => ({
        id: account.id, preset: account.preset, name: account.name, username: account.username, serverUrl: account.serverUrl,
        status: account.status, ...(account.error ? { error: account.error } : {}), ...(account.lastSyncedAt ? { lastSyncedAt: account.lastSyncedAt } : {}),
        ...(account.calendarHomeUrl ? { calendarHomeUrl: account.calendarHomeUrl } : {}),
        ...(account.addressbookHomeUrl ? { addressbookHomeUrl: account.addressbookHomeUrl } : {}),
        pendingWrites: operations.filter((operation) => operation.accountId === account.id && operation.status === 'queued').length
      })),
      collections: collections.map((collection): DavCollectionSummary => ({
        id: collection.id, accountId: collection.accountId, kind: collection.kind, name: collection.name, color: collection.color, url: collection.url,
        readOnly: collection.readOnly, shared: collection.shared, components: collection.components, enabled: collection.enabled, syncMode: collection.syncMode,
        ...(collection.lastSyncedAt ? { lastSyncedAt: collection.lastSyncedAt } : {}), ...(collection.error ? { error: collection.error } : {})
      })),
      review
    }
  }

  // --- Accounts -------------------------------------------------------------------------------

  async addAccount(input: DavAccountInput) {
    if (!input || typeof input !== 'object' || !DAV_PRESETS.some((preset) => preset.id === input.preset)) throw new Error('Choose a calendar and contacts service')
    const username = typeof input.username === 'string' ? input.username.trim() : ''
    const password = typeof input.password === 'string' ? input.password : ''
    if (!username || username.length > 500) throw new Error('Enter your user name')
    if (!password.trim() || password.length > 1_000) throw new Error('Enter an app password')
    const preset = davPreset(input.preset as DavPresetId)
    const roots = davServiceRoots(preset.id, input.serverUrl)
    const serverUrl = preset.needsServerUrl ? roots.calendar[0] : preset.calendarUrl!
    if (this.store.accounts().some((account) => account.serverUrl === serverUrl && account.username.toLowerCase() === username.toLowerCase())) {
      throw new Error('That account is already connected')
    }
    const client = new DavClient({ username, password }, { ...this.clientOptions(), allowedRoots: [...roots.calendar, ...roots.contacts] })
    let discovery
    try { discovery = await discoverAccount(client, roots) }
    catch (error) {
      if (error instanceof DavHttpError && error.status === 401) throw new Error('The server rejected the user name or app password')
      throw new Error(message(error, 'The server could not be reached'))
    }
    const id = `dav-${randomUUID()}`
    // Saving the password first means an OS without secure storage leaves nothing behind.
    this.options.credentials.save(id, password)
    const account: DavAccountRecord = {
      id, preset: preset.id, name: (typeof input.name === 'string' && input.name.trim().slice(0, 200)) || `${preset.label} · ${username}`,
      username, serverUrl, calendarRoots: roots.calendar, contactsRoots: roots.contacts,
      ...(discovery.calendar ? { principalUrl: discovery.calendar.principalUrl, calendarHomeUrl: discovery.calendar.homeUrl } : {}),
      ...(discovery.contacts ? { principalUrl: discovery.calendar?.principalUrl ?? discovery.contacts.principalUrl, addressbookHomeUrl: discovery.contacts.homeUrl } : {}),
      status: 'ready'
    }
    this.store.saveAccount(account)
    this.mergeCollections(account, discovery.collections)
    this.options.diagnostic?.({ level: 'info', event: 'dav-account-added', accountId: id, details: { preset: preset.id, host: host(serverUrl), collections: discovery.collections.length } })
    this.changed()
    await this.sync(id).catch(() => undefined)
    return this.store.account(id)!
  }

  async updatePassword(accountId: string, password: unknown) {
    const account = this.store.account(accountId)
    if (!account) throw new Error('That account is no longer connected')
    if (typeof password !== 'string' || !password.trim() || password.length > 1_000) throw new Error('Enter an app password')
    const client = new DavClient({ username: account.username, password }, { ...this.clientOptions(), allowedRoots: [...account.calendarRoots, ...account.contactsRoots] })
    const home = account.calendarHomeUrl ?? account.addressbookHomeUrl
    try { if (home) await listCollections(client, home) }
    catch (error) {
      if (error instanceof DavHttpError && error.status === 401) throw new Error('The server rejected the user name or app password')
      throw new Error(message(error, 'The server could not be reached'))
    }
    this.options.credentials.save(accountId, password)
    this.store.saveAccount({ ...account, status: 'ready', error: undefined })
    // Writes held after a profile restore stay held until the user sends them from review.
    await this.sync(accountId).catch(() => undefined)
  }

  removeAccount(accountId: string) {
    this.store.removeAccount(accountId)
    this.options.credentials.remove(accountId)
    this.options.productivity().removeAccount(accountId)
    this.options.diagnostic?.({ level: 'info', event: 'dav-account-removed', accountId })
    this.changed()
  }

  setCollectionEnabled(id: string, enabled: boolean) {
    const collection = this.store.collection(id)
    if (!collection) throw new Error('That calendar or address book is no longer available')
    this.store.saveCollection({ ...collection, enabled })
    this.project(collection.accountId)
    this.changed()
  }

  private mergeCollections(account: DavAccountRecord, discovered: DiscoveredCollection[]) {
    const existing = this.store.collections(account.id)
    const byUrl = new Map(existing.map((collection) => [collection.url.replace(/\/+$/, ''), collection]))
    const seen = new Set<string>()
    discovered.forEach((found, index) => {
      const key = found.url.replace(/\/+$/, '')
      seen.add(key)
      const previous = byUrl.get(key)
      this.store.saveCollection({
        id: previous?.id ?? collectionId(account.id, found.url), accountId: account.id, url: found.url, kind: found.kind, name: found.name,
        color: found.color ?? previous?.color ?? COLORS[(existing.length + index) % COLORS.length],
        ...(found.description ? { description: found.description } : {}),
        components: found.components, readOnly: found.readOnly, shared: found.shared, enabled: previous?.enabled ?? true,
        // Revision markers come from the last successful pull, never from the listing.
        ...(previous?.ctag ? { ctag: previous.ctag } : {}), ...(previous?.syncToken ? { syncToken: previous.syncToken } : {}),
        supportsSyncCollection: found.supportsSyncCollection, syncMode: previous?.syncMode ?? (found.supportsSyncCollection ? 'sync-collection' : 'ctag'),
        ...(previous?.lastSyncedAt ? { lastSyncedAt: previous.lastSyncedAt } : {}), ...(previous?.error ? { error: previous.error } : {})
      })
    })
    for (const collection of existing) {
      if (seen.has(collection.url.replace(/\/+$/, ''))) continue
      // Local writes for a collection that disappeared stay in review rather than vanishing.
      for (const operation of this.store.operations({ accountId: account.id }).filter((item) => item.collectionId === collection.id)) {
        this.store.saveOperation({ ...operation, status: 'failed', error: 'This calendar or address book was removed on the server', updatedAt: this.now().toISOString() })
      }
      this.store.removeCollection(collection.id)
    }
  }

  // --- Synchronization ------------------------------------------------------------------------

  sync(accountId: string) {
    return this.exclusive(accountId, () => this.syncNow(accountId))
  }

  async syncAll() {
    for (const account of this.store.accounts()) {
      if (account.status === 'needs-auth') continue
      await this.sync(account.id).catch(() => undefined)
    }
  }

  /** Sends queued writes for every account (for example when the network comes back). */
  async flushAll() {
    for (const account of this.store.accounts()) {
      if (account.status === 'needs-auth') continue
      await this.exclusive(account.id, async () => {
        const latest = this.store.account(account.id)
        if (!latest) return
        await this.flush(latest, this.client(latest))
        this.project(account.id)
      }).catch(() => undefined)
    }
    this.changed()
  }

  private async syncNow(accountId: string) {
    let account = this.store.account(accountId)
    if (!account) throw new Error('That account is no longer connected')
    if (this.options.online && !this.options.online()) throw new DavNetworkError('Aerio is offline; changes will be sent when the connection returns')
    this.store.saveAccount({ ...account, status: 'syncing' })
    this.changed()
    try {
      const client = this.client(account)
      await this.flush(account, client)
      account = this.store.account(accountId)!
      await this.refreshCollections(account, client)
      let pulled = 0
      for (const collection of this.store.collections(accountId).filter(syncable)) {
        try {
          const changes = await pullCollection(client, collection, this.store.etags(collection.id))
          pulled += changes.changed.length + changes.removed.length
          this.store.applyChanges({
            ...collection,
            ...(changes.ctag !== undefined ? { ctag: changes.ctag } : {}),
            ...(changes.syncToken !== undefined ? { syncToken: changes.syncToken } : {}),
            syncMode: changes.mode, lastSyncedAt: this.now().toISOString(), error: undefined
          }, changes.changed, changes.removed)
        } catch (error) {
          if (error instanceof DavNetworkError || (error instanceof DavHttpError && error.status === 401)) throw error
          this.store.saveCollection({ ...collection, error: message(error, 'This collection could not be synchronized') })
          this.options.diagnostic?.({ level: 'warn', event: 'dav-collection-sync-failed', accountId, message: message(error, ''), details: { kind: collection.kind } })
        }
      }
      this.store.saveAccount({ ...this.store.account(accountId)!, status: 'ready', error: undefined, lastSyncedAt: this.now().toISOString() })
      this.project(accountId)
      this.options.diagnostic?.({ level: 'info', event: 'dav-sync-complete', accountId, details: { changes: pulled, host: host(account.serverUrl) } })
    } catch (error) {
      const latest = this.store.account(accountId)
      if (latest) {
        const auth = error instanceof DavHttpError && error.status === 401
        this.store.saveAccount({ ...latest, status: auth ? 'needs-auth' : 'error', error: auth ? 'The server rejected the app password. Enter it again.' : message(error, 'Synchronization failed') })
        this.project(accountId)
      }
      this.options.diagnostic?.({ level: 'error', event: 'dav-sync-failed', accountId, message: message(error, '') })
      throw error
    } finally {
      this.changed()
    }
  }

  private async refreshCollections(account: DavAccountRecord, client: DavClient) {
    const found: DiscoveredCollection[] = []
    const homes = new Set([account.calendarHomeUrl, account.addressbookHomeUrl].filter((home): home is string => Boolean(home)))
    if (!homes.size) return
    for (const home of homes) {
      try {
        const listed = await listCollections(client, home)
        found.push(...listed.filter((item) => (item.kind === 'calendar' ? home === account.calendarHomeUrl : home === account.addressbookHomeUrl) && !found.some((other) => other.url === item.url)))
      } catch (error) {
        if (error instanceof DavNetworkError || (error instanceof DavHttpError && error.status === 401)) throw error
        // A listing failure keeps the known collections rather than removing them.
        return
      }
    }
    this.mergeCollections(account, found)
  }

  /** Projects server copies plus pending local writes into the shared productivity cache. */
  project(accountId: string) {
    const account = this.store.account(accountId)
    if (!account) return
    const data: ProviderProductivityData = { calendars: [], events: [], contacts: [] }
    const operations = this.store.operations({ accountId })
    let primary = true
    for (const collection of this.store.collections(accountId).filter(syncable)) {
      const resources = new Map(this.store.resources(collection.id).map((resource) => [resource.href, resource]))
      for (const operation of operations.filter((item) => item.collectionId === collection.id)) {
        if (operation.action === 'delete') resources.delete(operation.href)
        else if (operation.data) resources.set(operation.href, { collectionId: collection.id, href: operation.href, data: operation.data, etag: resources.get(operation.href)?.etag })
      }
      if (collection.kind === 'calendar') {
        data.calendars.push({
          id: collection.id, remoteId: collection.url, accountId, provider: 'dav', name: collection.name, color: collection.color,
          primary: primary && !collection.readOnly, canWrite: !collection.readOnly
        } satisfies SyncedCalendar)
        if (!collection.readOnly) primary = false
        for (const resource of resources.values()) {
          try { data.events.push(...eventsFromResource(ref(collection), resource.href, resource.data)) }
          catch { /* An unreadable calendar object is skipped; the server copy is kept untouched. */ }
        }
      } else {
        for (const resource of resources.values()) {
          try {
            const contact = contactFromResource(ref(collection), resource.href, resource.etag, resource.data)
            if (contact) data.contacts.push(contact)
          } catch { /* Skipped like unreadable events. */ }
        }
      }
    }
    const productivity = this.options.productivity()
    productivity.replaceAccount(accountId, 'dav', data, {})
    if (account.status === 'error' || account.status === 'needs-auth') productivity.setError(accountId, account.error ?? 'This account needs attention')
  }

  // --- Durable write queue --------------------------------------------------------------------

  private async flush(account: DavAccountRecord, client: DavClient) {
    if (this.options.online && !this.options.online()) return
    const now = this.now()
    for (const operation of this.store.operations({ accountId: account.id, status: ['queued'] })) {
      if (operation.nextAttemptAt && Date.parse(operation.nextAttemptAt) > now.getTime()) continue
      try {
        await this.send(client, operation)
      } catch (error) {
        if (error instanceof DavHttpError && error.status === 401) throw error
        const transient = error instanceof DavNetworkError || (error instanceof DavHttpError && (error.status >= 500 || error.status === 429 || error.status === 408))
        const attempts = operation.attempts + 1
        this.store.saveOperation({
          ...operation, attempts, error: message(error, 'The change could not be sent'), updatedAt: now.toISOString(),
          ...(transient
            ? { nextAttemptAt: new Date(now.getTime() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 10))).toISOString() }
            : { status: 'failed' as const, error: error instanceof DavHttpError && error.status === 403 ? 'The server refused this change; the calendar or address book may be read-only' : message(error, 'The server refused this change') })
        })
        // Offline: stop here and keep every later write queued in order.
        if (error instanceof DavNetworkError) return
      }
    }
  }

  private async send(client: DavClient, operation: DavOperationRecord) {
    const contentType = operation.kind === 'event' ? 'text/calendar; charset=utf-8' : 'text/vcard; charset=utf-8'
    if (operation.action !== 'create' && !operation.ifMatch) {
      return this.conflict(client, operation, 'The server did not report a revision for this item, so Aerio cannot update it safely')
    }
    const response = operation.action === 'delete'
      ? await client.request('DELETE', operation.href, { headers: { 'If-Match': operation.ifMatch! } })
      : await client.request('PUT', operation.href, {
        headers: { 'Content-Type': contentType, ...(operation.action === 'create' ? { 'If-None-Match': '*' } : { 'If-Match': operation.ifMatch! }) },
        body: operation.data
      })
    if (response.status === 412) return this.conflict(client, operation, operation.action === 'create' ? 'An item with this address already exists on the server' : 'Changed on the server since you edited it')
    if (operation.action === 'delete') {
      if ((response.status >= 200 && response.status < 300) || response.status === 404 || response.status === 410) {
        this.store.completeOperation(operation, undefined)
        return
      }
    } else if (response.status === 404 || response.status === 410) {
      return this.conflict(client, operation, 'Deleted on the server since you edited it')
    } else if (response.status >= 200 && response.status < 300) {
      let etag = response.headers.get('etag')?.trim() || undefined
      let data = operation.data!
      // Without an ETag the server may have rewritten the item; read back its stored copy.
      if (!etag) {
        const stored = await client.request('GET', operation.href)
        if (stored.status >= 200 && stored.status < 300) {
          data = stored.text
          etag = stored.headers.get('etag')?.trim() || undefined
        }
      }
      this.store.completeOperation(operation, { collectionId: operation.collectionId, href: operation.href, data, ...(etag ? { etag } : {}) })
      return
    }
    throw new DavHttpError(response.status === 403 ? 'The server refused this change' : `The server responded with ${response.status}`, response.status, response.text.slice(0, 2_000))
  }

  // 412 or a vanished item: record what the server holds now and wait for the user's decision.
  private async conflict(client: DavClient, operation: DavOperationRecord, reason: string) {
    const current = await client.request('GET', operation.href)
    const deleted = current.status === 404 || current.status === 410
    if (!deleted && (current.status < 200 || current.status >= 300)) throw new DavHttpError(`The server responded with ${current.status}`, current.status)
    const serverEtag = deleted ? undefined : current.headers.get('etag')?.trim() || undefined
    this.store.transaction(() => {
      if (deleted) this.store.removeResource(operation.collectionId, operation.href)
      else if (this.store.collection(operation.collectionId)) this.store.saveResource({ collectionId: operation.collectionId, href: operation.href, data: current.text, ...(serverEtag ? { etag: serverEtag } : {}) })
      this.store.saveOperation({
        ...operation, status: 'conflict', error: deleted && operation.action !== 'delete' ? 'Deleted on the server since you edited it' : reason,
        serverDeleted: deleted, serverData: deleted ? undefined : current.text, serverEtag, updatedAt: this.now().toISOString()
      })
    })
    this.options.diagnostic?.({ level: 'warn', event: 'dav-write-conflict', accountId: operation.accountId, details: { kind: operation.kind, action: operation.action, serverDeleted: deleted } })
  }

  private baseData(collection: DavCollectionRecord, href: string) {
    const pending = this.store.operationFor(collection.id, href)
    if (pending && pending.status !== 'queued') throw new DavWriteBlockedError('This item has a synchronization conflict. Resolve it in Settings → Calendar and contacts accounts first.')
    if (pending?.action === 'delete') throw new DavWriteBlockedError('This item is being deleted')
    const resource = this.store.resource(collection.id, href)
    const data = pending?.data ?? resource?.data
    if (!data) throw new DavWriteBlockedError('That item is no longer available; synchronize and try again')
    return { pending, resource, data }
  }

  private enqueue(collection: DavCollectionRecord, kind: 'event' | 'contact', href: string, action: 'create' | 'update' | 'delete', data?: string) {
    const timestamp = this.now().toISOString()
    const pending = this.store.operationFor(collection.id, href)
    const resource = this.store.resource(collection.id, href)
    if (pending && pending.status !== 'queued') throw new DavWriteBlockedError('This item has a synchronization conflict. Resolve it in Settings → Calendar and contacts accounts first.')
    if (pending) {
      // Coalesce with the queued write: a never-sent create that is deleted simply disappears.
      if (action === 'delete' && pending.action === 'create') { this.store.deleteOperation(pending.id); return }
      this.store.saveOperation({
        ...pending, action: pending.action === 'create' ? 'create' : action, data: action === 'delete' ? undefined : data,
        attempts: 0, nextAttemptAt: undefined, error: undefined, updatedAt: timestamp
      })
      return
    }
    this.store.saveOperation({
      id: `dav-op-${randomUUID()}`, accountId: collection.accountId, collectionId: collection.id, href, kind, action,
      ...(data !== undefined ? { data } : {}), ...(action !== 'create' && resource?.etag ? { ifMatch: resource.etag } : {}),
      status: 'queued', attempts: 0, createdAt: timestamp, updatedAt: timestamp
    })
  }

  // Applies the queued write locally at once, then tries to send it. Offline or failing servers
  // leave it queued; nothing here throws for a network problem.
  private async commit(accountId: string) {
    this.project(accountId)
    this.changed()
    const account = this.store.account(accountId)
    if (!account || account.status === 'needs-auth') return
    try {
      await this.flush(account, this.client(account))
    } catch (error) {
      if (error instanceof DavHttpError && error.status === 401) {
        this.store.saveAccount({ ...this.store.account(accountId)!, status: 'needs-auth', error: 'The server rejected the app password. Enter it again.' })
      }
    }
    this.project(accountId)
    this.changed()
  }

  private writableCollection(id: string | undefined, kind: 'calendar' | 'addressbook') {
    const collection = id ? this.store.collection(id) : undefined
    if (!collection || collection.kind !== kind) throw new Error(kind === 'calendar' ? 'That calendar is no longer available' : 'That address book is no longer available')
    if (collection.readOnly) throw new Error(kind === 'calendar' ? 'This calendar is read-only' : 'This address book is read-only')
    return collection
  }

  createEvent(calendar: SyncedCalendar, input: CalendarEvent) {
    return this.exclusive(calendar.accountId, async () => {
      const collection = this.writableCollection(calendar.id, 'calendar')
      const uid = randomUUID()
      const href = memberUrl(collection, `${uid}.ics`)
      this.enqueue(collection, 'event', href, 'create', newEventResource({ ...input, calendarId: collection.id }, uid))
      await this.commit(collection.accountId)
    })
  }

  updateEvent(current: SyncedCalendarEvent, input: CalendarEvent) {
    return this.exclusive(current.accountId, async () => {
      const collection = this.writableCollection(current.calendarId, 'calendar')
      const { data } = this.baseData(collection, current.remoteId)
      this.enqueue(collection, 'event', current.remoteId, 'update', mergeEventResource(data, current, input))
      await this.commit(collection.accountId)
    })
  }

  deleteEvent(current: SyncedCalendarEvent) {
    return this.exclusive(current.accountId, async () => {
      const collection = this.writableCollection(current.calendarId, 'calendar')
      const { data } = this.baseData(collection, current.remoteId)
      // Deleting one occurrence of a recurring series rewrites the series instead of deleting it.
      const rewritten = current.recurrenceId ? removeEventInstance(data, current.recurrenceId) : undefined
      this.enqueue(collection, 'event', current.remoteId, rewritten ? 'update' : 'delete', rewritten)
      await this.commit(collection.accountId)
    })
  }

  defaultAddressbook(accountId: string) {
    return this.store.collections(accountId).find((collection) => collection.kind === 'addressbook' && collection.enabled && !collection.readOnly)
  }

  createContact(accountId: string, input: Contact) {
    return this.exclusive(accountId, async () => {
      const collection = this.defaultAddressbook(accountId)
      if (!collection) throw new Error('This account has no address book that Aerio can write to')
      const uid = randomUUID()
      const href = memberUrl(collection, `${uid}.vcf`)
      this.enqueue(collection, 'contact', href, 'create', newContactResource(input, uid, collection.name))
      await this.commit(accountId)
      return this.projectedContact(accountId, collection.id, href)
    })
  }

  updateContact(current: SyncedContact, input: Contact) {
    return this.exclusive(current.accountId, async () => {
      const collection = this.writableCollection(current.folderId, 'addressbook')
      const { data } = this.baseData(collection, current.remoteId)
      this.enqueue(collection, 'contact', current.remoteId, 'update', mergeContactResource(data, input, collection.name))
      await this.commit(current.accountId)
      return this.projectedContact(current.accountId, collection.id, current.remoteId)
    })
  }

  deleteContact(current: SyncedContact) {
    return this.exclusive(current.accountId, async () => {
      const collection = this.writableCollection(current.folderId, 'addressbook')
      this.baseData(collection, current.remoteId)
      this.enqueue(collection, 'contact', current.remoteId, 'delete')
      await this.commit(current.accountId)
    })
  }

  private projectedContact(accountId: string, collectionId: string, href: string) {
    const contact = this.options.productivity().accountData(accountId).contacts.find((item) => item.folderId === collectionId && item.remoteId === href)
    if (!contact) throw new Error('The contact was saved but could not be read back')
    return contact
  }

  // --- Conflict review ------------------------------------------------------------------------

  resolve(reviewId: string, resolution: DavResolution) {
    const initial = this.store.operation(reviewId)
    if (!initial || initial.status === 'queued') throw new Error('That change no longer needs review')
    if (resolution !== 'keep-server' && resolution !== 'keep-local') throw new Error('Choose how to resolve the change')
    return this.exclusive(initial.accountId, async () => {
      const operation = this.store.operation(reviewId)
      if (!operation || operation.status === 'queued') return
      const timestamp = this.now().toISOString()
      if (resolution === 'keep-server') {
        this.store.transaction(() => {
          if (operation.serverDeleted) this.store.removeResource(operation.collectionId, operation.href)
          else if (operation.serverData !== undefined && this.store.collection(operation.collectionId)) {
            this.store.saveResource({ collectionId: operation.collectionId, href: operation.href, data: operation.serverData, ...(operation.serverEtag ? { etag: operation.serverEtag } : {}) })
          }
          this.store.deleteOperation(operation.id)
        })
        this.options.diagnostic?.({ level: 'info', event: 'dav-conflict-kept-server', accountId: operation.accountId, details: { kind: operation.kind } })
      } else {
        if (!this.store.collection(operation.collectionId)) throw new Error('This calendar or address book no longer exists on the server')
        if (operation.serverDeleted && operation.action === 'delete') this.store.completeOperation(operation, undefined)
        else {
          // Re-send against the server's current revision, still conditionally: a newer change
          // made meanwhile produces another conflict instead of being overwritten.
          const recreate = Boolean(operation.serverDeleted)
          this.store.saveOperation({
            ...operation, status: 'queued', action: recreate ? 'create' : operation.action, ifMatch: recreate ? undefined : operation.serverEtag ?? operation.ifMatch,
            error: undefined, attempts: 0, nextAttemptAt: undefined, serverData: undefined, serverEtag: undefined, serverDeleted: false, updatedAt: timestamp
          })
        }
        this.options.diagnostic?.({ level: 'info', event: 'dav-conflict-kept-local', accountId: operation.accountId, details: { kind: operation.kind } })
      }
      await this.commit(operation.accountId)
    })
  }
}
