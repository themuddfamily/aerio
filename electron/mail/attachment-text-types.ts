import type { MailAttachmentTextStatus } from '../../src/mail-types'

/** Final extraction states; `pending` only exists before an attachment is processed. */
export type AttachmentTextOutcome = Exclude<MailAttachmentTextStatus, 'pending'>

export interface AttachmentTextResult {
  status: AttachmentTextOutcome
  text: string
  truncated: boolean
  detail?: string
}

export interface AttachmentTextInput {
  filename: string
  mimeType: string
  content: Buffer
}

/**
 * Bounds for one attachment. Parsers run in an isolated worker with its own
 * heap limit and timeout as well, so these are the first line of defence
 * against oversized or decompression-bomb attachments, not the only one.
 */
export interface AttachmentTextLimits {
  /** Attachments larger than this are recorded as too large without parsing. */
  maxInputBytes: number
  /** Extracted text beyond this many characters is dropped and the result is marked truncated. */
  maxTextChars: number
  /** Total bytes a parser may inflate from zip entries or PDF streams. */
  maxExpandedBytes: number
  /** Archives with more entries than this are rejected. */
  maxZipEntries: number
}

export const DEFAULT_ATTACHMENT_TEXT_LIMITS: AttachmentTextLimits = {
  maxInputBytes: 25 * 1024 * 1024,
  maxTextChars: 200_000,
  maxExpandedBytes: 64 * 1024 * 1024,
  maxZipEntries: 5_000
}

/**
 * Bump when an extractor improves so stored results are re-extracted. Rows
 * written by an older version are treated as pending by the indexer.
 */
export const ATTACHMENT_TEXT_EXTRACTOR_VERSION = 1

/** Thrown by parsers for an expected, user-explainable outcome. */
export class AttachmentTextError extends Error {
  constructor(readonly status: Exclude<AttachmentTextOutcome, 'indexed' | 'empty' | 'timeout' | 'memory-limit'>, message: string) {
    super(message)
  }
}

/** Collects extracted text up to a character budget. */
export class TextBudget {
  private parts: string[] = []
  private used = 0
  truncated = false

  constructor(private readonly maxChars: number) {}

  /** Appends text; returns false once text had to be dropped. */
  push(value: string) {
    if (!value || this.truncated) return !this.truncated
    const room = this.maxChars - this.used
    if (value.length > room) {
      if (room > 0) this.parts.push(value.slice(0, room))
      this.used = this.maxChars
      // Separators after the last kept character don't lose any searchable text.
      if (value.slice(Math.max(0, room)).trim()) this.truncated = true
      return !this.truncated
    }
    this.parts.push(value)
    this.used += value.length
    return true
  }

  text() {
    return this.parts.join('').replaceAll(/[ \t\f\v ]+/g, ' ').replaceAll(/\s*\n\s*/g, '\n').trim()
  }
}
