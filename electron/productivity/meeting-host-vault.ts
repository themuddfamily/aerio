import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { MeetingHostAccount, MeetingHostProvider, MeetingHostSnapshot } from '../../src/meeting-host-types'
import { MEETING_HOST_PROVIDERS } from '../../src/meeting-host-types'
import { sendOAuthCallbackPage } from '../mail/oauth-callback-page'
import { assertSecureCredentialStorage } from '../mail/secure-storage'
import {
  MEETING_HOSTS, meetingHostRedirectUri, parseMeetingHostClient,
  type BuiltInMeetingHostClients, type MeetingHostClientConfig, type MeetingHostDefinition
} from './meeting-host-providers'

// Zoom and Webex OAuth grants (E47), encrypted as one blob with OS secure storage (DPAPI, Keychain, or
// libsecret) in meeting-host-vault.dat. Like oauth-vault.dat, the file is outside the profile-backup
// allowlist, and tokens never cross to the renderer.

export interface MeetingHostSecretStorage {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

interface TokenSet {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scope?: string
}

interface StoredHost {
  config?: MeetingHostClientConfig
  tokens?: TokenSet
  account?: { id: string; email?: string; displayName?: string; connectedAt: string }
  // Why the provider rejected the stored grant; cleared by reconnecting.
  revoked?: string
}

type StoredData = Partial<Record<MeetingHostProvider, StoredHost>>

// The provider rejected Aerio's credentials. Callers show the message, which always explains how to reconnect.
export class MeetingHostAuthError extends Error {
  constructor(readonly provider: MeetingHostProvider, message: string) {
    super(message)
    this.name = 'MeetingHostAuthError'
  }
}

export const revokedMessage = (label: string) =>
  `${label} no longer accepts Aerio’s access (it was revoked, the app was removed, or the sign-in expired). Reconnect ${label} in Settings › Online meetings, then try again.`

export interface MeetingHostVaultOptions {
  storage: MeetingHostSecretStorage
  builtIn?: BuiltInMeetingHostClients
  openExternal(url: string): Promise<void>
  fetch?: typeof fetch
  // Loopback ports; tests pass 0 for an ephemeral port.
  ports?: Partial<Record<MeetingHostProvider, number>>
  now?(): number
  authorizeTimeoutMs?: number
  // Called after the connection status changes (connect, disconnect, revoked grant).
  changed?(): void
}

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; reason?: string; error_description?: string; message?: string }

const readJson = async <T>(response: Response): Promise<T> => {
  try { return await response.json() as T } catch { return {} as T }
}

export class MeetingHostVault {
  private cache?: StoredData
  private readonly refreshing = new Map<MeetingHostProvider, Promise<string>>()
  private readonly fetch: typeof fetch
  private readonly now: () => number

  constructor(private readonly path: string, private readonly options: MeetingHostVaultOptions) {
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.now = options.now ?? Date.now
  }

  private read(): StoredData {
    if (this.cache) return this.cache
    if (!existsSync(this.path)) return (this.cache = {})
    assertSecureCredentialStorage(this.options.storage)
    try {
      const parsed = JSON.parse(this.options.storage.decryptString(Buffer.from(readFileSync(this.path, 'utf8'), 'base64'))) as unknown
      this.cache = parsed && typeof parsed === 'object' ? parsed as StoredData : {}
    } catch {
      // Undecryptable (for example copied from another computer): treat as not connected.
      this.cache = {}
    }
    return this.cache
  }

  private write(next: StoredData) {
    assertSecureCredentialStorage(this.options.storage)
    if (!Object.values(next).some(Boolean)) {
      rmSync(this.path, { force: true })
      this.cache = {}
      return
    }
    const temporary = `${this.path}.partial`
    writeFileSync(temporary, this.options.storage.encryptString(JSON.stringify(next)).toString('base64'), { mode: 0o600 })
    renameSync(temporary, this.path)
    this.cache = next
  }

  private update(provider: MeetingHostProvider, change: (host: StoredHost) => StoredHost | undefined) {
    const current = this.read()
    const next = change({ ...(current[provider] ?? {}) })
    const data = { ...current }
    if (next && Object.values(next).some((value) => value !== undefined)) data[provider] = next
    else delete data[provider]
    this.write(data)
  }

  private config(provider: MeetingHostProvider) {
    return this.options.builtIn?.[provider] ?? this.read()[provider]?.config
  }

  private definition(provider: MeetingHostProvider): MeetingHostDefinition {
    return MEETING_HOSTS[provider]
  }

  private redirectUri(provider: MeetingHostProvider, port?: number) {
    return meetingHostRedirectUri(this.definition(provider), port ?? this.options.ports?.[provider])
  }

  account(provider: MeetingHostProvider): MeetingHostAccount {
    const definition = this.definition(provider)
    const config = this.config(provider)
    const host = this.read()[provider]
    return {
      provider,
      configured: Boolean(config),
      ...(config ? { configSource: this.options.builtIn?.[provider] ? 'built-in' as const : 'user' as const, clientIdHint: `${config.clientId.slice(0, 4)}…${config.clientId.slice(-4)}` } : {}),
      redirectUri: this.redirectUri(provider),
      scopes: [...definition.scopes],
      connected: Boolean(host?.tokens),
      ...(host?.account?.email ? { email: host.account.email } : {}),
      ...(host?.account?.displayName ? { displayName: host.account.displayName } : {}),
      ...(host?.account?.connectedAt ? { connectedAt: host.account.connectedAt } : {}),
      ...(host?.tokens && host.revoked ? { needsReconnect: true, error: host.revoked } : {})
    }
  }

  status(): MeetingHostSnapshot {
    return { accounts: MEETING_HOST_PROVIDERS.map((provider) => this.account(provider)) }
  }

  configure(provider: MeetingHostProvider, clientId: unknown, clientSecret: unknown) {
    const label = this.definition(provider).label
    if (this.options.builtIn?.[provider]) throw new Error(`This Aerio build already includes its ${label} app registration`)
    const config = parseMeetingHostClient(provider, clientId, clientSecret)
    // A different registration cannot use grants issued to the previous one.
    this.update(provider, (host) => ({ config, ...(host.config?.clientId === config.clientId ? { tokens: host.tokens, account: host.account, revoked: host.revoked } : {}) }))
    this.options.changed?.()
    return this.status()
  }

  async authorize(provider: MeetingHostProvider): Promise<MeetingHostAccount> {
    const definition = this.definition(provider)
    const config = this.config(provider)
    if (!config) throw new Error(`Add the ${definition.label} app’s client ID and secret first`)
    const verifier = randomBytes(64).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = randomBytes(32).toString('base64url')
    const callback = await this.listen(definition, state)
    try {
      const authorization = new URL(definition.authorizeUrl)
      authorization.search = new URLSearchParams({
        response_type: 'code', client_id: config.clientId, redirect_uri: callback.redirectUri, state,
        code_challenge: challenge, code_challenge_method: 'S256',
        ...(definition.sendScopes ? { scope: definition.scopes.join(' ') } : {})
      }).toString()
      await this.options.openExternal(authorization.toString())
      const code = await callback.code
      const token = await this.tokenRequest(definition, config, { grant_type: 'authorization_code', code, redirect_uri: callback.redirectUri, code_verifier: verifier })
      if (!token.ok || !token.body.access_token || !token.body.refresh_token) {
        throw new Error(token.body.reason ?? token.body.error_description ?? token.body.message ?? `${definition.label} did not return renewable credentials`)
      }
      const granted = new Set((token.body.scope ?? '').split(/[\s,]+/).filter(Boolean))
      const missing = granted.size ? definition.scopes.filter((scope) => !granted.has(scope)) : []
      if (missing.length) throw new Error(`The ${definition.label} app registration does not grant ${missing.join(', ')}. Add these scopes to the app and connect again.`)
      const profile = await this.profile(definition, token.body.access_token)
      const tokens: TokenSet = {
        accessToken: token.body.access_token,
        refreshToken: token.body.refresh_token,
        expiresAt: this.now() + Number(token.body.expires_in ?? 3600) * 1_000,
        ...(token.body.scope ? { scope: token.body.scope } : {})
      }
      this.update(provider, (host) => ({ config: host.config, tokens, account: { ...profile, connectedAt: new Date(this.now()).toISOString() } }))
      this.options.changed?.()
      return this.account(provider)
    } finally {
      callback.close()
    }
  }

  private listen(definition: MeetingHostDefinition, state: string) {
    const port = this.options.ports?.[definition.provider] ?? definition.redirectPort
    const timeoutMs = this.options.authorizeTimeoutMs ?? 5 * 60_000
    return new Promise<{ redirectUri: string; code: Promise<string>; close(): void }>((resolve, reject) => {
      let settle: ((code: string) => void) | undefined
      let fail: ((error: Error) => void) | undefined
      const code = new Promise<string>((resolveCode, rejectCode) => { settle = resolveCode; fail = rejectCode })
      // Settled by close() when the flow fails before the browser returns; nothing else awaits it then.
      code.catch(() => undefined)
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost')
        if (url.pathname !== definition.redirectPath) {
          sendOAuthCallbackPage(response, 404, { kind: 'not-found' })
          return
        }
        if (url.searchParams.get('state') !== state) {
          sendOAuthCallbackPage(response, 400, { kind: 'invalid-state', provider: definition.label as 'Zoom' | 'Webex' })
          fail?.(new Error(`${definition.label} returned an invalid OAuth state`))
          return
        }
        const returned = url.searchParams.get('code')
        const error = url.searchParams.get('error_description') ?? url.searchParams.get('error')
        if (!returned || error) {
          sendOAuthCallbackPage(response, 400, { kind: 'denied', provider: definition.label as 'Zoom' | 'Webex' })
          fail?.(new Error(error ? `${definition.label} sign-in failed: ${error}` : `${definition.label} did not return an authorization code`))
          return
        }
        sendOAuthCallbackPage(response, 200, { kind: 'success', provider: definition.label as 'Zoom' | 'Webex' })
        settle?.(returned)
      })
      const timeout = setTimeout(() => { server.close(); fail?.(new Error(`${definition.label} sign-in timed out after five minutes`)) }, timeoutMs)
      timeout.unref?.()
      server.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timeout)
        reject(error.code === 'EADDRINUSE'
          ? new Error(`Port ${port} is in use, so the ${definition.label} sign-in cannot receive its reply. Close the program using it and try again.`)
          : error)
      })
      server.listen(port, 'localhost', () => {
        const address = server.address()
        if (!address || typeof address === 'string') return reject(new Error(`Could not start the local ${definition.label} sign-in callback`))
        resolve({
          redirectUri: meetingHostRedirectUri(definition, address.port),
          code,
          close: () => { clearTimeout(timeout); server.close(); fail?.(new Error(`${definition.label} sign-in was closed`)) }
        })
      })
    })
  }

  private async tokenRequest(definition: MeetingHostDefinition, config: MeetingHostClientConfig, values: Record<string, string>) {
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
    const body = new URLSearchParams(values)
    if (definition.clientAuth === 'basic') headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`
    else {
      body.set('client_id', config.clientId)
      body.set('client_secret', config.clientSecret)
    }
    const response = await this.fetch(definition.tokenUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(30_000) })
    return { ok: response.ok, status: response.status, body: await readJson<TokenResponse>(response) }
  }

  private async profile(definition: MeetingHostDefinition, accessToken: string) {
    const response = await this.fetch(definition.profileUrl, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
    const body = await readJson<{ id?: string; email?: string; emails?: string[]; display_name?: string; displayName?: string; first_name?: string; last_name?: string; message?: string }>(response)
    if (!response.ok || !body.id) throw new Error(body.message ?? `Could not read the ${definition.label} profile (${response.status})`)
    const email = body.email ?? body.emails?.[0]
    const displayName = body.display_name ?? body.displayName ?? ([body.first_name, body.last_name].filter(Boolean).join(' ') || undefined)
    return { id: String(body.id), ...(email ? { email } : {}), ...(displayName ? { displayName } : {}) }
  }

  // A current access token, renewed when it expires within a minute (or when forced after a 401). Renewals
  // are single-flight because Zoom rotates refresh tokens: a second concurrent refresh would invalidate the first.
  async accessToken(provider: MeetingHostProvider, options: { forceRefresh?: boolean } = {}): Promise<string> {
    const label = this.definition(provider).label
    const host = this.read()[provider]
    if (!host?.tokens) throw new MeetingHostAuthError(provider, `Connect ${label} in Settings › Online meetings first`)
    if (host.revoked) throw new MeetingHostAuthError(provider, revokedMessage(label))
    if (!options.forceRefresh && host.tokens.expiresAt > this.now() + 60_000) return host.tokens.accessToken
    const running = this.refreshing.get(provider)
    if (running) return running
    const refresh = this.refresh(provider, host).finally(() => this.refreshing.delete(provider))
    this.refreshing.set(provider, refresh)
    return refresh
  }

  private async refresh(provider: MeetingHostProvider, host: StoredHost): Promise<string> {
    const definition = this.definition(provider)
    const config = this.config(provider)
    if (!config || !host.tokens) throw new MeetingHostAuthError(provider, `Connect ${definition.label} in Settings › Online meetings first`)
    let token: Awaited<ReturnType<MeetingHostVault['tokenRequest']>>
    try {
      token = await this.tokenRequest(definition, config, { grant_type: 'refresh_token', refresh_token: host.tokens.refreshToken })
    } catch {
      throw new Error(`${definition.label} could not be reached to renew access. Check the connection and try again.`)
    }
    if (!token.ok || !token.body.access_token) {
      if (token.status === 400 || token.status === 401) {
        this.markRevoked(provider, token.body.reason ?? token.body.error_description ?? token.body.message ?? token.body.error)
        throw new MeetingHostAuthError(provider, revokedMessage(definition.label))
      }
      throw new Error(`${definition.label} did not renew access (${token.status}). Try again in a moment.`)
    }
    const tokens: TokenSet = {
      accessToken: token.body.access_token,
      refreshToken: token.body.refresh_token ?? host.tokens.refreshToken,
      expiresAt: this.now() + Number(token.body.expires_in ?? 3600) * 1_000,
      ...(token.body.scope ?? host.tokens.scope ? { scope: token.body.scope ?? host.tokens.scope } : {})
    }
    this.update(provider, (current) => ({ ...current, tokens }))
    return tokens.accessToken
  }

  // Records that the provider refused the grant; the account shows Reconnect until it is connected again.
  markRevoked(provider: MeetingHostProvider, reason?: string) {
    const host = this.read()[provider]
    if (!host?.tokens) return
    const label = this.definition(provider).label
    this.update(provider, (current) => ({ ...current, revoked: reason?.trim() ? `${label} refused Aerio’s access: ${reason.trim().slice(0, 300)}` : `${label} refused Aerio’s access` }))
    this.options.changed?.()
  }

  async disconnect(provider: MeetingHostProvider) {
    const definition = this.definition(provider)
    const config = this.config(provider)
    const host = this.read()[provider]
    if (definition.revokeUrl && config && host?.tokens && !host.revoked) {
      try {
        await this.fetch(definition.revokeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}` },
          body: new URLSearchParams({ token: host.tokens.accessToken }),
          signal: AbortSignal.timeout(15_000)
        })
      } catch {
        // Local removal still succeeds if the provider is unreachable.
      }
    }
    this.update(provider, (current) => ({ config: current.config }))
    this.options.changed?.()
    return this.status()
  }
}
