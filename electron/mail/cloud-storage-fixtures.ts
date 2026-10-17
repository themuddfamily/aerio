import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

// In-process fake Dropbox and ownCloud/Nextcloud servers on 127.0.0.1 for tests. They model just
// enough of each API to exercise sign-in, chunked upload with interruption and resume, sharing
// settings and refusals, link checks, revocation and sign-out. No real accounts or network.

const readBody = (request: IncomingMessage) => new Promise<Buffer>((resolve, reject) => {
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.on('end', () => resolve(Buffer.concat(chunks)))
  request.on('error', reject)
})

const sendJson = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

abstract class FixtureServer {
  private server?: Server
  url = ''
  /** While true every request has its connection dropped, like a network outage. */
  offline = false
  readonly requests: Array<{ method: string; path: string }> = []

  protected abstract handle(request: IncomingMessage, response: ServerResponse, body: Buffer): unknown

  async start() {
    this.server = createServer((request, response) => {
      void (async () => {
        const body = await readBody(request)
        this.requests.push({ method: request.method ?? 'GET', path: request.url ?? '/' })
        if (this.offline) { request.socket.destroy(); return }
        try { await this.handle(request, response, body) }
        catch (error) { sendJson(response, 500, { error: String(error) }) }
      })()
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }

  async stop() {
    this.server?.closeAllConnections?.()
    await new Promise<void>((resolve) => this.server ? this.server.close(() => resolve()) : resolve())
  }
}

// --- Dropbox ----------------------------------------------------------------------------------

export interface DropboxFixtureOptions {
  appKey?: string
  accountType?: 'basic' | 'pro' | 'business'
  linkPolicy?: 'default_public' | 'team_only'
  /** Drop the connection on this append_v2 call (1-based) after storing its bytes. */
  dropAfterAppend?: number
}

interface DropboxSession { data: Buffer; closed: boolean }
export interface DropboxFixtureLink { id: string; url: string; path: string; fileId: string; settings: Record<string, unknown>; expires?: string }

export class DropboxFixtureServer extends FixtureServer {
  readonly appKey: string
  readonly sessions = new Map<string, DropboxSession>()
  readonly files = new Map<string, { id: string; name: string; path: string; data: Buffer }>()
  readonly links = new Map<string, DropboxFixtureLink>()
  readonly accessTokens = new Set<string>()
  readonly refreshTokens = new Set<string>()
  readonly appendOffsets: number[] = []
  private readonly codes = new Map<string, { challenge: string; redirectUri: string }>()
  private appends = 0
  tokenGrants: string[] = []

  constructor(readonly options: DropboxFixtureOptions = {}) {
    super()
    this.appKey = options.appKey ?? 'aeriotestkey1'
  }

  get endpoints() { return { api: this.url, content: this.url, authorize: `${this.url}/oauth2/authorize` } }

  /** Simulates the browser: Dropbox's consent page approves and redirects to Aerio's loopback. */
  async approve(authorizeUrl: string) {
    const response = await fetch(authorizeUrl, { redirect: 'manual' })
    const location = response.headers.get('location')
    if (!location) throw new Error('The fake Dropbox did not redirect')
    await fetch(location)
  }

  expireAccessTokens() { this.accessTokens.clear() }

  private account() {
    const type = this.options.accountType ?? 'basic'
    return {
      account_id: 'dbid:AAAfixture', email: 'ada@example.test', name: { display_name: 'Ada Lovelace' }, account_type: { '.tag': type },
      ...(type === 'business' ? { team: { name: 'Analytical', sharing_policies: { shared_link_create_policy: { '.tag': this.options.linkPolicy ?? 'default_public' } } } } : {})
    }
  }

  private conflict(response: ServerResponse, summary: string, error: Record<string, unknown> = {}) {
    sendJson(response, 409, { error_summary: summary, error })
  }

  protected handle(request: IncomingMessage, response: ServerResponse, body: Buffer) {
    const url = new URL(request.url ?? '/', this.url)
    if (url.pathname === '/oauth2/authorize') {
      if (url.searchParams.get('client_id') !== this.appKey || url.searchParams.get('code_challenge_method') !== 'S256' || url.searchParams.get('token_access_type') !== 'offline') return sendJson(response, 400, { error: 'invalid_request' })
      const code = randomBytes(8).toString('hex')
      const redirectUri = url.searchParams.get('redirect_uri')!
      this.codes.set(code, { challenge: url.searchParams.get('code_challenge')!, redirectUri })
      response.writeHead(302, { Location: `${redirectUri}?code=${code}&state=${encodeURIComponent(url.searchParams.get('state') ?? '')}` })
      return response.end()
    }
    if (url.pathname === '/oauth2/token') {
      const form = new URLSearchParams(body.toString('utf8'))
      if (form.get('client_id') !== this.appKey) return sendJson(response, 400, { error: 'invalid_client' })
      this.tokenGrants.push(form.get('grant_type') ?? '')
      if (form.get('grant_type') === 'authorization_code') {
        const pending = this.codes.get(form.get('code') ?? '')
        this.codes.delete(form.get('code') ?? '')
        const verifier = form.get('code_verifier') ?? ''
        if (!pending || pending.redirectUri !== form.get('redirect_uri') || createHash('sha256').update(verifier).digest('base64url') !== pending.challenge) return sendJson(response, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' })
        const access = `access-${randomBytes(6).toString('hex')}`
        const refresh = `refresh-${randomBytes(6).toString('hex')}`
        this.accessTokens.add(access)
        this.refreshTokens.add(refresh)
        return sendJson(response, 200, { access_token: access, refresh_token: refresh, expires_in: 14_400, token_type: 'bearer' })
      }
      if (form.get('grant_type') === 'refresh_token') {
        if (!this.refreshTokens.has(form.get('refresh_token') ?? '')) return sendJson(response, 400, { error: 'invalid_grant', error_description: 'refresh token is invalid or revoked' })
        const access = `access-${randomBytes(6).toString('hex')}`
        this.accessTokens.add(access)
        return sendJson(response, 200, { access_token: access, expires_in: 14_400, token_type: 'bearer' })
      }
      return sendJson(response, 400, { error: 'unsupported_grant_type' })
    }
    const token = (request.headers.authorization ?? '').replace(/^Bearer /, '')
    if (!this.accessTokens.has(token)) return sendJson(response, 401, { error_summary: token.startsWith('access-') ? 'expired_access_token/' : 'invalid_access_token/', error: { '.tag': 'expired_access_token' } })
    const json = () => (body.length ? JSON.parse(body.toString('utf8')) : null) as Record<string, unknown>
    const arg = () => JSON.parse(String(request.headers['dropbox-api-arg'] ?? 'null')) as Record<string, any>
    switch (url.pathname) {
      case '/2/users/get_current_account': return sendJson(response, 200, this.account())
      case '/2/auth/token/revoke': {
        this.accessTokens.delete(token)
        this.refreshTokens.clear()
        return sendJson(response, 200, null)
      }
      case '/2/files/upload_session/start': {
        const id = `session-${this.sessions.size + 1}`
        this.sessions.set(id, { data: Buffer.from(body), closed: false })
        return sendJson(response, 200, { session_id: id })
      }
      case '/2/files/upload_session/append_v2':
      case '/2/files/upload_session/finish': {
        const { cursor, commit } = arg()
        const session = this.sessions.get(cursor.session_id)
        const finishing = url.pathname.endsWith('finish')
        const prefix = finishing ? 'lookup_failed/' : ''
        if (!session || session.closed) return this.conflict(response, `${prefix}not_found/`, finishing ? { '.tag': 'lookup_failed', lookup_failed: { '.tag': 'not_found' } } : { '.tag': 'not_found' })
        if (cursor.offset !== session.data.length) {
          const detail = { '.tag': 'incorrect_offset', correct_offset: session.data.length }
          return this.conflict(response, `${prefix}incorrect_offset/`, finishing ? { '.tag': 'lookup_failed', lookup_failed: detail } : detail)
        }
        session.data = Buffer.concat([session.data, body])
        if (!finishing) {
          this.appendOffsets.push(cursor.offset)
          if (body.length) this.appends += 1
          if (this.options.dropAfterAppend && this.appends === this.options.dropAfterAppend) { request.socket.destroy(); return }
          return sendJson(response, 200, null)
        }
        session.closed = true
        let path = String(commit.path)
        for (let index = 2; [...this.files.values()].some((file) => file.path === path); index += 1) path = String(commit.path).replace(/(\.[^./]+)?$/, ` (${index})$1`)
        const id = `id:file${this.files.size + 1}`
        const name = path.split('/').pop()!
        this.files.set(id, { id, name, path, data: session.data })
        return sendJson(response, 200, { '.tag': 'file', id, name, path_display: path, size: session.data.length })
      }
      case '/2/sharing/create_shared_link_with_settings': {
        const { path, settings } = json() as { path: string; settings: Record<string, any> }
        const file = this.files.get(path)
        if (!file) return this.conflict(response, 'path/not_found/', { '.tag': 'path', path: { '.tag': 'not_found' } })
        const paid = (this.options.accountType ?? 'basic') !== 'basic'
        if (!paid && (settings.link_password || settings.expires)) return this.conflict(response, 'settings_error/not_authorized/', { '.tag': 'settings_error', settings_error: { '.tag': 'not_authorized' } })
        if (settings.audience?.['.tag'] === 'team' && this.options.accountType !== 'business') return this.conflict(response, 'settings_error/invalid_settings/', { '.tag': 'settings_error' })
        if (this.options.linkPolicy === 'team_only' && settings.audience?.['.tag'] === 'public') return this.conflict(response, 'access_denied/', { '.tag': 'access_denied' })
        const id = `link-${this.links.size + 1}`
        const link: DropboxFixtureLink = { id, url: `${this.url}/s/${id}/${encodeURIComponent(file.name)}?dl=0`, path: file.path, fileId: file.id, settings, ...(settings.expires ? { expires: settings.expires } : {}) }
        this.links.set(link.url, link)
        return sendJson(response, 200, { '.tag': 'file', url: link.url, id, name: file.name, ...(link.expires ? { expires: link.expires } : {}), link_permissions: { effective_audience: settings.audience } })
      }
      case '/2/sharing/get_shared_link_metadata': {
        const link = this.links.get(String(json().url))
        if (!link) return this.conflict(response, 'shared_link_not_found/', { '.tag': 'shared_link_not_found' })
        return sendJson(response, 200, { url: link.url, id: link.id, ...(link.expires ? { expires: link.expires } : {}) })
      }
      case '/2/sharing/revoke_shared_link': {
        if (!this.links.delete(String(json().url))) return this.conflict(response, 'shared_link_not_found/', { '.tag': 'shared_link_not_found' })
        return sendJson(response, 200, null)
      }
      case '/2/files/get_metadata': {
        const file = this.files.get(String(json().path))
        if (!file) return this.conflict(response, 'path/not_found/', { '.tag': 'path', path: { '.tag': 'not_found' } })
        return sendJson(response, 200, { '.tag': 'file', id: file.id, name: file.name })
      }
      case '/2/files/delete_v2': {
        const id = String(json().path)
        if (!this.files.delete(id)) return this.conflict(response, 'path_lookup/not_found/', {})
        return sendJson(response, 200, { metadata: { id } })
      }
      default: return sendJson(response, 404, { error_summary: 'unknown endpoint' })
    }
  }
}

// --- ownCloud / Nextcloud ---------------------------------------------------------------------

export interface OcsFixtureOptions {
  username?: string
  userId?: string
  password?: string
  /** Nextcloud server major version; ownCloud fixtures report 10. */
  major?: number
  chunking?: boolean
  publicLinks?: boolean
  passwordEnforced?: boolean
  expiryEnforcedDays?: number
  publicUpload?: boolean
  /** Drop the connection on this chunk or PUT request (1-based), after storing its bytes. */
  dropAfterChunk?: number
}

export interface OcsFixtureShare { id: number; path: string; url: string; password?: string; expiration?: string; permissions: number }

export class OcsFixtureServer extends FixtureServer {
  readonly files = new Map<string, Buffer>()
  readonly folders = new Set<string>()
  readonly uploads = new Map<string, { destination: string; chunks: Map<number, Buffer> }>()
  readonly shares = new Map<number, OcsFixtureShare>()
  readonly chunkPuts: number[] = []
  plainPuts = 0
  private chunkRequests = 0
  private nextShare = 7

  constructor(readonly options: OcsFixtureOptions = {}) { super() }

  get username() { return this.options.username ?? 'ada' }
  get userId() { return this.options.userId ?? 'ada-uid' }
  get password() { return this.options.password ?? 'app-password-1' }
  /** Server root as a user would type it. */
  get serverUrl() { return `${this.url}/` }

  private authorized(request: IncomingMessage) {
    return request.headers.authorization === `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`
  }

  private ocs(response: ServerResponse, status: number, data: unknown, message = '') {
    const ok = status >= 200 && status < 300
    sendJson(response, status, { ocs: { meta: { status: ok ? 'ok' : 'failure', statuscode: ok ? 200 : status, message }, data } })
  }

  private capabilities() {
    const major = this.options.major ?? 28
    const days = this.options.expiryEnforcedDays
    return {
      version: { major, minor: 0, micro: 1, string: `${major}.0.1` },
      capabilities: {
        ...(this.options.chunking === false ? {} : { dav: { chunking: '1.0' } }),
        files_sharing: {
          api_enabled: true,
          public: this.options.publicLinks === false ? { enabled: false } : {
            enabled: true,
            password: { enforced: Boolean(this.options.passwordEnforced) },
            expire_date: days ? { enabled: true, days, enforced: true } : { enabled: false },
            upload: Boolean(this.options.publicUpload)
          }
        }
      }
    }
  }

  private filePath(pathname: string) {
    const prefix = `/remote.php/dav/files/${this.userId}/`
    return pathname.startsWith(prefix) ? decodeURIComponent(pathname.slice(prefix.length)).replace(/\/$/, '') : undefined
  }

  private chunkDrop(request: IncomingMessage) {
    this.chunkRequests += 1
    if (this.options.dropAfterChunk && this.chunkRequests === this.options.dropAfterChunk) { request.socket.destroy(); return true }
    return false
  }

  protected handle(request: IncomingMessage, response: ServerResponse, body: Buffer) {
    const url = new URL(request.url ?? '/', this.url)
    const method = request.method ?? 'GET'
    if (!this.authorized(request)) return this.ocs(response, 401, [], 'Unauthorised')
    if (url.pathname === '/ocs/v1.php/cloud/user') return sendJson(response, 200, { ocs: { meta: { status: 'ok', statuscode: 100 }, data: { id: this.userId, 'display-name': 'Ada Lovelace' } } })
    if (url.pathname === '/ocs/v1.php/cloud/capabilities') return sendJson(response, 200, { ocs: { meta: { status: 'ok', statuscode: 100 }, data: this.capabilities() } })
    const sharePrefix = '/ocs/v2.php/apps/files_sharing/api/v1/shares'
    if (url.pathname === sharePrefix && method === 'POST') {
      const form = new URLSearchParams(body.toString('utf8'))
      const path = (form.get('path') ?? '').replace(/^\//, '')
      if (!this.files.has(path)) return this.ocs(response, 404, [], 'Wrong path, file/folder does not exist')
      if (form.get('shareType') !== '3') return this.ocs(response, 400, [], 'Unknown share type')
      const password = form.get('password') ?? undefined
      if (this.options.passwordEnforced && !password) return this.ocs(response, 403, [], 'Password needs to be set for public link shares')
      const permissions = Number(form.get('permissions') ?? 1)
      if (permissions !== 1 && !this.options.publicUpload) return this.ocs(response, 400, [], 'Public upload disabled by the administrator')
      const expireDate = form.get('expireDate') ?? undefined
      const days = this.options.expiryEnforcedDays
      if (days) {
        if (!expireDate) return this.ocs(response, 403, [], 'Expiration date is enforced')
        if (Date.parse(`${expireDate}T00:00:00Z`) > Date.now() + days * 86_400_000) return this.ocs(response, 403, [], `Cannot set expiration date more than ${days} days in the future`)
      }
      const id = this.nextShare++
      const share: OcsFixtureShare = { id, path, url: `${this.url}/s/token${id}`, permissions, ...(password ? { password } : {}), ...(expireDate ? { expiration: `${expireDate} 00:00:00` } : {}) }
      this.shares.set(id, share)
      return this.ocs(response, 200, { id: String(id), url: share.url, token: `token${id}`, expiration: share.expiration ?? null, permissions })
    }
    if (url.pathname.startsWith(`${sharePrefix}/`)) {
      const id = Number(url.pathname.slice(sharePrefix.length + 1))
      const share = this.shares.get(id)
      if (!share) return this.ocs(response, 404, [], 'Wrong share ID, share does not exist')
      if (method === 'DELETE') { this.shares.delete(id); return this.ocs(response, 200, []) }
      return this.ocs(response, 200, [{ id: String(id), url: share.url, expiration: share.expiration ?? null, permissions: share.permissions }])
    }
    const uploadPrefix = `/remote.php/dav/uploads/${this.userId}/`
    if (url.pathname.startsWith(uploadPrefix)) {
      const [id, part] = url.pathname.slice(uploadPrefix.length).split('/')
      if (this.options.chunking === false) return sendJson(response, 405, {})
      if (method === 'MKCOL') {
        const destination = String(request.headers.destination ?? '')
        if (!destination) return sendJson(response, 400, {})
        this.uploads.set(id, { destination, chunks: new Map() })
        response.writeHead(201); return response.end()
      }
      const upload = this.uploads.get(id)
      if (!upload) { response.writeHead(404); return response.end() }
      if (method === 'PUT') {
        const number = Number(part)
        upload.chunks.set(number, Buffer.from(body))
        this.chunkPuts.push(number)
        if (this.chunkDrop(request)) return
        response.writeHead(201); return response.end()
      }
      if (method === 'PROPFIND') {
        const entries = [...upload.chunks.entries()].map(([number, data]) => `<d:response><d:href>${uploadPrefix}${id}/${number}</d:href><d:propstat><d:prop><d:getcontentlength>${data.length}</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`)
        response.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' })
        return response.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${uploadPrefix}${id}/</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>${entries.join('')}</d:multistatus>`)
      }
      if (method === 'MOVE' && part === '.file') {
        const target = this.filePath(new URL(String(request.headers.destination)).pathname)
        const data = Buffer.concat([...upload.chunks.entries()].sort(([a], [b]) => a - b).map(([, chunk]) => chunk))
        if (!target || String(data.length) !== request.headers['oc-total-length']) { response.writeHead(400); return response.end() }
        this.files.set(target, data)
        this.uploads.delete(id)
        response.writeHead(201); return response.end()
      }
      if (method === 'DELETE') { this.uploads.delete(id); response.writeHead(204); return response.end() }
    }
    const path = this.filePath(url.pathname)
    if (path !== undefined) {
      if (method === 'MKCOL') {
        if (this.folders.has(path)) { response.writeHead(405); return response.end() }
        this.folders.add(path); response.writeHead(201); return response.end()
      }
      if (method === 'PROPFIND') {
        if (!this.files.has(path) && !this.folders.has(path)) { response.writeHead(404); return response.end() }
        response.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' })
        return response.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${url.pathname}</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`)
      }
      if (method === 'PUT') {
        this.plainPuts += 1
        if (this.chunkDrop(request)) return
        const existed = this.files.has(path)
        this.files.set(path, Buffer.from(body))
        response.writeHead(existed ? 204 : 201); return response.end()
      }
      if (method === 'DELETE') {
        if (!this.files.delete(path)) { response.writeHead(404); return response.end() }
        response.writeHead(204); return response.end()
      }
    }
    sendJson(response, 404, {})
  }
}
