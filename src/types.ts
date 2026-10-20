export type ModuleId = 'mail' | 'calendar' | 'contacts' | 'tasks' | 'notes' | 'chat'
export type ThemePreference = 'system' | 'light' | 'dark'
export type DensityPreference = 'comfortable' | 'compact'

export interface UserProfile {
  displayName: string
  email?: string
  avatarDataUrl?: string
}

export interface Account {
  id: string
  name: string
  email: string
  initials: string
  color: string
  provider: 'gmail' | 'microsoft' | 'outlook' | 'imap' | 'local' | 'dav' | 'exchange'
}

export interface Attachment {
  id: string
  name: string
  size: number
  path?: string
  mime?: string
  /** Notes only: a picture shown inside the rich body rather than listed as a file (docs/rich-notes.md). */
  inline?: boolean
}

export interface CalendarEvent {
  id: string
  calendarId: string
  title: string
  start: string
  end: string
  location?: string
  description?: string
  color: string
  attendees: string[]
  reminderMinutes: number
  /** Reminder offsets before start in minutes. Empty disables; absent reads the legacy value. */
  reminders?: number[]
  recurrence?: 'none' | 'daily' | 'weekly' | 'monthly'
  // Interchange fields preserved from ICS imports and written back on export.
  allDay?: boolean
  timeZone?: string
  recurrenceRule?: string
  recurrenceExceptions?: string[]
  recurrenceId?: string
  sourceUid?: string
  // Series identity (E24). `seriesId` names the series master an occurrence belongs to: the provider's
  // master id (Google recurringEventId, Microsoft seriesMasterId) for synced instances, or the local
  // master event id for local overrides. `originalStart` is the occurrence's unmodified start.
  seriesId?: string
  originalStart?: string
  // Set only on occurrences generated in the view by the recurrence expander; never persisted.
  occurrenceOf?: string
  // Meeting details (E22). `attendees` stays the plain address list every caller reads; `attendeeDetails`
  // adds role, kind, and response for those addresses (matched case-insensitively). `sequence` is the
  // iCalendar SEQUENCE the organizer last published.
  organizer?: EventParticipant
  attendeeDetails?: EventAttendee[]
  sequence?: number
  // Online meeting (E25). Absent means "no change requested" on writes: connectors never drop an existing
  // conference unless status is 'removed'. See src/lib/online-meetings.ts.
  conference?: EventConference
}

// RFC 5545 ROLE, CUTYPE, and PARTSTAT values in Aerio's vocabulary.
export type AttendeeRole = 'chair' | 'required' | 'optional' | 'non-participant'
export type AttendeeKind = 'individual' | 'group' | 'resource' | 'room' | 'unknown'
export type AttendeeResponse = 'needs-action' | 'accepted' | 'tentative' | 'declined' | 'delegated'

export interface EventParticipant {
  email: string
  name?: string
  // The participant is the account that owns this copy of the event.
  self?: boolean
}

export interface EventAttendee extends EventParticipant {
  role?: AttendeeRole
  kind?: AttendeeKind
  response?: AttendeeResponse
  // RSVP=TRUE: the organizer asked this attendee to reply.
  rsvp?: boolean
}

export type ConferenceProvider = 'googleMeet' | 'teams' | 'skype' | 'zoom' | 'webex' | 'goto' | 'meetn' | 'icewarp' | 'other'

export interface EventConference {
  provider: ConferenceProvider
  // 'pending' on a write asks the connector to create a meeting; on a read it means the provider has not
  // finished creating it. 'removed' asks the connector to detach the meeting.
  status: 'pending' | 'ready' | 'failed' | 'removed'
  // Stable id for the creation request, generated once when the meeting is added and reused by every retry
  // (Google createRequest.requestId, Graph transactionId) so retries never create a second meeting.
  requestId?: string
  joinUrl?: string
  conferenceId?: string
  // Provider display name, e.g. "Google Meet" or a third-party add-on name.
  name?: string
  phone?: string
  pin?: string
}

export type RecurrenceEditScope = 'occurrence' | 'following' | 'series'

export interface ContactField {
  value: string
  type?: string
  preferred?: boolean
  // Structured ADR components: PO box, extended, street, locality, region, postal code, country.
  parts?: string[]
}

export interface Contact {
  id: string
  name: string
  email: string
  phone?: string
  company?: string
  title?: string
  group: string
  notes?: string
  favorite: boolean
  color: string
  source?: 'local'
  // Interchange fields preserved from vCard/CSV imports; `email` and `phone` stay the primary values.
  emails?: ContactField[]
  phones?: ContactField[]
  addresses?: ContactField[]
  urls?: ContactField[]
  nameParts?: string[]
  nickname?: string
  birthday?: string
  sourceUid?: string
  // Every group or category the contact belongs to; `group` stays the primary one shown in lists.
  groups?: string[]
  // A small data: URL image (PNG, JPEG, GIF, or WebP); see src/lib/contact-fields.ts for bounds.
  photo?: string
}

// An explicit distribution list. Members reference a contact by id when picked from the address
// book and always carry the address used at the time, so a list survives contact deletion and can
// include people who are not saved contacts.
export interface ContactListMember {
  contactId?: string
  email: string
  name?: string
}

export interface ContactList {
  id: string
  name: string
  members: ContactListMember[]
  notes?: string
  source: 'local'
}

export interface Task {
  id: string
  listId: string
  title: string
  notes?: string
  due?: string
  priority: 'low' | 'normal' | 'high'
  completed: boolean
  subtasks: { id: string; title: string; completed: boolean }[]
  recurrence?: 'none' | 'daily' | 'weekly' | 'monthly'
  // Start, independent reminder, progress, tags and managed attachments (E44); see task-fields-types.ts.
  start?: string
  startTimeZone?: string
  reminder?: string
  percentComplete?: number
  categories?: string[]
  attachments?: Attachment[]
  /** Imported from an .ics file (E45): its UID and the source VTODO, so export keeps unmapped properties. */
  icalendar?: { uid: string; source?: string }
}

export interface Note {
  id: string
  folder: string
  title: string
  /** Plain text; for rich notes, the projection of `html` used by search and older readers. */
  content: string
  /** Sanitized rich body (docs/rich-notes.md). Absent for plain-text notes. */
  html?: string
  tags: string[]
  pinned: boolean
  archived: boolean
  updatedAt: string
  color?: string
  attachments?: Attachment[]
}

export interface Settings {
  theme: ThemePreference
  messageToolbar?: import('./lib/message-toolbar').MessageToolbarCommand[]
  /** Saved palettes, restricted to known color tokens; see docs/custom-themes.md. */
  customThemes?: import('./lib/themes').CustomTheme[]
  customThemeId?: string
  density: DensityPreference
  closeToTray: boolean
  launchAtLogin?: boolean
  notifications: boolean
  mailNotifications?: import('./mail-notification-types').MailNotificationPreferences
  startModule: ModuleId
  readReceiptPolicy?: import('./mail-types').MailReadReceiptPolicy
  profile?: UserProfile
  /** User changes to keyboard shortcuts; absent commands use the platform defaults (docs/keyboard-shortcuts.md). */
  keyboardShortcuts?: import('./lib/keymap').KeymapOverrides
}

export interface AppPreferences {
  schemaVersion: 1
  settings: Settings
}

// A renderer view model for provider Calendar/Contacts and local Tasks/Notes.
export interface AppState {
  accounts: Account[]
  events: CalendarEvent[]
  contacts: Contact[]
  tasks: Task[]
  notes: Note[]
}

export type MessageWindowRequest = { source: 'connected'; accountId: string; threadId: string; messageId?: string; title: string }

export interface WindowControls {
  minimize(): Promise<void>
  maximize(): Promise<void>
  close(): Promise<void>
  isMaximized(): Promise<boolean>
  openMessage(input: MessageWindowRequest): Promise<void>
}

export type AppUpdatePhase = 'unsupported' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'current' | 'error'

export interface AppUpdateStatus {
  phase: AppUpdatePhase
  currentVersion: string
  availableVersion?: string
  progress?: number
  message?: string
  checkedAt?: string
}

export interface AppUpdateControls {
  status(): Promise<AppUpdateStatus>
  check(): Promise<AppUpdateStatus>
  download(): Promise<AppUpdateStatus>
  install(): Promise<void>
  onStatus(callback: (status: AppUpdateStatus) => void): () => void
}

export interface AppLockStatus {
  enabled: boolean
  locked: boolean
}

export interface AppLockControls {
  status(): Promise<AppLockStatus>
  enable(passphrase: string): Promise<AppLockStatus>
  disable(passphrase: string): Promise<AppLockStatus>
  lock(): Promise<AppLockStatus>
  unlock(passphrase: string): Promise<AppLockStatus>
  onStatus(callback: (status: AppLockStatus) => void): () => void
}

export interface AerioDesktopApi {
  providerChat?: import('./provider-chat-types').ProviderChatApi
  taskDelegations?: import('./task-delegation-types').TaskDelegationApi
  settingsSync?: import('./settings-sync-types').SettingsSyncApi
  appProfiles?: import('./app-profile-types').AppProfilesApi
  messageToolbar?: import('./lib/message-toolbar').MessageToolbarApi
  calendarWeather?: import('./calendar-weather-types').CalendarWeatherApi
  loadPreferences(): Promise<AppPreferences>
  savePreferences(preferences: AppPreferences): Promise<{ savedAt: string }>
  chooseAttachments(): Promise<Attachment[]>
  chooseProfileImage(): Promise<string | undefined>
  notify(title: string, body: string): Promise<void>
  appLock: AppLockControls
  updates: AppUpdateControls
  profileBackup: import('./profile-backup-types').ProfileBackupApi
  productivity: import('./productivity-types').ProductivityDesktopApi
  tasks: import('./task-provider-types').TaskDesktopApi
  window: WindowControls
  onWindowState(callback: (maximized: boolean) => void): () => void
  onComposeCommand(callback: () => void): () => void
  mail: import('./mail-types').MailDesktopApi
  ai: import('./ai-assistant-types').AiAssistantApi
  networkProxy?: import('./network-proxy-types').NetworkProxyApi
  openPgp?: import('./openpgp-types').OpenPgpApi
  smime?: import('./smime-types').SmimeApi
  /** External automation through the local MCP bridge (E48). */
  mcp?: import('./mcp-types').McpAutomationApi
  spotlight?: import('./spotlight-types').SpotlightApi
  interchange: import('./interchange-types').InterchangeDesktopApi
  dav: import('./dav-types').DavDesktopApi
  /** Zoom and Webex meeting-host accounts (E47). */
  meetingHosts?: import('./meeting-host-types').MeetingHostApi
  /** On-premises Exchange (EWS) accounts; optional so test doubles of the API stay valid. */
  exchange?: import('./exchange-types').ExchangeDesktopApi
  /** Organization directory and offline address book (E41); optional so test doubles stay valid. */
  directory?: import('./directory-types').DirectoryDesktopApi
  /** Server-synchronized Notes (CalDAV VJOURNAL, Exchange Notes) and vNote import; optional for test doubles. */
  serverNotes?: import('./server-notes-types').ServerNotesDesktopApi
  /** Shared/delegated mailboxes, delegates, and public folders (E40). */
  mailboxOwners?: import('./mailbox-owner-types').MailboxOwnersApi
  contactMerge?: import('./contact-merge-types').ContactMergeDesktopApi
  /** Duplicate cleanup for mail, events, and tasks (E32). */
  duplicates?: import('./duplicate-cleanup-types').DuplicateCleanupApi
  /** Matrix chat; the Chat module still appears only when its gate passes. */
  chat?: import('./chat-types').ChatDesktopApi
}
