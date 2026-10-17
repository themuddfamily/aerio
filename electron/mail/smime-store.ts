import { createPrivateKey, type KeyObject } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import PostalMime from 'postal-mime'
import type {
  MailSmimeOptions,
  SmimeCertificateSource,
  SmimeCertificateSummary,
  SmimeIdentityDefault,
  SmimeImportResult,
  SmimeMessageStatus,
  SmimeRecipientCertificate,
  SmimeSignatureResult
} from '../../src/smime-types'
import { OPENPGP_PASSPHRASE_CACHE_MS } from '../../src/openpgp-types'
import { assertSecureCredentialStorage } from './secure-storage'
import { addressEmail, NOT_SENT, validatePassphrase, type OpenPgpKeyStorage } from './openpgp-keyring'
import { headerValue, parseEntity, splitForProtection } from './openpgp-mime'
import {
  canEncryptTo, canSignMail, chainEntries, isExpired, isNotYetValid, keyUsageSummary, parseCertificate, Pkcs12PasswordError,
  readCertificates, readPkcs12, systemRootCertificates, validateChain, writePkcs12, type ParsedCertificate
} from './smime-certificate'
import { contentInfo, decryptEnveloped, encryptEnveloped, envelopedInfo, parseSignedData, recipientMatches, signDetached, signerMatches, verifySigner, type SignedDataInfo } from './smime-cms'
import { assembleSmimeMessage, buildEnvelopedEntity, buildSignedEntity, detectSmime, entityText } from './smime-mime'
import { OID } from './smime-der'

// The S/MIME certificate store. Private keys are kept only as
// passphrase-encrypted PKCS#8, and the whole file is additionally wrapped with
// OS secure storage (Electron safeStorage), like the OpenPGP keyring. It is
// not in the profile-backup allowlist: keys leave only as an explicit,
// password-protected PKCS#12 export.

interface StoredCertificate {
  fingerprint: string
  /** Base64 DER. */
  der: string
  /** PEM "ENCRYPTED PRIVATE KEY" (PKCS#8, AES-256-CBC). */
  privateKey?: string
  /** Base64 DER intermediates that came with the certificate. */
  chain?: string[]
  source: SmimeCertificateSource
  trusted: boolean
  addedAt: string
}

export interface SmimeStoreOptions {
  storage: OpenPgpKeyStorage
  isLocked?: () => boolean
  now?: () => number
  cacheMs?: number
  /** Trust anchors bundled with the runtime; tests pass none. */
  systemRoots?: () => ParsedCertificate[]
}

export class SmimePassphraseRequired extends Error {
  constructor(readonly fingerprint: string, readonly subject: string, message = 'Enter the passphrase for this S/MIME certificate') {
    super(message)
    this.name = 'SmimePassphraseRequired'
  }
}

export const MAX_SMIME_CERTIFICATES = 1000
const MAX_IMPORT_BYTES = 2 * 1024 * 1024
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const fingerprintPattern = /^[0-9A-F]{64}$/

export interface SmimeDecryptedContent {
  encrypted: boolean
  text: string
  html?: string
  attachments: { filename: string; mimeType: string; content: Uint8Array }[]
  signatures: SmimeSignatureResult[]
}

const bytes = (value: ArrayBuffer | Uint8Array | string) => typeof value === 'string' ? Buffer.from(value, 'utf8') : value instanceof Uint8Array ? value : new Uint8Array(value)

export class SmimeStore {
  private certificates = new Map<string, StoredCertificate>()
  private defaults: Record<string, SmimeIdentityDefault> = {}
  private unlocked = new Map<string, { key: KeyObject; expiresAt: number }>()
  private parsed = new Map<string, ParsedCertificate>()
  private loadError: string | undefined
  private readonly storage: OpenPgpKeyStorage
  private readonly isLocked: () => boolean
  private readonly now: () => number
  private readonly cacheMs: number
  private readonly systemRoots: () => ParsedCertificate[]

  constructor(private readonly path: string, options: SmimeStoreOptions) {
    this.storage = options.storage
    this.isLocked = options.isLocked ?? (() => false)
    this.now = options.now ?? Date.now
    this.cacheMs = options.cacheMs ?? OPENPGP_PASSPHRASE_CACHE_MS
    this.systemRoots = options.systemRoots ?? systemRootCertificates
    try { this.load() } catch (error) {
      // Never replace an unreadable store with an empty one.
      this.loadError = errorText(error)
    }
  }

  secureStorage() {
    try { assertSecureCredentialStorage(this.storage); return true } catch { return false }
  }

  locked() { return this.isLocked() }

  /** Clears every cached passphrase-decrypted private key. Called when Aerio locks. */
  lock() { this.unlocked.clear() }

  private load() {
    if (!existsSync(this.path)) return
    assertSecureCredentialStorage(this.storage)
    const parsed = JSON.parse(this.storage.decryptString(Buffer.from(readFileSync(this.path, 'utf8'), 'base64'))) as { certificates?: StoredCertificate[]; defaults?: Record<string, SmimeIdentityDefault> }
    for (const item of parsed.certificates ?? []) if (item && typeof item.fingerprint === 'string' && typeof item.der === 'string') this.certificates.set(item.fingerprint, item)
    if (parsed.defaults && typeof parsed.defaults === 'object') this.defaults = parsed.defaults
  }

  private save() {
    if (this.loadError) throw new Error(`The S/MIME certificate store could not be read, so Aerio will not change it: ${this.loadError}`)
    assertSecureCredentialStorage(this.storage)
    const encrypted = this.storage.encryptString(JSON.stringify({ version: 1, certificates: [...this.certificates.values()], defaults: this.defaults }))
    const temporary = `${this.path}.partial`
    writeFileSync(temporary, encrypted.toString('base64'), { mode: 0o600 })
    renameSync(temporary, this.path)
  }

  private assertUnlocked(action: string) {
    if (this.isLocked()) throw new Error(`Unlock Aerio before ${action}`)
  }

  private parse(der: string) {
    let cert = this.parsed.get(der)
    if (!cert) {
      cert = parseCertificate(Buffer.from(der, 'base64'))
      this.parsed.set(der, cert)
    }
    return cert
  }

  private stored(fingerprint: string) {
    const value = String(fingerprint).toUpperCase()
    const stored = this.certificates.get(value)
    if (!stored) throw new Error('That S/MIME certificate is not in your store')
    return stored
  }

  private chainOf(stored: StoredCertificate) {
    return (stored.chain ?? []).flatMap((der) => { try { return [this.parse(der)] } catch { return [] } })
  }

  /** Every stored certificate and the intermediates kept with them, as issuer candidates. */
  private pool() {
    return [...this.certificates.values()].flatMap((stored) => [this.parse(stored.der), ...this.chainOf(stored)])
  }

  private anchors() {
    const trusted = [...this.certificates.values()].filter((item) => item.trusted).map((item) => this.parse(item.der))
    return [...trusted, ...this.systemRoots()]
  }

  private cached(fingerprint: string) {
    const entry = this.unlocked.get(fingerprint)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now() || this.isLocked()) {
      this.unlocked.delete(fingerprint)
      return undefined
    }
    return entry.key
  }

  /** Summarizes a certificate with its chain status; extra certificates (from a message) can complete the chain. */
  describe(cert: ParsedCertificate, extra: ParsedCertificate[] = [], stored = this.certificates.get(cert.fingerprint)): SmimeCertificateSummary {
    const at = new Date(this.now())
    const anchors = this.anchors()
    const chain = validateChain(cert, [...extra, ...this.pool()], anchors, at)
    return {
      fingerprint: cert.fingerprint,
      subject: cert.subject,
      ...(cert.commonName ? { commonName: cert.commonName } : {}),
      issuer: cert.issuer,
      serialNumber: cert.serialNumber,
      emails: cert.emails,
      algorithm: cert.algorithm,
      validFrom: cert.validFrom.toISOString(),
      validTo: cert.validTo.toISOString(),
      expired: isExpired(cert, at),
      notYetValid: isNotYetValid(cert, at),
      isCa: cert.isCa,
      keyUsage: keyUsageSummary(cert),
      canSign: canSignMail(cert) && Boolean(stored?.privateKey),
      canEncrypt: canEncryptTo(cert),
      hasPrivateKey: Boolean(stored?.privateKey),
      unlocked: Boolean(stored && this.cached(stored.fingerprint)),
      source: stored?.source ?? 'message',
      trusted: Boolean(stored?.trusted),
      chain: chainEntries(chain, anchors, at),
      chainStatus: chain.status,
      revocation: 'not-checked'
    }
  }

  async list() {
    return [...this.certificates.values()]
      .map((stored) => this.describe(this.parse(stored.der), [], stored))
      .sort((left, right) => Number(right.hasPrivateKey) - Number(left.hasPrivateKey) || (left.emails[0] ?? left.subject).localeCompare(right.emails[0] ?? right.subject) || left.fingerprint.localeCompare(right.fingerprint))
  }

  summary(fingerprint: string) {
    const stored = this.stored(fingerprint)
    return this.describe(this.parse(stored.der), [], stored)
  }

  private put(cert: ParsedCertificate, values: Partial<StoredCertificate> & { source: SmimeCertificateSource }) {
    const existing = this.certificates.get(cert.fingerprint)
    if (!existing && this.certificates.size >= MAX_SMIME_CERTIFICATES) throw new Error(`The certificate store is limited to ${MAX_SMIME_CERTIFICATES} certificates`)
    if (values.privateKey !== undefined && !/^-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(values.privateKey)) throw new Error('Refusing to store an unprotected private key')
    const chain = [...new Set([...(existing?.chain ?? []), ...(values.chain ?? [])])]
    this.certificates.set(cert.fingerprint, {
      fingerprint: cert.fingerprint,
      der: cert.der.toString('base64'),
      ...(values.privateKey ?? existing?.privateKey ? { privateKey: values.privateKey ?? existing?.privateKey } : {}),
      ...(chain.length ? { chain } : {}),
      // A certificate you hold the key for stays "own"; harvesting never downgrades an import.
      source: existing?.source === 'own' || values.source === 'own' ? 'own' : existing?.source === 'imported' ? 'imported' : values.source,
      trusted: existing?.trusted ?? values.trusted ?? false,
      addedAt: existing?.addedAt ?? new Date(this.now()).toISOString()
    })
    return cert.fingerprint
  }

  /** Imports your certificate and private key from PKCS#12. The key is re-encrypted with the passphrase (default: the file password). */
  async importPkcs12(data: Uint8Array, password: string | undefined, passphrase?: string): Promise<SmimeImportResult> {
    this.assertUnlocked('importing certificates')
    if (data.length > MAX_IMPORT_BYTES) throw new Error('That certificate file is too large')
    if (password === undefined) return { imported: [], needsPassword: true }
    let contents: ReturnType<typeof readPkcs12>
    try { contents = readPkcs12(data, password) } catch (error) {
      if (error instanceof Pkcs12PasswordError) return { imported: [], needsPassword: true, ...(password ? { error: error.message } : {}) }
      throw error
    }
    const protection = passphrase || password
    try { validatePassphrase(protection) } catch { return { imported: [], needsPassphrase: true } }
    const { certificate, chain, privateKey } = contents
    if (certificate.keyType !== 'rsa') throw new Error(`Only RSA certificates can be used for your own S/MIME mail (this one is ${certificate.algorithm})`)
    const encryptedKey = privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: protection }) as string
    this.put(certificate, { source: 'own', privateKey: encryptedKey, chain: chain.map((item) => item.der.toString('base64')) })
    this.save()
    return { imported: [this.summary(certificate.fingerprint)] }
  }

  /** Imports public certificates (PEM bundle or DER): recipients, or CA certificates to mark trusted. */
  async importCertificates(data: string | Uint8Array): Promise<SmimeImportResult> {
    this.assertUnlocked('importing certificates')
    if (data.length > MAX_IMPORT_BYTES) throw new Error('That certificate file is too large')
    const certs = readCertificates(data)
    if (!certs.length) throw new Error('No certificates were found')
    const fingerprints = certs.map((cert) => this.put(cert, { source: 'imported' }))
    this.save()
    return { imported: [...new Set(fingerprints)].map((fingerprint) => this.summary(fingerprint)) }
  }

  /** Imports by file type: .p12/.pfx carry a private key, anything else is a certificate. */
  async importFile(data: Uint8Array, filename: string, password?: string, passphrase?: string) {
    if (/\.(?:p12|pfx)$/i.test(filename)) return this.importPkcs12(data, password, passphrase)
    const textValue = Buffer.from(data).toString('latin1')
    return this.importCertificates(/-----BEGIN /.test(textValue) ? textValue : data)
  }

  exportCertificate(fingerprint: string) {
    return this.parse(this.stored(fingerprint).der).x509.toString()
  }

  /** Exports certificate, chain and private key as PKCS#12 protected by a new password, after confirming the key passphrase. */
  exportPkcs12(fingerprint: string, passphrase: string, exportPassword: string) {
    this.assertUnlocked('exporting a private key')
    const stored = this.stored(fingerprint)
    if (!stored.privateKey) throw new Error('This certificate has no private key in Aerio')
    validatePassphrase(exportPassword)
    const key = this.decryptStored(stored, passphrase)
    const cert = this.parse(stored.der)
    return writePkcs12(key, cert, this.chainOf(stored), exportPassword, cert.commonName ?? cert.emails[0])
  }

  delete(fingerprint: string) {
    const stored = this.stored(fingerprint)
    this.certificates.delete(stored.fingerprint)
    this.unlocked.delete(stored.fingerprint)
    this.save()
  }

  /** Marks a certificate as a trust anchor (a CA you trust, or a leaf you accepted after checking its fingerprint). */
  setTrusted(fingerprint: string, trusted: boolean) {
    if (typeof trusted !== 'boolean') throw new Error('Choose trusted or not trusted')
    const stored = this.stored(fingerprint)
    stored.trusted = trusted
    this.save()
    return this.summary(stored.fingerprint)
  }

  private decryptStored(stored: StoredCertificate, passphrase: string) {
    if (typeof passphrase !== 'string' || !passphrase || passphrase.length > 1024) throw new Error('Enter the certificate passphrase')
    try {
      return createPrivateKey({ key: stored.privateKey!, format: 'pem', passphrase })
    } catch {
      throw new Error('The passphrase for this S/MIME certificate is incorrect')
    }
  }

  unlock(fingerprint: string, passphrase: string) {
    this.assertUnlocked('unlocking an S/MIME certificate')
    const stored = this.stored(fingerprint)
    if (!stored.privateKey) throw new Error('This certificate has no private key in Aerio')
    const key = this.decryptStored(stored, passphrase)
    this.unlocked.set(stored.fingerprint, { key, expiresAt: this.now() + this.cacheMs })
    return this.summary(stored.fingerprint)
  }

  identityDefault(address: string): SmimeIdentityDefault | undefined {
    return this.defaults[addressEmail(address)]
  }

  setIdentityDefault(address: string, value: SmimeIdentityDefault | undefined) {
    const email = addressEmail(String(address ?? ''))
    if (!email.includes('@') || email.length > 320) throw new Error('Choose a valid sender address')
    if (value && (value.sign || value.encrypt)) this.defaults[email] = { sign: value.sign === true, encrypt: value.encrypt === true }
    else delete this.defaults[email]
    this.save()
  }

  private usableAt(cert: ParsedCertificate) {
    const at = new Date(this.now())
    return !isExpired(cert, at) && !isNotYetValid(cert, at)
  }

  private newest(summaries: SmimeCertificateSummary[]) {
    return [...summaries].sort((left, right) => Number(right.chainStatus === 'trusted' || right.trusted) - Number(left.chainStatus === 'trusted' || left.trusted) || right.validTo.localeCompare(left.validTo))[0]
  }

  /** Your certificate that signs mail from this address. */
  async signerFor(from: string) {
    const email = addressEmail(from)
    const usable = (await this.list()).filter((item) => item.hasPrivateKey && item.canSign && !item.expired && !item.notYetValid && item.emails.includes(email))
    return usable.length ? this.newest(usable) : undefined
  }

  /** Your own certificate to encrypt the Sent copy to. */
  async selfCertificate(from: string) {
    const email = addressEmail(from)
    const usable = (await this.list()).filter((item) => item.hasPrivateKey && item.canEncrypt && !item.expired && !item.notYetValid && item.emails.includes(email))
    return usable.length ? this.newest(usable) : undefined
  }

  /**
   * One certificate per recipient. A certificate is usable when it is valid
   * now, allows email encryption, and its chain is trusted (or you marked the
   * certificate itself trusted).
   */
  async recipientCertificates(addresses: string[], choices: Record<string, string> = {}): Promise<SmimeRecipientCertificate[]> {
    const all = (await this.list()).filter((item) => !item.isCa)
    return [...new Set(addresses.map(addressEmail))].map((address) => {
      const matching = all.filter((item) => item.emails.includes(address))
      const valid = matching.filter((item) => item.canEncrypt && !item.expired && !item.notYetValid)
      const usable = valid.filter((item) => item.chainStatus === 'trusted' || item.trusted)
      const candidates = usable.map((item) => ({ fingerprint: item.fingerprint, subject: item.commonName ?? item.subject, validTo: item.validTo, chainStatus: item.chainStatus, trusted: item.trusted }))
      if (!usable.length) {
        const status = !matching.length ? 'missing' : valid.length ? 'untrusted' : matching.some((item) => item.canEncrypt) ? 'expired' : 'unusable'
        return { address, status, candidates } satisfies SmimeRecipientCertificate
      }
      const chosen = usable.find((item) => item.fingerprint === choices[address]?.toUpperCase()) ?? this.newest(usable)
      return { address, status: 'ok', fingerprint: chosen.fingerprint, candidates } satisfies SmimeRecipientCertificate
    })
  }

  private async signingKey(from: string) {
    const signer = await this.signerFor(from)
    if (!signer) throw new Error(`No usable S/MIME certificate for ${addressEmail(from)} is available to sign with. ${NOT_SENT}`)
    const key = this.cached(signer.fingerprint)
    if (!key) throw new SmimePassphraseRequired(signer.fingerprint, signer.subject, `Unlock your S/MIME certificate (${signer.commonName ?? signer.subject}) before sending signed mail. ${NOT_SENT}`)
    const stored = this.stored(signer.fingerprint)
    return { key, cert: this.parse(stored.der), chain: this.chainOf(stored) }
  }

  /**
   * Signs and/or encrypts a complete outgoing message as S/MIME. Any problem
   * throws: callers must never fall back to sending the original message.
   * Sign plus encrypt signs first, then encrypts the signed entity.
   */
  async protect(message: string, input: { from: string; recipients: string[]; options: MailSmimeOptions }) {
    const { sign, encrypt } = input.options
    if (!sign && !encrypt) return message
    if (this.isLocked()) throw new Error(`Unlock Aerio before sending signed or encrypted mail. ${NOT_SENT}`)
    const signing = sign ? await this.signingKey(input.from) : undefined
    const { outer, inner } = splitForProtection(message)
    let payload = inner
    let signedEntity: ReturnType<typeof buildSignedEntity> | undefined
    if (signing) {
      let signature: Buffer
      try {
        signature = signDetached(Buffer.from(inner, 'utf8'), signing.key, signing.cert, signing.chain, new Date(this.now()))
      } catch (error) {
        throw new Error(`Signing failed: ${errorText(error)}. ${NOT_SENT}`)
      }
      signedEntity = buildSignedEntity(inner, signature)
      payload = entityText(signedEntity)
    }
    if (!encrypt) return assembleSmimeMessage(outer, signedEntity!)
    const recipients = await this.recipientCertificates(input.recipients, input.options.recipientCerts)
    const problems = recipients.filter((item) => item.status !== 'ok')
    if (!recipients.length) throw new Error(`Add at least one recipient. ${NOT_SENT}`)
    if (problems.length) throw new Error(`${describeSmimeRecipientProblems(problems)} ${NOT_SENT}`)
    const fingerprints = new Set(recipients.map((item) => item.fingerprint!))
    // Encrypt to the sender too, so the Sent copy stays readable here.
    const self = await this.selfCertificate(input.from)
    if (self) fingerprints.add(self.fingerprint)
    let envelope: Buffer
    try {
      envelope = encryptEnveloped(Buffer.from(payload, 'utf8'), [...fingerprints].map((fingerprint) => this.parse(this.stored(fingerprint).der)))
    } catch (error) {
      throw new Error(`Encryption failed: ${errorText(error)}. ${NOT_SENT}`)
    }
    return assembleSmimeMessage(outer, buildEnvelopedEntity(envelope))
  }

  /** Verifies every signer. A valid signature from a trusted certificate that matches the sender is saved for replies. */
  verify(signed: SignedDataInfo, data: Buffer, from: string | undefined): SmimeSignatureResult[] {
    const pool = [...signed.certificates, ...this.pool()]
    const email = from ? addressEmail(from) : undefined
    const at = new Date(this.now())
    return signed.signers.map((signer): SmimeSignatureResult => {
      const signedAt = signer.signedAt?.toISOString()
      const cert = pool.find((item) => signerMatches(signer, item))
      if (!cert) return { status: 'unknown-certificate', ...(signedAt ? { signedAt } : {}), detail: 'The signer’s certificate is not included in the message or in your store' }
      const check = verifySigner(signed, signer, data, cert)
      const summary = this.describe(cert, signed.certificates)
      const base = { signer: summary, ...(signedAt ? { signedAt } : {}) }
      if (!check.supported) return { ...base, status: check.valid ? 'valid' : 'unsupported', ...(check.detail ? { detail: check.detail } : {}) }
      if (!check.valid) return { ...base, status: 'invalid', detail: check.detail }
      if (isExpired(cert, at) || isNotYetValid(cert, at)) {
        const validThen = signer.signedAt && signer.signedAt >= cert.validFrom && signer.signedAt <= cert.validTo
        return { ...base, status: 'expired-certificate', detail: `The certificate is valid from ${cert.validFrom.toISOString().slice(0, 10)} to ${cert.validTo.toISOString().slice(0, 10)}${validThen ? '; the message says it was signed while it was valid' : ''}` }
      }
      if (summary.chainStatus !== 'trusted' && !summary.trusted) {
        return { ...base, status: 'untrusted', detail: summary.chainStatus === 'untrusted-root' ? 'The certificate was issued by a root you have not trusted' : summary.chainStatus === 'incomplete' ? 'The certificate’s issuer is unknown' : 'The certificate chain is not valid' }
      }
      if (!email || !cert.emails.includes(email)) return { ...base, status: 'email-mismatch', detail: `The certificate is for ${cert.emails.join(', ') || 'no email address'}, not the sender ${email ?? ''}`.trim() }
      const harvested = this.harvest(cert, summary, signed.certificates)
      return { ...base, status: 'valid', ...(harvested ? { harvested, signer: this.summary(cert.fingerprint) } : {}) }
    })
  }

  private harvest(cert: ParsedCertificate, summary: SmimeCertificateSummary, extra: ParsedCertificate[]) {
    if (this.certificates.has(cert.fingerprint) || !summary.canEncrypt || this.isLocked()) return false
    const chainDer = summary.chain.slice(1).filter((entry) => !entry.trustAnchor).flatMap((entry) => extra.filter((item) => item.fingerprint === entry.fingerprint).map((item) => item.der.toString('base64')))
    try {
      this.put(cert, { source: 'harvested', chain: chainDer })
      this.save()
      return true
    } catch {
      this.certificates.delete(cert.fingerprint)
      return false
    }
  }

  /** What an incoming message is, and the result of checking any outer signature. */
  async inspect(source: string): Promise<SmimeMessageStatus> {
    this.assertUnlocked('reading S/MIME mail')
    const structure = detectSmime(source)
    const from = headerValue(parseEntity(source), 'from')
    try {
      if (structure.kind === 'signed') return { kind: 'signed', signatures: this.verify(parseSignedData(structure.signature), Buffer.from(structure.signedPart, 'utf8'), from) }
      if (structure.kind === 'pkcs7') {
        const type = contentInfo(structure.der).type
        if (type === OID.signedData) {
          const signed = parseSignedData(structure.der)
          return { kind: 'signed-opaque', signatures: this.verify(signed, signed.content ?? Buffer.alloc(0), from) }
        }
        const info = envelopedInfo(structure.der)
        const own = [...this.certificates.values()].filter((item) => item.privateKey).map((item) => this.parse(item.der))
        return {
          kind: 'encrypted',
          algorithm: info.algorithm,
          encryptedTo: info.recipients.map((recipient) => {
            const match = own.find((cert) => recipientMatches(recipient, cert))
            const known = match ?? this.pool().find((cert) => recipientMatches(recipient, cert))
            return { issuer: known?.issuer ?? (recipient.subjectKeyId ? `key ${recipient.subjectKeyId}` : 'unknown issuer'), serialNumber: recipient.serialNumber ?? '', ...(known ? { fingerprint: known.fingerprint } : {}), available: Boolean(match) }
          })
        }
      }
    } catch (error) {
      return { kind: structure.kind === 'signed' ? 'signed' : structure.kind === 'pkcs7' ? 'encrypted' : 'none', error: `The S/MIME data could not be read: ${errorText(error)}` }
    }
    return { kind: 'none' }
  }

  private async decryptEnvelope(der: Buffer, passphrase?: string) {
    this.assertUnlocked('decrypting mail')
    const info = envelopedInfo(der)
    const own = [...this.certificates.values()].filter((item) => item.privateKey && info.recipients.some((recipient) => recipientMatches(recipient, this.parse(item.der))))
    if (!own.length) throw new Error('This message was not encrypted to any of your S/MIME certificates')
    let target = own.find((item) => this.cached(item.fingerprint))
    let key = target ? this.cached(target.fingerprint) : undefined
    if (!target || !key) {
      target = own[0]
      const subject = this.parse(target.der).commonName ?? this.parse(target.der).subject
      if (!passphrase) throw new SmimePassphraseRequired(target.fingerprint, subject)
      try { key = this.decryptStored(target, passphrase) } catch (error) { throw new SmimePassphraseRequired(target.fingerprint, subject, errorText(error)) }
      this.unlocked.set(target.fingerprint, { key, expiresAt: this.now() + this.cacheMs })
    }
    return decryptEnveloped(der, this.parse(target.der), key)
  }

  /**
   * Opens an encrypted or opaque-signed message: decrypts it when needed,
   * verifies any signature inside, and parses the content. Nothing is cached.
   */
  async open(source: string, passphrase?: string): Promise<SmimeDecryptedContent> {
    this.assertUnlocked('reading S/MIME mail')
    const structure = detectSmime(source)
    if (structure.kind !== 'pkcs7') throw new Error('This message is not S/MIME encrypted')
    const from = headerValue(parseEntity(source), 'from')
    const outerType = contentInfo(structure.der).type
    const encrypted = outerType !== OID.signedData
    let entity = encrypted ? (await this.decryptEnvelope(structure.der, passphrase)).toString('utf8') : ''
    const signatures: SmimeSignatureResult[] = []
    let opaque = encrypted ? undefined : structure.der
    if (encrypted) {
      const nested = detectSmime(entity)
      if (nested.kind === 'signed') signatures.push(...this.verify(parseSignedData(nested.signature), Buffer.from(nested.signedPart, 'utf8'), from))
      else if (nested.kind === 'pkcs7' && contentInfo(nested.der).type === OID.signedData) opaque = nested.der
    }
    if (opaque) {
      const signed = parseSignedData(opaque)
      const data = signed.content ?? Buffer.alloc(0)
      signatures.push(...this.verify(signed, data, from))
      entity = data.toString('utf8')
    }
    const parsed = await PostalMime.parse(entity)
    return {
      encrypted,
      text: parsed.text ?? '',
      html: parsed.html,
      attachments: parsed.attachments
        .filter((item) => !/^application\/(?:x-)?pkcs7-signature$/i.test(item.mimeType))
        .map((item) => ({ filename: item.filename || 'attachment', mimeType: item.mimeType || 'application/octet-stream', content: bytes(item.content) })),
      signatures
    }
  }

  static validFingerprint(value: unknown): value is string {
    return typeof value === 'string' && fingerprintPattern.test(value.toUpperCase())
  }
}

export function describeSmimeRecipientProblems(problems: SmimeRecipientCertificate[]) {
  const group = (status: SmimeRecipientCertificate['status'], label: string) => {
    const list = problems.filter((item) => item.status === status).map((item) => item.address)
    return list.length ? `${label}: ${list.join(', ')}.` : ''
  }
  return [
    group('missing', 'No S/MIME certificate for'),
    group('expired', 'The S/MIME certificate has expired for'),
    group('untrusted', 'The S/MIME certificate is not trusted for'),
    group('unusable', 'No S/MIME certificate that allows encryption for')
  ].filter(Boolean).join(' ')
}

