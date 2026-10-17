import { open, stat } from 'node:fs/promises'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { IpcMain } from 'electron'
import type { MailProviderId } from '../../src/mail-types'
import type {
  CloudAttachmentStatus,
  CloudLinkIssue,
  CloudPendingUpload,
  CloudShareAudience,
  CloudShareOptions,
  CloudSharedLink,
  CloudStorageProvider,
  CloudUploadProgress,
  CloudUploadResult
} from '../../src/cloud-attachment-types'
import { isCompleteMailAddress } from '../../src/lib/mail-address'
import { cloudProviderName, shareScopeLabel } from '../../src/lib/cloud-attachments'
import type { LinkedCloudStorageService } from './cloud-linked-storage'

// Cloud attachments upload a file with the mail account's own OAuth grant and
// insert a sharing link instead of the file. Tokens never leave the main
// process; the renderer only sees progress, links, and plain-language scope.

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const DRIVE_SCOPES = [DRIVE_FILE_SCOPE, 'https://www.googleapis.com/auth/drive']
export const ONEDRIVE_SCOPE = 'Files.ReadWrite'
const ONEDRIVE_SCOPES = [ONEDRIVE_SCOPE, 'Files.ReadWrite.All']

// Gmail documents a 25 MB attachment limit. Aerio sends Microsoft mail as one
// MIME request to Graph, which is capped near 4 MB after base64 encoding.
export const GMAIL_ATTACHMENT_LIMIT = 25 * 1024 * 1024
export const MICROSOFT_ATTACHMENT_LIMIT = 3 * 1024 * 1024
const IMAP_ATTACHMENT_LIMIT = 25 * 1024 * 1024

// 5 MiB is a multiple of both Drive's 256 KiB and OneDrive's 320 KiB chunk units.
export const UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024
const DRIVE_SESSION_LIFETIME_MS = 7 * 24 * 60 * 60_000
const ONEDRIVE_FOLDER = 'Aerio attachments'
const MAX_TRACKED_LINKS = 500
const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const GRAPH_API = 'https://graph.microsoft.com/v1.0'

export class CloudProviderError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
    this.name = 'CloudProviderError'
  }
}

export class CloudPermissionError extends Error {
  constructor(message: string, readonly scope: string) {
    super(message)
    this.name = 'CloudPermissionError'
  }
}

export class UploadSessionExpiredError extends Error {
  constructor() {
    super('The interrupted upload session has expired. Start the upload again.')
    this.name = 'UploadSessionExpiredError'
  }
}

export interface StoredUpload extends CloudPendingUpload {
  sessionUrl: string
  modifiedAt: number
  /** Connected storage accounts: bytes the provider has acknowledged so far. */
  confirmedBytes?: number
  /** Connected storage accounts: where the finished file is written. */
  remotePath?: string
}

export interface StoredLink extends CloudSharedLink {
  permissionIds: string[]
}

interface StoredState {
  uploads: Record<string, StoredUpload>
  links: StoredLink[]
}

export interface CloudStateCodec {
  encode(value: string): string
  decode(value: string): string
}

/**
 * Upload sessions and links Aerio created. Session URLs are short-lived upload
 * capabilities (not OAuth tokens), so the main process encrypts the file at rest.
 */
export class CloudAttachmentStateStore {
  private state: StoredState = { uploads: {}, links: [] }

  constructor(private readonly path: string, private readonly codec: CloudStateCodec = { encode: (value) => value, decode: (value) => value }) {
    try {
      const parsed = JSON.parse(codec.decode(readFileSync(path, 'utf8'))) as Partial<StoredState>
      this.state = { uploads: parsed.uploads ?? {}, links: Array.isArray(parsed.links) ? parsed.links : [] }
    } catch {
      // A missing or unreadable file only loses resumability; uploads restart from zero.
    }
  }

  private save() {
    try {
      const temporary = `${this.path}.partial`
      writeFileSync(temporary, this.codec.encode(JSON.stringify(this.state)), { mode: 0o600 })
      renameSync(temporary, this.path)
    } catch {
      // Without secure storage (or a writable profile) uploads still work; they just cannot resume after a restart.
    }
  }

  upload(id: string) { return this.state.uploads[id] }
  uploads() { return Object.values(this.state.uploads) }
  putUpload(value: StoredUpload) { this.state.uploads[value.uploadId] = value; this.save() }
  removeUpload(id: string) {
    if (!this.state.uploads[id]) return
    delete this.state.uploads[id]
    this.save()
  }
  links() { return this.state.links }
  /** Drops interrupted uploads and link records that match, for example when a storage account is disconnected. */
  removeWhere(upload: (value: StoredUpload) => boolean, link: (value: StoredLink) => boolean) {
    const uploads = Object.fromEntries(Object.entries(this.state.uploads).filter(([, value]) => !upload(value)))
    const links = this.state.links.filter((value) => !link(value))
    if (Object.keys(uploads).length === Object.keys(this.state.uploads).length && links.length === this.state.links.length) return
    this.state = { uploads, links }
    this.save()
  }
  removeLink(url: string) {
    const links = this.state.links.filter((value) => value.url !== url)
    if (links.length === this.state.links.length) return
    this.state.links = links
    this.save()
  }
  addLink(value: StoredLink) {
    this.state.links = [...this.state.links.filter((item) => item.url !== value.url), value].slice(-MAX_TRACKED_LINKS)
    this.save()
  }
}

export interface CloudAttachmentDependencies {
  account(accountId: string): Promise<{ id: string; provider: MailProviderId; email: string } | undefined>
  googleToken(accountId: string): Promise<string>
  microsoftToken(accountId: string): Promise<string>
  grantedScopes(accountId: string, provider: 'gmail' | 'microsoft'): string[] | undefined
  /** Interactive reconnect that adds `scopes` to the account's existing grant. */
  authorize(account: { id: string; provider: 'gmail' | 'microsoft'; email: string }, scopes: string[]): Promise<void>
  /** Only files the user picked in a dialog (or staged by Aerio) may be uploaded. */
  isApprovedPath(path: string): boolean
  state: CloudAttachmentStateStore
  /** Connected Dropbox, ownCloud and Nextcloud accounts, usable from any mail account. */
  linked?: LinkedCloudStorageService
  fetch?: typeof fetch
  now?(): number
  chunkBytes?: number
}

export function cloudProviderFor(provider: MailProviderId): CloudStorageProvider | undefined {
  return provider === 'gmail' ? 'google-drive' : provider === 'microsoft' ? 'onedrive' : undefined
}

export function attachmentLimitFor(provider: MailProviderId) {
  return provider === 'gmail' ? GMAIL_ATTACHMENT_LIMIT : provider === 'microsoft' ? MICROSOFT_ATTACHMENT_LIMIT : IMAP_ATTACHMENT_LIMIT
}

export function cloudAudiences(provider: CloudStorageProvider): CloudShareAudience[] {
  // Drive domain sharing needs the Workspace domain name; OneDrive resolves "organization" itself.
  return provider === 'onedrive' ? ['anyone', 'organization', 'recipients'] : ['anyone', 'recipients']
}

const providerName = cloudProviderName

const bareAddress = (value: string) => value.trim().match(/<([^<>]+)>$/)?.[1].trim() ?? value.trim()

export function validateShareOptions(provider: CloudStorageProvider, value: CloudShareOptions): CloudShareOptions {
  if (!value || typeof value !== 'object') throw new Error('Choose who can open the shared file')
  if (!cloudAudiences(provider).includes(value.audience)) throw new Error(`${providerName(provider)} cannot share with that audience`)
  if (value.role !== 'view' && value.role !== 'edit') throw new Error('Choose view or edit access')
  if (value.audience !== 'recipients') return { audience: value.audience, role: value.role }
  const recipients = Array.from(new Set((Array.isArray(value.recipients) ? value.recipients : []).map((item) => bareAddress(String(item)).toLowerCase()).filter(Boolean)))
  if (!recipients.length) throw new Error('Add recipients before sharing only with them')
  if (recipients.length > 100) throw new Error('Share with 100 recipients or fewer, or use a link')
  if (recipients.some((item) => !isCompleteMailAddress(item))) throw new Error('Correct the recipient addresses before sharing with them')
  return { audience: 'recipients', role: value.role, recipients }
}

export async function readChunk(path: string, start: number, end: number) {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(end - start)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, start + offset)
      if (!bytesRead) throw new Error('The file changed while it was uploading')
      offset += bytesRead
    }
    return buffer
  } finally {
    await handle.close()
  }
}

export async function errorFrom(response: Response, fallback: string) {
  const body = await response.json().catch(() => undefined) as { error?: { message?: string; code?: string | number; errors?: Array<{ reason?: string }>; status?: string } } | undefined
  const code = body?.error?.errors?.[0]?.reason ?? (typeof body?.error?.code === 'string' ? body.error.code : body?.error?.status)
  return new CloudProviderError(body?.error?.message || `${fallback} (${response.status})`, response.status, code)
}

function isScopeError(error: unknown) {
  if (!(error instanceof CloudProviderError) || (error.status !== 403 && error.status !== 401)) return false
  return /insufficient|scope|ACCESS_TOKEN_SCOPE/i.test(`${error.code ?? ''} ${error.message}`)
}

export function isAbort(error: unknown, signal?: AbortSignal) {
  return Boolean(signal?.aborted) || (error instanceof Error && error.name === 'AbortError')
}

export class CloudAttachmentService {
  private readonly active = new Map<string, AbortController>()

  constructor(private readonly dependencies: CloudAttachmentDependencies) {}

  private fetch(input: string, init?: RequestInit) {
    return (this.dependencies.fetch ?? fetch)(input, init)
  }

  private now() {
    return this.dependencies.now?.() ?? Date.now()
  }

  private async resolve(accountId: string) {
    if (typeof accountId !== 'string' || !accountId) throw new Error('Invalid account id')
    const account = await this.dependencies.account(accountId)
    if (!account) throw new Error('Account not found')
    return account
  }

  private connected(accountId: string, provider: 'gmail' | 'microsoft') {
    // Legacy grants without a stored scope list predate cloud attachments, so they lack it.
    const granted = new Set(this.dependencies.grantedScopes(accountId, provider) ?? [])
    return (provider === 'gmail' ? DRIVE_SCOPES : ONEDRIVE_SCOPES).some((scope) => granted.has(scope))
  }

  private permissionMessage(provider: CloudStorageProvider) {
    return provider === 'google-drive'
      ? 'Aerio needs permission to create and share the files it uploads to Google Drive (drive.file). It cannot see your other Drive files. Connect Google Drive to continue.'
      : 'Aerio needs permission to upload and share files in your OneDrive (Files.ReadWrite). Connect OneDrive to continue. Work or school accounts may need administrator approval.'
  }

  async status(accountId: string): Promise<CloudAttachmentStatus> {
    const account = await this.resolve(accountId)
    const provider = cloudProviderFor(account.provider)
    const base = { accountId, mailProvider: account.provider, attachmentLimitBytes: attachmentLimitFor(account.provider) }
    if (!provider || (account.provider !== 'gmail' && account.provider !== 'microsoft')) {
      return { ...base, supported: false, connected: false, audiences: [], message: 'This account has no storage of its own. Connect a Dropbox, ownCloud or Nextcloud account to share links from it, or attach the file normally.' }
    }
    const connected = this.connected(accountId, account.provider)
    return {
      ...base,
      provider,
      supported: true,
      connected,
      requiredScope: account.provider === 'gmail' ? DRIVE_FILE_SCOPE : ONEDRIVE_SCOPE,
      audiences: cloudAudiences(provider),
      ...(connected ? {} : { message: this.permissionMessage(provider) })
    }
  }

  /** Incremental consent: adds only the storage scope; existing mail grants are kept. */
  async connect(accountId: string) {
    const account = await this.resolve(accountId)
    if (account.provider !== 'gmail' && account.provider !== 'microsoft') throw new Error('Cloud links are not available for IMAP accounts')
    await this.dependencies.authorize({ id: account.id, provider: account.provider, email: account.email }, [account.provider === 'gmail' ? DRIVE_FILE_SCOPE : ONEDRIVE_SCOPE])
    const next = await this.status(accountId)
    if (!next.connected) return { ...next, message: `The storage permission was not granted. ${next.message ?? ''}`.trim() }
    return next
  }

  private async storageAccount(accountId: string) {
    const account = await this.resolve(accountId)
    const provider = cloudProviderFor(account.provider)
    if (!provider || (account.provider !== 'gmail' && account.provider !== 'microsoft')) throw new Error('Cloud links are not available for IMAP accounts')
    if (!this.connected(accountId, account.provider)) throw new CloudPermissionError(this.permissionMessage(provider), account.provider === 'gmail' ? DRIVE_FILE_SCOPE : ONEDRIVE_SCOPE)
    return { account, provider }
  }

  private token(accountId: string, provider: CloudStorageProvider) {
    return provider === 'google-drive' ? this.dependencies.googleToken(accountId) : this.dependencies.microsoftToken(accountId)
  }

  private async api<T>(accountId: string, provider: CloudStorageProvider, url: string, init: RequestInit = {}, fallback = 'The storage provider rejected the request'): Promise<T> {
    const response = await this.fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${await this.token(accountId, provider)}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers }
    })
    if (!response.ok) {
      const error = await errorFrom(response, fallback)
      if (isScopeError(error)) throw new CloudPermissionError(this.permissionMessage(provider), provider === 'google-drive' ? DRIVE_FILE_SCOPE : ONEDRIVE_SCOPE)
      throw error
    }
    return (response.status === 204 ? undefined : await response.json().catch(() => undefined)) as T
  }

  private async createSession(accountId: string, provider: CloudStorageProvider, name: string, size: number, signal: AbortSignal) {
    if (provider === 'google-drive') {
      const response = await this.fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink`, {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Bearer ${await this.token(accountId, provider)}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Length': String(size),
          'X-Upload-Content-Type': 'application/octet-stream'
        },
        body: JSON.stringify({ name })
      })
      const location = response.headers.get('location')
      if (!response.ok || !location) {
        const error = await errorFrom(response, 'Google Drive did not start the upload')
        if (isScopeError(error)) throw new CloudPermissionError(this.permissionMessage(provider), DRIVE_FILE_SCOPE)
        throw error
      }
      return { sessionUrl: location, expiresAt: new Date(this.now() + DRIVE_SESSION_LIFETIME_MS).toISOString() }
    }
    const session = await this.api<{ uploadUrl?: string; expirationDateTime?: string }>(accountId, provider,
      `${GRAPH_API}/me/drive/root:/${encodeURIComponent(ONEDRIVE_FOLDER)}/${encodeURIComponent(name)}:/createUploadSession`,
      { method: 'POST', signal, body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename' } }) },
      'OneDrive did not start the upload')
    if (!session?.uploadUrl) throw new Error('OneDrive did not return an upload session')
    return { sessionUrl: session.uploadUrl, expiresAt: session.expirationDateTime }
  }

  /** Asks the provider how much of an interrupted upload it already holds. */
  private async sessionOffset(record: StoredUpload, signal: AbortSignal): Promise<{ offset: number; file?: { id: string; name?: string; url?: string } }> {
    if (record.provider === 'google-drive') {
      const response = await this.fetch(record.sessionUrl, { method: 'PUT', signal, headers: { 'Content-Range': `bytes */${record.totalBytes}`, 'Content-Length': '0' } })
      if (response.status === 404 || response.status === 410) throw new UploadSessionExpiredError()
      if (response.status === 308) return { offset: rangeEnd(response.headers.get('range')) }
      if (response.ok) {
        const file = await response.json() as { id: string; name?: string; webViewLink?: string }
        return { offset: record.totalBytes, file: { id: file.id, name: file.name, url: file.webViewLink } }
      }
      throw await errorFrom(response, 'Google Drive could not report the upload progress')
    }
    // OneDrive upload URLs are pre-authenticated and must not carry the bearer token.
    const response = await this.fetch(record.sessionUrl, { method: 'GET', signal })
    if (response.status === 404 || response.status === 410) throw new UploadSessionExpiredError()
    if (!response.ok) throw await errorFrom(response, 'OneDrive could not report the upload progress')
    const session = await response.json() as { nextExpectedRanges?: string[] }
    return { offset: Number.parseInt(session.nextExpectedRanges?.[0] ?? '0', 10) || 0 }
  }

  private async transfer(record: StoredUpload, start: number, signal: AbortSignal, progress?: (value: CloudUploadProgress) => void) {
    const chunkBytes = this.dependencies.chunkBytes ?? UPLOAD_CHUNK_BYTES
    let offset = start
    let retries = 0
    while (true) {
      const end = Math.min(offset + chunkBytes, record.totalBytes)
      const body = await readChunk(record.path, offset, end)
      let response: Response
      try {
        response = await this.fetch(record.sessionUrl, {
          method: 'PUT',
          signal,
          headers: { 'Content-Length': String(end - offset), 'Content-Range': `bytes ${offset}-${end - 1}/${record.totalBytes}` },
          body: new Uint8Array(body)
        })
      } catch (error) {
        if (isAbort(error, signal) || retries >= 2) throw error
        // A dropped connection may still have delivered part of the chunk.
        retries += 1
        offset = (await this.sessionOffset(record, signal)).offset
        continue
      }
      if (response.status === 404 || response.status === 410) throw new UploadSessionExpiredError()
      if (response.status >= 500 && retries < 2) {
        retries += 1
        offset = (await this.sessionOffset(record, signal)).offset
        continue
      }
      if (record.provider === 'google-drive' && response.status === 308) {
        offset = rangeEnd(response.headers.get('range'))
      } else if (record.provider === 'onedrive' && response.status === 202) {
        const next = await response.json().catch(() => ({})) as { nextExpectedRanges?: string[] }
        offset = Number.parseInt(next.nextExpectedRanges?.[0] ?? String(end), 10)
      } else if (response.ok) {
        progress?.({ uploadId: record.uploadId, name: record.name, sentBytes: record.totalBytes, totalBytes: record.totalBytes })
        const file = await response.json() as { id: string; name?: string; webViewLink?: string; webUrl?: string }
        return { id: file.id, name: file.name, url: file.webViewLink ?? file.webUrl }
      } else {
        throw await errorFrom(response, `${providerName(record.provider)} rejected the upload`)
      }
      retries = 0
      progress?.({ uploadId: record.uploadId, name: record.name, sentBytes: offset, totalBytes: record.totalBytes })
    }
  }

  private async share(accountId: string, provider: CloudStorageProvider, file: { id: string; url?: string }, share: CloudShareOptions) {
    const id = encodeURIComponent(file.id)
    if (provider === 'google-drive') {
      const role = share.role === 'edit' ? 'writer' : 'reader'
      const permissionIds: string[] = []
      const targets = share.audience === 'anyone' ? [{ type: 'anyone', role, allowFileDiscovery: false }] : (share.recipients ?? []).map((emailAddress) => ({ type: 'user', role, emailAddress }))
      for (const target of targets) {
        try {
          const permission = await this.api<{ id: string }>(accountId, provider, `${DRIVE_API}/files/${id}/permissions?sendNotificationEmail=false&fields=id`, { method: 'POST', body: JSON.stringify(target) }, 'Google Drive could not share the file')
          permissionIds.push(permission.id)
        } catch (error) {
          if (error instanceof CloudProviderError && 'emailAddress' in target && error.status === 400) {
            throw new Error(`Google Drive could not share with ${target.emailAddress} without emailing them (they may not have a Google account). Choose “Anyone with the link” instead.`)
          }
          if (error instanceof CloudProviderError && error.status === 403 && share.audience === 'anyone') {
            throw new Error('Your Google Workspace administrator does not allow sharing files with anyone who has the link. Share only with the recipients instead.')
          }
          throw error
        }
      }
      const url = file.url ?? (await this.api<{ webViewLink?: string }>(accountId, provider, `${DRIVE_API}/files/${id}?fields=webViewLink`)).webViewLink
      if (!url) throw new Error('Google Drive did not return a sharing link')
      return { url, permissionIds }
    }
    const item = `${GRAPH_API}/me/drive/items/${id}`
    const roles = [share.role === 'edit' ? 'write' : 'read']
    if (share.audience === 'recipients') {
      const result = await this.api<{ value?: Array<{ id: string; link?: { webUrl?: string }; expirationDateTime?: string }> }>(accountId, provider, `${item}/invite`, {
        method: 'POST',
        body: JSON.stringify({ recipients: (share.recipients ?? []).map((email) => ({ email })), requireSignIn: true, sendInvitation: false, roles })
      }, 'OneDrive could not share the file')
      const url = result.value?.find((permission) => permission.link?.webUrl)?.link?.webUrl ?? file.url
      if (!url) throw new Error('OneDrive did not return a sharing link')
      return { url, permissionIds: (result.value ?? []).map((permission) => permission.id), expiresAt: result.value?.[0]?.expirationDateTime }
    }
    try {
      const result = await this.api<{ id: string; link?: { webUrl?: string }; expirationDateTime?: string }>(accountId, provider, `${item}/createLink`, {
        method: 'POST',
        body: JSON.stringify({ type: share.role, scope: share.audience === 'anyone' ? 'anonymous' : 'organization' })
      }, 'OneDrive could not create a sharing link')
      if (!result.link?.webUrl) throw new Error('OneDrive did not return a sharing link')
      return { url: result.link.webUrl, permissionIds: [result.id], expiresAt: result.expirationDateTime }
    } catch (error) {
      if (error instanceof CloudProviderError && (error.status === 403 || error.status === 400 || error.status === 501)) {
        throw new Error(share.audience === 'anyone'
          ? 'OneDrive does not allow links that work without signing in for this account. Choose your organization or the recipients instead.'
          : 'This OneDrive account cannot create organization links (personal accounts have no organization). Choose another audience.')
      }
      throw error
    }
  }

  private async deleteRemoteFile(accountId: string, provider: CloudStorageProvider, fileId: string) {
    const url = provider === 'google-drive' ? `${DRIVE_API}/files/${encodeURIComponent(fileId)}` : `${GRAPH_API}/me/drive/items/${encodeURIComponent(fileId)}`
    await this.api(accountId, provider, url, { method: 'DELETE' }).catch(() => undefined)
  }

  private async cancelSession(record: StoredUpload) {
    // Both providers discard an unfinished session on DELETE; failures leave it to expire.
    await this.fetch(record.sessionUrl, { method: 'DELETE' }).catch(() => undefined)
  }

  private async complete(record: StoredUpload, file: { id: string; name?: string; url?: string }): Promise<CloudUploadResult> {
    let shared: { url: string; permissionIds: string[]; expiresAt?: string }
    try {
      shared = await this.share(record.accountId, record.provider, file, record.share)
    } catch (error) {
      // An unshared upload would only clutter the user's storage.
      await this.deleteRemoteFile(record.accountId, record.provider, file.id)
      this.dependencies.state.removeUpload(record.uploadId)
      throw error
    }
    this.dependencies.state.removeUpload(record.uploadId)
    const link: StoredLink = {
      provider: record.provider,
      accountId: record.accountId,
      fileId: file.id,
      name: file.name ?? record.name,
      size: record.totalBytes,
      url: shared.url,
      share: record.share,
      scopeLabel: shareScopeLabel(record.provider, record.share),
      permissionIds: shared.permissionIds,
      ...(shared.expiresAt ? { expiresAt: shared.expiresAt } : {})
    }
    this.dependencies.state.addLink(link)
    const { permissionIds: _permissionIds, ...visible } = link
    return { status: 'shared', uploadId: record.uploadId, link: visible }
  }

  private async run(record: StoredUpload, signal: AbortSignal, progress?: (value: CloudUploadProgress) => void, resume = false): Promise<CloudUploadResult> {
    try {
      let start = 0
      if (resume) {
        const current = await this.sessionOffset(record, signal)
        if (current.file) return await this.complete(record, current.file)
        start = current.offset
      }
      progress?.({ uploadId: record.uploadId, name: record.name, sentBytes: start, totalBytes: record.totalBytes })
      const file = await this.transfer(record, start, signal, progress)
      if (signal.aborted) {
        // Cancelled as the last chunk landed: remove the finished but unshared file.
        await this.deleteRemoteFile(record.accountId, record.provider, file.id)
        this.dependencies.state.removeUpload(record.uploadId)
        return { status: 'cancelled', uploadId: record.uploadId }
      }
      return await this.complete(record, file)
    } catch (error) {
      if (isAbort(error, signal)) {
        await this.cancelSession(record)
        this.dependencies.state.removeUpload(record.uploadId)
        return { status: 'cancelled', uploadId: record.uploadId }
      }
      if (error instanceof UploadSessionExpiredError || error instanceof CloudPermissionError) this.dependencies.state.removeUpload(record.uploadId)
      // Other failures keep the session so the upload can resume later.
      throw error
    } finally {
      this.active.delete(record.uploadId)
    }
  }

  private begin(uploadId: string) {
    if (this.active.has(uploadId)) throw new Error('This upload is already running')
    const controller = new AbortController()
    this.active.set(uploadId, controller)
    return controller
  }

  async upload(uploadId: string, accountId: string, path: string, shareInput: CloudShareOptions, progress?: (value: CloudUploadProgress) => void, storageAccountId?: string): Promise<CloudUploadResult> {
    if (typeof uploadId !== 'string' || !/^[\w-]{8,64}$/.test(uploadId)) throw new Error('Invalid upload id')
    if (typeof path !== 'string' || !this.dependencies.isApprovedPath(path)) throw new Error('Choose the file to share again')
    if (storageAccountId !== undefined && storageAccountId !== null) {
      if (!this.dependencies.linked || typeof storageAccountId !== 'string') throw new Error('Choose a connected storage account')
      await this.resolve(accountId)
      return this.dependencies.linked.upload(uploadId, accountId, path, shareInput, storageAccountId, progress)
    }
    const controller = this.begin(uploadId)
    try {
      const { provider } = await this.storageAccount(accountId)
      const share = validateShareOptions(provider, shareInput)
      const info = await stat(path)
      if (!info.isFile()) throw new Error('Only files can be shared')
      if (info.size === 0) throw new Error('Empty files cannot be shared as cloud links')
      const name = basename(path).replace(/^\d+(?:-[a-f0-9]{10})?-/, '')
      const session = await this.createSession(accountId, provider, name, info.size, controller.signal)
      const record: StoredUpload = {
        uploadId, accountId, provider, name, path, totalBytes: info.size, share,
        createdAt: new Date(this.now()).toISOString(), sessionUrl: session.sessionUrl, modifiedAt: info.mtimeMs,
        ...(session.expiresAt ? { expiresAt: session.expiresAt } : {})
      }
      this.dependencies.state.putUpload(record)
      return await this.run(record, controller.signal, progress)
    } catch (error) {
      this.active.delete(uploadId)
      if (isAbort(error, controller.signal)) return { status: 'cancelled', uploadId }
      throw error
    }
  }

  async cancel(uploadId: string) {
    if (this.dependencies.linked?.isActive(uploadId) || this.dependencies.state.upload(uploadId)?.storageAccountId) return this.dependencies.linked?.cancel(uploadId)
    const controller = this.active.get(uploadId)
    if (controller) controller.abort()
    else await this.discard(uploadId)
  }

  async pending(accountId: string): Promise<CloudPendingUpload[]> {
    return this.dependencies.state.uploads()
      .filter((item) => item.accountId === accountId && !this.active.has(item.uploadId) && !this.dependencies.linked?.isActive(item.uploadId))
      // Session capabilities and any link password stay in the main process.
      .map(({ sessionUrl: _sessionUrl, modifiedAt: _modifiedAt, confirmedBytes: _confirmed, remotePath: _remote, share: { password: _password, ...share }, ...visible }) => ({ ...visible, share }))
  }

  async discard(uploadId: string) {
    const record = this.dependencies.state.upload(uploadId)
    if (!record) return
    if (record.storageAccountId) return this.dependencies.linked?.discard(uploadId) ?? this.dependencies.state.removeUpload(uploadId)
    this.active.get(uploadId)?.abort()
    await this.cancelSession(record)
    this.dependencies.state.removeUpload(uploadId)
  }

  /** Resumes an upload interrupted by quitting Aerio, or clears it when it can no longer continue. */
  async resume(uploadId: string, progress?: (value: CloudUploadProgress) => void): Promise<CloudUploadResult> {
    const record = this.dependencies.state.upload(uploadId)
    if (!record) throw new Error('This upload is no longer available. Start it again.')
    if (record.storageAccountId) {
      if (!this.dependencies.linked) throw new Error('This upload is no longer available. Start it again.')
      return this.dependencies.linked.resume(uploadId, progress)
    }
    const clear = async (message: string) => {
      await this.cancelSession(record)
      this.dependencies.state.removeUpload(uploadId)
      return new Error(message)
    }
    if (record.expiresAt && Date.parse(record.expiresAt) <= this.now()) throw await clear('The interrupted upload session has expired. Start the upload again.')
    const info = await stat(record.path).catch(() => undefined)
    if (!info || info.size !== record.totalBytes || info.mtimeMs !== record.modifiedAt) throw await clear(`${record.name} was moved or changed since the upload started. Start the upload again.`)
    const controller = this.begin(uploadId)
    try {
      await this.storageAccount(record.accountId)
    } catch (error) {
      this.active.delete(uploadId)
      throw error
    }
    return this.run(record, controller.signal, progress, true)
  }

  /**
   * Re-checks links Aerio created before a message goes out: deleted files,
   * removed permissions, and expired links are reported; anything that cannot
   * be checked right now (offline, unknown URL) is not.
   */
  async verify(accountId: string, urls: string[]): Promise<CloudLinkIssue[]> {
    if (!Array.isArray(urls)) return []
    const wanted = new Set(urls.filter((url) => typeof url === 'string'))
    const links = this.dependencies.state.links().filter((link) => link.accountId === accountId && wanted.has(link.url))
    const issues: CloudLinkIssue[] = []
    for (const link of links) {
      const issue = await (link.storageAccountId ? this.dependencies.linked?.check(link) : this.check(link))?.catch(() => undefined)
      if (issue) issues.push(issue)
    }
    return issues
  }

  private async check(link: StoredLink): Promise<CloudLinkIssue | undefined> {
    const issue = (problem: CloudLinkIssue['problem'], message: string): CloudLinkIssue => ({ url: link.url, name: link.name, problem, message })
    if (link.expiresAt && Date.parse(link.expiresAt) <= this.now()) return issue('expired', `The sharing link for ${link.name} has expired.`)
    const id = encodeURIComponent(link.fileId)
    const fileUrl = link.provider === 'google-drive' ? `${DRIVE_API}/files/${id}?fields=id,trashed` : `${GRAPH_API}/me/drive/items/${id}?$select=id`
    try {
      const file = await this.api<{ trashed?: boolean }>(link.accountId, link.provider, fileUrl)
      if (file?.trashed) return issue('deleted', `${link.name} is in the ${providerName(link.provider)} trash, so its link no longer opens.`)
      for (const permissionId of link.permissionIds) {
        const permissionUrl = link.provider === 'google-drive'
          ? `${DRIVE_API}/files/${id}/permissions/${encodeURIComponent(permissionId)}?fields=id,expirationTime`
          : `${GRAPH_API}/me/drive/items/${id}/permissions/${encodeURIComponent(permissionId)}`
        try {
          const permission = await this.api<{ expirationTime?: string; expirationDateTime?: string }>(link.accountId, link.provider, permissionUrl)
          const expiry = permission?.expirationTime ?? permission?.expirationDateTime
          if (expiry && Date.parse(expiry) <= this.now()) return issue('expired', `The sharing link for ${link.name} has expired.`)
        } catch (error) {
          if (error instanceof CloudProviderError && error.status === 404) return issue('revoked', `Sharing for ${link.name} was turned off in ${providerName(link.provider)}, so recipients cannot open it.`)
          throw error
        }
      }
      return undefined
    } catch (error) {
      if (error instanceof CloudProviderError && (error.status === 404 || error.status === 410)) return issue('deleted', `${link.name} was deleted from ${providerName(link.provider)}, so its link no longer opens.`)
      if (error instanceof CloudPermissionError || (error instanceof CloudProviderError && error.status === 403)) {
        return issue('permission-denied', `Aerio can no longer check ${link.name}; its ${providerName(link.provider)} permission may have been removed.`)
      }
      throw error
    }
  }
}

/** Parses Drive's `Range: bytes=0-N` into the next byte to send. */
function rangeEnd(value: string | null) {
  const match = value?.match(/bytes=\d+-(\d+)/)
  return match ? Number(match[1]) + 1 : 0
}

export function registerCloudAttachments(ipc: Pick<IpcMain, 'handle'>, service: () => CloudAttachmentService) {
  const progress = (event: Electron.IpcMainInvokeEvent) => (value: CloudUploadProgress) => {
    if (!event.sender.isDestroyed()) event.sender.send('mail:cloud:progress', value)
  }
  ipc.handle('mail:cloud:status', (_event, accountId: string) => service().status(accountId))
  ipc.handle('mail:cloud:connect', (_event, accountId: string) => service().connect(accountId))
  ipc.handle('mail:cloud:upload', (event, uploadId: string, accountId: string, path: string, share: CloudShareOptions, storageAccountId?: string) => service().upload(uploadId, accountId, path, share, progress(event), storageAccountId))
  ipc.handle('mail:cloud:cancel', (_event, uploadId: string) => service().cancel(uploadId))
  ipc.handle('mail:cloud:pending', (_event, accountId: string) => service().pending(accountId))
  ipc.handle('mail:cloud:resume', (event, uploadId: string) => service().resume(uploadId, progress(event)))
  ipc.handle('mail:cloud:discard', (_event, uploadId: string) => service().discard(uploadId))
  ipc.handle('mail:cloud:verify', (_event, accountId: string, urls: string[]) => service().verify(accountId, urls))
}
