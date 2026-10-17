import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { CloudLinkProblem, CloudShareAudience, CloudShareOptions, CloudStorageCapabilities } from '../../src/cloud-attachment-types'
import { CloudProviderError, isAbort, readChunk, UploadSessionExpiredError, UPLOAD_CHUNK_BYTES, type StoredLink, type StoredUpload } from './cloud-attachments'
import { CloudAuthError, LINKED_UPLOAD_FOLDER, validExpiryDate, type LinkedFile, type LinkedShare, type LinkedStorageConnector, type LinkedUploadSession } from './cloud-storage-connector'

type HttpInit = Omit<RequestInit, 'headers'> & { headers?: Record<string, string>; duplex?: 'half' }
import { sendOAuthCallbackPage } from './oauth-callback-page'

// Dropbox through its HTTP API v2: OAuth 2 with PKCE (no app secret), upload sessions
// (start / append_v2 / finish) for chunked uploads that resume from the acknowledged offset,
// and shared links created with create_shared_link_with_settings.

export interface DropboxEndpoints {
  api: string
  content: string
  authorize: string
}

export const DROPBOX_ENDPOINTS: DropboxEndpoints = {
  api: 'https://api.dropboxapi.com',
  content: 'https://content.dropboxapi.com',
  authorize: 'https://www.dropbox.com/oauth2/authorize'
}

/** Scoped-app permissions Aerio asks for; it never reads files it did not upload. */
export const DROPBOX_SCOPES = ['account_info.read', 'files.metadata.read', 'files.content.write', 'sharing.read', 'sharing.write']
/** Dropbox only accepts redirect URIs registered in the App Console, so the loopback port is fixed. */
export const DROPBOX_REDIRECT_PORT = 53134
export const DROPBOX_REDIRECT_PATH = '/dropbox'
// Dropbox documents upload sessions as short-lived; Aerio assumes 48 hours and restarts after that.
const DROPBOX_SESSION_LIFETIME_MS = 48 * 60 * 60_000

type DropboxAccountType = 'basic' | 'pro' | 'business'
type LinkPolicy = 'default_public' | 'default_team_only' | 'team_only' | 'default_no_one' | 'other'

export interface DropboxIdentity {
  accountId: string
  email: string
  name: string
  accountType: DropboxAccountType
  linkPolicy?: LinkPolicy
}

/** Dropbox-API-Arg must be ASCII; non-ASCII characters are sent as JSON \u escapes. */
export function dropboxArg(value: unknown) {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

class DropboxApiError extends CloudProviderError {
  constructor(message: string, status: number, readonly summary: string, readonly detail: Record<string, unknown> | undefined) {
    super(message, status, summary)
    this.name = 'DropboxApiError'
  }
}

async function dropboxError(response: Response, fallback: string) {
  const text = await response.text().catch(() => '')
  let body: { error_summary?: string; error?: Record<string, unknown> } | undefined
  try { body = JSON.parse(text) as typeof body } catch { /* Dropbox sends plain text for some 400s. */ }
  const summary = body?.error_summary ?? text.slice(0, 200)
  return new DropboxApiError(`${fallback} (${response.status}${summary ? `: ${summary}` : ''})`, response.status, summary, body?.error)
}

const tag = (value: unknown) => (value && typeof value === 'object' ? (value as { '.tag'?: string })['.tag'] : undefined)

function identityFrom(account: Record<string, unknown>): DropboxIdentity {
  const type = tag(account.account_type)
  const policy = tag((account.team as { sharing_policies?: { shared_link_create_policy?: unknown } } | undefined)?.sharing_policies?.shared_link_create_policy)
  return {
    accountId: String(account.account_id ?? ''),
    email: String(account.email ?? ''),
    name: String((account.name as { display_name?: string } | undefined)?.display_name ?? account.email ?? 'Dropbox'),
    accountType: type === 'pro' || type === 'business' ? type : 'basic',
    ...(policy ? { linkPolicy: (['default_public', 'default_team_only', 'team_only', 'default_no_one'].includes(policy) ? policy : 'other') as LinkPolicy } : {})
  }
}

export interface DropboxAuthorizeOptions {
  appKey: string
  openExternal(url: string): Promise<void>
  endpoints?: DropboxEndpoints
  fetch?: typeof fetch
  /** Loopback port; tests pass 0 for any free port. */
  port?: number
  timeoutMs?: number
}

export interface DropboxGrant extends DropboxIdentity {
  refreshToken: string
  accessToken: string
  expiresAt: number
}

/** Interactive sign-in: authorization code with PKCE (S256) through a loopback redirect. */
export async function authorizeDropbox(options: DropboxAuthorizeOptions): Promise<DropboxGrant> {
  const endpoints = options.endpoints ?? DROPBOX_ENDPOINTS
  const request = options.fetch ?? fetch
  const verifier = randomBytes(64).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(32).toString('base64url')
  const callback = await new Promise<{ redirectUri: string; code: Promise<string>; close(): void }>((resolve, reject) => {
    let settle: ((code: string) => void) | undefined
    let fail: ((error: Error) => void) | undefined
    const code = new Promise<string>((resolveCode, rejectCode) => { settle = resolveCode; fail = rejectCode })
    code.catch(() => undefined)
    const server = createServer((incoming, response) => {
      const url = new URL(incoming.url ?? '/', 'http://localhost')
      if (url.pathname !== DROPBOX_REDIRECT_PATH) return sendOAuthCallbackPage(response, 404, { kind: 'not-found' })
      if (url.searchParams.get('state') !== state) {
        sendOAuthCallbackPage(response, 400, { kind: 'invalid-state', provider: 'Dropbox' })
        fail?.(new Error('Dropbox returned an invalid OAuth state'))
        return
      }
      const returned = url.searchParams.get('code')
      const oauthError = url.searchParams.get('error_description') ?? url.searchParams.get('error')
      if (!returned || oauthError) {
        sendOAuthCallbackPage(response, 400, { kind: 'denied', provider: 'Dropbox' })
        fail?.(new Error(oauthError ?? 'Dropbox did not return an authorization code'))
        return
      }
      sendOAuthCallbackPage(response, 200, { kind: 'success', provider: 'Dropbox' })
      settle?.(returned)
    })
    const timeout = setTimeout(() => { server.close(); fail?.(new Error('Dropbox sign-in timed out after five minutes')) }, options.timeoutMs ?? 5 * 60_000)
    server.on('error', (error: NodeJS.ErrnoException) => reject(error.code === 'EADDRINUSE' ? new Error(`Port ${options.port ?? DROPBOX_REDIRECT_PORT} is in use, so the Dropbox sign-in cannot finish. Close the program using it and try again.`) : error))
    server.listen(options.port ?? DROPBOX_REDIRECT_PORT, 'localhost', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('Could not start the local Dropbox sign-in callback'))
      resolve({ redirectUri: `http://localhost:${address.port}${DROPBOX_REDIRECT_PATH}`, code, close: () => { clearTimeout(timeout); server.close() } })
    })
  })
  try {
    const authorization = new URL(endpoints.authorize)
    authorization.search = new URLSearchParams({
      client_id: options.appKey, response_type: 'code', redirect_uri: callback.redirectUri, state,
      code_challenge: challenge, code_challenge_method: 'S256', token_access_type: 'offline', scope: DROPBOX_SCOPES.join(' ')
    }).toString()
    await options.openExternal(authorization.toString())
    const code = await callback.code
    const response = await request(`${endpoints.api}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: options.appKey, redirect_uri: callback.redirectUri, code_verifier: verifier })
    })
    const token = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string }
    if (!response.ok || !token.access_token || !token.refresh_token) throw new Error(token.error_description ?? 'Dropbox did not return renewable credentials')
    const accountResponse = await request(`${endpoints.api}/2/users/get_current_account`, { method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' }, body: 'null' })
    if (!accountResponse.ok) throw await dropboxError(accountResponse, 'Could not read the Dropbox account')
    const identity = identityFrom(await accountResponse.json() as Record<string, unknown>)
    if (!identity.accountId) throw new Error('Dropbox did not identify the account')
    return { ...identity, refreshToken: token.refresh_token, accessToken: token.access_token, expiresAt: Date.now() + Number(token.expires_in ?? 14_400) * 1_000 }
  } finally {
    callback.close()
  }
}

/** Short-lived access tokens renewed from the stored refresh token. */
export class DropboxTokenSource {
  private cached?: { token: string; expiresAt: number }

  constructor(private readonly options: { appKey: () => string | undefined; refreshToken: () => string | undefined; endpoints: DropboxEndpoints; fetch: typeof fetch; now(): number; initial?: { token: string; expiresAt: number } }) {
    this.cached = options.initial
  }

  invalidate() { this.cached = undefined }

  async token() {
    if (this.cached && this.cached.expiresAt > this.options.now() + 60_000) return this.cached.token
    const appKey = this.options.appKey()
    const refreshToken = this.options.refreshToken()
    if (!appKey || !refreshToken) throw new CloudAuthError('Connect Dropbox again to keep sharing from it.')
    const response = await this.options.fetch(`${this.options.endpoints.api}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: appKey })
    })
    const token = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string; error_description?: string }
    if (response.status === 400 || response.status === 401) throw new CloudAuthError(`Dropbox no longer accepts Aerio's sign-in${token.error_description ? ` (${token.error_description})` : ''}. Connect Dropbox again.`)
    if (!response.ok || !token.access_token) throw new CloudProviderError(token.error_description ?? `Dropbox token refresh failed (${response.status})`, response.status)
    this.cached = { token: token.access_token, expiresAt: this.options.now() + Number(token.expires_in ?? 14_400) * 1_000 }
    return this.cached.token
  }
}

export interface DropboxConnectorOptions {
  tokens: DropboxTokenSource
  endpoints?: DropboxEndpoints
  fetch?: typeof fetch
  chunkBytes?: number
  now?(): number
  /** Called when a fresh account check reports a different plan or team policy. */
  identity?: DropboxIdentity
}

export class DropboxConnector implements LinkedStorageConnector {
  private readonly endpoints: DropboxEndpoints
  private readonly request: typeof fetch
  private identity?: DropboxIdentity

  constructor(private readonly options: DropboxConnectorOptions) {
    this.endpoints = options.endpoints ?? DROPBOX_ENDPOINTS
    this.request = options.fetch ?? fetch
    this.identity = options.identity
  }

  private now() { return this.options.now?.() ?? Date.now() }

  /** One authenticated call; an expired access token is renewed once. */
  private async call(url: string, init: HttpInit, fallback: string, retried = false): Promise<Response> {
    const response = await this.request(url, { ...init, headers: { Authorization: `Bearer ${await this.options.tokens.token()}`, ...init.headers } })
    if (response.status === 401) {
      const error = await dropboxError(response, fallback)
      if (!retried && /expired_access_token/.test(error.summary)) {
        this.options.tokens.invalidate()
        return this.call(url, init, fallback, true)
      }
      throw new CloudAuthError('Dropbox signed Aerio out. Connect Dropbox again.')
    }
    if (!response.ok) throw await dropboxError(response, fallback)
    return response
  }

  private async rpc<T>(path: string, body: unknown, fallback: string, signal?: AbortSignal): Promise<T> {
    const response = await this.call(`${this.endpoints.api}/2/${path}`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: body === null ? 'null' : JSON.stringify(body) }, fallback)
    const text = await response.text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  private content<T>(path: string, arg: unknown, body: Uint8Array, signal: AbortSignal, fallback: string) {
    return this.call(`${this.endpoints.content}/2/${path}`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': dropboxArg(arg) },
      body: body as unknown as BodyInit
    }, fallback).then(async (response) => { const text = await response.text(); return (text ? JSON.parse(text) : undefined) as T })
  }

  async account() {
    this.identity = identityFrom(await this.rpc<Record<string, unknown>>('users/get_current_account', null, 'Could not read the Dropbox account'))
    return this.identity
  }

  async capabilities(): Promise<CloudStorageCapabilities> {
    const identity = await this.account()
    const paid = identity.accountType !== 'basic'
    const audiences: CloudShareAudience[] = identity.linkPolicy === 'team_only' ? ['organization', 'members'] : identity.accountType === 'business' ? ['anyone', 'organization', 'members'] : ['anyone', 'members']
    const notes = [
      'Dropbox links to files open read-only; editing needs a shared folder, which Aerio does not create.',
      paid ? 'Your plan allows link passwords and expiry dates.' : 'Dropbox Basic links cannot have a password or an expiry date (Plus, Professional or Business can).'
    ]
    if (identity.linkPolicy === 'team_only') notes.push('Your Dropbox team only allows links for team members.')
    return { audiences, password: paid ? 'available' : 'unavailable', expiry: paid ? 'available' : 'unavailable', edit: 'unavailable', resumableUpload: true, notes }
  }

  async startUpload(name: string, _size: number, signal: AbortSignal): Promise<LinkedUploadSession> {
    const session = await this.content<{ session_id?: string }>('files/upload_session/start', { close: false }, new Uint8Array(0), signal, 'Dropbox did not start the upload')
    if (!session?.session_id) throw new Error('Dropbox did not return an upload session')
    return { sessionUrl: session.session_id, remotePath: `/${LINKED_UPLOAD_FOLDER}/${name}`, expiresAt: new Date(this.now() + DROPBOX_SESSION_LIFETIME_MS).toISOString() }
  }

  /** Dropbox has no progress query: an empty append at the last saved offset is accepted or corrected. */
  async confirmedOffset(record: StoredUpload, signal: AbortSignal) {
    const offset = record.confirmedBytes ?? 0
    try {
      await this.content('files/upload_session/append_v2', { cursor: { session_id: record.sessionUrl, offset }, close: false }, new Uint8Array(0), signal, 'Dropbox could not report the upload progress')
      return offset
    } catch (error) {
      const corrected = this.correctedOffset(error)
      if (corrected !== undefined) return corrected
      throw error
    }
  }

  private correctedOffset(error: unknown) {
    if (!(error instanceof DropboxApiError) || error.status !== 409) return undefined
    if (/^(?:lookup_failed\/)?(?:not_found|closed)\b/.test(error.summary)) throw new UploadSessionExpiredError()
    if (!/incorrect_offset/.test(error.summary)) return undefined
    const lookup = (error.detail?.correct_offset ?? (error.detail?.lookup_failed as Record<string, unknown> | undefined)?.correct_offset) as number | undefined
    return typeof lookup === 'number' ? lookup : undefined
  }

  async transfer(record: StoredUpload, start: number, signal: AbortSignal, confirmed: (offset: number) => void): Promise<LinkedFile> {
    const chunkBytes = this.options.chunkBytes ?? UPLOAD_CHUNK_BYTES
    let offset = start
    let retries = 0
    while (true) {
      const end = Math.min(offset + chunkBytes, record.totalBytes)
      const body = new Uint8Array(await readChunk(record.path, offset, end))
      const cursor = { session_id: record.sessionUrl, offset }
      try {
        if (end === record.totalBytes) {
          const file = await this.content<{ id: string; name: string }>('files/upload_session/finish', {
            cursor, commit: { path: record.remotePath, mode: 'add', autorename: true, mute: true }
          }, body, signal, 'Dropbox rejected the upload')
          confirmed(record.totalBytes)
          return { id: file.id, name: file.name }
        }
        await this.content('files/upload_session/append_v2', { cursor, close: false }, body, signal, 'Dropbox rejected the upload')
        offset = end
        retries = 0
        confirmed(offset)
      } catch (error) {
        if (isAbort(error, signal)) throw error
        const corrected = this.correctedOffset(error)
        if (corrected !== undefined && retries < 2) {
          retries += 1
          offset = corrected
          continue
        }
        const transient = error instanceof TypeError || (error instanceof CloudProviderError && (error.status >= 500 || error.status === 429))
        if (!transient || retries >= 2) throw error
        // A dropped connection may still have delivered the chunk; ask Dropbox where to continue.
        retries += 1
        offset = await this.confirmedOffset({ ...record, confirmedBytes: offset }, signal)
      }
    }
  }

  async cancelUpload() {
    // Dropbox has no call to discard an upload session; unfinished sessions expire on their own.
  }

  async share(file: LinkedFile, share: CloudShareOptions): Promise<LinkedShare> {
    const audience = share.audience === 'organization' ? 'team' : share.audience === 'members' ? 'no_one' : 'public'
    const settings: Record<string, unknown> = { audience: { '.tag': audience }, access: { '.tag': 'viewer' }, allow_download: true }
    if (share.password) settings.requested_visibility = { '.tag': 'password' }
    else if (audience !== 'no_one') settings.requested_visibility = { '.tag': audience === 'team' ? 'team_only' : 'public' }
    if (share.password) settings.link_password = share.password
    if (share.expiresOn) settings.expires = `${validExpiryDate(share.expiresOn, this.now())}T23:59:59Z`
    try {
      const link = await this.rpc<{ url?: string; id?: string; expires?: string }>('sharing/create_shared_link_with_settings', { path: file.id, settings }, 'Dropbox could not create a sharing link')
      if (!link?.url) throw new Error('Dropbox did not return a sharing link')
      return { url: link.url, permissionIds: link.id ? [link.id] : [], ...(link.expires ? { expiresAt: link.expires } : {}) }
    } catch (error) {
      if (!(error instanceof DropboxApiError)) throw error
      if (/shared_link_already_exists/.test(error.summary)) {
        const existing = ((error.detail?.shared_link_already_exists as Record<string, unknown> | undefined)?.metadata) as { url?: string; id?: string; expires?: string } | undefined
        if (existing?.url) return { url: existing.url, permissionIds: existing.id ? [existing.id] : [], ...(existing.expires ? { expiresAt: existing.expires } : {}) }
      }
      if (/settings_error\/not_authorized/.test(error.summary)) throw new Error('Your Dropbox plan does not allow link passwords or expiry dates. Remove them, or use Dropbox Plus, Professional or Business.')
      if (/settings_error\/invalid_settings/.test(error.summary)) throw new Error('Dropbox rejected these link settings. Try a different audience, or remove the password or expiry date.')
      if (/access_denied|email_not_verified/.test(error.summary)) throw new Error(/email_not_verified/.test(error.summary) ? 'Verify your Dropbox email address before creating links.' : 'Your Dropbox team does not allow links for this audience. Choose another audience.')
      throw error
    }
  }

  async deleteFile(file: LinkedFile) {
    await this.rpc('files/delete_v2', { path: file.id }, 'Dropbox could not remove the unshared upload').catch(() => undefined)
  }

  async check(link: StoredLink): Promise<CloudLinkProblem | undefined> {
    try {
      await this.rpc('files/get_metadata', { path: link.fileId }, 'Dropbox could not find the file')
    } catch (error) {
      if (error instanceof DropboxApiError && /path\/not_found/.test(error.summary)) return 'deleted'
      if (error instanceof CloudAuthError) return 'permission-denied'
      throw error
    }
    try {
      const metadata = await this.rpc<{ expires?: string }>('sharing/get_shared_link_metadata', { url: link.url }, 'Dropbox could not check the sharing link')
      if (metadata?.expires && Date.parse(metadata.expires) <= this.now()) return 'expired'
      return undefined
    } catch (error) {
      if (error instanceof DropboxApiError && /shared_link_not_found/.test(error.summary)) return 'revoked'
      if (error instanceof DropboxApiError && /shared_link_access_denied/.test(error.summary)) return 'permission-denied'
      if (error instanceof CloudAuthError) return 'permission-denied'
      throw error
    }
  }

  async revoke(link: StoredLink) {
    try {
      await this.rpc('sharing/revoke_shared_link', { url: link.url }, 'Dropbox could not turn off the link')
    } catch (error) {
      // Already gone counts as revoked.
      if (error instanceof DropboxApiError && /shared_link_not_found/.test(error.summary)) return
      throw error
    }
  }

  async signOut() {
    await this.rpc('auth/token/revoke', null, 'Dropbox did not sign Aerio out').catch(() => undefined)
  }
}
