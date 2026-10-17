import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Authenticated encryption for Chat's local plaintext (messages, room names,
 * drafts, search records, media metadata). Every ciphertext is bound to the
 * account, table, record and schema version through AES-GCM associated data,
 * so a row copied to another account or column fails to open instead of
 * revealing or impersonating content.
 */
export const CHAT_CACHE_SCHEMA = 1
const VERSION = 'c1'

export interface ChatCacheBinding {
  table: string
  record: string
}

export class ChatCacheCipher {
  constructor(private readonly accountId: string, private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('A Chat cache key must be 32 bytes')
  }

  static generateKey() {
    return randomBytes(32)
  }

  private aad(binding: ChatCacheBinding) {
    return Buffer.from(JSON.stringify([VERSION, CHAT_CACHE_SCHEMA, this.accountId, binding.table, binding.record]), 'utf8')
  }

  seal(plaintext: string | Buffer, binding: ChatCacheBinding): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(this.aad(binding))
    const body = Buffer.concat([cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext), cipher.final()])
    return `${VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`
  }

  openBuffer(sealed: string, binding: ChatCacheBinding): Buffer {
    if (!sealed.startsWith(`${VERSION}.`)) throw new Error('Unsupported Chat cache record')
    const raw = Buffer.from(sealed.slice(VERSION.length + 1), 'base64')
    if (raw.length < 28) throw new Error('Corrupt Chat cache record')
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12))
    decipher.setAAD(this.aad(binding))
    decipher.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()])
  }

  open(sealed: string, binding: ChatCacheBinding): string {
    return this.openBuffer(sealed, binding).toString('utf8')
  }

  sealJson(value: unknown, binding: ChatCacheBinding) {
    return this.seal(JSON.stringify(value), binding)
  }

  openJson<T>(sealed: string, binding: ChatCacheBinding): T {
    return JSON.parse(this.open(sealed, binding)) as T
  }
}
