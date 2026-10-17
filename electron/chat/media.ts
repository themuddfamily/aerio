/**
 * Chat attachment policy and the Matrix v2 encrypted-attachment format
 * (AES-256-CTR with a SHA-256 ciphertext hash). Uses WebCrypto so the same
 * code runs in the main process and the isolated chat service. Limits are
 * measured on real bytes before encryption and enforced while streaming
 * downloads, and the ciphertext hash is verified before anything is decrypted.
 * Remote names never choose a local path.
 */
export const CHAT_ATTACHMENT_LIMIT = 25 * 1024 * 1024

export function attachmentLimit(serverLimit?: number) {
  return typeof serverLimit === 'number' && serverLimit > 0 ? Math.min(CHAT_ATTACHMENT_LIMIT, serverLimit) : CHAT_ATTACHMENT_LIMIT
}

export function assertAttachmentSize(size: number, serverLimit?: number) {
  const limit = attachmentLimit(serverLimit)
  if (!Number.isFinite(size) || size < 0) throw new Error('The file size could not be measured')
  if (size === 0) throw new Error('Empty files cannot be sent')
  if (size > limit) throw new Error(`Chat attachments are limited to ${Math.floor(limit / 1024 / 1024)} MiB`)
}

/** A display-only name: no path separators, control characters or leading dots; bounded length. */
export function sanitizeMediaName(name: unknown) {
  const base = typeof name === 'string' ? name.split(/[\\/]/).pop() ?? '' : ''
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/^[.\s]+/, '').trim().slice(0, 180)
  return cleaned || 'attachment'
}

const SAFE_MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i
/** Active types are never treated as viewable; they are saved only as opaque files. */
const ACTIVE_MIME = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|application\/javascript|text\/javascript|application\/x-msdownload)$/i

export function sanitizeMime(value: unknown) {
  return typeof value === 'string' && SAFE_MIME.test(value) && value.length <= 127 && !ACTIVE_MIME.test(value) ? value.toLowerCase() : 'application/octet-stream'
}

export interface ParsedMxc { serverName: string; mediaId: string }

export function parseMxc(value: unknown): ParsedMxc {
  const match = typeof value === 'string' ? /^mxc:\/\/([A-Za-z0-9.\-:[\]]{1,255})\/([A-Za-z0-9_-]{1,255})$/.exec(value) : null
  if (!match) throw new Error('This attachment reference is not valid')
  return { serverName: match[1], mediaId: match[2] }
}

/** Authenticated-media download path for a validated mxc reference; arbitrary message URLs are never fetched. */
export function mediaDownloadPath(mxc: string) {
  const { serverName, mediaId } = parseMxc(mxc)
  return `/_matrix/client/v1/media/download/${encodeURIComponent(serverName)}/${encodeURIComponent(mediaId)}`
}

export interface EncryptedFileInfo {
  url?: string
  key: { kty: 'oct'; key_ops: string[]; alg: 'A256CTR'; k: string; ext: true }
  iv: string
  hashes: { sha256: string }
  v: 'v2'
}

const subtle = () => globalThis.crypto.subtle
const unpadded = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=+$/, '')
const unpaddedUrl = (bytes: Uint8Array) => unpadded(bytes).replace(/\+/g, '-').replace(/\//g, '_')
function decodeBase64(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export function validEncryptedFile(value: unknown): value is EncryptedFileInfo {
  if (!value || typeof value !== 'object') return false
  const file = value as Partial<EncryptedFileInfo>
  return file.v === 'v2' && typeof file.iv === 'string' && typeof file.hashes?.sha256 === 'string' &&
    file.key?.kty === 'oct' && file.key.alg === 'A256CTR' && typeof file.key.k === 'string' && Array.isArray(file.key.key_ops) && file.key.key_ops.includes('decrypt')
}

export async function encryptAttachment(plaintext: Uint8Array): Promise<{ ciphertext: Uint8Array; info: EncryptedFileInfo }> {
  const keyBytes = globalThis.crypto.getRandomValues(new Uint8Array(32))
  // Matrix v2: a random 64-bit IV prefix with a zero 64-bit counter.
  const iv = new Uint8Array(16)
  globalThis.crypto.getRandomValues(iv.subarray(0, 8))
  const key = await subtle().importKey('raw', keyBytes, { name: 'AES-CTR' }, true, ['encrypt', 'decrypt'])
  const ciphertext = new Uint8Array(await subtle().encrypt({ name: 'AES-CTR', counter: iv, length: 64 }, key, plaintext as Uint8Array<ArrayBuffer>))
  const hash = new Uint8Array(await subtle().digest('SHA-256', ciphertext))
  return {
    ciphertext,
    info: { v: 'v2', iv: unpadded(iv), hashes: { sha256: unpadded(hash) }, key: { kty: 'oct', key_ops: ['encrypt', 'decrypt'], alg: 'A256CTR', k: unpaddedUrl(keyBytes), ext: true } }
  }
}

/** Verifies the ciphertext hash, then decrypts. Tampered or truncated ciphertext never reaches decryption. */
export async function decryptAttachment(ciphertext: Uint8Array, info: unknown): Promise<Uint8Array> {
  if (!validEncryptedFile(info)) throw new Error('This attachment is missing its encryption details')
  const hash = new Uint8Array(await subtle().digest('SHA-256', ciphertext as Uint8Array<ArrayBuffer>))
  if (unpadded(hash) !== info.hashes.sha256.replace(/=+$/, '')) throw new Error('This attachment failed its integrity check')
  const key = await subtle().importKey('raw', decodeBase64(info.key.k), { name: 'AES-CTR' }, false, ['decrypt'])
  return new Uint8Array(await subtle().decrypt({ name: 'AES-CTR', counter: decodeBase64(info.iv), length: 64 }, key, ciphertext as Uint8Array<ArrayBuffer>))
}

/** Reads a response body, aborting once it exceeds `limit` bytes (Content-Length is not trusted). */
export async function readBoundedBody(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) throw new Error('This attachment is larger than Aerio allows')
  if (!response.body) return new Uint8Array(await response.arrayBuffer())
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      throw new Error('This attachment is larger than Aerio allows')
    }
    chunks.push(value)
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return result
}
