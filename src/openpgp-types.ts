import type { MailMessageRef } from './mail-types'

// OpenPGP mail (PGP/MIME, RFC 3156). All key material and every crypto
// operation stay in the main process; the renderer only sees summaries,
// verification results, and decrypted content it asked for explicitly.

/** Per-draft OpenPGP choices, stored with the draft and honored at delivery. */
export interface MailOpenPgpOptions {
  sign?: boolean
  encrypt?: boolean
  /** Lower-cased recipient address -> chosen key fingerprint, when several keys match. */
  recipientKeys?: Record<string, string>
}

export type OpenPgpVerificationState = 'unverified' | 'verified'

export interface OpenPgpKeySummary {
  fingerprint: string
  keyId: string
  userIds: string[]
  emails: string[]
  algorithm: string
  createdAt: string
  /** ISO time, or undefined when the key never expires. */
  expiresAt?: string
  expired: boolean
  revoked: boolean
  hasPrivateKey: boolean
  canEncrypt: boolean
  canSign: boolean
  /** Manual fingerprint verification recorded by the user. */
  verification: OpenPgpVerificationState
  /** A decrypted copy of the private key is cached in memory until lock or timeout. */
  unlocked: boolean
}

export interface OpenPgpStatus {
  secureStorage: boolean
  locked: boolean
  keys: OpenPgpKeySummary[]
}

export interface OpenPgpGenerateInput {
  name: string
  email: string
  passphrase: string
  /** 0 or omitted means the key does not expire. */
  expiresInDays?: number
}

export interface OpenPgpImportResult {
  imported: OpenPgpKeySummary[]
  /** Secret keys that arrived without a passphrase need one before they are stored. */
  needsPassphrase?: boolean
}

export type OpenPgpRecipientKeyStatus = 'ok' | 'missing' | 'expired' | 'revoked' | 'unusable'

export interface OpenPgpRecipientKey {
  address: string
  status: OpenPgpRecipientKeyStatus
  fingerprint?: string
  verification?: OpenPgpVerificationState
  /** Every usable key for this address, so the composer can offer a choice. */
  candidates: { fingerprint: string; userId: string; verification: OpenPgpVerificationState }[]
}

export interface OpenPgpPreflightInput {
  accountId: string
  fromIdentityId?: string
  recipients: string[]
  options: MailOpenPgpOptions
}

export interface OpenPgpPreflight {
  ready: boolean
  /** Human-readable reasons the message cannot be signed or encrypted yet. */
  problems: string[]
  from: string
  signer?: { fingerprint: string; userId: string; unlocked: boolean }
  recipients: OpenPgpRecipientKey[]
}

export type OpenPgpSignatureStatus = 'valid' | 'invalid' | 'unknown-key' | 'expired-key' | 'revoked-key'

export interface OpenPgpSignatureResult {
  status: OpenPgpSignatureStatus
  keyId: string
  fingerprint?: string
  userIds?: string[]
  verification?: OpenPgpVerificationState
  signedAt?: string
  detail?: string
}

export type OpenPgpMessageKind = 'none' | 'signed' | 'encrypted' | 'inline-signed' | 'inline-encrypted'

export interface OpenPgpMessageStatus {
  kind: OpenPgpMessageKind
  /** Signature results for signed messages (verified without any secret key). */
  signatures?: OpenPgpSignatureResult[]
  /** Key ids the message was encrypted to and whether a matching secret key exists. */
  encryptedTo?: { keyId: string; fingerprint?: string; available: boolean }[]
  error?: string
}

export interface OpenPgpDecryptedAttachment {
  index: number
  filename: string
  mimeType: string
  size: number
}

export type OpenPgpDecryptResult =
  | { status: 'passphrase-required'; fingerprint: string; userId: string; error?: string }
  | { status: 'decrypted'; text: string; sanitizedHtml?: string; attachments: OpenPgpDecryptedAttachment[]; signatures: OpenPgpSignatureResult[] }

export interface OpenPgpApi {
  status(): Promise<OpenPgpStatus>
  generate(input: OpenPgpGenerateInput): Promise<OpenPgpKeySummary>
  importText(armored: string, passphrase?: string): Promise<OpenPgpImportResult>
  importFile(passphrase?: string): Promise<OpenPgpImportResult | undefined>
  exportPublic(fingerprint: string): Promise<{ savedPath?: string }>
  exportPrivate(fingerprint: string, passphrase: string): Promise<{ savedPath?: string }>
  delete(fingerprint: string): Promise<OpenPgpStatus>
  setVerification(fingerprint: string, state: OpenPgpVerificationState): Promise<OpenPgpKeySummary>
  unlock(fingerprint: string, passphrase: string): Promise<OpenPgpKeySummary>
  forgetPassphrases(): Promise<void>
  preflight(input: OpenPgpPreflightInput): Promise<OpenPgpPreflight>
  inspect(ref: MailMessageRef): Promise<OpenPgpMessageStatus>
  decrypt(ref: MailMessageRef, passphrase?: string): Promise<OpenPgpDecryptResult>
  saveAttachment(ref: MailMessageRef, index: number): Promise<{ savedPath?: string }>
}

export const OPENPGP_PASSPHRASE_CACHE_MS = 10 * 60_000

/** Cheap renderer-side check so ordinary messages never trigger an OpenPGP inspection. */
export function messageLooksOpenPgp(message: { text: string; attachments: { filename: string; mimeType: string }[] }) {
  if (/-----BEGIN PGP (?:SIGNED )?MESSAGE-----/.test(message.text)) return true
  return message.attachments.some((item) => /^application\/pgp-(?:signature|encrypted)$/i.test(item.mimeType) ||
    /\.(?:asc|sig|pgp|gpg)$/i.test(item.filename) && /octet-stream|pgp/i.test(item.mimeType))
}
