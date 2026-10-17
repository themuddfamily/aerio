import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { MailDraftInput, MailListUnsubscribeInfo, MailUnsubscribeMethod, MailUnsubscribeOption, MailUnsubscribeResult } from '../../src/mail-types'

// List-Unsubscribe (RFC 2369) and List-Unsubscribe-Post (RFC 8058) handling. Parsing is side-effect free so
// that showing a message, or the unsubscribe dialog, can never contact the list; only performUnsubscribe acts.

const MAX_URI_LENGTH = 2048
const ONE_CLICK_BODY = 'List-Unsubscribe=One-Click'
const emailPattern = /^[^\s@<>()[\],;:"\\]+@[^\s@<>()[\],;:"\\]+\.[^\s@<>()[\],;:"\\]+$/

/** Unfolds an RFC 5322 header block and returns the values of every header with the given (case-insensitive) name. */
export function headerValues(headers: string, name: string) {
  const unfolded = headers.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ')
  const prefix = `${name.toLowerCase()}:`
  return unfolded.split(/\r?\n/).filter((line) => line.toLowerCase().startsWith(prefix)).map((line) => line.slice(prefix.length).trim())
}

/** Splits a header value into its angle-bracketed entries, skipping RFC 5322 comments. Returns undefined when the syntax is invalid. */
export function bracketedEntries(value: string) {
  const entries: string[] = []
  let depth = 0
  let current: string | undefined
  let stray = false
  for (const character of value) {
    if (current !== undefined) {
      if (character === '>') { entries.push(current); current = undefined }
      else if (character === '<') return undefined
      else current += character
    } else if (depth > 0) {
      if (character === '(') depth++
      else if (character === ')') depth--
    } else if (character === '(') depth++
    else if (character === '<') current = ''
    else if (character !== ',' && !/\s/.test(character)) stray = true
  }
  if (current !== undefined || depth > 0 || stray) return undefined
  // RFC 2369 lets senders fold long URIs; whitespace inside the brackets is not part of the URI.
  return entries.map((entry) => entry.replace(/\s+/g, ''))
}

function parseMailto(uri: string): NonNullable<MailUnsubscribeOption['mailto']> | string {
  const query = uri.indexOf('?')
  const path = uri.slice('mailto:'.length, query >= 0 ? query : undefined)
  const decode = (text: string) => decodeURIComponent(text.replace(/\+/g, '%20'))
  let to: string[]
  let subject = ''
  let body = ''
  try {
    to = path ? decodeURIComponent(path).split(',').map((address) => address.trim()).filter(Boolean) : []
    for (const pair of query >= 0 ? uri.slice(query + 1).split('&') : []) {
      const [key, ...rest] = pair.split('=')
      const value = decode(rest.join('='))
      if (key.toLowerCase() === 'to') to.push(...value.split(',').map((address) => address.trim()).filter(Boolean))
      else if (key.toLowerCase() === 'subject') subject = value
      else if (key.toLowerCase() === 'body') body = value
    }
  } catch { return 'An unsubscribe email address is not correctly encoded' }
  to = [...new Set(to.map((address) => address.toLowerCase()))]
  if (!to.length || to.some((address) => !emailPattern.test(address))) return 'An unsubscribe email address is not valid'
  if (to.length > 3) return 'An unsubscribe email link lists too many recipients'
  return { to, subject: subject.replace(/[\r\n]+/g, ' ').trim().slice(0, 200), body: body.replace(/\r?\n/g, '\n').slice(0, 2000) }
}

/** Parses the unsubscribe metadata of a message from its raw header block. */
export function parseListUnsubscribe(headers: string): MailListUnsubscribeInfo {
  const warnings: string[] = []
  const options: MailUnsubscribeOption[] = []
  const values = headerValues(headers, 'List-Unsubscribe')
  const listIdValue = headerValues(headers, 'List-Id')[0]
  const listId = listIdValue && /<([^<>\s]+)>/.exec(listIdValue)?.[1]
  if (values.length > 1) warnings.push('This message has more than one List-Unsubscribe header; only the first is used')
  const postValues = headerValues(headers, 'List-Unsubscribe-Post')
  const oneClick = postValues.length === 1 && postValues[0].replace(/\s+/g, '').toLowerCase() === ONE_CLICK_BODY.toLowerCase()
  if (postValues.length && !oneClick) warnings.push('The one-click unsubscribe header is malformed, so one-click unsubscribe is unavailable')
  if (values[0] !== undefined) {
    const entries = bracketedEntries(values[0])
    if (!entries) warnings.push('The List-Unsubscribe header is malformed')
    for (const uri of entries ?? []) {
      if (!uri) continue
      if (uri.length > MAX_URI_LENGTH) { warnings.push('An unsubscribe link is too long and was ignored'); continue }
      if (options.some((option) => option.url === uri)) continue
      const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(uri)?.[1].toLowerCase()
      if (scheme === 'https') {
        let url: URL
        try { url = new URL(uri) } catch { warnings.push('An unsubscribe link is not a valid URL and was ignored'); continue }
        if (url.username || url.password) { warnings.push('An unsubscribe link containing credentials was ignored'); continue }
        options.push({ kind: 'https', url: uri, destination: url.host, oneClick })
      } else if (scheme === 'mailto') {
        const mailto = parseMailto(uri)
        if (typeof mailto === 'string') { warnings.push(mailto); continue }
        options.push({ kind: 'mailto', url: uri, destination: mailto.to.join(', '), oneClick: false, mailto })
      } else if (scheme === 'http') warnings.push('An unencrypted HTTP unsubscribe link was ignored; Aerio only uses HTTPS links')
      else warnings.push(`An unsupported ${scheme ? `${scheme}: ` : ''}unsubscribe link was ignored`)
    }
  }
  if (oneClick && !options.some((option) => option.kind === 'https')) warnings.push('One-click unsubscribe was advertised without an HTTPS link')
  return { ...(listId ? { listId } : {}), options, warnings }
}

function privateIpv4(address: string) {
  const [a, b] = address.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}
/** True for loopback, private, link-local, unique-local, multicast and unspecified addresses. */
export function isPrivateAddress(address: string) {
  const value = address.replace(/^\[|\]$/g, '').toLowerCase()
  if (isIP(value) === 4) return privateIpv4(value)
  if (isIP(value) !== 6) return false
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value)
  if (mapped) return privateIpv4(mapped[1])
  return value === '::' || value === '::1' || /^f[cd]/.test(value) || /^fe[89ab]/.test(value) || value.startsWith('ff') || value.startsWith('::ffff:')
}

export interface UnsubscribeDependencies {
  fetch: typeof fetch
  resolve(hostname: string): Promise<string[]>
  openExternal(url: string): Promise<void>
  sendMail(input: MailDraftInput): Promise<unknown>
}
export const defaultResolve = async (hostname: string) => (await lookup(hostname, { all: true })).map((entry) => entry.address)

async function assertPublicHost(url: URL, resolve: UnsubscribeDependencies['resolve']) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(hostname) || isPrivateAddress(hostname)) throw new Error(`Aerio will not send unsubscribe requests to the local or private address ${url.host}`)
  if (isIP(hostname)) return
  let addresses: string[]
  try { addresses = await resolve(hostname) } catch { throw new Error(`Could not find the unsubscribe server ${url.host}`) }
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error(`Aerio will not send unsubscribe requests to ${url.host} because it resolves to a local or private address`)
}

/**
 * Performs the explicitly chosen unsubscribe action. The URL must be one the message's own headers advertise.
 * One-click requests follow RFC 8058: a bare POST with no cookies or credentials, and redirects are not followed.
 */
export async function performUnsubscribe(input: { info: MailListUnsubscribeInfo; url: unknown; method: unknown; accountId: string; readOnly: boolean }, dependencies: UnsubscribeDependencies): Promise<MailUnsubscribeResult> {
  const method = input.method as MailUnsubscribeMethod
  if (!['one-click', 'browser', 'mailto'].includes(method)) throw new Error('Choose an unsubscribe method')
  const option = input.info.options.find((item) => item.url === input.url)
  if (!option) throw new Error('This unsubscribe destination is not listed in the email')
  if (method === 'mailto') {
    if (option.kind !== 'mailto' || !option.mailto) throw new Error('This unsubscribe destination is not an email address')
    if (input.readOnly) throw new Error('This account is archived and cannot send email')
    await dependencies.sendMail({ accountId: input.accountId, to: option.mailto.to, cc: [], bcc: [], subject: option.mailto.subject || 'unsubscribe', text: option.mailto.body || 'unsubscribe', attachmentPaths: [] })
    return { method, destination: option.destination, status: 'queued' }
  }
  if (option.kind !== 'https') throw new Error('This unsubscribe destination is not an HTTPS link')
  const url = new URL(option.url)
  if (method === 'browser') {
    await dependencies.openExternal(url.href)
    return { method, destination: option.destination, status: 'opened' }
  }
  if (!option.oneClick) throw new Error('This list does not support one-click unsubscribe')
  await assertPublicHost(url, dependencies.resolve)
  let response: Response
  try {
    response = await dependencies.fetch(url.href, { method: 'POST', redirect: 'manual', credentials: 'omit', cache: 'no-store', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: ONE_CLICK_BODY, signal: AbortSignal.timeout(30_000) })
  } catch (error) {
    throw new Error(`Could not reach ${option.destination}: ${error instanceof Error ? error.message : 'the request failed'}`)
  }
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    const location = response.headers.get('location')
    let target = ''
    try { target = location ? ` to ${new URL(location, url).host}` : '' } catch { /* keep the generic message */ }
    throw new Error(`${option.destination} tried to redirect the unsubscribe request${target}, which Aerio does not follow. Open the link in your browser instead.`)
  }
  if (!response.ok) throw new Error(`${option.destination} rejected the unsubscribe request (HTTP ${response.status})`)
  return { method, destination: option.destination, status: 'unsubscribed' }
}
