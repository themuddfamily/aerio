import type { MailMessageRef } from './mail-types'

// S/MIME mail (RFC 8551, CMS RFC 5652). Like OpenPGP, every private key and
// crypto operation stays in the main process; the renderer only sees
// certificate summaries, verification results, and decrypted content it asked
// for. A message uses S/MIME or OpenPGP, never both.

/** Per-draft S/MIME choices, stored with the draft and honored at delivery. */
export interface MailSmimeOptions {
  sign?: boolean
  encrypt?: boolean
  /** Lower-cased recipient address -> chosen certificate fingerprint (SHA-256 hex), when several match. */
  recipientCerts?: Record<string, string>
}

/** 'message' marks a certificate that came with a message and is not in your store. */
export type SmimeCertificateSource = 'own' | 'imported' | 'harvested' | 'message'

/** Path validation from the certificate up to a trust anchor. */
export type SmimeChainStatus = 'trusted' | 'untrusted-root' | 'incomplete' | 'invalid'

export interface SmimeChainEntry {
  subject: string
  issuer: string
  fingerprint: string
  validFrom: string
  validTo: string
  expired: boolean
  /** The operating system's bundled roots or a certificate you marked trusted. */
  trustAnchor: boolean
}

export interface SmimeKeyUsage {
  /** Undefined when the certificate has no key-usage extension (any use allowed). */
  digitalSignature?: boolean
  nonRepudiation?: boolean
  keyEncipherment?: boolean
  /** Extended key usage includes email protection (or no restriction is present). */
  emailProtection: boolean
}

export interface SmimeCertificateSummary {
  fingerprint: string
  subject: string
  commonName?: string
  issuer: string
  serialNumber: string
  emails: string[]
  algorithm: string
  validFrom: string
  validTo: string
  expired: boolean
  notYetValid: boolean
  isCa: boolean
  keyUsage: SmimeKeyUsage
  canSign: boolean
  canEncrypt: boolean
  hasPrivateKey: boolean
  unlocked: boolean
  source: SmimeCertificateSource
  /** You marked this certificate as trusted (as a root, or as an accepted leaf). */
  trusted: boolean
  chain: SmimeChainEntry[]
  chainStatus: SmimeChainStatus
  /** CRL and OCSP checks are not implemented. */
  revocation: 'not-checked'
}

export interface SmimeStatus {
  secureStorage: boolean
  locked: boolean
  certificates: SmimeCertificateSummary[]
}

export interface SmimeImportResult {
  imported: SmimeCertificateSummary[]
  /** A PKCS#12 file needs its password (or the password was wrong). */
  needsPassword?: boolean
  /** The PKCS#12 password is too short to protect the key here; choose a passphrase of at least 8 characters. */
  needsPassphrase?: boolean
  error?: string
}

export type SmimeRecipientStatus = 'ok' | 'missing' | 'expired' | 'untrusted' | 'unusable'

export interface SmimeRecipientCertificate {
  address: string
  status: SmimeRecipientStatus
  fingerprint?: string
  candidates: { fingerprint: string; subject: string; validTo: string; chainStatus: SmimeChainStatus; trusted: boolean }[]
}

export interface SmimePreflightInput {
  accountId: string
  fromIdentityId?: string
  recipients: string[]
  options: MailSmimeOptions
}

export interface SmimePreflight {
  ready: boolean
  problems: string[]
  /** Advice that does not block sending, such as an untrusted own certificate. */
  warnings: string[]
  from: string
  signer?: { fingerprint: string; subject: string; unlocked: boolean }
  recipients: SmimeRecipientCertificate[]
}

export type SmimeSignatureStatus = 'valid' | 'invalid' | 'unknown-certificate' | 'expired-certificate' | 'untrusted' | 'email-mismatch' | 'unsupported'

export interface SmimeSignatureResult {
  status: SmimeSignatureStatus
  signer?: SmimeCertificateSummary
  signedAt?: string
  detail?: string
  /** The signer's certificate was saved for encrypting replies. */
  harvested?: boolean
}

export type SmimeMessageKind = 'none' | 'signed' | 'signed-opaque' | 'encrypted'

export interface SmimeMessageStatus {
  kind: SmimeMessageKind
  signatures?: SmimeSignatureResult[]
  /** Recipients the message was encrypted to and whether one of your certificates matches. */
  encryptedTo?: { issuer: string; serialNumber: string; fingerprint?: string; available: boolean }[]
  /** The content encryption algorithm, e.g. AES-256-CBC. */
  algorithm?: string
  error?: string
}

export interface SmimeDecryptedAttachment {
  index: number
  filename: string
  mimeType: string
  size: number
}

export type SmimeDecryptResult =
  | { status: 'passphrase-required'; fingerprint: string; subject: string; error?: string }
  | { status: 'decrypted'; encrypted: boolean; text: string; sanitizedHtml?: string; attachments: SmimeDecryptedAttachment[]; signatures: SmimeSignatureResult[] }

export interface SmimeIdentityDefault {
  sign: boolean
  encrypt: boolean
}

export interface SmimeSender {
  accountId: string
  fromIdentityId?: string
}

export interface SmimeApi {
  status(): Promise<SmimeStatus>
  /** PKCS#12 (.p12/.pfx) for your own certificate, or .cer/.crt/.pem/.der for others. */
  importFile(): Promise<SmimeImportResult | undefined>
  /** Retries the file chosen last with its PKCS#12 password and, optionally, a separate passphrase for Aerio. */
  retryImport(password: string, passphrase?: string): Promise<SmimeImportResult>
  importText(pem: string): Promise<SmimeImportResult>
  exportCertificate(fingerprint: string): Promise<{ savedPath?: string }>
  /** Exports your certificate and private key as a password-protected PKCS#12 file. */
  exportPkcs12(fingerprint: string, passphrase: string, exportPassword: string): Promise<{ savedPath?: string }>
  delete(fingerprint: string): Promise<SmimeStatus>
  setTrusted(fingerprint: string, trusted: boolean): Promise<SmimeCertificateSummary>
  unlock(fingerprint: string, passphrase: string): Promise<SmimeCertificateSummary>
  forgetPassphrases(): Promise<void>
  preflight(input: SmimePreflightInput): Promise<SmimePreflight>
  /** The default S/MIME choice for new messages from this sender (account or alias). */
  identityDefault(sender: SmimeSender): Promise<SmimeIdentityDefault | undefined>
  setIdentityDefault(sender: SmimeSender, value: SmimeIdentityDefault | undefined): Promise<void>
  inspect(ref: MailMessageRef): Promise<SmimeMessageStatus>
  decrypt(ref: MailMessageRef, passphrase?: string): Promise<SmimeDecryptResult>
  saveAttachment(ref: MailMessageRef, index: number): Promise<{ savedPath?: string }>
}

/** Cheap renderer-side check so ordinary messages never trigger an S/MIME inspection. */
export function messageLooksSmime(message: { attachments: { filename: string; mimeType: string }[] }) {
  return message.attachments.some((item) => /^application\/(?:x-)?pkcs7-(?:signature|mime)$/i.test(item.mimeType) ||
    /\.p7[msc]$/i.test(item.filename) && /octet-stream|pkcs7/i.test(item.mimeType))
}
