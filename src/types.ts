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
  provider: 'gmail' | 'microsoft' | 'outlook' | 'imap'
}

export interface Attachment {
  id: string
  name: string
  size: number
  path?: string
  mime?: string
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
  recurrence?: 'none' | 'daily' | 'weekly' | 'monthly'
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
}

export interface Note {
  id: string
  folder: string
  title: string
  content: string
  tags: string[]
  pinned: boolean
  archived: boolean
  updatedAt: string
  color?: string
}

export interface Settings {
  theme: ThemePreference
  density: DensityPreference
  closeToTray: boolean
  launchAtLogin?: boolean
  notifications: boolean
  startModule: ModuleId
  profile?: UserProfile
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

export interface AerioDesktopApi {
  loadPreferences(): Promise<AppPreferences>
  savePreferences(preferences: AppPreferences): Promise<{ savedAt: string }>
  chooseAttachments(): Promise<Attachment[]>
  chooseProfileImage(): Promise<string | undefined>
  notify(title: string, body: string): Promise<void>
  updates: AppUpdateControls
  productivity: import('./productivity-types').ProductivityDesktopApi
  window: WindowControls
  onWindowState(callback: (maximized: boolean) => void): () => void
  onComposeCommand(callback: () => void): () => void
  mail: import('./mail-types').MailDesktopApi
}
