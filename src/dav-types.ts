// CalDAV / CardDAV calendar and contact accounts. These are separate from mail accounts: a DAV
// account signs in with a user name and an app-specific password kept in OS secure storage, and its
// calendars and address books appear in Calendar and Contacts through the productivity snapshot.

export type DavPresetId = 'icloud' | 'fastmail' | 'nextcloud' | 'generic'
export type DavCollectionKind = 'calendar' | 'addressbook'
export type DavAccountStatus = 'ready' | 'syncing' | 'needs-auth' | 'error'

export interface DavAccountInput {
  preset: DavPresetId
  name?: string
  // Required for Nextcloud and generic servers; presets with fixed hosts ignore it.
  serverUrl?: string
  username: string
  password: string
}

export interface DavAccountSummary {
  id: string
  preset: DavPresetId
  name: string
  username: string
  serverUrl: string
  status: DavAccountStatus
  error?: string
  lastSyncedAt?: string
  calendarHomeUrl?: string
  addressbookHomeUrl?: string
  pendingWrites: number
}

export interface DavCollectionSummary {
  id: string
  accountId: string
  kind: DavCollectionKind
  name: string
  color: string
  url: string
  readOnly: boolean
  shared: boolean
  // CalDAV supported-calendar-component-set; only collections with VEVENT appear in Calendar.
  components: string[]
  enabled: boolean
  syncMode: 'sync-collection' | 'ctag'
  lastSyncedAt?: string
  error?: string
}

export type DavReviewStatus = 'conflict' | 'failed' | 'held'

// A local change the server did not accept. Nothing is overwritten until the user chooses.
export interface DavReviewItem {
  id: string
  accountId: string
  collectionId: string
  kind: 'event' | 'contact'
  action: 'create' | 'update' | 'delete'
  status: DavReviewStatus
  title: string
  error: string
  serverDeleted: boolean
  serverTitle?: string
  updatedAt: string
}

export type DavResolution = 'keep-server' | 'keep-local'

export interface DavSnapshot {
  accounts: DavAccountSummary[]
  collections: DavCollectionSummary[]
  review: DavReviewItem[]
}

export interface DavDesktopApi {
  snapshot(): Promise<DavSnapshot>
  onChanged(callback: (snapshot: DavSnapshot) => void): () => void
  addAccount(input: DavAccountInput): Promise<DavSnapshot>
  updatePassword(accountId: string, password: string): Promise<DavSnapshot>
  removeAccount(accountId: string): Promise<DavSnapshot>
  sync(accountId: string): Promise<DavSnapshot>
  syncAll(): Promise<DavSnapshot>
  setCollectionEnabled(collectionId: string, enabled: boolean): Promise<DavSnapshot>
  resolve(reviewId: string, resolution: DavResolution): Promise<DavSnapshot>
}
