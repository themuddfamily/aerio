import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import * as openpgp from 'openpgp'
import type {
  MailOpenPgpOptions,
  OpenPgpGenerateInput,
  OpenPgpImportResult,
  OpenPgpKeySummary,
  OpenPgpRecipientKey,
  OpenPgpSignatureResult,
  OpenPgpVerificationState
} from '../../src/openpgp-types'
import { OPENPGP_PASSPHRASE_CACHE_MS } from '../../src/openpgp-types'
import { assertSecureCredentialStorage } from './secure-storage'
import { assembleProtectedMessage, buildEncryptedEntity, buildSignedEntity, splitForProtection } from './openpgp-mime'

// The OpenPGP keyring. Private keys are stored only in their
// passphrase-protected OpenPGP form, and the whole keyring file is
// additionally wrapped with OS secure storage (Electron safeStorage), exactly
// like the OAuth vault. It is not in the profile-backup allowlist, so keys
// leave this device only through an explicit export.

export interface OpenPgpKeyStorage {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

interface StoredKey {
  fingerprint: string
  publicKey: string
  /** Armored secret key, always passphrase-encrypted. */
  privateKey?: string
  verification: OpenPgpVerificationState
  addedAt: string
}

export interface OpenPgpKeyringOptions {
  storage: OpenPgpKeyStorage
  isLocked?: () => boolean
  now?: () => number
  cacheMs?: number
}

export class OpenPgpPassphraseRequired extends Error {
  constructor(readonly fingerprint: string, readonly userId: string, message = 'Enter the passphrase for this OpenPGP key') {
    super(message)
    this.name = 'OpenPgpPassphraseRequired'
  }
}

export const MAX_OPENPGP_KEYS = 500
const MAX_IMPORT_BYTES = 2 * 1024 * 1024
export const NOT_SENT = 'The message was not sent; your draft is kept.'

export const addressEmail = (value: string) => (value.trim().match(/<([^<>]+)>\s*$/)?.[1] ?? value).trim().toLowerCase()

const describeAlgorithm = (info: openpgp.AlgorithmInfo) => {
  if (info.curve) return `${info.algorithm} (${info.curve})`
  return info.bits ? `${info.algorithm} ${info.bits}` : String(info.algorithm)
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export class OpenPgpKeyring {
  private keys = new Map<string, StoredKey>()
  private unlocked = new Map<string, { key: openpgp.PrivateKey; expiresAt: number }>()
  private parsed = new Map<string, Promise<openpgp.Key>>()
  private loadError: string | undefined
  private readonly storage: OpenPgpKeyStorage
  private readonly isLocked: () => boolean
  private readonly now: () => number
  private readonly cacheMs: number

  constructor(private readonly path: string, options: OpenPgpKeyringOptions) {
    this.storage = options.storage
    this.isLocked = options.isLocked ?? (() => false)
    this.now = options.now ?? Date.now
    this.cacheMs = options.cacheMs ?? OPENPGP_PASSPHRASE_CACHE_MS
    try { this.load() } catch (error) {
      // Never replace an unreadable keyring with an empty one.
      this.loadError = errorText(error)
    }
  }

  secureStorage() {
    try { assertSecureCredentialStorage(this.storage); return true } catch { return false }
  }

  locked() { return this.isLocked() }

  private load() {
    if (!existsSync(this.path)) return
    assertSecureCredentialStorage(this.storage)
    const parsed = JSON.parse(this.storage.decryptString(Buffer.from(readFileSync(this.path, 'utf8'), 'base64'))) as { keys?: StoredKey[] }
    for (const key of parsed.keys ?? []) if (key && typeof key.fingerprint === 'string' && typeof key.publicKey === 'string') this.keys.set(key.fingerprint, key)
  }

  private save() {
    if (this.loadError) throw new Error(`The OpenPGP keyring could not be read, so Aerio will not change it: ${this.loadError}`)
    assertSecureCredentialStorage(this.storage)
    const encrypted = this.storage.encryptString(JSON.stringify({ version: 1, keys: [...this.keys.values()] }))
    const temporary = `${this.path}.partial`
    writeFileSync(temporary, encrypted.toString('base64'), { mode: 0o600 })
    renameSync(temporary, this.path)
  }

  private assertUnlocked(action: string) {
    if (this.isLocked()) throw new Error(`Unlock Aerio before ${action}`)
  }

  /** Clears every cached passphrase-decrypted key. Called when Aerio locks. */
  lock() {
    this.unlocked.clear()
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

  private stored(fingerprint: string) {
    const key = this.keys.get(String(fingerprint).toUpperCase())
    if (!key) throw new Error('That OpenPGP key is not in your keyring')
    return key
  }

  private publicKey(stored: StoredKey) {
    let key = this.parsed.get(stored.publicKey)
    if (!key) {
      key = openpgp.readKey({ armoredKey: stored.publicKey })
      this.parsed.set(stored.publicKey, key)
    }
    return key as Promise<openpgp.PublicKey>
  }

  private async summarize(stored: StoredKey): Promise<OpenPgpKeySummary> {
    const key = await this.publicKey(stored)
    const now = new Date(this.now())
    const expiration = await key.getExpirationTime().catch(() => null)
    const revoked = await key.isRevoked(undefined, undefined, now).catch(() => false)
    const expiresAt = expiration instanceof Date ? expiration.toISOString() : undefined
    const usable = async (probe: () => Promise<unknown>) => { try { await probe(); return true } catch { return false } }
    return {
      fingerprint: stored.fingerprint,
      keyId: key.getKeyID().toHex().toUpperCase(),
      userIds: key.getUserIDs(),
      emails: [...new Set(key.users.map((user) => user.userID?.email?.toLowerCase()).filter((email): email is string => Boolean(email)))],
      algorithm: describeAlgorithm(key.getAlgorithmInfo()),
      createdAt: key.getCreationTime().toISOString(),
      expiresAt,
      expired: expiration instanceof Date && expiration.getTime() <= now.getTime(),
      revoked,
      hasPrivateKey: Boolean(stored.privateKey),
      canEncrypt: await usable(() => key.getEncryptionKey(undefined, now)),
      canSign: Boolean(stored.privateKey) && await usable(() => key.getSigningKey(undefined, now)),
      verification: stored.verification,
      unlocked: Boolean(this.cached(stored.fingerprint))
    }
  }

  async list() {
    const summaries = await Promise.all([...this.keys.values()].map((key) => this.summarize(key)))
    return summaries.sort((left, right) => (left.userIds[0] ?? '').localeCompare(right.userIds[0] ?? '') || left.fingerprint.localeCompare(right.fingerprint))
  }

  summary(fingerprint: string) {
    return this.summarize(this.stored(fingerprint))
  }

  async generate(input: OpenPgpGenerateInput) {
    this.assertUnlocked('creating an OpenPGP key')
    const name = typeof input?.name === 'string' ? input.name.replaceAll(/[\r\n<>]+/g, ' ').trim() : ''
    const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : ''
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || email.length > 320) throw new Error('Enter the email address this key is for')
    if (name.length > 200) throw new Error('The name is too long')
    validatePassphrase(input.passphrase)
    const days = Number(input.expiresInDays ?? 0)
    if (!Number.isInteger(days) || days < 0 || days > 3650) throw new Error('Choose an expiry of up to ten years, or none')
    const { privateKey } = await openpgp.generateKey({
      type: 'ecc',
      userIDs: [{ ...(name ? { name } : {}), email }],
      passphrase: input.passphrase,
      keyExpirationTime: days ? days * 86_400 : 0,
      format: 'object'
    })
    // A key you created yourself starts verified.
    const fingerprint = this.store(privateKey.toPublic(), privateKey, 'verified')
    this.save()
    return this.summary(fingerprint)
  }

  private store(publicKey: openpgp.PublicKey, privateKey: openpgp.PrivateKey | undefined, verification?: OpenPgpVerificationState) {
    const fingerprint = publicKey.getFingerprint().toUpperCase()
    const existing = this.keys.get(fingerprint)
    if (!existing && this.keys.size >= MAX_OPENPGP_KEYS) throw new Error(`The keyring is limited to ${MAX_OPENPGP_KEYS} keys`)
    if (privateKey?.isDecrypted()) throw new Error('Refusing to store an unprotected private key')
    this.keys.set(fingerprint, {
      fingerprint,
      publicKey: publicKey.armor(),
      privateKey: privateKey?.armor() ?? existing?.privateKey,
      verification: verification ?? existing?.verification ?? 'unverified',
      addedAt: existing?.addedAt ?? new Date(this.now()).toISOString()
    })
    return fingerprint
  }

  /** Imports armored or binary keys, merging updates such as revocations into existing entries. */
  async importKeys(data: string | Uint8Array, passphrase?: string): Promise<OpenPgpImportResult> {
    this.assertUnlocked('importing OpenPGP keys')
    if (data.length > MAX_IMPORT_BYTES) throw new Error('That key file is too large')
    const parsed: openpgp.Key[] = []
    try {
      if (typeof data === 'string') {
        const blocks = data.match(/-----BEGIN PGP (?:PUBLIC|PRIVATE) KEY BLOCK-----[\s\S]*?-----END PGP (?:PUBLIC|PRIVATE) KEY BLOCK-----/g) ?? []
        for (const block of blocks) parsed.push(...await openpgp.readKeys({ armoredKeys: block }))
      } else parsed.push(...await openpgp.readKeys({ binaryKeys: data }))
    } catch (error) {
      throw new Error(`That is not a readable OpenPGP key: ${errorText(error)}`)
    }
    if (!parsed.length) throw new Error('No OpenPGP keys were found')
    // Protect unprotected secret keys before anything is written.
    const prepared: { publicKey: openpgp.PublicKey; privateKey?: openpgp.PrivateKey }[] = []
    for (const key of parsed) {
      if (!key.isPrivate()) { prepared.push({ publicKey: key as openpgp.PublicKey }); continue }
      let privateKey = key as openpgp.PrivateKey
      if (privateKey.isDecrypted()) {
        if (!passphrase) return { imported: [], needsPassphrase: true }
        validatePassphrase(passphrase)
        privateKey = await openpgp.encryptKey({ privateKey, passphrase })
      }
      prepared.push({ publicKey: privateKey.toPublic(), privateKey })
    }
    const fingerprints: string[] = []
    for (const item of prepared) {
      const fingerprint = item.publicKey.getFingerprint().toUpperCase()
      const existing = this.keys.get(fingerprint)
      let publicKey = item.publicKey
      let privateKey = item.privateKey
      if (existing) {
        // update() keeps the union of user IDs, subkeys and revocations.
        publicKey = await (await this.publicKey(existing)).update(publicKey, new Date(this.now()))
        if (!privateKey && existing.privateKey) privateKey = await (await openpgp.readPrivateKey({ armoredKey: existing.privateKey })).update(publicKey, new Date(this.now()))
      }
      fingerprints.push(this.store(publicKey, privateKey))
    }
    this.save()
    return { imported: await Promise.all([...new Set(fingerprints)].map((fingerprint) => this.summary(fingerprint))) }
  }

  async exportPublic(fingerprint: string) {
    return this.stored(fingerprint).publicKey
  }

  /** Exports the secret key still protected by its passphrase, after confirming the passphrase. */
  async exportPrivate(fingerprint: string, passphrase: string) {
    this.assertUnlocked('exporting a private key')
    const stored = this.stored(fingerprint)
    if (!stored.privateKey) throw new Error('This key has no private key in Aerio')
    await this.decryptStored(stored, passphrase)
    return stored.privateKey
  }

  delete(fingerprint: string) {
    const stored = this.stored(fingerprint)
    this.keys.delete(stored.fingerprint)
    this.unlocked.delete(stored.fingerprint)
    this.save()
  }

  async setVerification(fingerprint: string, state: OpenPgpVerificationState) {
    if (state !== 'verified' && state !== 'unverified') throw new Error('Choose verified or unverified')
    const stored = this.stored(fingerprint)
    stored.verification = state
    this.save()
    return this.summary(stored.fingerprint)
  }

  private async decryptStored(stored: StoredKey, passphrase: string) {
    if (typeof passphrase !== 'string' || !passphrase || passphrase.length > 1024) throw new Error('Enter the key passphrase')
    try {
      return await openpgp.decryptKey({ privateKey: await openpgp.readPrivateKey({ armoredKey: stored.privateKey! }), passphrase })
    } catch {
      throw new Error('The passphrase for this OpenPGP key is incorrect')
    }
  }

  /** Decrypts a secret key with its passphrase and keeps it in memory until lock or timeout. */
  async unlock(fingerprint: string, passphrase: string) {
    this.assertUnlocked('unlocking an OpenPGP key')
    const stored = this.stored(fingerprint)
    if (!stored.privateKey) throw new Error('This key has no private key in Aerio')
    const key = await this.decryptStored(stored, passphrase)
    this.unlocked.set(stored.fingerprint, { key, expiresAt: this.now() + this.cacheMs })
    return this.summary(stored.fingerprint)
  }

  private async best(summaries: OpenPgpKeySummary[]) {
    return summaries.sort((left, right) => Number(right.verification === 'verified') - Number(left.verification === 'verified') || right.createdAt.localeCompare(left.createdAt))[0]
  }

  /** Picks one usable encryption key per recipient, honoring an explicit choice when it is still usable. */
  async recipientKeys(addresses: string[], choices: Record<string, string> = {}): Promise<OpenPgpRecipientKey[]> {
    const all = await this.list()
    return Promise.all([...new Set(addresses.map(addressEmail))].map(async (address) => {
      const matching = all.filter((key) => key.emails.includes(address))
      const usable = matching.filter((key) => key.canEncrypt && !key.revoked && !key.expired)
      const candidates = usable.map((key) => ({ fingerprint: key.fingerprint, userId: key.userIds.find((id) => id.toLowerCase().includes(address)) ?? key.userIds[0] ?? address, verification: key.verification }))
      if (!usable.length) {
        const status = !matching.length ? 'missing' : matching.every((key) => key.revoked) ? 'revoked' : matching.every((key) => key.revoked || key.expired) ? 'expired' : 'unusable'
        return { address, status, candidates } satisfies OpenPgpRecipientKey
      }
      const chosen = usable.find((key) => key.fingerprint === choices[address]?.toUpperCase()) ?? await this.best(usable)
      return { address, status: 'ok', fingerprint: chosen.fingerprint, verification: chosen.verification, candidates } satisfies OpenPgpRecipientKey
    }))
  }

  /** The secret key used to sign mail from this address, if any. */
  async signerFor(from: string) {
    const email = addressEmail(from)
    const usable = (await this.list()).filter((key) => key.hasPrivateKey && key.canSign && !key.revoked && !key.expired && key.emails.includes(email))
    return usable.length ? this.best(usable) : undefined
  }

  private async signingKey(from: string) {
    const signer = await this.signerFor(from)
    if (!signer) throw new Error(`No usable OpenPGP secret key for ${addressEmail(from)} is available to sign with. ${NOT_SENT}`)
    const key = this.cached(signer.fingerprint)
    if (!key) throw new OpenPgpPassphraseRequired(signer.fingerprint, signer.userIds[0] ?? signer.fingerprint, `Unlock your OpenPGP key ${signer.fingerprint.slice(-16)} before sending signed mail. ${NOT_SENT}`)
    return key
  }

  /**
   * Signs and/or encrypts a complete outgoing message as PGP/MIME. Any problem
   * throws: callers must never fall back to sending the original message.
   */
  async protect(message: string, input: { from: string; recipients: string[]; options: MailOpenPgpOptions }) {
    const { sign, encrypt } = input.options
    if (!sign && !encrypt) return message
    if (this.isLocked()) throw new Error(`Unlock Aerio before sending signed or encrypted mail. ${NOT_SENT}`)
    const signingKey = sign ? await this.signingKey(input.from) : undefined
    const { outer, inner } = splitForProtection(message)
    const data = await openpgp.createMessage({ binary: Buffer.from(inner, 'utf8') })
    if (!encrypt) {
      const armoredSignature = await openpgp.sign({ message: data, signingKeys: signingKey!, detached: true, format: 'armored' })
      const signature = await openpgp.readSignature({ armoredSignature })
      const hash = Object.entries(openpgp.enums.hash).find(([, id]) => id === signature.packets[0].hashAlgorithm)?.[0] ?? 'sha256'
      return assembleProtectedMessage(outer, buildSignedEntity(inner, armoredSignature, `pgp-${String(hash).toLowerCase()}`))
    }
    const recipients = await this.recipientKeys(input.recipients, input.options.recipientKeys)
    const problems = recipients.filter((item) => item.status !== 'ok')
    if (problems.length) throw new Error(`${describeRecipientProblems(problems)} ${NOT_SENT}`)
    const fingerprints = new Set(recipients.map((item) => item.fingerprint!))
    // Encrypt to the sender too, so the Sent copy stays readable here.
    const self = (await this.recipientKeys([input.from])).find((item) => item.status === 'ok')
    if (self?.fingerprint) fingerprints.add(self.fingerprint)
    const encryptionKeys = await Promise.all([...fingerprints].map((fingerprint) => this.publicKey(this.stored(fingerprint))))
    let armored: string
    try {
      armored = await openpgp.encrypt({ message: data, encryptionKeys, ...(signingKey ? { signingKeys: signingKey } : {}), format: 'armored' })
    } catch (error) {
      throw new Error(`Encryption failed: ${errorText(error)}. ${NOT_SENT}`)
    }
    return assembleProtectedMessage(outer, buildEncryptedEntity(armored))
  }

  private async verificationKeys() {
    return Promise.all([...this.keys.values()].map((key) => this.publicKey(key)))
  }

  private async findByKeyId(keyId: openpgp.KeyID) {
    for (const stored of this.keys.values()) {
      const key = await this.publicKey(stored)
      if (key.getKeys(keyId).length) return stored
    }
    return undefined
  }

  private async signatureResults(signatures: openpgp.VerifyMessageResult['signatures']): Promise<OpenPgpSignatureResult[]> {
    return Promise.all(signatures.map(async (item) => {
      const keyId = item.keyID.toHex().toUpperCase()
      const signedAt = await item.signature.then((signature) => signature.packets[0]?.created?.toISOString()).catch(() => undefined)
      const stored = await this.findByKeyId(item.keyID)
      if (!stored) return { status: 'unknown-key', keyId, signedAt, detail: 'The signer’s public key is not in your keyring' } satisfies OpenPgpSignatureResult
      const summary = await this.summarize(stored)
      const base = { keyId, fingerprint: summary.fingerprint, userIds: summary.userIds, verification: summary.verification, signedAt }
      let detail: string | undefined
      let valid = false
      try { await item.verified; valid = true } catch (error) { detail = errorText(error) }
      if (summary.revoked) return { ...base, status: 'revoked-key', detail: detail ?? 'The signing key has been revoked' } satisfies OpenPgpSignatureResult
      if (summary.expired) return { ...base, status: 'expired-key', detail: detail ?? 'The signing key has expired' } satisfies OpenPgpSignatureResult
      return { ...base, status: valid ? 'valid' : 'invalid', ...(detail ? { detail } : {}) } satisfies OpenPgpSignatureResult
    }))
  }

  async verifyDetached(signedPart: string, armoredSignature: string) {
    const signature = await openpgp.readSignature({ armoredSignature })
    const message = await openpgp.createMessage({ binary: Buffer.from(signedPart, 'utf8') })
    const result = await openpgp.verify({ message, signature, verificationKeys: await this.verificationKeys(), expectSigned: false })
    return this.signatureResults(result.signatures)
  }

  async verifyCleartext(block: string) {
    const message = await openpgp.readCleartextMessage({ cleartextMessage: block })
    const result = await openpgp.verify({ message, verificationKeys: await this.verificationKeys(), expectSigned: false })
    return { text: String(result.data), signatures: await this.signatureResults(result.signatures) }
  }

  async encryptedTo(armored: string) {
    const message = await openpgp.readMessage({ armoredMessage: armored })
    return Promise.all(message.getEncryptionKeyIDs().map(async (id) => {
      const stored = await this.findByKeyId(id)
      return { keyId: id.toHex().toUpperCase(), fingerprint: stored?.fingerprint, available: Boolean(stored?.privateKey) }
    }))
  }

  /** Decrypts an armored OpenPGP message with a cached key or the supplied passphrase. */
  async decrypt(armored: string, passphrase?: string) {
    this.assertUnlocked('decrypting mail')
    const message = await openpgp.readMessage({ armoredMessage: armored })
    const ids = message.getEncryptionKeyIDs()
    const candidates: StoredKey[] = []
    for (const id of ids) {
      const stored = await this.findByKeyId(id)
      if (stored?.privateKey && !candidates.includes(stored)) candidates.push(stored)
    }
    if (!candidates.length) throw new Error('This message was not encrypted to any private key in your keyring')
    let key = candidates.map((item) => this.cached(item.fingerprint)).find(Boolean)
    if (!key) {
      const target = candidates[0]
      const userId = (await this.publicKey(target)).getUserIDs()[0] ?? target.fingerprint
      if (!passphrase) throw new OpenPgpPassphraseRequired(target.fingerprint, userId)
      try { key = await this.decryptStored(target, passphrase) } catch (error) { throw new OpenPgpPassphraseRequired(target.fingerprint, userId, errorText(error)) }
      this.unlocked.set(target.fingerprint, { key, expiresAt: this.now() + this.cacheMs })
    }
    let result: Awaited<ReturnType<typeof openpgp.decrypt<Uint8Array>>>
    try {
      result = await openpgp.decrypt({ message, decryptionKeys: key, verificationKeys: await this.verificationKeys(), expectSigned: false, format: 'binary' })
    } catch (error) {
      throw new Error(`This message could not be decrypted: ${errorText(error)}`)
    }
    return { data: result.data as Uint8Array, signatures: await this.signatureResults(result.signatures) }
  }
}

export function validatePassphrase(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 1024) throw new Error('Use a key passphrase of at least 8 characters')
}

export function describeRecipientProblems(problems: OpenPgpRecipientKey[]) {
  const group = (status: OpenPgpRecipientKey['status'], label: string) => {
    const list = problems.filter((item) => item.status === status).map((item) => item.address)
    return list.length ? `${label}: ${list.join(', ')}.` : ''
  }
  return [
    group('missing', 'No OpenPGP public key for'),
    group('expired', 'The OpenPGP key has expired for'),
    group('revoked', 'The OpenPGP key was revoked for'),
    group('unusable', 'No usable OpenPGP encryption key for')
  ].filter(Boolean).join(' ')
}
