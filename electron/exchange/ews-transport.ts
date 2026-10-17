import { Agent as HttpAgent, request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import type { ExchangeAuthMethod, ExchangeAuthPreference } from '../../src/exchange-types'
import { authenticateMessage, negotiateMessage, NtlmError, parseChallengeMessage } from './ntlm'

// HTTP transport for EWS and Autodiscover. NTLM authenticates a TCP connection rather than a
// request, so each transport owns a keep-alive agent limited to one socket: the negotiate,
// challenge, and authenticate legs (and the requests that follow) reuse the same connection.
// Credentials are only ever sent over TLS, except to loopback addresses used by tests and tunnels.

export const EWS_TIMEOUT_MS = 100_000
export const EWS_MAX_RESPONSE_BYTES = 96 * 1024 * 1024

export class EwsNetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EwsNetworkError'
  }
}

/** 401 after authenticating: wrong password, expired token, or a locked account. */
export class EwsAuthError extends Error {
  readonly status = 401
  constructor(message: string, readonly offered: string[] = []) {
    super(message)
    this.name = 'EwsAuthError'
  }
}

/** The server needs something Aerio does not implement, such as Kerberos-only authentication. */
export class EwsUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EwsUnsupportedError'
  }
}

export class EwsHttpError extends Error {
  constructor(message: string, readonly status: number, readonly body = '') {
    super(message)
    this.name = 'EwsHttpError'
  }
}

export interface EwsCredentials {
  auth: ExchangeAuthPreference
  username?: string
  password?: string
  bearerToken?: string
}

export interface HttpResult {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i

export function isLoopbackHost(hostname: string) {
  return LOOPBACK.test(hostname)
}

/** Refuses plain HTTP (except loopback) and URLs with embedded credentials. */
export function assertSecureEndpoint(value: string, label = 'The Exchange server address') {
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`${label} is not a valid URL`) }
  if (url.username || url.password) throw new Error(`${label} must not contain a user name or password`)
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new EwsUnsupportedError('Exchange over plain HTTP is not supported: credentials would be sent without encryption. Use the https:// address of the server.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${label} must start with https://`)
  return url
}

/** Authentication schemes from WWW-Authenticate, lower-cased (e.g. ["negotiate", "ntlm", "basic"]). */
export function offeredSchemes(headers: IncomingHttpHeaders) {
  const raw = headers['www-authenticate']
  const values = Array.isArray(raw) ? raw : raw ? [raw] : []
  const schemes = new Set<string>()
  for (const value of values) {
    for (const part of value.split(',')) {
      const match = /^\s*([A-Za-z][\w-]*)(?:\s|$)/.exec(part)
      // A comma also separates auth-params (realm="x", charset=...); only tokens without "=" are schemes.
      if (match && !/^\s*[\w-]+\s*=/.test(part)) schemes.add(match[1].toLowerCase())
    }
  }
  return [...schemes]
}

function challengeToken(headers: IncomingHttpHeaders, scheme: string) {
  const raw = headers['www-authenticate']
  const values = (Array.isArray(raw) ? raw : raw ? [raw] : []).flatMap((value) => value.split(','))
  for (const value of values) {
    const match = new RegExp(`^\\s*${scheme}\\s+([A-Za-z0-9+/=]+)\\s*$`, 'i').exec(value)
    if (match) return Buffer.from(match[1], 'base64')
  }
  return undefined
}

/** Picks an authentication method for 'auto' from the schemes a 401 offered. */
export function chooseAuthMethod(offered: string[], hasToken: boolean, hasPassword: boolean): ExchangeAuthMethod {
  if (hasToken && offered.includes('bearer')) return 'bearer'
  if (hasPassword && (offered.includes('ntlm') || offered.includes('negotiate'))) return 'ntlm'
  if (hasPassword && offered.includes('basic')) return 'basic'
  if (hasToken && !offered.length) return 'bearer'
  if (offered.length && offered.every((scheme) => scheme === 'kerberos' || scheme === 'negotiate')) {
    throw new EwsUnsupportedError('This Exchange server accepts only Kerberos (Negotiate) authentication, which Aerio does not support. Ask the administrator to enable NTLM or Basic authentication over HTTPS for EWS.')
  }
  if (offered.includes('bearer') && !hasToken) {
    throw new EwsUnsupportedError('This Exchange server accepts only OAuth (modern authentication). Paste an access token for the EWS resource, or ask the administrator to enable NTLM or Basic authentication.')
  }
  throw new EwsUnsupportedError(offered.length
    ? `This Exchange server offers ${offered.join(', ')} authentication, which Aerio does not support with the details entered.`
    : 'The Exchange server did not offer an authentication method Aerio supports.')
}

export interface EwsTransportOptions {
  url: string
  credentials: EwsCredentials
  timeoutMs?: number
  maxBytes?: number
  userAgent?: string
  /** Autodiscover inspects 3xx answers itself instead of treating them as errors. */
  returnRedirects?: boolean
}

export class EwsTransport {
  readonly url: URL
  private readonly agent: HttpAgent | HttpsAgent
  private method?: ExchangeAuthMethod
  /** NTLM scheme name the server uses: "NTLM", or "Negotiate" carrying NTLM tokens. */
  private ntlmScheme = 'NTLM'
  private ntlmReady = false

  constructor(private readonly options: EwsTransportOptions) {
    this.url = assertSecureEndpoint(options.url)
    const agentOptions = { keepAlive: true, maxSockets: 1, maxFreeSockets: 1, keepAliveMsecs: 30_000 }
    this.agent = this.url.protocol === 'https:' ? new HttpsAgent({ ...agentOptions, rejectUnauthorized: true }) : new HttpAgent(agentOptions)
    if (options.credentials.auth !== 'auto') this.method = options.credentials.auth
  }

  /** The method in use, known after the first successful request when the preference was 'auto'. */
  get authMethod() { return this.method }

  close() { this.agent.destroy() }

  private send(headers: Record<string, string>, body: Buffer, target = this.url): Promise<HttpResult> {
    const timeoutMs = this.options.timeoutMs ?? EWS_TIMEOUT_MS
    const maxBytes = this.options.maxBytes ?? EWS_MAX_RESPONSE_BYTES
    const requester = target.protocol === 'https:' ? httpsRequest : httpRequest
    return new Promise((resolve, reject) => {
      const request = requester(target, {
        method: 'POST',
        agent: this.agent,
        headers: { 'Content-Type': 'text/xml; charset=utf-8', Accept: 'text/xml', 'User-Agent': this.options.userAgent ?? 'Aerio-EWS/1.0', 'Content-Length': String(body.length), ...headers }
      }, (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > maxBytes) {
            request.destroy()
            reject(new EwsNetworkError('The Exchange response is too large'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }))
        response.on('error', (error) => reject(new EwsNetworkError(error.message)))
      })
      request.setTimeout(timeoutMs, () => request.destroy(new Error('The Exchange server did not respond in time')))
      request.on('error', (error) => reject(error instanceof EwsNetworkError ? error : new EwsNetworkError(`The Exchange server could not be reached: ${error.message}`)))
      request.end(body)
    })
  }

  private basicHeader() {
    const { username, password } = this.options.credentials
    if (!username || password === undefined) throw new EwsAuthError('Enter the Exchange user name and password')
    return { Authorization: `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}` }
  }

  private bearerHeader() {
    const token = this.options.credentials.bearerToken
    if (!token) throw new EwsAuthError('Paste an OAuth access token for this Exchange account')
    return { Authorization: `Bearer ${token}` }
  }

  private async ntlmHandshake(body: Buffer, extra: Record<string, string>): Promise<HttpResult> {
    const { username, password } = this.options.credentials
    if (!username || password === undefined) throw new EwsAuthError('Enter the Exchange user name and password')
    const negotiate = negotiateMessage()
    const first = await this.send({ ...extra, Authorization: `${this.ntlmScheme} ${negotiate.toString('base64')}` }, Buffer.alloc(0))
    const token = first.status === 401 ? challengeToken(first.headers, this.ntlmScheme) : undefined
    if (!token) {
      if (first.status === 401 && this.ntlmScheme === 'Negotiate') {
        throw new EwsUnsupportedError('This Exchange server accepts only Kerberos (Negotiate without NTLM) authentication, which Aerio does not support. Ask the administrator to enable NTLM or Basic authentication over HTTPS for EWS.')
      }
      if (first.status === 401) throw new EwsAuthError('Exchange refused to start NTLM authentication (401 Unauthorized). The session may have expired or the account may be locked.', offeredSchemes(first.headers))
      throw new EwsHttpError(`Exchange answered the NTLM negotiation with ${first.status}`, first.status, first.body.toString('utf8').slice(0, 2_000))
    }
    let challenge
    try { challenge = parseChallengeMessage(token) } catch (error) { throw new EwsHttpError(error instanceof NtlmError ? error.message : 'Malformed NTLM challenge', 401) }
    const { message } = authenticateMessage({ username, password, challenge, negotiate })
    const result = await this.send({ ...extra, Authorization: `${this.ntlmScheme} ${message.toString('base64')}` }, body)
    if (result.status === 401) throw new EwsAuthError('Exchange rejected the user name or password (401 Unauthorized)', offeredSchemes(result.headers))
    this.ntlmReady = true
    return result
  }

  /** Posts a SOAP body, authenticating as configured. Throws EwsAuthError on 401. */
  async post(xml: string, extraHeaders: Record<string, string> = {}): Promise<HttpResult> {
    const body = Buffer.from(xml, 'utf8')
    if (!this.method) {
      // 'auto': ask without credentials first; the 401 lists what the server accepts.
      const probe = await this.send(extraHeaders, body)
      if (probe.status !== 401) return this.finish(probe)
      const offered = offeredSchemes(probe.headers)
      const { password, bearerToken } = this.options.credentials
      this.method = chooseAuthMethod(offered, Boolean(bearerToken), password !== undefined && password !== '')
      if (this.method === 'ntlm') this.ntlmScheme = offered.includes('ntlm') ? 'NTLM' : 'Negotiate'
    }
    if (this.method === 'basic') return this.finish(await this.send({ ...extraHeaders, ...this.basicHeader() }, body), 'basic')
    if (this.method === 'bearer') return this.finish(await this.send({ ...extraHeaders, ...this.bearerHeader() }, body), 'bearer')
    if (this.ntlmReady) {
      const reused = await this.send(extraHeaders, body)
      if (reused.status !== 401) return this.finish(reused)
      this.ntlmReady = false
      if (!offeredSchemes(reused.headers).includes('ntlm') && offeredSchemes(reused.headers).includes('negotiate')) this.ntlmScheme = 'Negotiate'
    }
    return this.finish(await this.ntlmHandshake(body, extraHeaders))
  }

  private finish(result: HttpResult, method?: ExchangeAuthMethod) {
    if (result.status === 401) {
      const offered = offeredSchemes(result.headers)
      if (method === 'bearer') throw new EwsAuthError('Exchange rejected the OAuth access token (401 Unauthorized). It may have expired; paste a new token.', offered)
      if (method === 'basic' && offered.length && !offered.includes('basic')) {
        throw new EwsUnsupportedError(`Basic authentication is turned off on this Exchange server (it offers ${offered.join(', ')}). Choose NTLM or Automatic in the account's authentication setting.`)
      }
      throw new EwsAuthError('Exchange rejected the user name or password (401 Unauthorized)', offered)
    }
    if (result.status >= 300 && result.status < 400 && !this.options.returnRedirects) {
      throw new EwsHttpError(`Exchange redirected the request to ${String(result.headers.location ?? 'another address')}. Check the EWS URL.`, result.status)
    }
    return result
  }
}

/** The authentication preference that should be stored after a transport resolved 'auto'. */
export const resolvedAuth = (transport: EwsTransport, fallback: ExchangeAuthPreference): ExchangeAuthMethod =>
  transport.authMethod ?? (fallback === 'auto' ? 'ntlm' : fallback)
