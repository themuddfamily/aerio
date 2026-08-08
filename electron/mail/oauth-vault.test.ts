import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImapAccountInput } from '../../src/mail-types'

const mocks = vi.hoisted(() => {
  const files = new Map<string, string>()
  const oauthQueue: any[] = []
  const oauthInstances: Array<{ args: unknown[]; client: any }> = []
  const servers: any[] = []
  let encryptionAvailable = true
  let callbackPlan: ((url: string, server: any) => void) | undefined
  let serverAddress: any = { port: 43123 }
  let serverError: unknown

  const OAuth2Client = vi.fn(function (this: unknown, ...args: unknown[]) {
    const client = oauthQueue.shift()
    if (!client) throw new Error('No mock Google OAuth client queued')
    oauthInstances.push({ args, client })
    return client
  })

  const createServer = vi.fn((handler: (request: any, response: any) => void) => {
    const errorHandlers: Array<(error: unknown) => void> = []
    const server = {
      handler,
      close: vi.fn(),
      on: vi.fn((event: string, callback: (error: unknown) => void) => {
        if (event === 'error') errorHandlers.push(callback)
        return server
      }),
      listen: vi.fn((_port: number, _host: string, callback: () => void) => {
        if (serverError) {
          for (const errorHandler of errorHandlers) errorHandler(serverError)
        } else callback()
        return server
      }),
      address: vi.fn(() => serverAddress)
    }
    servers.push(server)
    return server
  })

  const shell = {
    openExternal: vi.fn(async (authorizationUrl: string) => {
      const server = servers.at(-1)
      if (!server) throw new Error('No OAuth callback server')
      if (callbackPlan) callbackPlan(authorizationUrl, server)
      else {
        const authorization = new URL(authorizationUrl)
        const state = authorization.searchParams.get('state')
        const microsoft = authorization.hostname === 'login.microsoftonline.com'
        server.handler(
          { url: `${microsoft ? '/' : '/oauth/callback'}?state=${encodeURIComponent(state ?? '')}&code=authorization-code` },
          {}
        )
      }
    })
  }

  return {
    files,
    oauthQueue,
    oauthInstances,
    servers,
    OAuth2Client,
    createServer,
    shell,
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => encryptionAvailable),
      encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
      decryptString: vi.fn((value: Buffer) => value.toString().replace(/^encrypted:/, ''))
    },
    fs: {
      readFileSync: vi.fn((path: string) => {
        const value = files.get(path)
        if (value === undefined) throw new Error('ENOENT')
        return value
      }),
      writeFileSync: vi.fn((path: string, value: string) => { files.set(path, value) }),
      renameSync: vi.fn((source: string, destination: string) => {
        const value = files.get(source)
        if (value === undefined) throw new Error('ENOENT')
        files.set(destination, value)
        files.delete(source)
      })
    },
    parseDesktopOAuthConfig: vi.fn(() => ({ clientId: 'user-client.apps.googleusercontent.com', clientSecret: 'user-secret' })),
    parseMicrosoftClientId: vi.fn((value: string) => value.trim()),
    callbackPage: vi.fn(),
    setEncryptionAvailable(value: boolean) { encryptionAvailable = value },
    setCallbackPlan(value?: (url: string, server: any) => void) { callbackPlan = value },
    setServerAddress(value: any) { serverAddress = value },
    setServerError(value?: unknown) { serverError = value }
  }
})

vi.mock('node:fs', () => mocks.fs)
vi.mock('node:http', () => ({ createServer: mocks.createServer }))
vi.mock('electron', () => ({ safeStorage: mocks.safeStorage, shell: mocks.shell }))
vi.mock('google-auth-library', () => ({
  OAuth2Client: mocks.OAuth2Client,
  CodeChallengeMethod: { S256: 'S256' }
}))
vi.mock('./oauth-config', () => ({
  parseDesktopOAuthConfig: mocks.parseDesktopOAuthConfig,
  parseMicrosoftClientId: mocks.parseMicrosoftClientId
}))
vi.mock('./oauth-callback-page', () => ({ sendOAuthCallbackPage: mocks.callbackPage }))

import { OAuthVault } from './oauth-vault'

const vaultPath = 'C:\\data\\oauth-vault.dat'
const googleConfig = { clientId: 'built-in-client.apps.googleusercontent.com', clientSecret: 'built-in-secret' }
const microsoftClientId = '4369b922-aba6-4a2c-acef-2e1c51b8f372'
const imap: ImapAccountInput = {
  provider: 'imap', email: 'person@example.test', username: 'person', password: 'secret',
  imapHost: 'imap.example.test', imapPort: 993, imapSecurity: 'tls',
  smtpHost: 'smtp.example.test', smtpPort: 587, smtpSecurity: 'starttls'
}

function stored(data: unknown) {
  return Buffer.from(`encrypted:${JSON.stringify(data)}`).toString('base64')
}

function googleClient(overrides: Record<string, unknown> = {}) {
  const client: any = {
    credentials: {},
    generateCodeVerifierAsync: vi.fn().mockResolvedValue({ codeVerifier: 'verifier', codeChallenge: 'challenge' }),
    generateAuthUrl: vi.fn().mockReturnValue('https://accounts.google.test/authorize'),
    getToken: vi.fn().mockResolvedValue({ tokens: {} }),
    setCredentials: vi.fn((credentials: unknown) => { client.credentials = { ...(credentials as object) } }),
    getAccessToken: vi.fn().mockResolvedValue({ token: 'google-access-token' }),
    revokeCredentials: vi.fn().mockResolvedValue(undefined),
    ...overrides
  }
  return client
}

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: vi.fn().mockResolvedValue(body) }
}

function privateData(vault: OAuthVault) {
  return (vault as unknown as { data: any }).data
}

function privateCache(vault: OAuthVault) {
  return (vault as unknown as { accessCache: Map<string, { token: string; expiresAt: number }> }).accessCache
}

describe('OAuthVault storage and configuration', () => {
  beforeEach(() => {
    mocks.files.clear()
    mocks.oauthQueue.length = 0
    mocks.oauthInstances.length = 0
    mocks.servers.length = 0
    mocks.setEncryptionAvailable(true)
    mocks.setCallbackPlan()
    mocks.setServerAddress({ port: 43123 })
    mocks.setServerError()
    mocks.OAuth2Client.mockClear()
    mocks.createServer.mockClear()
    mocks.shell.openExternal.mockClear()
    mocks.safeStorage.isEncryptionAvailable.mockClear()
    mocks.safeStorage.encryptString.mockClear()
    mocks.safeStorage.decryptString.mockClear()
    mocks.fs.readFileSync.mockClear()
    mocks.fs.writeFileSync.mockClear()
    mocks.fs.renameSync.mockClear()
    mocks.parseDesktopOAuthConfig.mockClear()
    mocks.parseMicrosoftClientId.mockClear()
    mocks.callbackPage.mockClear()
    vi.unstubAllGlobals()
  })

  it('loads legacy Google keys while filling newer collections with defaults', () => {
    mocks.files.set(vaultPath, stored({
      config: { clientId: 'legacy.apps.googleusercontent.com', clientSecret: 'legacy-secret' },
      tokens: { google1: { refresh_token: 'refresh' } }
    }))
    const vault = new OAuthVault(vaultPath)
    expect(vault.status()).toEqual({
      configured: true,
      clientIdHint: 'legacy.app…rcontent.com',
      source: 'user'
    })
    expect(privateData(vault)).toMatchObject({
      googleTokens: { google1: { refresh_token: 'refresh' } },
      googleCalendarWrite: {}, microsoftTokens: {}, imapAccounts: {}
    })
  })

  it('keeps an empty in-memory vault when encrypted storage is missing or malformed', () => {
    expect(new OAuthVault(vaultPath).status()).toEqual({ configured: false, clientIdHint: undefined, source: undefined })
    mocks.files.set(vaultPath, stored('not-an-object'))
    expect(new OAuthVault(vaultPath).status().configured).toBe(false)
    mocks.setEncryptionAvailable(false)
    const vault = new OAuthVault(vaultPath)
    expect(() => vault.storeImap('imap-1', imap)).toThrow('Windows secure storage is unavailable')
  })

  it('imports and atomically saves a user Google desktop configuration', () => {
    mocks.files.set('selected.json', '{"installed":{}}')
    const vault = new OAuthVault(vaultPath)
    expect(vault.importConfig('selected.json')).toEqual({
      configured: true,
      clientIdHint: 'user-clien…rcontent.com',
      source: 'user'
    })
    expect(mocks.parseDesktopOAuthConfig).toHaveBeenCalledWith({ installed: {} })
    expect(mocks.fs.writeFileSync).toHaveBeenCalledWith(`${vaultPath}.partial`, expect.any(String), { mode: 0o600 })
    expect(mocks.fs.renameSync).toHaveBeenCalledWith(`${vaultPath}.partial`, vaultPath)
  })

  it('prefers built-in Google and Microsoft registrations and prevents replacement', () => {
    const vault = new OAuthVault(vaultPath, { googleConfig, microsoftClientId })
    expect(vault.status()).toMatchObject({ configured: true, source: 'built-in' })
    expect(vault.microsoftStatus()).toEqual({ configured: true, clientIdHint: '4369b922…f372', source: 'built-in' })
    expect(() => vault.importConfig('selected.json')).toThrow('already includes its Google OAuth registration')
    expect(() => vault.configureMicrosoft('replacement')).toThrow('already includes its Microsoft OAuth registration')
  })

  it('configures and reports a user Microsoft registration', () => {
    const vault = new OAuthVault(vaultPath)
    expect(vault.microsoftStatus()).toEqual({ configured: false, clientIdHint: undefined, source: undefined })
    expect(vault.configureMicrosoft(` ${microsoftClientId} `)).toEqual({
      configured: true, clientIdHint: '4369b922…f372', source: 'user'
    })
    expect(mocks.parseMicrosoftClientId).toHaveBeenCalledWith(` ${microsoftClientId} `)
  })

  it('stores, retrieves, and summarizes IMAP credentials', () => {
    const vault = new OAuthVault(vaultPath)
    vault.storeImap('imap-1', { ...imap, allowInvalidCertificates: true })
    expect(vault.imapCredential('imap-1')).toMatchObject({ username: 'person', password: 'secret' })
    expect(vault.imapSettings('imap-1')).toEqual({
      username: 'person', imapHost: 'imap.example.test', imapPort: 993, imapSecurity: 'tls',
      smtpHost: 'smtp.example.test', smtpPort: 587, smtpSecurity: 'starttls',
      allowInvalidCertificates: true, passwordConfigured: true
    })
    expect(new OAuthVault(vaultPath).imapCredential('imap-1')).toMatchObject({ email: 'person@example.test' })
  })

  it('reloads once before reporting a missing IMAP credential', () => {
    const vault = new OAuthVault(vaultPath)
    expect(() => vault.imapCredential('missing')).toThrow('needs to be connected again')
    expect(mocks.fs.readFileSync).toHaveBeenCalledTimes(2)
  })

  it('routes generic credential requests to the correct provider', async () => {
    const vault = new OAuthVault(vaultPath)
    vi.spyOn(vault, 'accessToken').mockResolvedValue('google-token')
    vi.spyOn(vault, 'microsoftAccessToken').mockResolvedValue('microsoft-token')
    vi.spyOn(vault, 'imapCredential').mockReturnValue(imap)
    await expect(vault.credential('a', 'gmail')).resolves.toEqual({ type: 'oauth', accessToken: 'google-token' })
    await expect(vault.credential('b', 'microsoft')).resolves.toEqual({ type: 'oauth', accessToken: 'microsoft-token' })
    await expect(vault.credential('c', 'fastmail')).resolves.toEqual({ type: 'imap', config: imap })
  })
})

describe('OAuthVault access tokens', () => {
  beforeEach(() => {
    mocks.files.clear()
    mocks.oauthQueue.length = 0
    mocks.oauthInstances.length = 0
    mocks.setEncryptionAvailable(true)
    mocks.fs.readFileSync.mockClear()
    mocks.fs.writeFileSync.mockClear()
    mocks.fs.renameSync.mockClear()
    vi.unstubAllGlobals()
  })

  it('returns a sufficiently fresh Google token from memory', async () => {
    const vault = new OAuthVault(vaultPath, { googleConfig })
    privateCache(vault).set('google-1', { token: 'cached', expiresAt: Date.now() + 120_000 })
    await expect(vault.accessToken('google-1')).resolves.toBe('cached')
    expect(mocks.OAuth2Client).not.toHaveBeenCalled()
  })

  it('refreshes and persists Google credentials, using a fallback expiry', async () => {
    const vault = new OAuthVault(vaultPath, { googleConfig })
    privateData(vault).googleTokens['google-1'] = { refresh_token: 'old-refresh', scope: 'scope-a' }
    const oauth = googleClient()
    oauth.getAccessToken.mockImplementation(async () => {
      oauth.credentials = { refresh_token: 'new-refresh' }
      return { token: 'fresh-token' }
    })
    mocks.oauthQueue.push(oauth)
    await expect(vault.accessToken('google-1')).resolves.toBe('fresh-token')
    expect(oauth.setCredentials).toHaveBeenCalledWith({ refresh_token: 'old-refresh', scope: 'scope-a' })
    expect(privateData(vault).googleTokens['google-1']).toMatchObject({ refresh_token: 'new-refresh', scope: 'scope-a' })
    expect(privateCache(vault).get('google-1')).toMatchObject({ token: 'fresh-token', expiresAt: expect.any(Number) })
  })

  it('reloads missing Google credentials and gives a reconnect error', async () => {
    const vault = new OAuthVault(vaultPath, { googleConfig })
    await expect(vault.accessToken('missing')).rejects.toThrow('needs to be connected again')
    expect(mocks.fs.readFileSync).toHaveBeenCalledTimes(2)
  })

  it('rejects an empty Google access-token response', async () => {
    const vault = new OAuthVault(vaultPath, { googleConfig })
    privateData(vault).googleTokens['google-1'] = { refresh_token: 'refresh' }
    mocks.oauthQueue.push(googleClient({ getAccessToken: vi.fn().mockResolvedValue({ token: null }) }))
    await expect(vault.accessToken('google-1')).rejects.toThrow('did not provide an access token')
  })

  it('recognizes stored or scope-derived Google Calendar write access', () => {
    const vault = new OAuthVault(vaultPath)
    privateData(vault).googleTokens = {
      marker: { scope: 'readonly' },
      calendar: { scope: 'https://www.googleapis.com/auth/calendar' },
      events: { scope: 'one https://www.googleapis.com/auth/calendar.events two' }
    }
    privateData(vault).googleCalendarWrite.marker = true
    expect(vault.hasGoogleCalendarWriteAccess('marker')).toBe(true)
    expect(vault.hasGoogleCalendarWriteAccess('calendar')).toBe(true)
    expect(vault.hasGoogleCalendarWriteAccess('events')).toBe(true)
    expect(vault.hasGoogleCalendarWriteAccess('missing')).toBe(false)
  })

  it('recognizes provider Contacts write scopes without treating read-only access as writable', () => {
    const vault = new OAuthVault(vaultPath)
    privateData(vault).googleTokens = {
      write: { scope: 'https://www.googleapis.com/auth/contacts' },
      readonly: { scope: 'https://www.googleapis.com/auth/contacts.readonly' }
    }
    privateData(vault).microsoftTokens = {
      write: { accessToken: 'a', refreshToken: 'r', expiresAt: 0, scope: 'Mail.ReadWrite Contacts.ReadWrite' },
      readonly: { accessToken: 'a', refreshToken: 'r', expiresAt: 0, scope: 'Contacts.Read' }
    }
    expect(vault.hasGoogleContactsWriteAccess('write')).toBe(true)
    expect(vault.hasGoogleContactsWriteAccess('readonly')).toBe(false)
    expect(vault.hasMicrosoftContactsWriteAccess('write')).toBe(true)
    expect(vault.hasMicrosoftContactsWriteAccess('readonly')).toBe(false)
  })

  it('returns a sufficiently fresh Microsoft token from memory', async () => {
    const vault = new OAuthVault(vaultPath, { microsoftClientId })
    privateCache(vault).set('microsoft-1', { token: 'cached', expiresAt: Date.now() + 120_000 })
    await expect(vault.microsoftAccessToken('microsoft-1')).resolves.toBe('cached')
  })

  it('refreshes Microsoft credentials and retains an omitted refresh token', async () => {
    const vault = new OAuthVault(vaultPath, { microsoftClientId })
    privateData(vault).microsoftTokens['microsoft-1'] = { accessToken: 'old', refreshToken: 'refresh', expiresAt: 0 }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ access_token: 'new', expires_in: 120 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(vault.microsoftAccessToken('microsoft-1')).resolves.toBe('new')
    expect(privateData(vault).microsoftTokens['microsoft-1']).toMatchObject({ accessToken: 'new', refreshToken: 'refresh' })
    const request = fetchMock.mock.calls[0]
    expect(request[0]).toContain('/token')
    expect(String((request[1] as any).body)).toContain('grant_type=refresh_token')
  })

  it('reports missing or rejected Microsoft refresh credentials', async () => {
    const missing = new OAuthVault(vaultPath)
    await expect(missing.microsoftAccessToken('missing')).rejects.toThrow('needs to be connected again')

    const vault = new OAuthVault(vaultPath, { microsoftClientId })
    privateData(vault).microsoftTokens['microsoft-1'] = { accessToken: 'old', refreshToken: 'refresh', expiresAt: 0 }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error_description: 'Refresh revoked' }, false)))
    await expect(vault.microsoftAccessToken('microsoft-1')).rejects.toThrow('Refresh revoked')

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, true)))
    await expect(vault.microsoftAccessToken('microsoft-1')).rejects.toThrow('Microsoft token refresh failed')
  })

  it('removes every local credential even when Google revocation fails', async () => {
    const vault = new OAuthVault(vaultPath, { googleConfig })
    privateData(vault).googleTokens.account = { refresh_token: 'refresh' }
    privateData(vault).googleCalendarWrite.account = true
    privateData(vault).microsoftTokens.account = { accessToken: 'a', refreshToken: 'r', expiresAt: 0 }
    privateData(vault).imapAccounts.account = imap
    privateCache(vault).set('account', { token: 'cached', expiresAt: Infinity })
    const oauth = googleClient({ revokeCredentials: vi.fn().mockRejectedValue(new Error('offline')) })
    mocks.oauthQueue.push(oauth)
    await vault.remove('account')
    expect(oauth.revokeCredentials).toHaveBeenCalledOnce()
    expect(privateData(vault).googleTokens.account).toBeUndefined()
    expect(privateData(vault).googleCalendarWrite.account).toBeUndefined()
    expect(privateData(vault).microsoftTokens.account).toBeUndefined()
    expect(privateData(vault).imapAccounts.account).toBeUndefined()
    expect(privateCache(vault).has('account')).toBe(false)

    // Removing an account without Google credentials skips revocation.
    await vault.remove('another')
  })
})

describe('OAuthVault interactive authorization', () => {
  beforeEach(() => {
    mocks.files.clear()
    mocks.oauthQueue.length = 0
    mocks.oauthInstances.length = 0
    mocks.servers.length = 0
    mocks.setEncryptionAvailable(true)
    mocks.setCallbackPlan()
    mocks.setServerAddress({ port: 43123 })
    mocks.setServerError()
    mocks.shell.openExternal.mockClear()
    mocks.callbackPage.mockClear()
    vi.unstubAllGlobals()
  })

  afterEach(() => vi.useRealTimers())

  it('authorizes Google with PKCE, reads the profile, and records Calendar scope', async () => {
    const authorizationClient = googleClient()
    authorizationClient.generateAuthUrl.mockImplementation((options: Record<string, unknown>) => {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      url.searchParams.set('state', String(options.state))
      return url.toString()
    })
    const exchangeClient = googleClient({
      getToken: vi.fn().mockResolvedValue({ tokens: { refresh_token: 'refresh' } })
    })
    exchangeClient.getAccessToken.mockImplementation(async () => {
      exchangeClient.credentials = {
        ...exchangeClient.credentials,
        scope: 'https://www.googleapis.com/auth/calendar.events',
        expiry_date: Date.now() + 300_000
      }
      return { token: 'access' }
    })
    mocks.oauthQueue.push(authorizationClient, exchangeClient)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ emailAddress: 'Person@Example.test' })))
    const vault = new OAuthVault(vaultPath, { googleConfig })
    const account = await vault.authorize()
    expect(account).toEqual({ accountId: expect.stringMatching(/^[0-9a-f]{24}$/), email: 'Person@Example.test' })
    expect(authorizationClient.generateAuthUrl).toHaveBeenCalledWith(expect.objectContaining({
      access_type: 'offline', prompt: 'consent', code_challenge: 'challenge',
      code_challenge_method: 'S256', redirect_uri: 'http://127.0.0.1:43123/oauth/callback',
      scope: expect.arrayContaining(['https://www.googleapis.com/auth/contacts'])
    }))
    expect(mocks.oauthInstances[1].args).toEqual([googleConfig.clientId, googleConfig.clientSecret, 'http://127.0.0.1:43123/oauth/callback'])
    expect(exchangeClient.getToken).toHaveBeenCalledWith({ code: 'authorization-code', codeVerifier: 'verifier', redirect_uri: 'http://127.0.0.1:43123/oauth/callback' })
    expect(vault.hasGoogleCalendarWriteAccess(account.accountId)).toBe(true)
    expect(mocks.servers[0].close).toHaveBeenCalledOnce()
    expect(mocks.callbackPage).toHaveBeenCalledWith({}, 200, { kind: 'success', provider: 'Google' })
  })

  it('closes Google authorization after profile and expected-account failures', async () => {
    const authorizeOnce = async (profileResponse: any, expected?: { accountId: string; email: string }) => {
      const first = googleClient()
      first.generateAuthUrl.mockImplementation((options: Record<string, unknown>) => `https://accounts.google.test/?state=${options.state}`)
      mocks.oauthQueue.push(first, googleClient({ getToken: vi.fn().mockResolvedValue({ tokens: {} }) }))
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(profileResponse))
      return new OAuthVault(vaultPath, { googleConfig }).authorize(expected)
    }
    await expect(authorizeOnce(jsonResponse({}, false, 503))).rejects.toThrow('Could not read the Gmail profile (503)')
    await expect(authorizeOnce(jsonResponse({ emailAddress: 'other@example.test' }), { accountId: 'wrong', email: 'wanted@example.test' }))
      .rejects.toThrow('Sign in to wanted@example.test')
    expect(mocks.servers.every((server) => server.close.mock.calls.length === 1)).toBe(true)
  })

  it('reports an empty Google token and missing Google configuration', async () => {
    await expect(new OAuthVault(vaultPath).authorize()).rejects.toThrow('does not include Google OAuth credentials')
    const first = googleClient()
    first.generateAuthUrl.mockImplementation((options: Record<string, unknown>) => `https://accounts.google.test/?state=${options.state}`)
    mocks.oauthQueue.push(first, googleClient({ getAccessToken: vi.fn().mockResolvedValue({ token: null }) }))
    await expect(new OAuthVault(vaultPath, { googleConfig }).authorize()).rejects.toThrow('did not return an access token')
  })

  it('rejects invalid, denied, and missing-code Google callbacks', async () => {
    const callbackCases = [
      { query: 'state=wrong&code=code', message: 'invalid OAuth state', kind: 'invalid-state' },
      { query: 'error=access_denied', message: 'sign-in failed: access_denied', kind: 'denied' },
      { query: '', message: 'did not return an authorization code', kind: 'denied' }
    ]
    for (const testCase of callbackCases) {
      const first = googleClient()
      first.generateAuthUrl.mockImplementation((options: Record<string, unknown>) => `https://accounts.google.test/?state=${options.state}`)
      mocks.oauthQueue.push(first)
      mocks.setCallbackPlan((authorizationUrl, server) => {
        const state = new URL(authorizationUrl).searchParams.get('state')
        const query = testCase.kind === 'invalid-state'
          ? testCase.query
          : `state=${encodeURIComponent(state ?? '')}${testCase.query ? `&${testCase.query}` : ''}`
        server.handler({ url: `/oauth/callback?${query}` }, {})
      })
      await expect(new OAuthVault(vaultPath, { googleConfig }).authorize()).rejects.toThrow(testCase.message)
      expect(mocks.callbackPage).toHaveBeenLastCalledWith({}, 400, expect.objectContaining({ kind: testCase.kind, provider: 'Google' }))
    }
  })

  it('ignores unrelated Google callback paths before accepting the real callback', async () => {
    const first = googleClient()
    first.generateAuthUrl.mockImplementation((options: Record<string, unknown>) => `https://accounts.google.test/?state=${options.state}`)
    mocks.oauthQueue.push(first, googleClient())
    mocks.setCallbackPlan((authorizationUrl, server) => {
      const state = new URL(authorizationUrl).searchParams.get('state')
      server.handler({ url: '/favicon.ico' }, {})
      server.handler({ url: `/oauth/callback?state=${state}&code=ok` }, {})
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ emailAddress: 'person@example.test' })))
    await expect(new OAuthVault(vaultPath, { googleConfig }).authorize()).resolves.toMatchObject({ email: 'person@example.test' })
    expect(mocks.callbackPage).toHaveBeenCalledWith({}, 404, { kind: 'not-found' })
  })

  it('authorizes Microsoft with PKCE and mailbox profile fallbacks', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'access', refresh_token: 'refresh' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'profile-id', userPrincipalName: 'person@example.test' })))
    const vault = new OAuthVault(vaultPath, { microsoftClientId })
    const account = await vault.authorizeMicrosoft()
    expect(account).toEqual({ accountId: expect.stringMatching(/^[0-9a-f]{24}$/), email: 'person@example.test', displayName: 'person' })
    const opened = new URL(String(mocks.shell.openExternal.mock.calls.at(-1)?.[0]))
    expect(opened.origin + opened.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
    expect(opened.searchParams.get('code_challenge_method')).toBe('S256')
    expect(opened.searchParams.get('scope')).toContain('Mail.Send')
    expect(opened.searchParams.get('scope')).toContain('Contacts.ReadWrite')
    expect(privateData(vault).microsoftTokens[account.accountId]).toMatchObject({ accessToken: 'access', refreshToken: 'refresh' })
    expect(mocks.servers[0].close).toHaveBeenCalledOnce()
  })

  it('requires Microsoft configuration and renewable token credentials', async () => {
    await expect(new OAuthVault(vaultPath).authorizeMicrosoft()).rejects.toThrow('Configure the Microsoft Entra')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error_description: 'Consent denied' }, false)))
    await expect(new OAuthVault(vaultPath, { microsoftClientId }).authorizeMicrosoft()).rejects.toThrow('Consent denied')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, true)))
    await expect(new OAuthVault(vaultPath, { microsoftClientId }).authorizeMicrosoft()).rejects.toThrow('renewable credentials')
  })

  it('reports Microsoft profile, mailbox, and expected-account failures', async () => {
    const run = async (profile: unknown, ok = true, expected?: { accountId: string; email: string }) => {
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(jsonResponse({ access_token: 'access', refresh_token: 'refresh' }))
        .mockResolvedValueOnce(jsonResponse(profile, ok)))
      return new OAuthVault(vaultPath, { microsoftClientId }).authorizeMicrosoft(expected)
    }
    await expect(run({ error: { message: 'Graph denied' } }, false)).rejects.toThrow('Graph denied')
    await expect(run({}, true)).rejects.toThrow('Could not read the Microsoft profile')
    await expect(run({ id: 'profile-id' })).rejects.toThrow('does not expose a mailbox address')
    await expect(run({ id: 'profile-id', mail: 'other@example.test' }, true, { accountId: 'wrong', email: 'wanted@example.test' }))
      .rejects.toThrow('Sign in to wanted@example.test')
  })

  it('handles Microsoft callback validation and unrelated paths', async () => {
    const cases = [
      { query: 'state=wrong&code=ok', message: 'invalid OAuth state', kind: 'invalid-state' },
      { query: 'error_description=No+thanks', message: 'No thanks', kind: 'denied' },
      { query: '', message: 'did not return an authorization code', kind: 'denied' }
    ]
    for (const testCase of cases) {
      mocks.setCallbackPlan((authorizationUrl, server) => {
        const state = new URL(authorizationUrl).searchParams.get('state')
        const query = testCase.kind === 'invalid-state'
          ? testCase.query
          : `state=${encodeURIComponent(state ?? '')}${testCase.query ? `&${testCase.query}` : ''}`
        server.handler({ url: `/?${query}` }, {})
      })
      await expect(new OAuthVault(vaultPath, { microsoftClientId }).authorizeMicrosoft()).rejects.toThrow(testCase.message)
      expect(mocks.callbackPage).toHaveBeenLastCalledWith({}, 400, expect.objectContaining({ kind: testCase.kind, provider: 'Microsoft' }))
    }

    mocks.setCallbackPlan((authorizationUrl, server) => {
      const state = new URL(authorizationUrl).searchParams.get('state')
      server.handler({ url: '/favicon.ico' }, {})
      server.handler({ url: `/?state=${state}&code=ok` }, {})
    })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'a', refresh_token: 'r' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'id', mail: 'mail@example.test' })))
    await expect(new OAuthVault(vaultPath, { microsoftClientId }).authorizeMicrosoft()).resolves.toMatchObject({ email: 'mail@example.test' })
    expect(mocks.callbackPage).toHaveBeenCalledWith({}, 404, { kind: 'not-found' })
  })

  it('reports callback server startup failures for both providers', async () => {
    mocks.setServerAddress(undefined)
    mocks.oauthQueue.push(googleClient())
    await expect(new OAuthVault(vaultPath, { googleConfig }).authorize()).rejects.toThrow('Could not start the secure local sign-in callback')
    await expect(new OAuthVault(vaultPath, { microsoftClientId }).authorizeMicrosoft()).rejects.toThrow('Could not start the local Microsoft sign-in callback')

    mocks.setServerAddress('named-pipe')
    mocks.oauthQueue.push(googleClient())
    await expect(new OAuthVault(vaultPath, { googleConfig }).authorize()).rejects.toThrow('Could not start the secure local sign-in callback')

    mocks.setServerAddress({ port: 1 })
    mocks.setServerError(new Error('EADDRINUSE'))
    mocks.oauthQueue.push(googleClient())
    await expect(new OAuthVault(vaultPath, { googleConfig }).authorize()).rejects.toThrow('EADDRINUSE')
    await expect(new OAuthVault(vaultPath, { microsoftClientId }).authorizeMicrosoft()).rejects.toThrow('EADDRINUSE')
  })

  it('times out abandoned Google and Microsoft callback sessions', async () => {
    vi.useFakeTimers()
    mocks.setCallbackPlan(() => undefined)
    mocks.oauthQueue.push(googleClient())
    const googleAuthorization = new OAuthVault(vaultPath, { googleConfig }).authorize()
    const googleFailure = expect(googleAuthorization).rejects.toThrow('Google sign-in timed out after five minutes')
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await googleFailure

    const microsoftAuthorization = new OAuthVault(vaultPath, { microsoftClientId }).authorizeMicrosoft()
    const microsoftFailure = expect(microsoftAuthorization).rejects.toThrow('Microsoft sign-in timed out after five minutes')
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await microsoftFailure
  })
})
