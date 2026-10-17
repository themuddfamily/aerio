import { isLoopbackHost, normalizeDavUrl } from '../../src/lib/dav-presets'
import { parseMultistatus, type Multistatus } from './dav-xml'

export const DAV_TIMEOUT_MS = 60_000
export const DAV_MAX_BYTES = 32 * 1024 * 1024
const MAX_REDIRECTS = 5
const MAX_RETRIES = 3

export type DavFetch = (url: string, init: RequestInit) => Promise<Response>

export interface DavCredentials {
  username: string
  password: string
}

export interface DavClientOptions {
  fetch?: DavFetch
  timeoutMs?: number
  maxBytes?: number
  sleep?(ms: number): Promise<void>
  // The account's service roots. Every request, including hrefs the server returns, must stay on
  // one of these sites, so a hostile response cannot steer the password to another host.
  allowedRoots?: string[]
}

export interface DavRequest {
  headers?: Record<string, string>
  body?: string
  depth?: '0' | '1' | 'infinity'
}

export interface DavHttpResponse {
  status: number
  url: string
  headers: Headers
  text: string
}

export class DavHttpError extends Error {
  constructor(message: string, readonly status: number, readonly body = '') {
    super(message)
    this.name = 'DavHttpError'
  }
}

/** Thrown when the network or server is unreachable; queued writes stay queued. */
export class DavNetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DavNetworkError'
  }
}

async function readLimited(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > maxBytes) throw new DavHttpError('The server response is too large', response.status)
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new DavHttpError('The server response is too large', response.status)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8').decode(bytes)
}

// Redirects may move between hosts of one provider (caldav.icloud.com → p52-caldav.icloud.com) but
// never to another site, and never from HTTPS to HTTP, so the password only reaches the server it was meant for.
const siteOf = (host: string) => isLoopbackHost(host) ? host : host.toLowerCase().split('.').slice(-2).join('.')

export function sameDavSite(from: string, to: string) {
  const a = new URL(from)
  const b = new URL(to)
  if (a.protocol === 'https:' && b.protocol !== 'https:') return false
  return isLoopbackHost(a.hostname) ? a.host === b.host : siteOf(a.hostname) === siteOf(b.hostname)
}

const RETRYABLE_METHODS = new Set(['GET', 'PROPFIND', 'REPORT'])

export class DavClient {
  private readonly fetch: DavFetch
  private readonly authorization: string

  constructor(credentials: DavCredentials, private readonly options: DavClientOptions = {}) {
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init))
    this.authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8').toString('base64')}`
  }

  async request(method: string, url: string, request: DavRequest = {}): Promise<DavHttpResponse> {
    let current = normalizeDavUrl(url)
    const origin = current
    const roots = this.options.allowedRoots
    if (roots?.length && !roots.some((root) => sameDavSite(root, current))) {
      throw new DavHttpError(`The server pointed to a different site (${new URL(current).host}); Aerio did not send your password there`, 0)
    }
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? DAV_TIMEOUT_MS)
    for (let redirects = 0, attempt = 0; ;) {
      let response: Response
      try {
        response = await this.fetch(current, {
          method,
          redirect: 'manual',
          signal,
          headers: {
            Authorization: this.authorization,
            'User-Agent': 'Aerio CalDAV/CardDAV',
            ...(request.depth ? { Depth: request.depth } : {}),
            ...(request.body !== undefined ? { 'Content-Type': 'application/xml; charset=utf-8' } : {}),
            ...request.headers
          },
          ...(request.body !== undefined ? { body: request.body } : {})
        })
      } catch (error) {
        if (signal.aborted) throw new DavNetworkError('The server did not respond in time')
        throw new DavNetworkError(error instanceof Error && error.message ? `The server could not be reached (${error.message.slice(0, 200)})` : 'The server could not be reached')
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        if (!location || redirects >= MAX_REDIRECTS) throw new DavHttpError('The server redirected too many times', response.status)
        const next = normalizeDavUrl(new URL(location, current).toString())
        if (!sameDavSite(origin, next)) throw new DavHttpError(`The server redirected to a different site (${new URL(next).host}); Aerio did not send your password there`, response.status)
        current = next
        redirects++
        continue
      }
      if ((response.status === 429 || response.status === 503) && RETRYABLE_METHODS.has(method) && attempt < MAX_RETRIES) {
        const retryAfter = Number(response.headers.get('retry-after') ?? 0)
        await (this.options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(retryAfter > 0 ? Math.min(retryAfter, 60) * 1_000 : 2 ** attempt * 1_000)
        attempt++
        continue
      }
      const text = await readLimited(response, this.options.maxBytes ?? DAV_MAX_BYTES)
      return { status: response.status, url: current, headers: response.headers, text }
    }
  }

  /** Issues a request that must succeed; non-2xx statuses become DavHttpError. */
  async expect(method: string, url: string, request: DavRequest = {}) {
    const response = await this.request(method, url, request)
    if (response.status < 200 || response.status >= 300) throw httpError(response)
    return response
  }

  async multistatus(method: 'PROPFIND' | 'REPORT', url: string, body: string, depth: '0' | '1'): Promise<Multistatus & { url: string }> {
    const response = await this.expect(method, url, { body, depth })
    if (response.status !== 207) throw new DavHttpError(`The server answered ${method} without a multistatus response (${response.status})`, response.status)
    return { ...parseMultistatus(response.text), url: response.url }
  }
}

export function httpError(response: Pick<DavHttpResponse, 'status' | 'text'>) {
  const message = response.status === 401 ? 'The server rejected the user name or app password'
    : response.status === 403 ? 'The server does not allow this request'
      : response.status === 404 ? 'The server could not find that calendar or address book'
        : response.status === 412 ? 'The item changed on the server'
          : response.status === 507 ? 'The server is out of storage'
            : `The server responded with ${response.status}`
  return new DavHttpError(message, response.status, response.text.slice(0, 2_000))
}

/** Resolves an href from a multistatus body against the URL the request was sent to. */
export function resolveHref(href: string, base: string) {
  const url = new URL(href, base)
  url.hash = ''
  // Servers disagree on percent-encoding; decode and re-encode each segment for a stable key.
  url.pathname = url.pathname.split('/').map((segment) => {
    try { return encodeURIComponent(decodeURIComponent(segment)).replace(/%40/g, '@').replace(/%3A/gi, ':') } catch { return segment }
  }).join('/')
  return url.toString()
}

export const sameCollection = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')
