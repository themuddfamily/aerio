import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  discoverHomeserver, homeserverBase, isPrivateHost, loginFlows, logout, passwordLogin, serverNameFromInput,
  validateHomeserverUrl, validMatrixUserId, whoami
} from './homeserver'
import { FakeHomeserver } from './test-homeserver'

let server: FakeHomeserver
beforeAll(async () => {
  server = await new FakeHomeserver().start()
  server.addUser('alice', 'correct horse')
})
afterAll(() => server.stop())

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } })

describe('homeserver validation', () => {
  it('requires HTTPS and allows loopback HTTP only for fixtures', () => {
    expect(validateHomeserverUrl('matrix.example.org').toString()).toBe('https://matrix.example.org/')
    expect(homeserverBase(validateHomeserverUrl('https://matrix.example.org/base/'))).toBe('https://matrix.example.org/base')
    expect(() => validateHomeserverUrl('http://matrix.example.org')).toThrow('HTTPS only')
    expect(() => validateHomeserverUrl('http://127.0.0.1:8008')).toThrow('HTTPS only')
    expect(validateHomeserverUrl('http://127.0.0.1:8008', { allowLoopbackHttp: true }).origin).toBe('http://127.0.0.1:8008')
    expect(() => validateHomeserverUrl('http://10.0.0.5', { allowLoopbackHttp: true })).toThrow('HTTPS only')
    expect(() => validateHomeserverUrl('ftp://example.org')).toThrow('HTTPS only')
    expect(() => validateHomeserverUrl('https://user:pw@example.org')).toThrow('credentials')
    expect(() => validateHomeserverUrl('https://example.org/?token=1')).toThrow('query')
    expect(() => validateHomeserverUrl('   ')).toThrow('Enter a homeserver')
    expect(() => validateHomeserverUrl('https://exa mple.org')).toThrow('valid URL')
  })

  it('classifies private destinations and Matrix identifiers', () => {
    for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.4', '172.20.0.1', '169.254.1.1', '[::1]', 'fd00::1', 'printer.local', 'intranet']) expect(isPrivateHost(host)).toBe(true)
    for (const host of ['matrix.org', '8.8.8.8', '2001:db8::1']) expect(isPrivateHost(host)).toBe(false)
    expect(serverNameFromInput('@alice:example.org')).toBe('example.org')
    expect(() => serverNameFromInput('@alice')).toThrow('full Matrix ID')
    expect(validMatrixUserId('@alice:example.org')).toBe(true)
    expect(validMatrixUserId('alice@example.org')).toBe(false)
  })
})

describe('discovery and login against a loopback fixture', () => {
  it('reports advertised login methods honestly', async () => {
    const flows = await loginFlows(server.url, { allowLoopbackHttp: true })
    expect(flows).toMatchObject({ homeserver: server.url, password: true, sso: true, unsupported: ['m.login.sso'] })
    expect(flows.versions).toContain('v1.11')
  })

  it('logs in with a password, confirms identity and logs out', async () => {
    const options = { allowLoopbackHttp: true }
    await expect(passwordLogin(server.url, 'alice', 'wrong', options)).rejects.toThrow('rejected these credentials')
    const session = await passwordLogin(server.url, 'alice', 'correct horse', options)
    expect(session.userId).toBe('@alice:localhost')
    const loginRequest = server.requests.find((request) => request.method === 'POST' && request.path.endsWith('/login'))!
    expect(JSON.parse(loginRequest.body!)).toMatchObject({ type: 'm.login.password', initial_device_display_name: 'Aerio' })
    expect(await whoami(server.url, session.accessToken, options)).toEqual({ userId: session.userId, deviceId: session.deviceId })
    await logout(server.url, session.accessToken, options)
    await expect(whoami(server.url, session.accessToken, options)).rejects.toThrow('no longer valid')
    await logout(server.url, session.accessToken, options)
    await expect(passwordLogin(server.url, ' ', 'x', options)).rejects.toThrow('user name')
    await expect(passwordLogin(server.url, 'alice', '', options)).rejects.toThrow('password')
  })
})

describe('discovery with delegated and redirected well-known documents', () => {
  it('follows a delegated base URL and never sends credentials to discovery', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (url === 'https://example.org/.well-known/matrix/client') return json({ 'm.homeserver': { base_url: 'https://matrix.example.org/' } })
      if (url === 'https://matrix.example.org/_matrix/client/versions') return json({ versions: ['v1.11'] })
      if (url === 'https://matrix.example.org/_matrix/client/v3/login') return json({ flows: [{ type: 'm.login.password' }, { type: 'm.login.token' }] })
      return json({}, 404)
    }) as unknown as typeof fetch
    const flows = await discoverHomeserver('@alice:example.org', { fetch: fetchFn })
    expect(flows).toMatchObject({ homeserver: 'https://matrix.example.org', password: true, sso: false, unsupported: ['m.login.token'] })
    expect(calls.every((call) => !new Headers(call.init.headers).has('authorization'))).toBe(true)
    expect(calls.every((call) => call.init.redirect === 'manual')).toBe(true)
  })

  it('rejects private delegation, insecure redirects and non-Matrix servers', async () => {
    const delegating = (base: string) => (async (url: string) => url.endsWith('/.well-known/matrix/client') ? json({ 'm.homeserver': { base_url: base } }) : json({}, 404)) as unknown as typeof fetch
    await expect(discoverHomeserver('example.org', { fetch: delegating('https://10.0.0.2') })).rejects.toThrow('private network')
    await expect(discoverHomeserver('example.org', { fetch: delegating('http://matrix.example.org') })).rejects.toThrow('HTTPS only')
    const redirecting = (location: string) => (async (url: string) => url.endsWith('/.well-known/matrix/client') ? new Response(null, { status: 302, headers: { Location: location } }) : json({}, 404)) as unknown as typeof fetch
    await expect(discoverHomeserver('example.org', { fetch: redirecting('https://192.168.1.1/.well-known/matrix/client') })).rejects.toThrow('private network')
    await expect(discoverHomeserver('example.org', { fetch: redirecting('http://other.example/.well-known/matrix/client') })).rejects.toThrow('HTTPS only')
    await expect(discoverHomeserver('example.org', { fetch: redirecting('https://example.org/.well-known/matrix/client') })).rejects.toThrow('too many times')
    await expect(discoverHomeserver('example.org', { fetch: (async () => json({}, 404)) as unknown as typeof fetch })).rejects.toThrow('did not answer as a Matrix homeserver')
    await expect(discoverHomeserver('example.org', { fetch: (async () => { throw new TypeError('offline') }) as unknown as typeof fetch })).rejects.toThrow('could not be reached')
  })

  it('accepts a private homeserver entered directly', async () => {
    const fetchFn = (async (url: string) => url.endsWith('/versions') ? json({ versions: ['v1.1'] }) : json({}, 404)) as unknown as typeof fetch
    expect(await discoverHomeserver('https://192.168.1.10:8448', { fetch: fetchFn })).toMatchObject({ homeserver: 'https://192.168.1.10:8448', password: false })
  })
})
