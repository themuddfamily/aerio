import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { OAuth2Client, CodeChallengeMethod, type Credentials } from 'google-auth-library'
import { safeStorage, shell } from 'electron'
import type { GmailCredentialStatus } from '../../src/gmail-types'
import { parseDesktopOAuthConfig, type DesktopOAuthConfig } from './oauth-config'

interface StoredOAuthData {
  config?: DesktopOAuthConfig
  tokens: Record<string, Credentials>
}

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify']

export class OAuthVault {
  private data: StoredOAuthData = { tokens: {} }
  private accessCache = new Map<string, { token: string; expiresAt: number }>()

  constructor(private readonly path: string) {
    this.load()
  }

  private ensureEncryption() {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows secure storage is unavailable. Aerio will not save Gmail tokens without OS encryption.')
    }
  }

  private load() {
    try {
      this.ensureEncryption()
      const encrypted = Buffer.from(readFileSync(this.path, 'utf8'), 'base64')
      this.data = JSON.parse(safeStorage.decryptString(encrypted)) as StoredOAuthData
      this.data.tokens ??= {}
    } catch {
      this.data = { tokens: {} }
    }
  }

  private save() {
    this.ensureEncryption()
    const encrypted = safeStorage.encryptString(JSON.stringify(this.data))
    const temporary = `${this.path}.partial`
    writeFileSync(temporary, encrypted.toString('base64'), { mode: 0o600 })
    renameSync(temporary, this.path)
  }

  status(): GmailCredentialStatus {
    const clientId = this.data.config?.clientId
    return {
      configured: Boolean(clientId),
      clientIdHint: clientId ? `${clientId.slice(0, 10)}…${clientId.slice(-12)}` : undefined
    }
  }

  importConfig(path: string) {
    this.data.config = parseDesktopOAuthConfig(JSON.parse(readFileSync(path, 'utf8')))
    this.save()
    return this.status()
  }

  private config() {
    if (!this.data.config) throw new Error('Import Google Desktop OAuth credentials first')
    return this.data.config
  }

  private oauth(redirectUri?: string) {
    const config = this.config()
    return new OAuth2Client(config.clientId, config.clientSecret, redirectUri)
  }

  async authorize() {
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
          response.writeHead(404).end('Not found')
          return
        }
        if (url.searchParams.get('state') !== state) {
          response.writeHead(400).end('Invalid OAuth state. You can close this tab.')
          rejectCode?.(new Error('Google returned an invalid OAuth state'))
          return
        }
        const error = url.searchParams.get('error')
        const returnedCode = url.searchParams.get('code')
        if (error || !returnedCode) {
          response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Aerio was not authorized. You can close this tab.')
          rejectCode?.(new Error(error ? `Google sign-in failed: ${error}` : 'Google did not return an authorization code'))
          return
        }
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end('<!doctype html><title>Aerio connected</title><style>body{font:16px system-ui;margin:4rem;max-width:38rem}h1{color:#176b55}</style><h1>Google account connected</h1><p>You can close this tab and return to Aerio.</p>')
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
      this.data.tokens[accountId] = { ...result.tokens, ...exchangingClient.credentials }
      this.save()
      return { accountId, email: profile.emailAddress }
    } finally {
      callback.close()
    }
  }

  async accessToken(accountId: string) {
    const cached = this.accessCache.get(accountId)
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token
    const credentials = this.data.tokens[accountId]
    if (!credentials) throw new Error('This account needs to be connected again')
    const oauth = this.oauth()
    oauth.setCredentials(credentials)
    const result = await oauth.getAccessToken()
    if (!result.token) throw new Error('Google did not provide an access token')
    this.data.tokens[accountId] = { ...credentials, ...oauth.credentials }
    this.save()
    this.accessCache.set(accountId, {
      token: result.token,
      expiresAt: Number(oauth.credentials.expiry_date ?? Date.now() + 5 * 60_000)
    })
    return result.token
  }

  async remove(accountId: string) {
    const credentials = this.data.tokens[accountId]
    if (credentials) {
      try {
        const oauth = this.oauth()
        oauth.setCredentials(credentials)
        await oauth.revokeCredentials()
      } catch {
        // Local removal still succeeds if Google is unreachable.
      }
    }
    delete this.data.tokens[accountId]
    this.accessCache.delete(accountId)
    this.save()
  }
}
