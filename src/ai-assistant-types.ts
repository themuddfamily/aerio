import type { MailMessageRef } from './mail-types'

export type AiProviderId = 'anthropic' | 'openai-compatible'
export type AiFeature = 'summarize' | 'compose' | 'replies' | 'search'

export const AI_FEATURES: AiFeature[] = ['summarize', 'compose', 'replies', 'search']
export const AI_DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5'
export const AI_DEFAULT_OPENAI_BASE_URL = 'http://localhost:11434/v1'

/** Shown in Settings and in every assistant dialog so the user knows exactly what leaves the computer. */
export const AI_FEATURE_DETAILS: Record<AiFeature, { label: string; sends: string }> = {
  summarize: { label: 'Summarize emails', sends: 'The email’s subject, date, and plain-text body (up to 12,000 characters). Sender name and address only when “Include sender details” is on. Never recipients, attachments, headers, or HTML.' },
  compose: { label: 'Draft and rephrase', sends: 'Your instruction and the text currently in the composer. The email you are replying to is added only when you tick “Include the email I’m replying to”.' },
  replies: { label: 'Suggested replies', sends: 'The same email content as Summarize: subject, date, and plain-text body, plus sender details only when that option is on.' },
  search: { label: 'Natural-language search', sends: 'Only the words you type into the Ask AI search box. No email content is sent.' }
}

export interface AiAssistantStatus {
  enabled: boolean
  provider: AiProviderId
  model: string
  /** Used by the OpenAI-compatible provider only. */
  baseUrl: string
  hasApiKey: boolean
  features: Record<AiFeature, boolean>
  includeSenderDetails: boolean
  /** False when the operating system cannot encrypt the API key; keys cannot be saved then. */
  secureStorage: boolean
}

export interface AiAssistantSettingsInput {
  enabled: boolean
  provider: AiProviderId
  model: string
  baseUrl: string
  features: Record<AiFeature, boolean>
  includeSenderDetails: boolean
  /** A new API key. Omit or leave empty to keep the stored key. */
  apiKey?: string
  clearApiKey?: boolean
}

export interface AiComposeInput {
  instruction: string
  draft: string
  /** Optional email to give the model as untrusted context. */
  replyTo?: MailMessageRef
}

/**
 * Every call returns preview text only. Nothing here can send, save, or change
 * mail; applying a result always needs a separate, explicit user action.
 * `requestId` lets the renderer cancel an in-flight request.
 */
export interface AiAssistantApi {
  status(): Promise<AiAssistantStatus>
  configure(input: AiAssistantSettingsInput): Promise<AiAssistantStatus>
  summarize(requestId: string, ref: MailMessageRef): Promise<string>
  suggestReplies(requestId: string, ref: MailMessageRef): Promise<string[]>
  compose(requestId: string, input: AiComposeInput): Promise<string>
  search(requestId: string, request: string): Promise<{ query: string }>
  cancel(requestId: string): Promise<boolean>
}
