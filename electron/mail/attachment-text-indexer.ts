// Background pipeline that keeps extracted attachment text in the search
// index. It works incrementally from the database: every attachment without a
// result from the current extractor version is pending, so new mail, upgraded
// extractors, and interrupted runs all resume from the same query.
import { attachmentTextKind } from './attachment-text-extract'
import type { AttachmentTextStore, PendingAttachment } from './attachment-text-store'
import { DEFAULT_ATTACHMENT_TEXT_LIMITS, type AttachmentTextInput, type AttachmentTextResult } from './attachment-text-types'

export interface AttachmentIndexerOptions {
  store: AttachmentTextStore
  /** Returns every attachment's bytes for one message by attachment id, or undefined when the raw message is gone. */
  readAttachments: (accountId: string, messageId: string) => Promise<Map<string, Buffer> | undefined>
  extract: (input: AttachmentTextInput, signal: AbortSignal) => Promise<AttachmentTextResult>
  batchSize?: number
  maxInputBytes?: number
  onError?: (error: unknown) => void
}

const isCancellation = (error: unknown) => error instanceof Error && error.name === 'AbortError'
const yieldToEvents = () => new Promise<void>((resolve) => setImmediate(resolve))

export class AttachmentContentIndexer {
  private running?: Promise<void>
  private rerun = false
  private stopped = false
  private readonly cancelled = new Set<string>()
  private current?: { accountId: string; controller: AbortController }
  private readonly batchSize: number
  private readonly maxInputBytes: number

  constructor(private readonly options: AttachmentIndexerOptions) {
    this.batchSize = options.batchSize ?? 25
    this.maxInputBytes = options.maxInputBytes ?? DEFAULT_ATTACHMENT_TEXT_LIMITS.maxInputBytes
  }

  /** Starts a run, or asks the current run to look for new work before it finishes. */
  schedule() {
    if (this.stopped) return
    if (this.running) {
      this.rerun = true
      return
    }
    this.running = this.loop().finally(() => {
      this.running = undefined
      if (this.rerun && !this.stopped) this.schedule()
    })
  }

  /** Resolves once no run is in progress. */
  async idle() {
    while (this.running) await this.running
  }

  /** Cancels in-flight work for an account and skips it until resumed, e.g. while it is deleted. */
  cancelAccount(accountId: string) {
    this.cancelled.add(accountId)
    if (this.current?.accountId === accountId) this.current.controller.abort()
  }

  resumeAccount(accountId: string) {
    if (this.cancelled.delete(accountId)) this.schedule()
  }

  /** Cancels everything; the indexer can't be restarted afterwards. */
  async stop() {
    this.stopped = true
    this.current?.controller.abort()
    await this.idle()
  }

  private active(accountId: string) {
    return !this.stopped && !this.cancelled.has(accountId)
  }

  private async loop() {
    while (!this.stopped) {
      this.rerun = false
      const batch = this.options.store.pending(this.batchSize, this.cancelled)
      if (!batch.length) return
      const messages = new Map<string, PendingAttachment[]>()
      for (const attachment of batch) {
        const key = JSON.stringify([attachment.accountId, attachment.messageId])
        messages.set(key, [...messages.get(key) ?? [], attachment])
      }
      let progressed = false
      for (const attachments of messages.values()) {
        if (!this.active(attachments[0].accountId)) continue
        try {
          if (await this.indexMessage(attachments)) progressed = true
        } catch (error) {
          if (this.stopped) return
          if (!isCancellation(error)) this.options.onError?.(error)
        }
        await yieldToEvents()
      }
      // A batch where nothing could be saved would come back unchanged; wait for the next schedule instead.
      if (!progressed) return
    }
  }

  private async indexMessage(attachments: PendingAttachment[]) {
    const { store } = this.options
    const { accountId, messageId } = attachments[0]
    let saved = false
    const record = (attachment: PendingAttachment, result: AttachmentTextResult) => {
      if (!this.active(accountId)) return
      if (store.save(attachment, result)) saved = true
    }
    // Unsupported and oversized files are recorded without reading the message at all.
    const readable = attachments.filter((attachment) => {
      if (!attachmentTextKind(attachment.filename, attachment.mimeType)) {
        record(attachment, { status: 'unsupported', text: '', truncated: false, detail: 'This file type is not searchable' })
        return false
      }
      if (attachment.size > this.maxInputBytes) {
        record(attachment, { status: 'too-large', text: '', truncated: false, detail: 'The attachment is larger than the indexing limit' })
        return false
      }
      return true
    })
    if (readable.length) {
      const contents = await this.options.readAttachments(accountId, messageId).catch(() => undefined)
      for (const attachment of readable) {
        if (!this.active(accountId)) break
        const content = contents?.get(attachment.attachmentId)
        if (!content) {
          record(attachment, { status: 'failed', text: '', truncated: false, detail: 'The attachment is not available offline' })
          continue
        }
        const controller = new AbortController()
        this.current = { accountId, controller }
        try {
          const result = await this.options.extract({ filename: attachment.filename, mimeType: attachment.mimeType, content }, controller.signal)
          record(attachment, result)
        } finally {
          this.current = undefined
        }
      }
    }
    if (saved && this.active(accountId)) store.refreshSearch(accountId, messageId)
    return saved
  }
}
