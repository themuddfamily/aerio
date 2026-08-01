import type { CalendarEvent, Contact, Note, Task } from './types'

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
  sync: ProductivitySyncState[]
}

export interface ProviderProductivityData {
  calendars: SyncedCalendar[]
  events: SyncedCalendarEvent[]
  contacts: SyncedContact[]
}

export interface LocalModuleSnapshot {
  tasks: Task[]
  notes: Note[]
}

export interface ProductivityDesktopApi {
  snapshot(): Promise<ProductivitySnapshot>
  sync(accountId: string): Promise<ProductivitySnapshot>
  localSnapshot(): Promise<LocalModuleSnapshot>
  saveLocal(snapshot: LocalModuleSnapshot): Promise<void>
}
