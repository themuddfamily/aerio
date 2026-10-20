import type { MailActionKind } from './mail-types'
export type AiOrganizeAction = Extract<MailActionKind, 'read' | 'unread' | 'archive' | 'star' | 'unstar' | 'trash' | 'label' | 'move'>
export interface AiConversationScope { allowMail: boolean; accountIds: string[]; allowWeb: boolean }
export interface AiWebSource { id: string; title: string; url: string }
export interface AiConversationTarget { ref: string; accountId: string; accountName: string; threadId: string; subject: string }
export interface AiConversationFolder { ref: string; accountId: string; name: string }
export interface AiOrganizeProposal {
  id: string
  action: AiOrganizeAction
  targets: AiConversationTarget[]
  folders: AiConversationFolder[]
  destinationRef?: string
  expiresAt: string
  consumed?: boolean
}
export interface AiConversationMessage { id: string; role: 'user' | 'assistant'; text: string; sources?: AiWebSource[]; proposal?: AiOrganizeProposal }
export interface AiConversationState { id: string; messages: AiConversationMessage[]; scope: AiConversationScope }
export interface AiConversationTurnInput extends AiConversationScope { conversationId: string; message: string; publicSearchQuery?: string }
export interface AiOrganizeReview { proposalId: string; action: AiOrganizeAction; targetRefs: string[]; destinationRef?: string }
export interface AiOrganizeResult { appliedCount: number; errors: string[]; state: AiConversationState }
export interface AiConversationApi {
  state(): Promise<AiConversationState>
  clear(): Promise<AiConversationState>
  turn(requestId: string, input: AiConversationTurnInput): Promise<AiConversationState>
  apply(input: AiOrganizeReview): Promise<AiOrganizeResult>
}
