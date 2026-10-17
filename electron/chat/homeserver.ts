import { isIP } from 'node:net'
import type { ChatLoginFlows } from '../../src/chat-types'

/**
 * Homeserver discovery, validation and password login. Discovery requests
 * never carry credentials; the password goes only to the validated origin the
 * user saw, and is never retained. HTTPS is required everywhere; plain HTTP is
 * accepted only for loopback fixtures when explicitly allowed. A discovery
 * redirect or `.well-known` delegation may not move a public name onto a
 * private network address.
 */
export interface HomeserverOptions {
  /** Automated fixtures only. */
  allowLoopbackHttp?: boolean
  fetch?: typeof fetch
  timeoutMs?: number
}

export class ChatHomeserverError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) { super(message) }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export function isLoopbackHost(hostname: string) {
  return LOOPBACK.has(hostname.toLowerCase()) || /^127\./.test(hostname)
}

/** Literal private, link-local, loopback or unique-local addresses, and single-label/`.local` names. */
export function isPrivateHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (isLoopbackHost(host) || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !isIP(host)) return true
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number)
    return a === 10 || a === 0 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  if (isIP(host) === 6) return host === '::' || host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:')
  return false
}

/** Normalizes a user-entered server into a canonical base URL (origin plus optional path, no trailing slash). */
export function validateHomeserverUrl(raw: string, options: HomeserverOptions = {}): URL {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > 2048) throw new ChatHomeserverError('Enter a homeserver address')
  let url: URL
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`) } catch { throw new ChatHomeserverError('The homeserver address is not a valid URL') }
  if (url.username || url.password) throw new ChatHomeserverError('Homeserver addresses cannot contain credentials')
  if (url.search || url.hash) throw new ChatHomeserverError('Homeserver addresses cannot contain a query or fragment')
  const loopback = isLoopbackHost(url.hostname)
  if (url.protocol === 'http:') {
    if (!(options.allowLoopbackHttp && loopback)) throw new ChatHomeserverError('Aerio connects to homeservers over HTTPS only')
  } else if (url.protocol !== 'https:') throw new ChatHomeserverError('Aerio connects to homeservers over HTTPS only')
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url
}

export function homeserverBase(url: URL) {
  return `${url.origin}${url.pathname === '/' ? '' : url.pathname}`
}

/** Splits `@user:server` into the server name used for discovery. */
export function serverNameFromInput(input: string) {
  const trimmed = input.trim()
  if (trimmed.startsWith('@')) {
    const index = trimmed.indexOf(':')
    if (index < 2 || index === trimmed.length - 1) throw new ChatHomeserverError('Enter a full Matrix ID such as @name:example.org')
    return trimmed.slice(index + 1)
  }
  return trimmed
}

export function validMatrixUserId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 && /^@[a-z0-9._=\-/+]+:[A-Za-z0-9.\-[\]:]+$/i.test(value)
}

export function validMatrixDeviceId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[\s/]/.test(value)
}

async function request(url: string, init: RequestInit, options: HomeserverOptions) {
  const fetchFn = options.fetch ?? fetch
  try {
    return await fetchFn(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(options.timeoutMs ?? 15_000) })
  } catch (error) {
    throw new ChatHomeserverError(error instanceof Error && error.name === 'TimeoutError' ? 'The homeserver did not respond in time' : 'The homeserver could not be reached')
  }
}

async function json(response: Response) {
  try { return await response.json() as Record<string, unknown> } catch { return {} }
}

async function matrixError(response: Response, fallback: string) {
  const body = await json(response)
  const code = typeof body.errcode === 'string' ? body.errcode : undefined
  const messages: Record<string, string> = {
    M_FORBIDDEN: 'The homeserver rejected these credentials',
    M_USER_DEACTIVATED: 'This Matrix account is deactivated',
    M_LIMIT_EXCEEDED: 'The homeserver is rate limiting sign-in. Try again shortly',
    M_UNKNOWN_TOKEN: 'The Matrix session is no longer valid. Sign in again'
  }
  return new ChatHomeserverError(code && messages[code] ? messages[code] : fallback, code, response.status)
}

/** GET with manually validated redirects: each hop must stay HTTPS and may not reach a private address unless the start did. */
async function getFollowingValidatedRedirects(start: URL, options: HomeserverOptions) {
  let current = start
  const startPrivate = isPrivateHost(start.hostname)
  for (let hop = 0; hop < 4; hop += 1) {
    const response = await request(current.toString(), { method: 'GET', headers: { Accept: 'application/json' } }, options)
    if (response.status < 300 || response.status >= 400) return { response, url: current }
    const location = response.headers.get('location')
    if (!location) return { response, url: current }
    const next = new URL(location, current)
    validateHomeserverUrl(next.origin, options)
    if (!startPrivate && isPrivateHost(next.hostname)) throw new ChatHomeserverError('Homeserver discovery redirected to a private network address')
    current = next
  }
  throw new ChatHomeserverError('Homeserver discovery redirected too many times')
}

/** Resolves the homeserver for a server name or Matrix ID and reports its advertised login methods. */
export async function discoverHomeserver(input: string, options: HomeserverOptions = {}): Promise<ChatLoginFlows> {
  const candidate = validateHomeserverUrl(serverNameFromInput(input), options)
  let base = candidate
  if (candidate.pathname === '/') {
    const wellKnown = new URL('/.well-known/matrix/client', candidate)
    const { response } = await getFollowingValidatedRedirects(wellKnown, options)
    if (response.ok) {
      const body = await json(response)
      const advertised = (body['m.homeserver'] as { base_url?: unknown } | undefined)?.base_url
      if (typeof advertised === 'string') {
        const delegated = validateHomeserverUrl(advertised, options)
        if (!isPrivateHost(candidate.hostname) && isPrivateHost(delegated.hostname)) throw new ChatHomeserverError('The server delegated to a private network address. Enter that address directly if you trust it')
        base = delegated
      }
    }
  }
  return loginFlows(homeserverBase(base), options)
}

export async function loginFlows(homeserver: string, options: HomeserverOptions = {}): Promise<ChatLoginFlows> {
  const base = homeserverBase(validateHomeserverUrl(homeserver, options))
  const versionsResponse = await request(`${base}/_matrix/client/versions`, { method: 'GET' }, options)
  if (!versionsResponse.ok) throw new ChatHomeserverError('This address did not answer as a Matrix homeserver', undefined, versionsResponse.status)
  const versionsBody = await json(versionsResponse)
  const versions = Array.isArray(versionsBody.versions) ? versionsBody.versions.filter((value): value is string => typeof value === 'string') : []
  if (!versions.length) throw new ChatHomeserverError('This address did not answer as a Matrix homeserver')
  const loginResponse = await request(`${base}/_matrix/client/v3/login`, { method: 'GET' }, options)
  const flows = loginResponse.ok ? ((await json(loginResponse)).flows as { type?: unknown }[] | undefined) ?? [] : []
  const types = flows.map((flow) => flow?.type).filter((type): type is string => typeof type === 'string')
  return {
    homeserver: base,
    versions,
    password: types.includes('m.login.password'),
    // SSO is advertised but not yet offered by Aerio's login screen.
    sso: types.includes('m.login.sso'),
    unsupported: types.filter((type) => type !== 'm.login.password')
  }
}

export interface ChatLoginResult {
  userId: string
  deviceId: string
  accessToken: string
}

export async function passwordLogin(homeserver: string, user: string, password: string, options: HomeserverOptions = {}): Promise<ChatLoginResult> {
  const base = homeserverBase(validateHomeserverUrl(homeserver, options))
  if (!user.trim() || user.length > 255) throw new ChatHomeserverError('Enter your Matrix user name')
  if (!password || password.length > 1024) throw new ChatHomeserverError('Enter your Matrix password')
  const response = await request(`${base}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'm.login.password', identifier: { type: 'm.id.user', user: user.trim() }, password, initial_device_display_name: 'Aerio' })
  }, options)
  if (!response.ok) throw await matrixError(response, 'The homeserver did not accept the sign-in')
  const body = await json(response)
  if (!validMatrixUserId(body.user_id) || !validMatrixDeviceId(body.device_id) || typeof body.access_token !== 'string' || !body.access_token) {
    throw new ChatHomeserverError('The homeserver returned an incomplete sign-in response')
  }
  return { userId: body.user_id, deviceId: body.device_id, accessToken: body.access_token }
}

export async function whoami(homeserver: string, accessToken: string, options: HomeserverOptions = {}) {
  const base = homeserverBase(validateHomeserverUrl(homeserver, options))
  const response = await request(`${base}/_matrix/client/v3/account/whoami`, { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } }, options)
  if (!response.ok) throw await matrixError(response, 'The Matrix session could not be confirmed')
  const body = await json(response)
  if (!validMatrixUserId(body.user_id)) throw new ChatHomeserverError('The homeserver returned an invalid identity')
  return { userId: body.user_id, deviceId: typeof body.device_id === 'string' ? body.device_id : undefined }
}

export async function logout(homeserver: string, accessToken: string, options: HomeserverOptions = {}) {
  const base = homeserverBase(validateHomeserverUrl(homeserver, options))
  const response = await request(`${base}/_matrix/client/v3/logout`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: '{}' }, options)
  // An already-invalid token means the device is gone remotely.
  if (!response.ok && response.status !== 401) throw await matrixError(response, 'The homeserver did not confirm sign-out')
}
