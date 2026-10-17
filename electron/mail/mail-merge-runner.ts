import type { MailDraftInput } from '../../src/mail-types'
import type { MailMergeJob, MailMergeJobSummary, MailMergeRecipient } from '../../src/mail-merge-types'
import { mergeRecipientAddress, renderMergeMessage } from '../../src/lib/mail-merge'
import { MAIL_MERGE_DAY_MS, type MailMergeStore } from './mail-merge-store'

/**
 * Thrown by a transport for problems found before anything reached the
 * provider (missing credentials, a sender the account may not use), so the
 * recipient can safely stay in the queue.
 */
export class MailMergeNotSubmittedError extends Error {
  constructor(readonly original: unknown) {
    super(original instanceof Error ? original.message : String(original))
    this.name = 'MailMergeNotSubmittedError'
  }
}

export type MailMergeSendOutcome =
  /** Definitely not accepted; retry later. */
  | 'rate-limited'
  /** Definitely not accepted; every later delivery would fail the same way. */
  | 'not-submitted'
  /** The provider refused this message; it was not delivered. */
  | 'rejected'
  /** Unknown: the provider may have accepted it. */
  | 'ambiguous'

const RATE_TEXT = /rate.?limit|too many|quota|throttl|try again later|sending limit|daily.?limit|exceeded/i
const AUTH_TEXT = /auth|credential|token|sign in|reconnect/i

/**
 * Classifies a send error. Only errors that prove the provider refused the
 * submission count as safe; anything else (timeouts, dropped connections,
 * server errors after submission) is `ambiguous` and needs a person.
 */
export function classifyMergeSendError(error: unknown): MailMergeSendOutcome {
  if (error instanceof MailMergeNotSubmittedError) return 'not-submitted'
  const value = (error ?? {}) as { status?: unknown; responseCode?: unknown; code?: unknown; reason?: unknown; message?: unknown }
  const text = `${typeof value.message === 'string' ? value.message : ''} ${typeof value.reason === 'string' ? value.reason : ''} ${typeof value.code === 'string' ? value.code : ''}`
  if (typeof value.status === 'number') {
    const status = value.status
    if (status === 429 || (status === 403 && RATE_TEXT.test(text))) return 'rate-limited'
    if (status === 401) return 'not-submitted'
    if (status >= 400 && status < 500 && status !== 408) return 'rejected'
    return 'ambiguous'
  }
  if (typeof value.responseCode === 'number') {
    const code = value.responseCode
    // 4xx SMTP replies are temporary refusals; nothing was accepted.
    if (code >= 400 && code < 500) return 'rate-limited'
    if (code === 530 || code === 534 || code === 535) return 'not-submitted'
    if (code >= 500 && code < 600) return RATE_TEXT.test(text) ? 'rate-limited' : 'rejected'
    return 'ambiguous'
  }
  if (value.code === 'EAUTH') return 'not-submitted'
  if (value.code === 'EENVELOPE') return 'rejected'
  return 'ambiguous'
}

/** One delivery: exactly one To recipient, never Cc or Bcc, so no address list is exposed. */
export function buildMergeDelivery(job: Pick<MailMergeJob, 'id' | 'accountId' | 'subject' | 'text' | 'html' | 'attachmentPaths' | 'fromIdentityId' | 'replyTo' | 'sendOptions'>, recipient: MailMergeRecipient): MailDraftInput {
  const rendered = renderMergeMessage(job, recipient)
  const delivery: MailDraftInput = {
    id: `merge-${job.id}-${recipient.position}`,
    accountId: job.accountId,
    references: [],
    to: [mergeRecipientAddress(recipient)],
    cc: [],
    bcc: [],
    subject: rendered.subject,
    text: rendered.text,
    ...(rendered.html !== undefined ? { html: rendered.html } : {}),
    attachmentPaths: [...job.attachmentPaths],
    ...(job.fromIdentityId ? { fromIdentityId: job.fromIdentityId } : {}),
    ...(job.replyTo?.length ? { replyTo: [...job.replyTo] } : {}),
    ...(job.sendOptions ? { sendOptions: job.sendOptions } : {})
  }
  if (delivery.to.length !== 1 || delivery.cc.length || delivery.bcc.length) throw new Error('A mail merge delivery must have exactly one recipient')
  return delivery
}

export interface MailMergeRunnerOptions {
  store: MailMergeStore
  /** Hands one message to the provider; resolves when the provider accepted it. */
  send(delivery: MailDraftInput): Promise<{ messageIdHeader?: string } | void>
  online(): boolean
  emit(summary: MailMergeJobSummary): void
  now?(): number
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
const BACKOFF_BASE_MS = 60_000
const BACKOFF_MAX_MS = 60 * 60_000

/**
 * Sends merge deliveries one at a time across all jobs. Each tick sends at
 * most one message, honouring the job's per-minute throttle, the account's
 * rolling 24-hour cap, and exponential back-off after rate-limit replies.
 */
export class MailMergeRunner {
  private busy = false
  constructor(private readonly options: MailMergeRunnerOptions) {}

  private now() {
    return this.options.now?.() ?? Date.now()
  }

  private emit(jobId: string) {
    const summary = this.options.store.summary(jobId)
    if (summary) this.options.emit(summary)
  }

  /** Returns true when a delivery was attempted. */
  async tick(): Promise<boolean> {
    if (this.busy || !this.options.online()) return false
    this.busy = true
    try {
      const store = this.options.store
      const at = new Date(this.now()).toISOString()
      for (const due of store.dueJobs(at)) {
        const windowStart = new Date(this.now() - MAIL_MERGE_DAY_MS).toISOString()
        const sent = store.sentSince(due.accountId, windowStart)
        if (sent.count >= due.limits.dailyCap) {
          const until = new Date(Date.parse(sent.oldest ?? at) + MAIL_MERGE_DAY_MS).toISOString()
          store.defer(due.id, until, `Daily limit of ${due.limits.dailyCap.toLocaleString('en-US')} reached for this account; sending resumes automatically`, at)
          this.emit(due.id)
          continue
        }
        const recipient = store.nextPending(due.id)
        if (!recipient) continue
        const job = store.get(due.id)
        if (!job) continue
        let delivery: MailDraftInput
        try {
          delivery = buildMergeDelivery(job, recipient)
        } catch (error) {
          if (store.claim(job.id, recipient.position, at)) store.markFailed(job.id, recipient.position, errorMessage(error), at)
          this.emit(job.id)
          return true
        }
        // Durable before submission: a crash from here on leaves the row `sending`, which restarts as ambiguous.
        if (!store.claim(job.id, recipient.position, at)) continue
        this.emit(job.id)
        await this.deliver(job, recipient, delivery)
        this.emit(job.id)
        return true
      }
      return false
    } finally {
      this.busy = false
    }
  }

  private async deliver(job: MailMergeJob, recipient: MailMergeRecipient, delivery: MailDraftInput) {
    const store = this.options.store
    try {
      const result = await this.options.send(delivery)
      store.markSent(job.id, recipient.position, result ? result.messageIdHeader : undefined, new Date(this.now()).toISOString())
    } catch (error) {
      const at = new Date(this.now()).toISOString()
      const message = errorMessage(error)
      const outcome = classifyMergeSendError(error)
      if (outcome === 'rate-limited') {
        const delayMs = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** store.backoffCount(job.id))
        store.requeue(job.id, recipient.position, `The provider asked Aerio to slow down: ${message}`, { delayMs }, at)
      } else if (outcome === 'not-submitted') {
        store.requeue(job.id, recipient.position, message, { pauseReason: AUTH_TEXT.test(message) ? `Reconnect this account, then resume: ${message}` : message }, at)
      } else if (outcome === 'rejected') {
        store.markFailed(job.id, recipient.position, message, at)
      } else {
        store.markAmbiguous(job.id, recipient.position, `The send outcome is unknown: ${message}`, at)
      }
    }
  }
}
