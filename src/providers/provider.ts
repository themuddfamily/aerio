import type { Account, AppState, DraftInput, Message } from '../types'

export interface MailProviderCapabilities {
  serverSearch: boolean
  scheduledSend: boolean
  contacts: boolean
  calendar: boolean
}

export interface MailProvider {
  readonly id: string
  readonly capabilities: MailProviderCapabilities
  connect(account: Account): Promise<void>
  synchronize(accountId: string): Promise<Partial<AppState>>
  send(draft: DraftInput): Promise<Message>
  applyMessageAction(messageIds: string[], action: string, value?: unknown): Promise<void>
}

export const demoProviderCapabilities: MailProviderCapabilities = {
  serverSearch: false,
  scheduledSend: true,
  contacts: true,
  calendar: true
}
