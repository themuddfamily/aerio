import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { OAuth2Client, CodeChallengeMethod, type Credentials } from 'google-auth-library'
import { safeStorage, shell } from 'electron'
import type { MailCredentialStatus, ImapAccountInput, ImapServerSettings, MailProviderId } from '../../src/mail-types'
import {
  parseDesktopOAuthConfig,
  parseMicrosoftClientId,
  type BuiltInOAuthClients,
  type DesktopOAuthConfig
} from './oauth-config'
import { sendOAuthCallbackPage } from './oauth-callback-page'

interface StoredOAuthData {
  googleConfig?: DesktopOAuthConfig
  googleTokens: Record<string, Credentials>
  googleCalendarWrite: Record<string, boolean>
  microsoftConfig?: { clientId: string }
  microsoftTokens: Record<string, MicrosoftTokenSet>
  imapAccounts: Record<string, ImapAccountInput>
}

interface MicrosoftTokenSet {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/contacts.readonly'
]
const MICROSOFT_SCOPES = ['openid', 'profile', 'offline_access', 'User.Read', 'Mail.ReadWrite', 'Mail.Send', 'Calendars.Read', 'Contacts.Read']

export class OAuthVault {
  private data: StoredOAuthData = { googleTokens: {}, googleCalendarWrite: {}, microsoftTokens: {}, imapAccounts: {} }
  private accessCache = new Map<string, { token: string; expiresAt: number }>()

  constructor(private readonly path: string, private readonly builtIn: BuiltInOAuthClients = {}) {
    this.load()
  }

  private ensureEncryption() {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows secure storage is unavailable. Aerio will not save mail credentials without OS encryption.')
    }
  }

  private load() {
    try {
      this.ensureEncryption()
      const encrypted = Buffer.from(readFileSync(this.path, 'utf8'), 'base64')
      const parsed = JSON.parse(safeStorage.decryptString(encrypted)) as StoredOAuthData & { config?: DesktopOAuthConfig; tokens?: Record<string, Credentials> }
      this.data = {
        googleConfig: parsed.googleConfig ?? parsed.config,
        googleTokens: parsed.googleTokens ?? parsed.tokens ?? {},
        googleCalendarWrite: parsed.googleCalendarWrite ?? {},
        microsoftConfig: parsed.microsoftConfig,
        microsoftTokens: parsed.microsoftTokens ?? {},
        imapAccounts: parsed.imapAccounts ?? {}
      }
    } catch {
      // Keep any credentials already held in memory. This also prevents a
      // transient read failure from replacing a valid vault with an empty one.
    }
  }

  private save() {
    this.ensureEncryption()
    const encrypted = safeStorage.encryptString(JSON.stringify(this.data))
    const temporary = `${this.path}.partial`
    writeFileSync(temporary, encrypted.toString('base64'), { mode: 0o600 })
    renameSync(temporary, this.path)
  }

  status(): MailCredentialStatus {
    const clientId = this.googleConfig()?.clientId
    return {
      configured: Boolean(clientId),
      clientIdHint: clientId ? `${clientId.slice(0, 10)}…${clientId.slice(-12)}` : undefined,
      source: this.builtIn.googleConfig ? 'built-in' : this.data.googleConfig ? 'user' : undefined
    }
  }

  importConfig(path: string) {
    if (this.builtIn.googleConfig) throw new Error('This Aerio build already includes its Google OAuth registration')
    this.data.googleConfig = parseDesktopOAuthConfig(JSON.parse(readFileSync(path, 'utf8')))
    this.save()
    return this.status()
  }

  private googleConfig() {
    return this.builtIn.googleConfig ?? this.data.googleConfig
  }

  private config() {
    const config = this.googleConfig()
    if (!config) throw new Error('This Aerio build does not include Google OAuth credentials')
    return config
  }

  private oauth(redirectUri?: string) {
    const config = this.config()
    return new OAuth2Client(config.clientId, config.clientSecret, redirectUri)
  }

  async authorize(expected?: { accountId: string; email: string }) {
    const oauth = this.oauth()
    const { codeVerifier, codeChallenge } = await oauth.generateCodeVerifierAsync()
    const state = randomBytes(32).toString('base64url')
    const callback = await new Promise<{ redirectUri: string; code: Promise<string>; close: () => void }>((resolve, reject) => {
      let settleCode: ((code: string) => void) | undefined
      let rejectCode: ((error: Error) => void) | undefined
      const code = new Promise<string>((resolveCode, rejectValue) => {
        settleCode = resolveCode
        rejectCode = rejectValue
      })
      const timeout = setTimeout(() => {
        server.close()
        rejectCode?.(new Error('Google sign-in timed out after five minutes'))
      }, 5 * 60_000)
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== '/oauth/callback') {
          sendOAuthCallbackPage(response, 404, { kind: 'not-found' })
          return
        }
        if (url.searchParams.get('state') !== state) {
          sendOAuthCallbackPage(response, 400, { kind: 'invalid-state', provider: 'Google' })
          rejectCode?.(new Error('Google returned an invalid OAuth state'))
          return
        }
        const error = url.searchParams.get('error')
        const returnedCode = url.searchParams.get('code')
        if (error || !returnedCode) {
          sendOAuthCallbackPage(response, 400, { kind: 'denied', provider: 'Google' })
          rejectCode?.(new Error(error ? `Google sign-in failed: ${error}` : 'Google did not return an authorization code'))
          return
        }
        sendOAuthCallbackPage(response, 200, { kind: 'success', provider: 'Google' })
        settleCode?.(returnedCode)
      })
      server.on('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Could not start the secure local sign-in callback'))
          return
        }
        resolve({
          redirectUri: `http://127.0.0.1:${address.port}/oauth/callback`,
          code,
          close: () => {
            clearTimeout(timeout)
            server.close()
          }
        })
      })
    })

    const authUrl = oauth.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      redirect_uri: callback.redirectUri
    })
    await shell.openExternal(authUrl)
    try {
      const code = await callback.code
      const exchangingClient = this.oauth(callback.redirectUri)
      const result = await exchangingClient.getToken({ code, codeVerifier, redirect_uri: callback.redirectUri })
      exchangingClient.setCredentials(result.tokens)
      const accessToken = await exchangingClient.getAccessToken()
      if (!accessToken.token) throw new Error('Google did not return an access token')
      const profileResponse = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: { Authorization: `Bearer ${accessToken.token}` }
      })
      if (!profileResponse.ok) throw new Error(`Could not read the Gmail profile (${profileResponse.status})`)
      const profile = await profileResponse.json() as { emailAddress: string }
      const accountId = createHash('sha256').update(profile.emailAddress.toLowerCase()).digest('hex').slice(0, 24)
      if (expected && expected.accountId !== accountId) throw new Error(`Sign in to ${expected.email}, not a different Google account`)
      this.data.googleTokens[accountId] = { ...result.tokens, ...exchangingClient.credentials }
      const grantedScopes = new Set((exchangingClient.credentials.scope ?? result.tokens.scope ?? '').split(/\s+/).filter(Boolean))
      this.data.googleCalendarWrite[accountId] = grantedScopes.has('https://www.googleapis.com/auth/calendar') ||
        grantedScopes.has('https://www.googleapis.com/auth/calendar.events')
      this.accessCache.set(accountId, {
        token: accessToken.token,
        expiresAt: Number(exchangingClient.credentials.expiry_date ?? Date.now() + 5 * 60_000)
      })
      this.save()
      return { accountId, email: profile.emailAddress }
    } finally {
      callback.close()
    }
  }

  async accessToken(accountId: string) {
    const cached = this.accessCache.get(accountId)
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token
    let credentials = this.data.googleTokens[accountId]
    if (!credentials) {
      this.load()
      credentials = this.data.googleTokens[accountId]
    }
    if (!credentials) throw new Error('This account needs to be connected again')
    const oauth = this.oauth()
    oauth.setCredentials(credentials)
    const result = await oauth.getAccessToken()
    if (!result.token) throw new Error('Google did not provide an access token')
    this.data.googleTokens[accountId] = { ...credentials, ...oauth.credentials }
    this.save()
    this.accessCache.set(accountId, {
      token: result.token,
      expiresAt: Number(oauth.credentials.expiry_date ?? Date.now() + 5 * 60_000)
    })
    return result.token
  }

  hasGoogleCalendarWriteAccess(accountId: string) {
    let credentials = this.data.googleTokens[accountId]
    if (!credentials) {
      this.load()
      credentials = this.data.googleTokens[accountId]
    }
    const scopes = new Set((credentials?.scope ?? '').split(/\s+/).filter(Boolean))
    return this.data.googleCalendarWrite[accountId] === true ||
      scopes.has('https://www.googleapis.com/auth/calendar') ||
      scopes.has('https://www.googleapis.com/auth/calendar.events')
  }

  microsoftStatus(): MailCredentialStatus {
    const clientId = this.microsoftClientId()
    return {
      configured: Boolean(clientId),
      clientIdHint: clientId ? `${clientId.slice(0, 8)}…${clientId.slice(-4)}` : undefined,
      source: this.builtIn.microsoftClientId ? 'built-in' : this.data.microsoftConfig ? 'user' : undefined
    }
  }

  configureMicrosoft(clientId: string) {
    if (this.builtIn.microsoftClientId) throw new Error('This Aerio build already includes its Microsoft OAuth registration')
    const value = parseMicrosoftClientId(clientId)
    this.data.microsoftConfig = { clientId: value }
    this.save()
    return this.microsoftStatus()
  }

  private microsoftClientId() {
    return this.builtIn.microsoftClientId ?? this.data.microsoftConfig?.clientId
  }

  async authorizeMicrosoft(expected?: { accountId: string; email: string }) {
    const clientId = this.microsoftClientId()
    if (!clientId) throw new Error('Configure the Microsoft Entra application client ID first')
    const verifier = randomBytes(64).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = randomBytes(32).toString('base64url')
    const callback = await new Promise<{ redirectUri: string; code: Promise<string>; close: () => void }>((resolve, reject) => {
      let settle: ((code: string) => void) | undefined
      let fail: ((error: Error) => void) | undefined
      const code = new Promise<string>((resolveCode, rejectCode) => { settle = resolveCode; fail = rejectCode })
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost')
        if (url.pathname !== '/') {
          sendOAuthCallbackPage(response, 404, { kind: 'not-found' })
          return
        }
        if (url.searchParams.get('state') !== state) {
          sendOAuthCallbackPage(response, 400, { kind: 'invalid-state', provider: 'Microsoft' })
          fail?.(new Error('Microsoft returned an invalid OAuth state'))
          return
        }
        const returnedCode = url.searchParams.get('code')
        const oauthError = url.searchParams.get('error_description') ?? url.searchParams.get('error')
        if (!returnedCode || oauthError) {
          sendOAuthCallbackPage(response, 400, { kind: 'denied', provider: 'Microsoft' })
          fail?.(new Error(oauthError ?? 'Microsoft did not return an authorization code'))
          return
        }
        sendOAuthCallbackPage(response, 200, { kind: 'success', provider: 'Microsoft' })
        settle?.(returnedCode)
      })
      const timeout = setTimeout(() => { server.close(); fail?.(new Error('Microsoft sign-in timed out after five minutes')) }, 5 * 60_000)
      server.on('error', reject)
      server.listen(0, 'localhost', () => {
        const address = server.address()
        if (!address || typeof address === 'string') return reject(new Error('Could not start the local Microsoft sign-in callback'))
        resolve({ redirectUri: `http://localhost:${address.port}`, code, close: () => { clearTimeout(timeout); server.close() } })
      })
    })
    const scopes = MICROSOFT_SCOPES
    const authorization = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
    authorization.search = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: callback.redirectUri, response_mode: 'query', scope: scopes.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' }).toString()
    await shell.openExternal(authorization.toString())
    try {
      const code = await callback.code
      const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, grant_type: 'authorization_code', code, redirect_uri: callback.redirectUri, code_verifier: verifier, scope: scopes.join(' ') })
      })
      const token = await tokenResponse.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string }
      if (!tokenResponse.ok || !token.access_token || !token.refresh_token) throw new Error(token.error_description ?? 'Microsoft did not return renewable credentials')
      const profileResponse = await fetch('https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName', { headers: { Authorization: `Bearer ${token.access_token}` } })
      const profile = await profileResponse.json() as { id?: string; displayName?: string; mail?: string; userPrincipalName?: string; error?: { message?: string } }
      if (!profileResponse.ok || !profile.id) throw new Error(profile.error?.message ?? 'Could not read the Microsoft profile')
      const email = profile.mail ?? profile.userPrincipalName
      if (!email) throw new Error('The Microsoft account does not expose a mailbox address')
      const accountId = createHash('sha256').update(`microsoft:${profile.id}`).digest('hex').slice(0, 24)
      if (expected && expected.accountId !== accountId) throw new Error(`Sign in to ${expected.email}, not a different Microsoft account`)
      this.data.microsoftTokens[accountId] = { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + Number(token.expires_in ?? 3600) * 1_000 }
      this.accessCache.set(accountId, { token: token.access_token, expiresAt: this.data.microsoftTokens[accountId].expiresAt })
      this.save()
      return { accountId, email, displayName: profile.displayName ?? email.split('@')[0] }
    } finally {
      callback.close()
    }
  }

  async microsoftAccessToken(accountId: string) {
    const cached = this.accessCache.get(accountId)
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token
    const clientId = this.microsoftClientId()
    let current = this.data.microsoftTokens[accountId]
    if (!current) {
      this.load()
      current = this.data.microsoftTokens[accountId]
    }
    if (!clientId || !current) throw new Error('This Microsoft account needs to be connected again')
    const response = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, grant_type: 'refresh_token', refresh_token: current.refreshToken, scope: MICROSOFT_SCOPES.join(' ') })
    })
    const token = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string }
    if (!response.ok || !token.access_token) throw new Error(token.error_description ?? 'Microsoft token refresh failed')
    const next = { accessToken: token.access_token, refreshToken: token.refresh_token ?? current.refreshToken, expiresAt: Date.now() + Number(token.expires_in ?? 3600) * 1_000 }
    this.data.microsoftTokens[accountId] = next
    this.accessCache.set(accountId, { token: next.accessToken, expiresAt: next.expiresAt })
    this.save()
    return next.accessToken
  }

  storeImap(accountId: string, input: ImapAccountInput) {
    this.data.imapAccounts[accountId] = input
    this.save()
  }

  imapCredential(accountId: string) {
    let config = this.data.imapAccounts[accountId]
    if (!config) {
      this.load()
      config = this.data.imapAccounts[accountId]
    }
    if (!config) throw new Error('This mail account needs to be connected again')
    return config
  }

  imapSettings(accountId: string): ImapServerSettings {
    const config = this.imapCredential(accountId)
    return {
      username: config.username,
      imapHost: config.imapHost,
      imapPort: config.imapPort,
      imapSecurity: config.imapSecurity,
      smtpHost: config.smtpHost,
      smtpPort: config.smtpPort,
      smtpSecurity: config.smtpSecurity,
      allowInvalidCertificates: Boolean(config.allowInvalidCertificates),
      passwordConfigured: Boolean(config.password)
    }
  }

  async credential(accountId: string, provider: MailProviderId) {
    if (provider === 'gmail') return { type: 'oauth' as const, accessToken: await this.accessToken(accountId) }
    if (provider === 'microsoft') return { type: 'oauth' as const, accessToken: await this.microsoftAccessToken(accountId) }
    return { type: 'imap' as const, config: this.imapCredential(accountId) }
  }

  async remove(accountId: string) {
    const credentials = this.data.googleTokens[accountId]
    if (credentials) {
      try {
        const oauth = this.oauth()
        oauth.setCredentials(credentials)
        await oauth.revokeCredentials()
      } catch {
        // Local removal still succeeds if Google is unreachable.
      }
    }
    delete this.data.googleTokens[accountId]
    delete this.data.googleCalendarWrite[accountId]
    delete this.data.microsoftTokens[accountId]
    delete this.data.imapAccounts[accountId]
    this.accessCache.delete(accountId)
    this.save()
  }
}
