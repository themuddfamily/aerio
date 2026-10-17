import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { IpcMain } from 'electron'
import type {
  CloudLinkIssue,
  CloudServerConnectInput,
  CloudShareOptions,
  CloudStorageAccount,
  CloudStorageLink,
  CloudStorageSnapshot,
  CloudUploadProgress,
  CloudUploadResult
} from '../../src/cloud-attachment-types'
import { cloudAudienceLabel, cloudProviderName, shareScopeLabel } from '../../src/lib/cloud-attachments'
import { CloudPermissionError, isAbort, UploadSessionExpiredError, type CloudAttachmentStateStore, type StoredLink, type StoredUpload } from './cloud-attachments'
import { CloudAuthError, validExpiryDate, type LinkedFile, type LinkedStorageConnector } from './cloud-storage-connector'
import { normalizeCloudServerUrl, type CloudStorageAccountStore, type StoredStorageAccount } from './cloud-storage-accounts'
import { authorizeDropbox, DropboxConnector, DropboxTokenSource, type DropboxEndpoints, DROPBOX_ENDPOINTS } from './cloud-dropbox'
import { discoverOcsAccount, OcsConnector } from './cloud-ocs'
import { parseDropboxAppKey } from './oauth-config'

// Dropbox, ownCloud and Nextcloud accounts connect on their own, independent of any mail
// account, and can be used from any composer. Their upload sessions and links live in the same
// encrypted cloud-uploads.dat record as Drive and OneDrive uploads, tagged with the storage
// account, so cancel, resume and the pre-send check work the same way.

export interface LinkedStorageDependencies {
  accounts: CloudStorageAccountStore
  state: CloudAttachmentStateStore
  isApprovedPath(path: string): boolean
  openExternal(url: string): Promise<void>
  /** App key compiled into this build (MAIN_VITE_DROPBOX_APP_KEY); otherwise the user enters one. */
  builtInDropboxAppKey?: string
  fetch?: typeof fetch
  now?(): number
  chunkBytes?: number
  dropboxEndpoints?: DropboxEndpoints
  /** Loopback port for the Dropbox redirect; tests use 0. */
  dropboxPort?: number
}

const accountHash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 20)
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200

export class LinkedCloudStorageService {
  private readonly active = new Map<string, AbortController>()
  private readonly tokenSources = new Map<string, DropboxTokenSource>()

  constructor(private readonly dependencies: LinkedStorageDependencies) {}

  private fetch: typeof fetch = (input, init) => (this.dependencies.fetch ?? fetch)(input, init)
  private now() { return this.dependencies.now?.() ?? Date.now() }
  private dropboxEndpoints() { return this.dependencies.dropboxEndpoints ?? DROPBOX_ENDPOINTS }
  private dropboxAppKey() { return this.dependencies.builtInDropboxAppKey ?? this.dependencies.accounts.dropboxAppKey() }

  snapshot(): CloudStorageSnapshot {
    return {
      accounts: this.dependencies.accounts.accounts().map(visibleAccount),
      dropboxConfigured: Boolean(this.dropboxAppKey()),
      dropboxBuiltIn: Boolean(this.dependencies.builtInDropboxAppKey)
    }
  }

  account(id: string) {
    const account = validId(id) ? this.dependencies.accounts.account(id) : undefined
    if (!account) throw new Error('That storage account is no longer connected')
    return account
  }

  configureDropbox(appKey: unknown) {
    if (this.dependencies.builtInDropboxAppKey) throw new Error('This Aerio build already includes its Dropbox app key')
    this.dependencies.accounts.setDropboxAppKey(parseDropboxAppKey(appKey))
    return this.snapshot()
  }

  private tokens(account: StoredStorageAccount, initial?: { token: string; expiresAt: number }) {
    let source = this.tokenSources.get(account.id)
    if (!source || initial) {
      source = new DropboxTokenSource({
        appKey: () => this.dropboxAppKey(),
        refreshToken: () => this.dependencies.accounts.secret(account.id),
        endpoints: this.dropboxEndpoints(),
        fetch: this.fetch,
        now: () => this.now(),
        ...(initial ? { initial } : {})
      })
      this.tokenSources.set(account.id, source)
    }
    return source
  }

  connector(account: StoredStorageAccount): LinkedStorageConnector {
    if (account.provider === 'dropbox') {
      return new DropboxConnector({ tokens: this.tokens(account), endpoints: this.dropboxEndpoints(), fetch: this.fetch, chunkBytes: this.dependencies.chunkBytes, now: () => this.now() })
    }
    return new OcsConnector({
      provider: account.provider, serverUrl: account.serverUrl!, username: account.username, userId: account.remoteUserId,
      password: () => this.dependencies.accounts.secret(account.id), chunkedUpload: Boolean(account.chunkedUpload),
      fetch: this.fetch, chunkBytes: this.dependencies.chunkBytes, now: () => this.now()
    })
  }

  async connectDropbox() {
    const appKey = this.dropboxAppKey()
    if (!appKey) throw new Error('Enter the Dropbox app key first')
    const grant = await authorizeDropbox({ appKey, openExternal: this.dependencies.openExternal, endpoints: this.dropboxEndpoints(), fetch: this.fetch, ...(this.dependencies.dropboxPort !== undefined ? { port: this.dependencies.dropboxPort } : {}) })
    const id = `dropbox-${accountHash(grant.accountId)}`
    const existing = this.dependencies.accounts.account(id)
    const draft: StoredStorageAccount = {
      id, provider: 'dropbox', name: `Dropbox · ${grant.email || grant.name}`, username: grant.email || grant.name, remoteUserId: grant.accountId,
      status: 'ready', connectedAt: existing?.connectedAt ?? new Date(this.now()).toISOString(),
      capabilities: { audiences: ['anyone'], password: 'unavailable', expiry: 'unavailable', edit: 'unavailable', resumableUpload: true, notes: [] }
    }
    // Saving the refresh token first fails cleanly when OS secure storage is unavailable.
    this.dependencies.accounts.put(draft, grant.refreshToken)
    this.tokens(draft, { token: grant.accessToken, expiresAt: grant.expiresAt })
    await this.refreshCapabilities(id).catch(() => undefined)
    return this.snapshot()
  }

  async connectServer(input: CloudServerConnectInput) {
    if (!input || typeof input !== 'object') throw new Error('Enter the server details')
    if (input.provider !== 'owncloud' && input.provider !== 'nextcloud') throw new Error('Choose ownCloud or Nextcloud')
    const serverUrl = normalizeCloudServerUrl(input.serverUrl)
    const username = typeof input.username === 'string' ? input.username.trim() : ''
    const password = typeof input.password === 'string' ? input.password : ''
    if (!username || username.length > 320) throw new Error('Enter the user name')
    if (!password || password.length > 1_000) throw new Error('Enter an app password')
    const discovery = await discoverOcsAccount({ provider: input.provider, serverUrl, username, password, fetch: this.fetch })
    const id = `${input.provider}-${accountHash(`${serverUrl}|${discovery.userId.toLowerCase()}`)}`
    const existing = this.dependencies.accounts.account(id)
    const label = cloudProviderName(input.provider)
    const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 120) : `${label} · ${discovery.displayName}`
    this.dependencies.accounts.put({
      id, provider: input.provider, name, username, serverUrl, remoteUserId: discovery.userId, status: 'ready',
      connectedAt: existing?.connectedAt ?? new Date(this.now()).toISOString(), capabilitiesCheckedAt: new Date(this.now()).toISOString(),
      capabilities: discovery.capabilities, chunkedUpload: discovery.chunkedUpload, ...(discovery.serverVersion ? { serverVersion: discovery.serverVersion } : {})
    }, password)
    return this.snapshot()
  }

  private async refreshCapabilities(id: string) {
    const account = this.account(id)
    try {
      const { chunkedUpload, serverVersion, ...capabilities } = await this.connector(account).capabilities()
      this.dependencies.accounts.update(id, {
        capabilities, status: 'ready', error: undefined, capabilitiesCheckedAt: new Date(this.now()).toISOString(),
        ...(account.provider !== 'dropbox' ? { chunkedUpload: Boolean(chunkedUpload), ...(serverVersion ? { serverVersion } : {}) } : {})
      })
    } catch (error) {
      this.noteFailure(id, error)
      throw error
    }
  }

  async refresh(id: string) {
    await this.refreshCapabilities(id)
    return this.snapshot()
  }

  private noteFailure(id: string, error: unknown) {
    if (error instanceof CloudAuthError) this.dependencies.accounts.update(id, { status: 'needs-auth', error: error.message })
  }

  /** Forgets the account everywhere: credentials, interrupted uploads, and link records. */
  async disconnect(id: string) {
    const account = this.account(id)
    const uploads = this.dependencies.state.uploads().filter((item) => item.storageAccountId === id)
    for (const upload of uploads) this.active.get(upload.uploadId)?.abort()
    const connector = this.connector(account)
    for (const upload of uploads) await connector.cancelUpload(upload).catch(() => undefined)
    await connector.signOut().catch(() => undefined)
    this.dependencies.state.removeWhere((item) => item.storageAccountId === id, (item) => item.storageAccountId === id)
    this.dependencies.accounts.remove(id)
    this.tokenSources.delete(id)
    return this.snapshot()
  }

  links(id: string): CloudStorageLink[] {
    this.account(id)
    return this.dependencies.state.links().filter((link) => link.storageAccountId === id).reverse().map((link) => ({
      url: link.url, name: link.name, storageAccountId: id, scopeLabel: link.scopeLabel, ...(link.expiresAt ? { expiresAt: link.expiresAt } : {})
    }))
  }

  async revoke(url: unknown) {
    const link = typeof url === 'string' ? this.dependencies.state.links().find((item) => item.url === url && item.storageAccountId) : undefined
    if (!link) throw new Error('Aerio did not create that link')
    const account = this.account(link.storageAccountId!)
    try {
      await this.connector(account).revoke(link)
    } catch (error) {
      this.noteFailure(account.id, error)
      throw error
    }
    this.dependencies.state.removeLink(link.url)
    return this.links(account.id)
  }

  /** Checks a requested share against what the account allows before anything is uploaded. */
  validateShare(account: StoredStorageAccount, value: CloudShareOptions): CloudShareOptions {
    if (!value || typeof value !== 'object') throw new Error('Choose who can open the shared file')
    const capabilities = account.capabilities
    const label = cloudProviderName(account.provider)
    if (!capabilities.audiences.length) throw new Error(`${account.name} does not allow sharing links. Ask the server administrator to allow public links.`)
    if (!capabilities.audiences.includes(value.audience)) throw new Error(`${label} cannot share with ${cloudAudienceLabel(account.provider, value.audience).toLowerCase()}`)
    if (value.role !== 'view' && value.role !== 'edit') throw new Error('Choose view or edit access')
    if (value.role === 'edit' && capabilities.edit === 'unavailable') throw new Error(`${label} links from this account can only be viewed`)
    const password = typeof value.password === 'string' && value.password ? value.password : undefined
    if (password && capabilities.password === 'unavailable') throw new Error(`${account.name} cannot protect links with a password`)
    if (!password && capabilities.password === 'enforced') throw new Error(`${account.name} requires a password for every link`)
    if (password && password.length > 200) throw new Error('Use a link password of 200 characters or fewer')
    const expiresOn = typeof value.expiresOn === 'string' && value.expiresOn ? validExpiryDate(value.expiresOn, this.now()) : undefined
    if (expiresOn && capabilities.expiry === 'unavailable') throw new Error(`${account.name} cannot set an expiry date on links`)
    if (!expiresOn && capabilities.expiry === 'enforced') throw new Error(`${account.name} requires an expiry date${capabilities.maxExpiryDays ? ` within ${capabilities.maxExpiryDays} days` : ''}`)
    if (expiresOn && capabilities.maxExpiryDays && capabilities.expiry === 'enforced' && Date.parse(`${expiresOn}T00:00:00Z`) > this.now() + capabilities.maxExpiryDays * 86_400_000) {
      throw new Error(`${account.name} allows links to last at most ${capabilities.maxExpiryDays} days`)
    }
    return { audience: value.audience, role: value.role, ...(password ? { password } : {}), ...(expiresOn ? { expiresOn } : {}) }
  }

  isActive(uploadId: string) { return this.active.has(uploadId) }

  private begin(uploadId: string) {
    if (this.active.has(uploadId)) throw new Error('This upload is already running')
    const controller = new AbortController()
    this.active.set(uploadId, controller)
    return controller
  }

  private ready(id: string) {
    const account = this.account(id)
    if (account.status === 'needs-auth') throw new CloudAuthError(account.error ?? `Connect ${account.name} again to share from it.`)
    return account
  }

  async upload(uploadId: string, mailAccountId: string, path: string, shareInput: CloudShareOptions, storageAccountId: string, progress?: (value: CloudUploadProgress) => void): Promise<CloudUploadResult> {
    if (typeof uploadId !== 'string' || !/^[\w-]{8,64}$/.test(uploadId)) throw new Error('Invalid upload id')
    if (typeof path !== 'string' || !this.dependencies.isApprovedPath(path)) throw new Error('Choose the file to share again')
    const controller = this.begin(uploadId)
    try {
      const account = this.ready(storageAccountId)
      const share = this.validateShare(account, shareInput)
      const info = await stat(path)
      if (!info.isFile()) throw new Error('Only files can be shared')
      if (info.size === 0) throw new Error('Empty files cannot be shared as cloud links')
      const name = basename(path).replace(/^\d+(?:-[a-f0-9]{10})?-/, '')
      const session = await this.connector(account).startUpload(name, info.size, controller.signal)
      const record: StoredUpload = {
        uploadId, accountId: mailAccountId, provider: account.provider, storageAccountId: account.id, name, path, totalBytes: info.size, share,
        createdAt: new Date(this.now()).toISOString(), sessionUrl: session.sessionUrl, remotePath: session.remotePath, modifiedAt: info.mtimeMs, confirmedBytes: 0,
        ...(session.expiresAt ? { expiresAt: session.expiresAt } : {})
      }
      this.dependencies.state.putUpload(record)
      return await this.run(record, account, controller.signal, progress)
    } catch (error) {
      this.active.delete(uploadId)
      this.noteFailure(storageAccountId, error)
      if (isAbort(error, controller.signal)) return { status: 'cancelled', uploadId }
      throw error
    }
  }

  async resume(uploadId: string, progress?: (value: CloudUploadProgress) => void): Promise<CloudUploadResult> {
    const record = this.dependencies.state.upload(uploadId)
    if (!record?.storageAccountId) throw new Error('This upload is no longer available. Start it again.')
    const account = this.account(record.storageAccountId)
    const clear = async (message: string) => {
      await this.connector(account).cancelUpload(record).catch(() => undefined)
      this.dependencies.state.removeUpload(uploadId)
      return new Error(message)
    }
    if (record.expiresAt && Date.parse(record.expiresAt) <= this.now()) throw await clear('The interrupted upload session has expired. Start the upload again.')
    const info = await stat(record.path).catch(() => undefined)
    if (!info || info.size !== record.totalBytes || info.mtimeMs !== record.modifiedAt) throw await clear(`${record.name} was moved or changed since the upload started. Start the upload again.`)
    const controller = this.begin(uploadId)
    try {
      this.ready(account.id)
    } catch (error) {
      this.active.delete(uploadId)
      throw error
    }
    return this.run(record, account, controller.signal, progress, true)
  }

  async cancel(uploadId: string) {
    const controller = this.active.get(uploadId)
    if (controller) controller.abort()
    else await this.discard(uploadId)
  }

  async discard(uploadId: string) {
    const record = this.dependencies.state.upload(uploadId)
    if (!record?.storageAccountId) return
    this.active.get(uploadId)?.abort()
    const account = this.dependencies.accounts.account(record.storageAccountId)
    if (account) await this.connector(account).cancelUpload(record).catch(() => undefined)
    this.dependencies.state.removeUpload(uploadId)
  }

  private async run(record: StoredUpload, account: StoredStorageAccount, signal: AbortSignal, progress?: (value: CloudUploadProgress) => void, resume = false): Promise<CloudUploadResult> {
    const connector = this.connector(account)
    try {
      const start = resume ? await connector.confirmedOffset(record, signal) : 0
      progress?.({ uploadId: record.uploadId, name: record.name, sentBytes: start, totalBytes: record.totalBytes })
      const file = await connector.transfer(record, start, signal, (offset) => {
        if (signal.aborted) return
        record.confirmedBytes = offset
        // Each acknowledged chunk is saved so a restart resumes from it.
        this.dependencies.state.putUpload(record)
        progress?.({ uploadId: record.uploadId, name: record.name, sentBytes: offset, totalBytes: record.totalBytes })
      })
      if (signal.aborted) {
        await connector.deleteFile(file)
        this.dependencies.state.removeUpload(record.uploadId)
        return { status: 'cancelled', uploadId: record.uploadId }
      }
      return await this.complete(record, account, connector, file)
    } catch (error) {
      if (isAbort(error, signal)) {
        await connector.cancelUpload(record).catch(() => undefined)
        this.dependencies.state.removeUpload(record.uploadId)
        return { status: 'cancelled', uploadId: record.uploadId }
      }
      this.noteFailure(account.id, error)
      if (error instanceof UploadSessionExpiredError || error instanceof CloudPermissionError) this.dependencies.state.removeUpload(record.uploadId)
      // Other failures (offline, server errors, an expired sign-in) keep the session for Resume.
      throw error
    } finally {
      this.active.delete(record.uploadId)
    }
  }

  private async complete(record: StoredUpload, account: StoredStorageAccount, connector: LinkedStorageConnector, file: LinkedFile): Promise<CloudUploadResult> {
    let shared: Awaited<ReturnType<LinkedStorageConnector['share']>>
    try {
      shared = await connector.share(file, record.share)
    } catch (error) {
      // An unshared upload would only clutter the user's storage.
      await connector.deleteFile(file).catch(() => undefined)
      this.dependencies.state.removeUpload(record.uploadId)
      throw error
    }
    this.dependencies.state.removeUpload(record.uploadId)
    // The link password is never kept once the link exists.
    const { password: _password, ...share } = record.share
    const link: StoredLink = {
      provider: account.provider, accountId: record.accountId, storageAccountId: account.id, fileId: file.id, name: file.name || record.name,
      size: record.totalBytes, url: shared.url, share, scopeLabel: shareScopeLabel(account.provider, record.share), permissionIds: shared.permissionIds,
      ...(shared.expiresAt ? { expiresAt: shared.expiresAt } : {})
    }
    this.dependencies.state.addLink(link)
    const { permissionIds: _permissionIds, ...visible } = link
    return { status: 'shared', uploadId: record.uploadId, link: visible }
  }

  /** Pre-send check of one link; network failures propagate and are ignored by the caller. */
  async check(link: StoredLink): Promise<CloudLinkIssue | undefined> {
    const issue = (problem: CloudLinkIssue['problem'], message: string): CloudLinkIssue => ({ url: link.url, name: link.name, problem, message })
    const account = link.storageAccountId ? this.dependencies.accounts.account(link.storageAccountId) : undefined
    const label = cloudProviderName(link.provider)
    if (!account) return issue('permission-denied', `The ${label} account that shared ${link.name} was disconnected, so Aerio cannot check its link.`)
    if (link.expiresAt && Date.parse(link.expiresAt) <= this.now()) return issue('expired', `The sharing link for ${link.name} has expired.`)
    const problem = await this.connector(account).check(link)
    if (!problem) return undefined
    if (problem === 'deleted') return issue('deleted', `${link.name} was deleted from ${label}, so its link no longer opens.`)
    if (problem === 'revoked') return issue('revoked', `Sharing for ${link.name} was turned off in ${label}, so recipients cannot open it.`)
    if (problem === 'expired') return issue('expired', `The sharing link for ${link.name} has expired.`)
    return issue('permission-denied', `Aerio can no longer check ${link.name}; sign in to ${account.name} again.`)
  }
}

function visibleAccount(account: StoredStorageAccount): CloudStorageAccount {
  const { remoteUserId: _remote, chunkedUpload: _chunked, serverVersion: _version, ...visible } = account
  return visible
}

export function registerCloudStorage(ipc: Pick<IpcMain, 'handle'>, service: () => LinkedCloudStorageService, isLocked: () => boolean) {
  const unlocked = () => { if (isLocked()) throw new Error('Unlock Aerio first') }
  const id = (value: unknown) => {
    if (!validId(value)) throw new Error('Choose a storage account')
    return value
  }
  ipc.handle('mail:cloud:storage:snapshot', () => { unlocked(); return service().snapshot() })
  ipc.handle('mail:cloud:storage:configure-dropbox', (_event, appKey: unknown) => { unlocked(); return service().configureDropbox(appKey) })
  ipc.handle('mail:cloud:storage:connect-dropbox', () => { unlocked(); return service().connectDropbox() })
  ipc.handle('mail:cloud:storage:connect-server', (_event, input: unknown) => { unlocked(); return service().connectServer(input as CloudServerConnectInput) })
  ipc.handle('mail:cloud:storage:refresh', (_event, accountId: unknown) => { unlocked(); return service().refresh(id(accountId)) })
  ipc.handle('mail:cloud:storage:disconnect', (_event, accountId: unknown) => { unlocked(); return service().disconnect(id(accountId)) })
  ipc.handle('mail:cloud:storage:links', (_event, accountId: unknown) => { unlocked(); return service().links(id(accountId)) })
  ipc.handle('mail:cloud:storage:revoke', (_event, url: unknown) => {
    unlocked()
    if (typeof url !== 'string' || !url || url.length > 4_096) throw new Error('Choose a link')
    return service().revoke(url)
  })
}
