// Personalized mass mail (mail merge). One job expands a message into one
// delivery per recipient; each delivery has exactly one To address and no
// Cc/Bcc, so recipients never see each other. Per-recipient state is durable
// so a relaunch resumes without sending anyone the same message twice.

import type { MailSendOptions } from './mail-types'

/**
 * `pending`: waiting to send. `sending`: handed to the provider; if Aerio stops
 * now the outcome is unknown. `ambiguous`: the provider may or may not have
 * accepted it (crash, timeout, or connection loss during submission); never
 * retried automatically. `failed`: the provider rejected it. `skipped` and
 * `cancelled` were never sent.
 */
export type MailMergeRecipientStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'ambiguous' | 'skipped' | 'cancelled'

/**
 * `needs-review`: at least one recipient is ambiguous; nothing else is sent
 * until each is resolved. `paused`: stopped by the user or by an account
 * problem (see `lastError`).
 */
export type MailMergeJobStatus = 'running' | 'paused' | 'needs-review' | 'completed' | 'cancelled'

export interface MailMergeRecipientInput {
  email: string
  name?: string
  firstName?: string
  lastName?: string
  company?: string
  /** Extra variables, e.g. custom CSV columns. Keys are matched case- and punctuation-insensitively. */
  fields?: Record<string, string>
}

export interface MailMergeRecipient extends MailMergeRecipientInput {
  position: number
  status: MailMergeRecipientStatus
  attempts: number
  error?: string
  sentAt?: string
  updatedAt: string
}

export interface MailMergeLimits {
  perMinute: number
  dailyCap: number
}

/** The message every recipient receives, before variables are substituted. */
export interface MailMergeMessageInput {
  accountId: string
  fromIdentityId?: string
  replyTo?: string[]
  subject: string
  text: string
  html?: string
  attachmentPaths: string[]
  sendOptions?: MailSendOptions
}

export interface MailMergeJobInput extends MailMergeMessageInput {
  name?: string
  recipients: MailMergeRecipientInput[]
  limits: MailMergeLimits
}

export type MailMergeCounts = Record<MailMergeRecipientStatus, number>

export interface MailMergeJobSummary {
  id: string
  accountId: string
  name: string
  subject: string
  status: MailMergeJobStatus
  limits: MailMergeLimits
  counts: MailMergeCounts
  total: number
  /** When the next delivery may start (throttle, daily cap, or rate-limit back-off). */
  nextAttemptAt?: string
  lastError?: string
  createdAt: string
  updatedAt: string
}

export interface MailMergeJob extends MailMergeJobSummary, MailMergeMessageInput {
  recipients: MailMergeRecipient[]
}

/** `resend` re-queues an ambiguous or failed recipient; `skip` never sends to it. */
export type MailMergeResolution = 'resend' | 'skip'

export interface MailMergeApi {
  list(): Promise<MailMergeJobSummary[]>
  get(id: string): Promise<MailMergeJob | undefined>
  create(input: MailMergeJobInput): Promise<MailMergeJob>
  pause(id: string): Promise<MailMergeJobSummary>
  resume(id: string): Promise<MailMergeJobSummary>
  cancel(id: string): Promise<MailMergeJobSummary>
  resolve(id: string, positions: number[], resolution: MailMergeResolution): Promise<MailMergeJob>
  delete(id: string): Promise<void>
}
