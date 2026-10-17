import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

/**
 * OS-wrapped Chat secrets. One encrypted file holds, per account, the access
 * token, the local cache key and the SDK crypto-store key. The codec is
 * Electron `safeStorage` behind `assertSecureCredentialStorage`, so Linux's
 * `basic_text` backend or unavailable secure storage refuses every write and
 * read: there is no plaintext fallback. Never included in profile backups.
 */
export interface ChatSecretCodec {
  /** Throws when OS-backed encryption is unavailable or weak. */
  assertSecure(): void
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

export interface ChatAccountSecrets {
  accessToken: string
  /** 32-byte AES-GCM key for chat.sqlite content and cached media. */
  cacheKey: Buffer
  /** 32-byte key the SDK uses to encrypt its own IndexedDB crypto store. */
  cryptoStoreKey: Buffer
  /** The device the crypto store was created for; a mismatch means a new device. */
  deviceId: string
}

interface StoredSecrets {
  accessToken: string
  cacheKey: string
  cryptoStoreKey: string
  deviceId: string
}

export class ChatVault {
  private data: Record<string, StoredSecrets> = {}
  private loaded = false

  constructor(private readonly path: string, private readonly codec: ChatSecretCodec) {}

  private load() {
    if (this.loaded) return
    this.codec.assertSecure()
    if (existsSync(this.path)) {
      const parsed = JSON.parse(this.codec.decrypt(Buffer.from(readFileSync(this.path, 'utf8'), 'base64'))) as { accounts?: Record<string, StoredSecrets> }
      this.data = parsed.accounts ?? {}
    }
    this.loaded = true
  }

  private persist() {
    this.codec.assertSecure()
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, this.codec.encrypt(JSON.stringify({ version: 1, accounts: this.data })).toString('base64'), { mode: 0o600 })
    renameSync(temporary, this.path)
  }

  has(accountId: string) {
    this.load()
    return Boolean(this.data[accountId])
  }

  get(accountId: string): ChatAccountSecrets | undefined {
    this.load()
    const stored = this.data[accountId]
    if (!stored) return undefined
    return { accessToken: stored.accessToken, cacheKey: Buffer.from(stored.cacheKey, 'base64'), cryptoStoreKey: Buffer.from(stored.cryptoStoreKey, 'base64'), deviceId: stored.deviceId }
  }

  /** Creates fresh keys for a new device. An existing entry is replaced: its old crypto store is no longer usable. */
  create(accountId: string, accessToken: string, deviceId: string): ChatAccountSecrets {
    this.load()
    this.data[accountId] = { accessToken, deviceId, cacheKey: randomBytes(32).toString('base64'), cryptoStoreKey: randomBytes(32).toString('base64') }
    this.persist()
    return this.get(accountId)!
  }

  /** A new device for an existing account: fresh crypto-store key, same cache key. */
  replaceDevice(accountId: string, accessToken: string, deviceId: string) {
    this.load()
    const stored = this.data[accountId]
    if (!stored) return this.create(accountId, accessToken, deviceId)
    this.data[accountId] = { ...stored, accessToken, deviceId, cryptoStoreKey: randomBytes(32).toString('base64') }
    this.persist()
    return this.get(accountId)!
  }

  updateToken(accountId: string, accessToken: string) {
    this.load()
    const stored = this.data[accountId]
    if (!stored) throw new Error('This Chat account has no stored session')
    stored.accessToken = accessToken
    this.persist()
  }

  /** Forgets the token but keeps the cache and crypto keys (soft logout, needs re-authentication). */
  clearToken(accountId: string) {
    this.load()
    const stored = this.data[accountId]
    if (!stored) return
    stored.accessToken = ''
    this.persist()
  }

  remove(accountId: string) {
    this.load()
    if (!this.data[accountId]) return
    delete this.data[accountId]
    if (Object.keys(this.data).length) this.persist()
    else rmSync(this.path, { force: true })
  }
}
