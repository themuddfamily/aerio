import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto'
const MAX_PLAINTEXT = 48 * 1024 * 1024
export const MAX_SYNC_BYTES = 70 * 1024 * 1024
const keyFor = (passphrase: string, salt: Buffer) => new Promise<Buffer>((resolve, reject) => scrypt(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)))
const aad = Buffer.from('aerio-settings-sync:1:scrypt-32768-8-1')
const base64 = (value: unknown, size?: number): Buffer => {
  if (typeof value !== 'string' || value.length > MAX_SYNC_BYTES || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid encrypted sync data.')
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value || size !== undefined && decoded.length !== size) throw new Error('Invalid encrypted sync data.')
  return decoded
}
export async function encryptSyncData(value: unknown, passphrase: string): Promise<string> {
  if (passphrase.length < 12 || passphrase.length > 1024) throw new Error('Use a sync passphrase of 12–1024 characters.')
  const plain = Buffer.from(JSON.stringify(value))
  if (plain.length > MAX_PLAINTEXT) throw new Error('Synchronized settings and template attachments exceed the 48 MB limit.')
  const salt = randomBytes(16), iv = randomBytes(12), key = await keyFor(passphrase, salt)
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad)
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
    return JSON.stringify({ format: 'aerio-settings-sync-encrypted', version: 1, kdf: 'scrypt-32768-8-1', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') })
  } finally { key.fill(0); plain.fill(0) }
}
export async function decryptSyncData(text: string, passphrase: string): Promise<unknown> {
  if (Buffer.byteLength(text) > MAX_SYNC_BYTES) throw new Error('The remote settings file is too large.')
  const document = JSON.parse(text)
  if (!document || document.format !== 'aerio-settings-sync-encrypted' || document.version !== 1 || document.kdf !== 'scrypt-32768-8-1') throw new Error('Unsupported encrypted settings format.')
  const salt = base64(document.salt, 16), iv = base64(document.iv, 12), tag = base64(document.tag, 16), ciphertext = base64(document.ciphertext)
  const key = await keyFor(passphrase, salt)
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad); cipher.setAuthTag(tag)
    let plain: Buffer
    try { plain = Buffer.concat([cipher.update(ciphertext), cipher.final()]) } catch { throw new Error('The sync passphrase is incorrect or the remote file was modified.') }
    try { if (plain.length > MAX_PLAINTEXT) throw new Error('The remote settings file is too large.'); return JSON.parse(plain.toString('utf8')) } finally { plain.fill(0) }
  } finally { key.fill(0) }
}
/** Canonical content digest ignores usage/edit timestamps that differ after import, while retaining every setting and attachment. */
export function syncDigest(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical)
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).filter(([key]) => !['exportedAt', 'createdAt', 'updatedAt', 'lastUsedAt'].includes(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)]))
    return item
  }
  return createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex')
}
