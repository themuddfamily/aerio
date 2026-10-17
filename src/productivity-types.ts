import type { Attachment, CalendarEvent, ConferenceProvider, Contact, ContactList, Note, RecurrenceEditScope, Task } from './types'

export type ProductivityProvider = 'gmail' | 'microsoft'
export type ProductivityModule = 'calendar' | 'contacts'
export type ProductivitySyncPhase = 'idle' | 'syncing' | 'ready' | 'error'

export interface SyncedCalendar {
  id: string
  remoteId: string
  accountId: string
  provider: ProductivityProvider
  name: string
  color: string
  primary: boolean
  canWrite: boolean
  // Online meeting capability reported by the provider (E25); absent on calendars synced before E25.
  conferences?: CalendarConferenceSupport
}

export interface CalendarConferenceSupport {
  // Raw provider values: Google conferenceProperties.allowedConferenceSolutionTypes or Graph
  // allowedOnlineMeetingProviders.
  allowed: string[]
  // Raw default provider when the provider reports one (Graph defaultOnlineMeetingProvider).
  defaultProvider?: string
  // Providers Aerio can create on this calendar with the current consent.
  creatable: ConferenceProvider[]
  // Whether an existing meeting can be detached from an event (Graph cannot turn isOnlineMeeting off).
  canRemove: boolean
}

export interface SyncedCalendarEvent extends CalendarEvent {
  remoteId: string
  accountId: string
  provider: ProductivityProvider
  readOnly: boolean
}

export interface SyncedContact extends Contact {
  remoteId: string
  accountId: string
  provider: ProductivityProvider
  readOnly: boolean
  revision?: string
  sourceId?: string
  folderId?: string
  // Provider group resource ids (Google contactGroups/...) behind `groups`.
  groupIds?: string[]
  // Raw provider values for the fields Aerio writes, merged back on update so per-entry
  // details Aerio does not model (labels, canonical forms, structured parts) are not discarded.
  providerData?: Record<string, unknown>
}

// A provider-managed contact group: Google People contactGroups. Microsoft Graph has no
// distribution-list API for personal contacts, so Outlook categories are derived from contacts instead.
export interface SyncedContactGroup {
  id: string
  remoteId: string
  accountId: string
  provider: ProductivityProvider
  name: string
  // System groups (Friends, Family, Coworkers) accept members but cannot be renamed or deleted.
  system: boolean
  readOnly: boolean
  revision?: string
  memberCount?: number
}

export interface ProductivitySyncState {
  accountId: string
  module: ProductivityModule
  phase: ProductivitySyncPhase
  lastSyncedAt?: string
  error?: string
}

export interface ProductivitySnapshot {
  calendars: SyncedCalendar[]
  events: SyncedCalendarEvent[]
  contacts: SyncedContact[]
  contactGroups?: SyncedContactGroup[]
  sync: ProductivitySyncState[]
}

export interface ProviderProductivityData {
  calendars: SyncedCalendar[]
  events: SyncedCalendarEvent[]
  contacts: SyncedContact[]
  contactGroups?: SyncedContactGroup[]
}

export interface ProviderProductivitySyncResult extends ProviderProductivityData {
  checkpoints: Record<string, string>
}

export interface LocalModuleSnapshot {
  tasks: Task[]
  notes: Note[]
  contacts?: Contact[]
  contactLists?: ContactList[]
}

export interface LocalDataBackupResult {
  savedPath?: string
}

export interface ProductivityContactWriteResult {
  contact: SyncedContact
  snapshot: ProductivitySnapshot
}

export interface ProductivityDesktopApi {
  onChanged(callback: (data: { local?: LocalModuleSnapshot; snapshot?: ProductivitySnapshot }) => void): () => void
  snapshot(): Promise<ProductivitySnapshot>
  sync(accountId: string): Promise<ProductivitySnapshot>
  createEvent(event: CalendarEvent): Promise<ProductivitySnapshot>
  updateEvent(event: CalendarEvent, scope?: RecurrenceEditScope): Promise<ProductivitySnapshot>
  deleteEvent(eventId: string, scope?: RecurrenceEditScope): Promise<ProductivitySnapshot>
  createContact(accountId: string, contact: Contact): Promise<ProductivityContactWriteResult>
  updateContact(contact: Contact): Promise<ProductivityContactWriteResult>
  deleteContact(contactId: string): Promise<ProductivitySnapshot>
  createContactGroup?(accountId: string, name: string): Promise<ProductivitySnapshot>
  renameContactGroup?(groupId: string, name: string): Promise<ProductivitySnapshot>
  deleteContactGroup?(groupId: string): Promise<ProductivitySnapshot>
  updateContactGroupMembers?(groupId: string, addContactIds: string[], removeContactIds: string[]): Promise<ProductivitySnapshot>
  chooseNoteAttachments(): Promise<Attachment[]>
  openNoteAttachment(path: string): Promise<{ error?: string }>
  localSnapshot(): Promise<LocalModuleSnapshot>
  saveLocal(snapshot: LocalModuleSnapshot): Promise<void>
  exportLocalData(): Promise<LocalDataBackupResult>
  importLocalData(): Promise<LocalModuleSnapshot | undefined>
  /** Free/busy lookup for the scheduling assistant, answered by the calendar's provider. */
  availability?(request: import('./scheduling-types').AvailabilityRequest): Promise<import('./scheduling-types').AvailabilityResult>
}
