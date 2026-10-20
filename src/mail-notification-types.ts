export type MailNotificationAction = 'open' | 'read' | 'archive' | 'star' | 'trash'
export interface MailNotificationPreferences {
  actions: MailNotificationAction[]
  preview: 'subject' | 'sender' | 'hidden'
  silent: boolean
  onlyWhenUnfocused: boolean
  quietHours: { enabled: boolean; start: string; end: string }
  /** Missing account entries inherit the account's own notifications switch. */
  accounts: Record<string, boolean>
  /** Undefined permits all current and future categories; [] permits none. */
  categories?: string[]
}
export interface MailNotificationPayload {
  accountId: string
  count: number
  threadId?: string
  subject?: string
  sender?: string
  category?: string
}
