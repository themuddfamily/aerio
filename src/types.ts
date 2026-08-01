export type ModuleId = 'mail' | 'calendar' | 'contacts' | 'tasks' | 'notes' | 'chat'
export type ThemePreference = 'system' | 'light' | 'dark'
export type DensityPreference = 'comfortable' | 'compact'

export interface Account {
  id: string
  name: string
  email: string
  initials: string
  color: string
  provider: 'demo' | 'gmail' | 'outlook' | 'imap'
}

export interface Folder {
  id: string
  accountId: string
  name: string
  icon?: string
  system?: 'inbox' | 'drafts' | 'sent' | 'archive' | 'trash' | 'spam'
}

export interface Attachment {
  id: string
  name: string
  size: number
  path?: string
  mime?: string
}

export interface Message {
  id: string
  threadId: string
  accountId: string
  folderId: string
  from: string
  fromEmail: string
  to: string[]
  cc?: string[]
  subject: string
  preview: string
  body: string
  date: string
  unread: boolean
  starred: boolean
  flagged: boolean
  labels: string[]
  attachments: Attachment[]
  draft?: boolean
  sent?: boolean
  archived?: boolean
  trashed?: boolean
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

export interface ChatMessage {
  id: string
  sender: 'me' | 'them'
  text: string
  time: string
  reaction?: string
  attachment?: Attachment
}

export interface Conversation {
  id: string
  name: string
  participants: string[]
  color: string
  online: boolean
  unread: number
  messages: ChatMessage[]
}

export interface Settings {
  theme: ThemePreference
  density: DensityPreference
  closeToTray: boolean
  notifications: boolean
  startModule: ModuleId
  signature: string
}

export interface AppState {
  schemaVersion: number
  accounts: Account[]
  folders: Folder[]
  messages: Message[]
  events: CalendarEvent[]
  contacts: Contact[]
  tasks: Task[]
  notes: Note[]
  conversations: Conversation[]
  settings: Settings
}

export interface DraftInput {
  accountId: string
  to: string[]
  cc: string[]
  subject: string
  body: string
  attachments: Attachment[]
  replyToThreadId?: string
}

export interface WindowControls {
  minimize(): Promise<void>
  maximize(): Promise<void>
  close(): Promise<void>
  isMaximized(): Promise<boolean>
}

export interface AerioDesktopApi {
  loadState(): Promise<AppState>
  saveState(state: AppState): Promise<{ savedAt: string }>
  resetState(): Promise<AppState>
  chooseAttachments(): Promise<Attachment[]>
  notify(title: string, body: string): Promise<void>
  window: WindowControls
  onWindowState(callback: (maximized: boolean) => void): () => void
  onComposeCommand(callback: () => void): () => void
  mail: import('./gmail-types').MailDesktopApi
}
