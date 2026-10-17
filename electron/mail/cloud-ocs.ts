import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import type { CloudCapabilityState, CloudLinkProblem, CloudShareOptions, CloudStorageCapabilities } from '../../src/cloud-attachment-types'
import { DAV_NS, parseMultistatus, propText } from '../productivity/dav-xml'
import { CloudProviderError, isAbort, readChunk, UploadSessionExpiredError, UPLOAD_CHUNK_BYTES, type StoredLink, type StoredUpload } from './cloud-attachments'
import { CloudAuthError, LINKED_UPLOAD_FOLDER, validExpiryDate, type LinkedFile, type LinkedShare, type LinkedStorageConnector, type LinkedUploadSession } from './cloud-storage-connector'

type HttpInit = Omit<RequestInit, 'headers'> & { headers?: Record<string, string>; duplex?: 'half' }

// ownCloud and Nextcloud: WebDAV for files (Nextcloud chunked upload v2 where the server offers
// it, otherwise one streamed PUT), the OCS Share API for public links, and OCS capabilities to
// learn which link settings the administrator enforces or allows.

export type OcsProvider = 'owncloud' | 'nextcloud'
const SHARE_API = 'ocs/v2.php/apps/files_sharing/api/v1/shares'
// Nextcloud keeps unfinished chunk folders for about a day before its cleanup job removes them.
const CHUNK_SESSION_LIFETIME_MS = 24 * 60 * 60_000
/** Nextcloud announced chunked upload v2 (MKCOL with Destination) in server 26. */
export const NEXTCLOUD_CHUNKING_V2_MAJOR = 26

const ocsLabel = (provider: OcsProvider) => provider === 'nextcloud' ? 'Nextcloud' : 'ownCloud'
const segments = (path: string) => path.split('/').filter(Boolean).map(encodeURIComponent).join('/')
const basicAuth = (username: string, password: string) => `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`

interface OcsEnvelope<T> { ocs?: { meta?: { status?: string; statuscode?: number; message?: string }; data?: T } }

export interface OcsDiscovery {
  userId: string
  displayName: string
  serverVersion?: number
  chunkedUpload: boolean
  capabilities: CloudStorageCapabilities
}

interface PublicSharingCapabilities {
  enabled?: boolean
  password?: { enforced?: boolean; enforced_for?: { read_only?: boolean } }
  expire_date?: { enabled?: boolean; days?: number | string; enforced?: boolean }
  upload?: boolean
}

/** Turns OCS `cloud/capabilities` data into what the composer shows. */
export function parseOcsCapabilities(provider: OcsProvider, data: unknown): Omit<OcsDiscovery, 'userId' | 'displayName'> {
  const root = (data && typeof data === 'object' ? data : {}) as { version?: { major?: number | string }; capabilities?: { files_sharing?: { api_enabled?: boolean; public?: PublicSharingCapabilities }; dav?: { chunking?: string } } }
  const major = Number(root.version?.major)
  const serverVersion = Number.isFinite(major) && major > 0 ? major : undefined
  const sharing = root.capabilities?.files_sharing
  const publicLinks = sharing?.public
  const linksEnabled = sharing?.api_enabled !== false && publicLinks?.enabled !== false && Boolean(publicLinks)
  const passwordEnforced = Boolean(publicLinks?.password?.enforced || publicLinks?.password?.enforced_for?.read_only)
  const days = Number(publicLinks?.expire_date?.days)
  const expiry: CloudCapabilityState = publicLinks?.expire_date?.enforced ? 'enforced' : 'available'
  const password: CloudCapabilityState = passwordEnforced ? 'enforced' : 'available'
  // Public editing of a single file follows the administrator's "allow public uploads" setting.
  const edit: CloudCapabilityState = publicLinks?.upload ? 'available' : 'unavailable'
  const chunkedUpload = provider === 'nextcloud' && Boolean(root.capabilities?.dav?.chunking) && (serverVersion ?? 0) >= NEXTCLOUD_CHUNKING_V2_MAJOR
  const notes: string[] = []
  if (!linksEnabled) notes.push(`Your ${ocsLabel(provider)} administrator has turned off public links, so files cannot be shared from this account.`)
  if (password === 'enforced') notes.push('The server requires a password on every public link.')
  if (expiry === 'enforced') notes.push(`The server requires links to expire${Number.isFinite(days) && days > 0 ? ` within ${days} days` : ''}.`)
  else if (publicLinks?.expire_date?.enabled && Number.isFinite(days) && days > 0) notes.push(`Links expire after ${days} days unless you choose a date.`)
  notes.push(chunkedUpload ? 'Large uploads go in chunks and resume after an interruption.' : 'Uploads go in one request; an interrupted upload starts again from the beginning.')
  return {
    ...(serverVersion ? { serverVersion } : {}),
    chunkedUpload,
    capabilities: {
      audiences: linksEnabled ? ['anyone'] : [],
      password: linksEnabled ? password : 'unavailable',
      expiry: linksEnabled ? expiry : 'unavailable',
      edit: linksEnabled ? edit : 'unavailable',
      ...(expiry === 'enforced' && Number.isFinite(days) && days > 0 ? { maxExpiryDays: days } : {}),
      ...(publicLinks?.expire_date?.enabled && Number.isFinite(days) && days > 0 ? { defaultExpiryDays: days } : {}),
      resumableUpload: chunkedUpload,
      notes
    }
  }
}

async function ocsError(response: Response, fallback: string) {
  const body = await response.json().catch(() => undefined) as OcsEnvelope<unknown> | undefined
  const message = body?.ocs?.meta?.message
  return new CloudProviderError(message ? `${fallback}: ${message}` : `${fallback} (${response.status})`, response.status, String(body?.ocs?.meta?.statuscode ?? response.status))
}

export interface OcsDiscoverOptions {
  provider: OcsProvider
  serverUrl: string
  username: string
  password: string
  fetch?: typeof fetch
}

/** Checks the app password and reads the user id and capabilities. */
export async function discoverOcsAccount(options: OcsDiscoverOptions): Promise<OcsDiscovery> {
  const request = options.fetch ?? fetch
  const headers = { Authorization: basicAuth(options.username, options.password), 'OCS-APIRequest': 'true', Accept: 'application/json' }
  const label = ocsLabel(options.provider)
  let user: Response
  try {
    user = await request(new URL('ocs/v1.php/cloud/user?format=json', options.serverUrl).toString(), { headers })
  } catch {
    throw new Error(`Aerio could not reach ${options.serverUrl}. Check the address and your connection.`)
  }
  if (user.status === 401 || user.status === 403) throw new Error(`${label} did not accept the user name and app password.`)
  if (!user.ok) throw new Error(`${options.serverUrl} does not look like ${label === 'Nextcloud' ? 'a Nextcloud' : 'an ownCloud'} server (${user.status}).`)
  const profile = (await user.json().catch(() => ({})) as OcsEnvelope<{ id?: string; 'display-name'?: string; displayname?: string }>).ocs?.data
  if (!profile?.id) throw new Error(`${label} did not identify the user.`)
  const capabilities = await request(new URL('ocs/v1.php/cloud/capabilities?format=json', options.serverUrl).toString(), { headers })
  if (!capabilities.ok) throw await ocsError(capabilities, `${label} did not report its sharing settings`)
  const data = (await capabilities.json() as OcsEnvelope<unknown>).ocs?.data
  return { userId: profile.id, displayName: profile['display-name'] ?? profile.displayname ?? profile.id, ...parseOcsCapabilities(options.provider, data) }
}

export interface OcsConnectorOptions extends Omit<OcsDiscoverOptions, 'password'> {
  userId: string
  password(): string | undefined
  chunkedUpload: boolean
  chunkBytes?: number
  now?(): number
}

export class OcsConnector implements LinkedStorageConnector {
  private readonly request: typeof fetch
  private readonly label: string

  constructor(private readonly options: OcsConnectorOptions) {
    this.request = options.fetch ?? fetch
    this.label = ocsLabel(options.provider)
  }

  private now() { return this.options.now?.() ?? Date.now() }
  private url(path: string) { return new URL(path, this.options.serverUrl).toString() }
  private filesRoot() { return this.url(`remote.php/dav/files/${encodeURIComponent(this.options.userId)}/`) }
  private fileUrl(relative: string) { return `${this.filesRoot()}${segments(relative)}` }

  private auth() {
    const password = this.options.password()
    if (!password) throw new CloudAuthError(`Enter the ${this.label} app password again to keep sharing from this account.`)
    return basicAuth(this.options.username, password)
  }

  private async send(url: string, init: HttpInit = {}) {
    const response = await this.request(url, { ...init, headers: { Authorization: this.auth(), ...init.headers } })
    if (response.status === 401) throw new CloudAuthError(`${this.label} no longer accepts the app password. Enter it again or create a new one.`)
    return response
  }

  private async ocs<T>(path: string, init: HttpInit = {}, fallback = `${this.label} rejected the request`): Promise<T> {
    const response = await this.send(this.url(`${path}${path.includes('?') ? '&' : '?'}format=json`), { ...init, headers: { 'OCS-APIRequest': 'true', Accept: 'application/json', ...init.headers } })
    if (!response.ok) throw await ocsError(response, fallback)
    const body = await response.json() as OcsEnvelope<T>
    const code = body.ocs?.meta?.statuscode
    // OCS v2 mirrors errors in the HTTP status, but some proxies rewrite it to 200.
    if (code !== undefined && code !== 100 && code !== 200) throw new CloudProviderError(`${fallback}: ${body.ocs?.meta?.message ?? code}`, code === 997 ? 401 : code, String(code))
    return body.ocs?.data as T
  }

  async capabilities() {
    const data = await this.ocs<unknown>('ocs/v1.php/cloud/capabilities', {}, `${this.label} did not report its sharing settings`)
    const parsed = parseOcsCapabilities(this.options.provider, data)
    return { ...parsed.capabilities, chunkedUpload: parsed.chunkedUpload, ...(parsed.serverVersion ? { serverVersion: parsed.serverVersion } : {}) }
  }

  private async exists(url: string) {
    const response = await this.send(url, { method: 'PROPFIND', headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' }, body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>' })
    if (response.status === 404) return false
    if (response.ok || response.status === 207) return true
    throw new CloudProviderError(`${this.label} could not check ${url} (${response.status})`, response.status)
  }

  /** Picks "name (2).ext" when the folder already has a file with that name. */
  private async freeName(name: string) {
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const extension = dot > 0 ? name.slice(dot) : ''
    for (let index = 1; index <= 50; index += 1) {
      const candidate = index === 1 ? name : `${stem} (${index})${extension}`
      if (!(await this.exists(this.fileUrl(`${LINKED_UPLOAD_FOLDER}/${candidate}`)))) return candidate
    }
    return `${stem} (${randomBytes(3).toString('hex')})${extension}`
  }

  async startUpload(name: string, _size: number, signal: AbortSignal): Promise<LinkedUploadSession> {
    const folder = await this.send(this.fileUrl(LINKED_UPLOAD_FOLDER), { method: 'MKCOL', signal })
    // 405 means the folder already exists.
    if (!folder.ok && folder.status !== 405) throw new CloudProviderError(`${this.label} could not create the “${LINKED_UPLOAD_FOLDER}” folder (${folder.status})`, folder.status)
    const finalName = await this.freeName(name)
    const remotePath = `${LINKED_UPLOAD_FOLDER}/${finalName}`
    if (!this.options.chunkedUpload) return { sessionUrl: '', remotePath }
    const sessionUrl = this.url(`remote.php/dav/uploads/${encodeURIComponent(this.options.userId)}/aerio-${randomBytes(12).toString('hex')}`)
    const created = await this.send(sessionUrl, { method: 'MKCOL', signal, headers: { Destination: this.fileUrl(remotePath) } })
    if (!created.ok) throw new CloudProviderError(`${this.label} did not start the chunked upload (${created.status})`, created.status)
    return { sessionUrl, remotePath, expiresAt: new Date(this.now() + CHUNK_SESSION_LIFETIME_MS).toISOString() }
  }

  private chunkBytes() { return this.options.chunkBytes ?? UPLOAD_CHUNK_BYTES }

  /** Lists the chunk folder; only consecutive complete chunks from 1 count. */
  async confirmedOffset(record: StoredUpload, signal: AbortSignal) {
    if (!record.sessionUrl) return 0
    const response = await this.send(record.sessionUrl, { method: 'PROPFIND', signal, headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }, body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/></d:prop></d:propfind>' })
    if (response.status === 404 || response.status === 410) throw new UploadSessionExpiredError()
    if (response.status !== 207 && !response.ok) throw new CloudProviderError(`${this.label} could not report the upload progress (${response.status})`, response.status)
    const sizes = new Map<number, number>()
    for (const item of parseMultistatus(await response.text()).responses) {
      const number = Number(decodeURIComponent(item.href.replace(/\/$/, '').split('/').pop() ?? ''))
      if (Number.isInteger(number) && number > 0) sizes.set(number, Number(propText(item, DAV_NS, 'getcontentlength') ?? 0))
    }
    const chunk = this.chunkBytes()
    let offset = 0
    for (let number = 1; sizes.has(number); number += 1) {
      const expected = Math.min(chunk, record.totalBytes - offset)
      if (sizes.get(number) !== expected) break
      offset += expected
    }
    return offset
  }

  private async assemble(record: StoredUpload, signal: AbortSignal) {
    const response = await this.send(`${record.sessionUrl}/.file`, { method: 'MOVE', signal, headers: { Destination: this.fileUrl(record.remotePath!), 'OC-Total-Length': String(record.totalBytes) } })
    if (response.status === 404) throw new UploadSessionExpiredError()
    if (!response.ok) throw this.uploadError(response.status)
  }

  private uploadError(status: number) {
    if (status === 507) return new CloudProviderError(`Your ${this.label} storage is full.`, status)
    if (status === 413) return new CloudProviderError(`The ${this.label} server does not accept files this large.`, status)
    return new CloudProviderError(`${this.label} rejected the upload (${status})`, status)
  }

  async transfer(record: StoredUpload, start: number, signal: AbortSignal, confirmed: (offset: number) => void): Promise<LinkedFile> {
    if (!record.remotePath) throw new UploadSessionExpiredError()
    const file = { id: `/${record.remotePath}`, name: record.remotePath.split('/').pop() ?? record.name }
    if (!record.sessionUrl) {
      await this.put(record, signal, confirmed)
      return file
    }
    const chunk = this.chunkBytes()
    let offset = start
    let retries = 0
    while (offset < record.totalBytes) {
      const end = Math.min(offset + chunk, record.totalBytes)
      const number = Math.floor(offset / chunk) + 1
      const body = new Uint8Array(await readChunk(record.path, offset, end))
      let response: Response
      try {
        response = await this.send(`${record.sessionUrl}/${number}`, { method: 'PUT', signal, headers: { Destination: this.fileUrl(record.remotePath), 'OC-Total-Length': String(record.totalBytes), 'Content-Length': String(body.length) }, body: body as unknown as BodyInit })
      } catch (error) {
        if (isAbort(error, signal) || error instanceof CloudAuthError || retries >= 2) throw error
        retries += 1
        offset = await this.confirmedOffset(record, signal)
        continue
      }
      if (response.status === 404 || response.status === 410) throw new UploadSessionExpiredError()
      if (response.status >= 500 && response.status !== 507 && retries < 2) {
        retries += 1
        offset = await this.confirmedOffset(record, signal)
        continue
      }
      if (!response.ok) throw this.uploadError(response.status)
      offset = end
      retries = 0
      confirmed(offset)
    }
    await this.assemble(record, signal)
    return file
  }

  /** Servers without chunked upload v2 get one streamed PUT, retried from the start. */
  private async put(record: StoredUpload, signal: AbortSignal, confirmed: (offset: number) => void) {
    const step = this.chunkBytes()
    for (let attempt = 0; ; attempt += 1) {
      let sent = 0
      let reported = 0
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          sent += chunk.length
          if (sent - reported >= step && sent < record.totalBytes) { reported = sent; confirmed(sent) }
          callback(null, chunk)
        }
      })
      const stream = Readable.toWeb(createReadStream(record.path).pipe(counter)) as unknown as ReadableStream<Uint8Array>
      let response: Response
      try {
        response = await this.send(this.fileUrl(record.remotePath!), {
          method: 'PUT', signal, body: stream as unknown as BodyInit,
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(record.totalBytes), 'OC-Total-Length': String(record.totalBytes) },
          duplex: 'half'
        } as HttpInit)
      } catch (error) {
        if (isAbort(error, signal) || error instanceof CloudAuthError || attempt >= 2) throw error
        continue
      }
      if (response.status >= 500 && response.status !== 507 && attempt < 2) continue
      if (!response.ok) throw this.uploadError(response.status)
      confirmed(record.totalBytes)
      return
    }
  }

  async cancelUpload(record: StoredUpload) {
    if (record.sessionUrl) await this.send(record.sessionUrl, { method: 'DELETE' }).catch(() => undefined)
  }

  async share(file: LinkedFile, share: CloudShareOptions): Promise<LinkedShare> {
    const form = new URLSearchParams({ path: file.id, shareType: '3', permissions: share.role === 'edit' ? '3' : '1' })
    if (share.password) form.set('password', share.password)
    if (share.expiresOn) form.set('expireDate', validExpiryDate(share.expiresOn, this.now()))
    try {
      const data = await this.ocs<{ id?: string | number; url?: string; expiration?: string | null }>(SHARE_API, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString()
      }, `${this.label} could not create a public link`)
      if (!data?.url || data.id === undefined) throw new Error(`${this.label} did not return a public link`)
      const expiry = data.expiration ? data.expiration.slice(0, 10) : undefined
      return { url: data.url, permissionIds: [String(data.id)], ...(expiry ? { expiresAt: `${expiry}T23:59:59Z` } : {}) }
    } catch (error) {
      if (error instanceof CloudProviderError && (error.status === 403 || error.status === 400)) {
        const detail = error.message.replace(/^[^:]+:\s*/, '')
        throw new Error(`${this.label} refused the link: ${detail}`)
      }
      throw error
    }
  }

  async deleteFile(file: LinkedFile) {
    await this.send(this.fileUrl(file.id), { method: 'DELETE' }).catch(() => undefined)
  }

  async check(link: StoredLink): Promise<CloudLinkProblem | undefined> {
    try {
      if (!(await this.exists(this.fileUrl(link.fileId)))) return 'deleted'
      for (const id of link.permissionIds) {
        let data: Array<{ expiration?: string | null }> | { expiration?: string | null } | undefined
        try {
          data = await this.ocs(`${SHARE_API}/${encodeURIComponent(id)}`, {}, `${this.label} could not check the link`)
        } catch (error) {
          if (error instanceof CloudProviderError && error.status === 404) return 'revoked'
          throw error
        }
        const share = Array.isArray(data) ? data[0] : data
        if (!share) return 'revoked'
        const expiry = share.expiration ? Date.parse(`${share.expiration.slice(0, 10)}T23:59:59Z`) : undefined
        if (expiry !== undefined && expiry <= this.now()) return 'expired'
      }
      return undefined
    } catch (error) {
      if (error instanceof CloudAuthError || (error instanceof CloudProviderError && error.status === 403)) return 'permission-denied'
      throw error
    }
  }

  async revoke(link: StoredLink) {
    for (const id of link.permissionIds) {
      try {
        await this.ocs(`${SHARE_API}/${encodeURIComponent(id)}`, { method: 'DELETE' }, `${this.label} could not turn off the link`)
      } catch (error) {
        if (error instanceof CloudProviderError && error.status === 404) continue
        throw error
      }
    }
  }

  async signOut() {
    // App passwords are revoked in the server's security settings; Aerio only forgets its copy,
    // because the same app password may also be used for calendars and contacts.
  }
}
