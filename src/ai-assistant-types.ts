import type { MailMessageRef, MailRuleInput } from './mail-types'

export type AiProviderId = 'anthropic' | 'openai-compatible'
export type AiSummaryScope = 'message' | 'conversation'
export type AiFeature = 'summarize' | 'compose' | 'replies' | 'search' | 'rules' | 'planning'

export const AI_FEATURES: AiFeature[] = ['summarize', 'compose', 'replies', 'search', 'rules', 'planning']
export const AI_DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5'
export const AI_DEFAULT_OPENAI_BASE_URL = 'http://localhost:11434/v1'

/** Shown in Settings and in every assistant dialog so the user knows exactly what leaves the computer. */
export const AI_FEATURE_DETAILS: Record<AiFeature, { label: string; sends: string }> = {
  summarize: { label: 'Summarize emails', sends: 'The email’s subject, date, and plain-text body (up to 12,000 characters). Sender name and address only when “Include sender details” is on. Never recipients, attachments, headers, or HTML.' },
  compose: { label: 'Draft and rephrase', sends: 'Your instruction, current draft and any saved writing style for the sending account. The email you are replying to is added only when you tick “Include the email I’m replying to”.' },
  replies: { label: 'Suggested replies', sends: 'The same email content as Summarize: subject, date, and plain-text body, plus sender details only when that option is on, and any saved writing style for the message account.' },
  search: { label: 'Natural-language search', sends: 'Only the words you type into the Ask AI search box. No email content is sent.' },
  rules: { label: 'Create mail rules', sends: 'Only your rule description and Aerio’s supported rule format. No emails, account details, folder list, or saved rules are sent. Folder names you type in the description are included.' },
  planning: { label: 'Detect tasks and events', sends: 'The displayed message’s subject, date and plain-text body, plus sender details only when enabled. Also the current date and your time zone. No recipients, attachments, HTML or other messages.' }
}

export interface AiAssistantStatus {
  enabled: boolean
  /** Explicit opt-in to sending displayed messages for reply suggestions. */
  automaticReplies?: boolean
  automaticPlanning?: boolean
  writingStyles?: Record<string, string>
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
  automaticReplies?: boolean
  automaticPlanning?: boolean
  writingStyles?: Record<string, string>
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
  accountId?: string
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
  summarize(requestId: string, ref: MailMessageRef, scope?: AiSummaryScope): Promise<string>
  suggestReplies(requestId: string, ref: MailMessageRef, automatic?: boolean): Promise<string[]>
  compose(requestId: string, input: AiComposeInput): Promise<string>
  learnStyle(requestId: string, sample: string): Promise<string>
  generateRule(requestId: string, input: { accountId: string; description: string }): Promise<MailRuleInput>
  detectPlanning(requestId: string, ref: MailMessageRef, timeZone: string): Promise<AiPlanningSuggestion[]>
  search(requestId: string, request: string): Promise<{ query: string }>
  cancel(requestId: string): Promise<boolean>
}

export type AiPlanningSuggestion = { kind: 'task'; title: string; notes: string; due?: string } | { kind: 'event'; title: string; notes: string; start: string; end: string }
