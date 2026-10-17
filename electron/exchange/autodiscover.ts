import { resolveSrv as dnsResolveSrv } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { ExchangeDiscoverInput, ExchangeDiscoverResult, ExchangeDiscoveryAttempt } from '../../src/exchange-types'
import { childElement, elementText, parseXml, type XmlElement } from '../productivity/dav-xml'
import { EwsAuthError, EwsTransport, EwsUnsupportedError, type HttpResult } from './ews-transport'
import { escapeXml } from './ews-xml'

// Exchange POX Autodiscover (MS-OXDSCLI). Aerio tries, in order:
//   1. https://<domain>/autodiscover/autodiscover.xml
//   2. https://autodiscover.<domain>/autodiscover/autodiscover.xml
//   3. the HTTP redirect method: an unauthenticated GET of http://autodiscover.<domain>/... whose
//      302 points at an HTTPS Autodiscover endpoint
//   4. the DNS SRV record _autodiscover._tcp.<domain>
// Credentials are only ever POSTed over HTTPS. A redirect, SRV target, or redirectUrl/redirectAddr
// answer that leaves the email domain is returned as `confirm-redirect`; the caller asks the user
// and calls again with that host in `trustedHosts`.

const REQUEST_SCHEMA = 'http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006'
const RESPONSE_SCHEMA = 'http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a'
const MAX_REDIRECTS = 10

export interface SrvRecord { name: string; port: number; priority: number; weight: number }

export interface AutodiscoverHttp {
  /** Authenticated POST that returns 3xx answers instead of following them. */
  post(url: string, xml: string): Promise<HttpResult>
  /** Unauthenticated GET, no redirect following. */
  get(url: string): Promise<HttpResult>
  resolveSrv(name: string): Promise<SrvRecord[]>
}

export function autodiscoverRequest(email: string) {
  return `<?xml version="1.0" encoding="utf-8"?><Autodiscover xmlns="${REQUEST_SCHEMA}"><Request><EMailAddress>${escapeXml(email)}</EMailAddress><AcceptableResponseSchema>${RESPONSE_SCHEMA}</AcceptableResponseSchema></Request></Autodiscover>`
}

/** POX ServerVersion hex (e.g. 73C18880): 4 marker bits, 6-bit major, 6-bit minor, 15-bit build. */
export function decodeServerVersion(hex: string | undefined) {
  if (!hex || !/^[0-9a-f]{8}$/i.test(hex)) return undefined
  const value = parseInt(hex, 16)
  return `${(value >>> 22) & 0x3f}.${(value >>> 16) & 0x3f}.${value & 0x7fff}`
}

/** An AlternativeMailbox entry (delegate or shared/team mailboxes the user was granted, E40). */
export interface PoxAlternativeMailbox { type: string; displayName: string; smtpAddress: string; ownerSmtpAddress?: string }

export type PoxResult =
  | { action: 'settings'; ewsUrl?: string; serverVersion?: string; displayName?: string; alternativeMailboxes?: PoxAlternativeMailbox[]; publicFolderMailbox?: string }
  | { action: 'redirectAddr'; address: string }
  | { action: 'redirectUrl'; url: string }
  | { action: 'error'; message: string }

const find = (element: XmlElement | undefined, name: string) => element?.children.find((child) => child.name === name)
const findAll = (element: XmlElement | undefined, name: string) => element?.children.filter((child) => child.name === name) ?? []

export function parsePoxResponse(xml: string): PoxResult {
  const root = parseXml(xml)
  if (root.name !== 'Autodiscover') throw new Error('The server did not return an Autodiscover response')
  const response = find(root, 'Response')
  const error = find(response, 'Error')
  if (error) return { action: 'error', message: elementText(find(error, 'Message')) || `Autodiscover error ${elementText(find(error, 'ErrorCode')) ?? ''}`.trim() }
  const account = find(response, 'Account')
  const action = elementText(find(account, 'Action'))
  if (action === 'redirectAddr') {
    const address = elementText(find(account, 'RedirectAddr'))
    if (address) return { action: 'redirectAddr', address }
  }
  if (action === 'redirectUrl') {
    const url = elementText(find(account, 'RedirectUrl'))
    if (url) return { action: 'redirectUrl', url }
  }
  // Prefer the internal (EXCH) endpoint, then external (EXPR), then any protocol with an EwsUrl.
  const protocols = findAll(account, 'Protocol')
  const byType = (type: string) => protocols.find((protocol) => elementText(find(protocol, 'Type')) === type && elementText(find(protocol, 'EwsUrl')))
  const chosen = byType('EXCH') ?? byType('EXPR') ?? protocols.find((protocol) => elementText(find(protocol, 'EwsUrl')))
  const versionSource = protocols.find((protocol) => elementText(find(protocol, 'ServerVersion')))
  const displayName = elementText(childElement(find(response, 'User'), RESPONSE_SCHEMA, 'DisplayName') ?? find(find(response, 'User'), 'DisplayName'))
  const alternativeMailboxes = findAll(account, 'AlternativeMailbox').flatMap((entry): PoxAlternativeMailbox[] => {
    const smtpAddress = elementText(find(entry, 'SmtpAddress'))
    if (!smtpAddress) return []
    const owner = elementText(find(entry, 'OwnerSmtpAddress'))
    return [{ type: elementText(find(entry, 'Type')) ?? '', displayName: elementText(find(entry, 'DisplayName')) || smtpAddress, smtpAddress, ...(owner ? { ownerSmtpAddress: owner } : {}) }]
  })
  const publicFolderMailbox = elementText(find(find(account, 'PublicFolderInformation'), 'SmtpAddress'))
  return {
    action: 'settings',
    ...(alternativeMailboxes.length ? { alternativeMailboxes } : {}),
    ...(publicFolderMailbox ? { publicFolderMailbox } : {}),
    ...(chosen ? { ewsUrl: elementText(find(chosen, 'EwsUrl')) } : {}),
    ...(versionSource ? { serverVersion: decodeServerVersion(elementText(find(versionSource, 'ServerVersion'))) } : {}),
    ...(displayName ? { displayName } : {})
  }
}

const hostOf = (url: string) => { try { return new URL(url).hostname.toLowerCase() } catch { return '' } }

export function isTrustedHost(host: string, domain: string, trusted: string[]) {
  const value = host.toLowerCase()
  const base = domain.toLowerCase()
  return value === base || value.endsWith(`.${base}`) || trusted.some((item) => item.toLowerCase() === value)
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300)

export interface AutodiscoverOptions {
  http?: AutodiscoverHttp
}

export async function autodiscover(input: ExchangeDiscoverInput, options: AutodiscoverOptions = {}): Promise<ExchangeDiscoverResult> {
  const http = options.http ?? defaultAutodiscoverHttp(input)
  const trusted = (input.trustedHosts ?? []).map((host) => host.toLowerCase())
  const attempts: ExchangeDiscoveryAttempt[] = []
  let email = input.email.trim().toLowerCase()
  const originalDomain = email.split('@')[1]
  if (!originalDomain || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email address')
  const trust = (host: string) => isTrustedHost(host, originalDomain, trusted)
  const confirm = (fromUrl: string, toUrl: string, reason: Extract<ExchangeDiscoverResult, { status: 'confirm-redirect' }>['reason']): ExchangeDiscoverResult =>
    ({ status: 'confirm-redirect', email, fromUrl, toUrl, host: hostOf(toUrl) || toUrl, reason, attempts })

  // POSTs to one endpoint, following same-site redirects and redirectUrl answers.
  const tryEndpoint = async (startUrl: string, source: Extract<ExchangeDiscoverResult, { status: 'found' }>['source'], hops = 0): Promise<ExchangeDiscoverResult | undefined> => {
    let url = startUrl
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
      if (!url.startsWith('https://')) { attempts.push({ url, error: 'Not HTTPS; credentials are never sent without TLS' }); return undefined }
      let result: HttpResult
      try { result = await http.post(url, autodiscoverRequest(email)) } catch (error) {
        attempts.push({ url, error: error instanceof EwsAuthError ? 'The server rejected the user name or password' : errorText(error) })
        if (error instanceof EwsUnsupportedError) throw error
        return undefined
      }
      if (result.status >= 300 && result.status < 400) {
        const location = String(result.headers.location ?? '')
        const next = location ? new URL(location, url).toString() : ''
        if (!next.startsWith('https://')) { attempts.push({ url, error: `Redirected to a non-HTTPS address (${next || 'none'})` }); return undefined }
        if (!trust(hostOf(next))) return confirm(url, next, 'redirect-url')
        url = next
        continue
      }
      if (result.status !== 200) { attempts.push({ url, error: `HTTP ${result.status}` }); return undefined }
      let pox: PoxResult
      try { pox = parsePoxResponse(result.body.toString('utf8')) } catch (error) { attempts.push({ url, error: errorText(error) }); return undefined }
      if (pox.action === 'error') { attempts.push({ url, error: pox.message }); return undefined }
      if (pox.action === 'redirectUrl') {
        if (!pox.url.startsWith('https://')) { attempts.push({ url, error: 'Autodiscover redirected to a non-HTTPS address' }); return undefined }
        if (!trust(hostOf(pox.url))) return confirm(url, pox.url, 'redirect-url')
        url = pox.url
        continue
      }
      if (pox.action === 'redirectAddr') {
        if (hops >= MAX_REDIRECTS) { attempts.push({ url, error: 'Too many Autodiscover address redirects' }); return undefined }
        const domain = pox.address.split('@')[1]?.toLowerCase()
        if (!domain) { attempts.push({ url, error: 'Autodiscover returned an invalid redirect address' }); return undefined }
        const previous = email
        email = pox.address.toLowerCase()
        if (!trust(domain)) return confirm(url, `https://autodiscover.${domain}/autodiscover/autodiscover.xml`, 'redirect-address')
        // The new address is discovered against the same server first.
        const again = await tryEndpoint(url, source, hops + 1)
        if (again) return again
        email = previous
        return undefined
      }
      if (!pox.ewsUrl) { attempts.push({ url, error: 'Autodiscover answered without an EWS URL' }); return undefined }
      return { status: 'found', email, ewsUrl: pox.ewsUrl, autodiscoverUrl: url, source, ...(pox.serverVersion ? { serverVersion: pox.serverVersion } : {}), ...(pox.displayName ? { displayName: pox.displayName } : {}), attempts }
    }
    attempts.push({ url, error: 'Too many redirects' })
    return undefined
  }

  const domain = originalDomain
  for (const [url, source] of [
    [`https://${domain}/autodiscover/autodiscover.xml`, 'domain'],
    [`https://autodiscover.${domain}/autodiscover/autodiscover.xml`, 'autodiscover-host']
  ] as const) {
    const result = await tryEndpoint(url, source)
    if (result) return result
  }

  // HTTP redirect method: no credentials are sent on the plain-HTTP request.
  const redirectProbe = `http://autodiscover.${domain}/autodiscover/autodiscover.xml`
  try {
    const result = await http.get(redirectProbe)
    const location = result.status >= 300 && result.status < 400 ? String(result.headers.location ?? '') : ''
    if (location) {
      const next = new URL(location, redirectProbe).toString()
      if (!next.startsWith('https://')) attempts.push({ url: redirectProbe, error: 'The redirect does not use HTTPS' })
      else if (!trust(hostOf(next))) return confirm(redirectProbe, next, 'http-redirect')
      else {
        const found = await tryEndpoint(next, 'http-redirect')
        if (found) return found
      }
    } else attempts.push({ url: redirectProbe, error: result.status >= 300 && result.status < 400 ? 'Redirect without a location' : `HTTP ${result.status} (no redirect)` })
  } catch (error) {
    attempts.push({ url: redirectProbe, error: errorText(error) })
  }

  // DNS SRV: _autodiscover._tcp.<domain>, lowest priority first, then highest weight.
  try {
    const records = (await http.resolveSrv(`_autodiscover._tcp.${domain}`)).sort((a, b) => a.priority - b.priority || b.weight - a.weight)
    if (!records.length) attempts.push({ url: `_autodiscover._tcp.${domain}`, error: 'No SRV record' })
    for (const record of records) {
      const target = record.name.replace(/\.$/, '').toLowerCase()
      const url = `https://${target}${record.port && record.port !== 443 ? `:${record.port}` : ''}/autodiscover/autodiscover.xml`
      if (!trust(target)) return confirm(`_autodiscover._tcp.${domain}`, url, 'srv')
      const found = await tryEndpoint(url, 'srv')
      if (found) return found
    }
  } catch (error) {
    attempts.push({ url: `_autodiscover._tcp.${domain}`, error: errorText(error) })
  }
  return { status: 'not-found', email, attempts }
}

function plainGet(url: string, timeoutMs = 15_000): Promise<HttpResult> {
  const target = new URL(url)
  const requester = target.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const request = requester(target, { method: 'GET', headers: { 'User-Agent': 'Aerio-EWS/1.0' } }, (response) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size < 1_000_000) chunks.push(chunk) })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }))
      response.on('error', reject)
    })
    request.setTimeout(timeoutMs, () => request.destroy(new Error('The server did not respond in time')))
    request.on('error', reject)
    request.end()
  })
}

export function defaultAutodiscoverHttp(input: ExchangeDiscoverInput): AutodiscoverHttp {
  const credentials = { auth: 'auto' as const, username: input.username?.trim() || input.email.trim(), password: input.password }
  return {
    async post(url, xml) {
      const transport = new EwsTransport({ url, credentials, timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024, returnRedirects: true })
      try { return await transport.post(xml) } finally { transport.close() }
    },
    get: (url) => plainGet(url),
    resolveSrv: async (name) => (await dnsResolveSrv(name)).map((record) => ({ name: record.name, port: record.port, priority: record.priority, weight: record.weight }))
  }
}
