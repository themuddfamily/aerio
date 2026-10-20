export type Provider = 'google' | 'microsoft';
export interface Account { id: string; provider: Provider; subject: string; email: string; name: string; lastSync?: string; cursor?: string }
export interface Message { id: string; accountId: string; threadId?: string; internetMessageId?: string; from: string; replyTo: string; to: string; subject: string; preview: string; body: string; receivedAt: string; read: boolean; starred: boolean; inbox: boolean; attachmentNames: string[] }
export interface Draft { id: string; accountId: string; to: string; subject: string; body: string; inReplyTo?: string; threadId?: string; status: 'editing' | 'sending' | 'sent' | 'failed' | 'uncertain'; error?: string; updatedAt: string }
export type MailAction = { kind: 'read'; value: boolean } | { kind: 'star'; value: boolean } | { kind: 'archive' } | { kind: 'trash' };
export interface PendingAction { id: string; accountId: string; messageId: string; action: MailAction; state: 'pending' | 'running' | 'applied' | 'failed' | 'review'; error?: string }
export interface ClientSettings { googleIosClientId: string; googleWebClientId: string; microsoftClientId: string; microsoftTenant: string }
export interface MicrosoftCredential { accessToken: string; refreshToken?: string; expiresAt: number; clientId: string; tenant: string }
export interface Secrets { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> }
export interface MailProvider {
  profile(token: string, signal?: AbortSignal): Promise<{ subject: string; email: string; name: string }>;
  inbox(accountId: string, token: string, cursor?: string, signal?: AbortSignal): Promise<{ messages: Message[]; cursor?: string }>;
  action(token: string, messageId: string, action: MailAction, signal?: AbortSignal): Promise<void>;
  send(token: string, draft: Draft, from: string, signal?: AbortSignal): Promise<void>;
}
