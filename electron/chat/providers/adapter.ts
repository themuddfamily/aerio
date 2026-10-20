import type { ProviderChatAccount, ProviderChatDescriptor, ProviderChatMessage, ProviderChatPage, ProviderChatRoom } from '../../../src/provider-chat-types'

export type ProviderChatSecret = Record<string, string>
export interface ProviderChatSession { account: ProviderChatAccount; secret: ProviderChatSecret }
export interface ProviderChatConnection { remoteUserId: string; name: string; secret: ProviderChatSecret }
/** Adapters implement only documented provider APIs; runtime owns encryption, IPC, lock and delivery state. */
export interface ProviderChatAdapter {
  descriptor(): ProviderChatDescriptor
  connect(input: Record<string, string | boolean>, existing?: ProviderChatSession): Promise<ProviderChatConnection>
  rooms(session: ProviderChatSession): Promise<ProviderChatRoom[]>
  messages(session: ProviderChatSession, room: ProviderChatRoom, options: { cursor?: string; threadId?: string }): Promise<ProviderChatPage>
  send(session: ProviderChatSession, room: ProviderChatRoom, body: string, threadId?: string, clientRequestId?: string): Promise<ProviderChatMessage>
  markRead?(session: ProviderChatSession, room: ProviderChatRoom): Promise<void>
  disconnect?(session: ProviderChatSession): Promise<void>
}
export class ProviderChatError extends Error {
  constructor(message: string, readonly kind: 'auth' | 'permission' | 'rate-limit' | 'network' | 'rejected' | 'uncertain', readonly retryAfter?: number) { super(message) }
}
