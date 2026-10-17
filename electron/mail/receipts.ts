import type { MailAccountSummary, MailReadReceiptPolicy, MailReceiptInfo, MailReceiptReportInfo, MailReceiptRequestInfo } from '../../src/mail-types'
import type { MailDatabase } from './database'

// Incoming read-receipt requests (RFC 8098 Disposition-Notification-To) and
// returned receipts (multipart/report MDNs and DSNs). A receipt only reports
// what a recipient's client or server chose to say; it never proves reading.

export type MailHeaders = Map<string, string[]>

const encodeHeader = (value: string) => value.replaceAll(/[\r\n]+/g, ' ').trim()

export function headerBlock(raw: string) {
  const separator = raw.search(/\r?\n\r?\n/)
  return separator >= 0 ? raw.slice(0, separator) : raw
}

export function parseHeaders(block: string): MailHeaders {
  const headers: MailHeaders = new Map()
  let current: { name: string; value: string } | undefined
  const commit = () => {
    if (!current) return
    const list = headers.get(current.name) ?? []
    list.push(current.value.trim())
    headers.set(current.name, list)
  }
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && current) {
      current.value += ` ${line.trim()}`
      continue
    }
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    commit()
    current = { name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1) }
  }
  commit()
  return headers
}

const firstHeader = (headers: MailHeaders, name: string) => headers.get(name)?.[0]

export function headerParameter(value: string | undefined, name: string) {
  const match = value?.match(new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i'))
  return match ? match[1] ?? match[2] : undefined
}

// Splits an address-list header and returns lower-case addr-specs.
export function addressList(value?: string) {
  if (!value) return []
  const addresses: string[] = []
  let current = ''
  let quoted = false
  let depth = 0
  for (const character of value) {
    if (character === '"') quoted = !quoted
    if (!quoted && character === '<') depth += 1
    if (!quoted && character === '>') depth = Math.max(0, depth - 1)
    if (!quoted && depth === 0 && character === ',') {
      addresses.push(current)
      current = ''
    } else current += character
  }
  addresses.push(current)
  return addresses
    .map((item) => (item.match(/<([^<>]+)>/)?.[1] ?? item.replace(/\([^)]*\)/g, '')).trim().toLowerCase())
    .filter((item) => /^[^\s@]+@[^\s@]+$/.test(item))
}

export function readReceiptRequest(headers: MailHeaders) {
  const value = firstHeader(headers, 'disposition-notification-to')
  const addresses = addressList(value)
  return value && addresses.length ? { notifyTo: encodeHeader(value), addresses } : undefined
}

export function isReceiptReport(headers: MailHeaders) {
  const contentType = firstHeader(headers, 'content-type') ?? ''
  if (!/^\s*multipart\/report\b/i.test(contentType)) return false
  return /^(disposition-notification|delivery-status)$/i.test(headerParameter(contentType, 'report-type') ?? '')
}

interface AutomaticReceiptContext {
  addresses: string[]
  headers: MailHeaders
  fromEmail: string
  labelIds: string[]
}

// RFC 8098 section 2.1: automatic MDNs must not go to an address the sender
// did not plainly control, so these cases always fall back to asking.
export function automaticReceiptBlocker({ addresses, headers, fromEmail, labelIds }: AutomaticReceiptContext) {
  if (labelIds.includes('SPAM') || labelIds.includes('TRASH')) return 'Receipts are never sent automatically for junk or deleted mail.'
  if (addresses.length !== 1) return 'The receipt would go to more than one address.'
  const autoSubmitted = firstHeader(headers, 'auto-submitted')
  if (autoSubmitted && !/^no\b/i.test(autoSubmitted)) return 'Automated messages never receive automatic receipts.'
  const returnPath = addressList(firstHeader(headers, 'return-path'))[0]
  const expected = returnPath ?? fromEmail.trim().toLowerCase()
  if (addresses[0] !== expected) return 'The receipt address is different from the sender’s address.'
  return undefined
}

function decodePart(headers: MailHeaders, body: string) {
  const encoding = (firstHeader(headers, 'content-transfer-encoding') ?? '').toLowerCase()
  if (encoding === 'base64') return Buffer.from(body.replaceAll(/\s+/g, ''), 'base64').toString('utf8')
  if (encoding === 'quoted-printable') {
    return body.replaceAll(/=\r?\n/g, '').replaceAll(/=([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
  }
  return body
}

function reportParts(raw: string, boundary: string) {
  const escaped = boundary.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const segments = raw.split(new RegExp(`\\r?\\n--${escaped}(?:--)?[ \\t]*(?=\\r?\\n|$)`))
  return segments.slice(1).map((segment) => {
    const content = segment.replace(/^\r?\n/, '')
    const separator = content.search(/\r?\n\r?\n/)
    const head = separator >= 0 ? content.slice(0, separator) : content
    const body = separator >= 0 ? content.slice(separator).replace(/^\r?\n\r?\n/, '') : ''
    const headers = parseHeaders(head)
    return { headers, body: decodePart(headers, body) }
  }).filter((part) => part.headers.size > 0)
}

const typeValue = (value?: string) => value?.split(';')[1]?.trim() ?? value?.trim()

export function parseReceiptReport(raw: string): MailReceiptReportInfo | undefined {
  const top = parseHeaders(headerBlock(raw))
  if (!isReceiptReport(top)) return undefined
  const contentType = firstHeader(top, 'content-type')!
  const boundary = headerParameter(contentType, 'boundary')
  if (!boundary) return undefined
  const kind = /^disposition-notification$/i.test(headerParameter(contentType, 'report-type') ?? '') ? 'read' : 'delivery'
  const parts = reportParts(raw, boundary)
  const statusPart = parts.find((part) => /^\s*message\/(?:global-)?(?:disposition-notification|delivery-status)\b/i.test(firstHeader(part.headers, 'content-type') ?? ''))
  if (!statusPart) return undefined
  const blocks = statusPart.body.split(/\r?\n[ \t]*\r?\n/).map((block) => parseHeaders(block)).filter((block) => block.size > 0)
  const returnedHeaders = parts.find((part) => /^\s*(?:message\/(?:global-)?rfc822|text\/rfc822-headers|message\/global-headers)\b/i.test(firstHeader(part.headers, 'content-type') ?? ''))
  const returnedMessageId = returnedHeaders ? firstHeader(parseHeaders(headerBlock(returnedHeaders.body)), 'message-id') : undefined
  if (kind === 'read') {
    const fields = blocks[0] ?? new Map()
    const disposition = firstHeader(fields, 'disposition')
    return {
      kind,
      reporter: typeValue(firstHeader(fields, 'final-recipient')) ?? firstHeader(fields, 'reporting-ua'),
      originalMessageId: firstHeader(fields, 'original-message-id') ?? returnedMessageId,
      disposition: disposition?.split(';').at(-1)?.trim().toLowerCase(),
      recipients: [{ recipient: typeValue(firstHeader(fields, 'final-recipient')) ?? '', action: disposition?.split(';').at(-1)?.trim().toLowerCase() }].filter((item) => item.recipient)
    }
  }
  const [messageFields, ...recipientBlocks] = blocks
  return {
    kind,
    reporter: typeValue(firstHeader(messageFields ?? new Map(), 'reporting-mta')),
    originalMessageId: returnedMessageId ?? firstHeader(messageFields ?? new Map(), 'original-envelope-id'),
    recipients: recipientBlocks.map((fields) => ({
      recipient: typeValue(firstHeader(fields, 'final-recipient') ?? firstHeader(fields, 'original-recipient')) ?? '',
      action: firstHeader(fields, 'action')?.toLowerCase(),
      status: firstHeader(fields, 'status')
    })).filter((item) => item.recipient)
  }
}

export interface ReadReceiptMimeInput {
  from: string
  finalRecipient: string
  notifyTo: string
  originalMessageId?: string
  originalSubject: string
  automatic: boolean
}

// Builds an RFC 8098 MDN with the "displayed" disposition.
export function createReadReceiptMime(input: ReadReceiptMimeInput) {
  const boundary = `aerio-mdn-${crypto.randomUUID()}`
  const originalId = input.originalMessageId ? encodeHeader(input.originalMessageId) : undefined
  const headers = [
    `Message-ID: <${crypto.randomUUID()}@aerio.local>`,
    `Date: ${new Date().toUTCString()}`,
    `From: ${encodeHeader(input.from)}`,
    `To: ${encodeHeader(input.notifyTo)}`,
    `Subject: Read: ${encodeHeader(input.originalSubject)}`,
    'MIME-Version: 1.0',
    ...(originalId ? [`In-Reply-To: ${originalId}`, `References: ${originalId}`] : []),
    ...(input.automatic ? ['Auto-Submitted: auto-replied'] : []),
    `Content-Type: multipart/report; report-type=disposition-notification; boundary="${boundary}"`
  ]
  const explanation = `This is a read receipt for your message "${encodeHeader(input.originalSubject)}" sent to ${encodeHeader(input.finalRecipient)}.\r\n` +
    'It means the message was displayed. It does not confirm that the message was read or understood.'
  const fields = [
    'Reporting-UA: Aerio',
    `Final-Recipient: rfc822; ${encodeHeader(input.finalRecipient)}`,
    ...(originalId ? [`Original-Message-ID: ${originalId}`] : []),
    `Disposition: manual-action/${input.automatic ? 'MDN-sent-automatically' : 'MDN-sent-manually'}; displayed`
  ]
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n` +
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${explanation}\r\n` +
    `--${boundary}\r\nContent-Type: message/disposition-notification\r\n\r\n${fields.join('\r\n')}\r\n` +
    `--${boundary}--\r\n`)
}

export interface ReceiptServiceDependencies {
  database: Pick<MailDatabase, 'receiptMessageContext' | 'messageByHeaderId' | 'getReceiptResponse' | 'recordReceiptResponse'> & {
    getAccount(accountId: string): MailAccountSummary | undefined
  }
  readRaw(path: string, maxBytes: number): Buffer
  online(): boolean
  sendRaw(account: MailAccountSummary, raw: Buffer, recipients: string[]): Promise<void>
}

const headerBytes = 64 * 1024
const reportBytes = 1024 * 1024

export function createReceiptService(deps: ReceiptServiceDependencies) {
  const inFlight = new Set<string>()

  const load = (accountId: string, messageId: string) => {
    const context = deps.database.receiptMessageContext(accountId, messageId)
    const account = deps.database.getAccount(accountId)
    if (!context?.rawPath || !account) return undefined
    const headers = parseHeaders(headerBlock(deps.readRaw(context.rawPath, headerBytes).toString('utf8')))
    return { context, account, headers }
  }

  const report = (accountId: string, rawPath: string) => {
    const parsed = parseReceiptReport(deps.readRaw(rawPath, reportBytes).toString('utf8'))
    if (!parsed?.originalMessageId) return parsed
    const original = deps.database.messageByHeaderId(accountId, parsed.originalMessageId)
    return original ? { ...parsed, originalSubject: original.subject, originalSentAt: original.date } : parsed
  }

  const send = async (loaded: NonNullable<ReturnType<typeof load>>, messageId: string, request: NonNullable<ReturnType<typeof readReceiptRequest>>, automatic: boolean) => {
    const key = `${loaded.account.id}\u0000${messageId}`
    if (inFlight.has(key)) throw new Error('A read receipt is already being sent for this message.')
    inFlight.add(key)
    try {
      const raw = createReadReceiptMime({
        from: `${loaded.account.displayName} <${loaded.account.email}>`,
        finalRecipient: loaded.account.email,
        notifyTo: request.notifyTo,
        originalMessageId: loaded.context.messageIdHeader,
        originalSubject: loaded.context.subject,
        automatic
      })
      await deps.sendRaw(loaded.account, raw, request.addresses)
      return deps.database.recordReceiptResponse(loaded.account.id, messageId, { notifyTo: request.notifyTo, originalMessageId: loaded.context.messageIdHeader, status: 'sent', automatic })
    } catch (error) {
      return deps.database.recordReceiptResponse(loaded.account.id, messageId, { notifyTo: request.notifyTo, originalMessageId: loaded.context.messageIdHeader, status: 'failed', automatic, error: error instanceof Error ? error.message : String(error) })
    } finally {
      inFlight.delete(key)
    }
  }

  const requestInfo = (notifyTo: string, policy: MailReadReceiptPolicy, stored?: ReturnType<MailDatabase['getReceiptResponse']>, reason?: string): MailReceiptRequestInfo => stored
    ? { notifyTo, policy, status: stored.status, automatic: stored.automatic, respondedAt: stored.respondedAt, ...(stored.error ? { error: stored.error } : {}), ...(reason ? { reason } : {}) }
    : { notifyTo, policy, status: policy === 'never' ? 'suppressed' : 'pending', ...(reason ? { reason } : {}) }

  // Messages from the account itself, and receipts themselves, never prompt.
  const pendingRequest = (loaded: NonNullable<ReturnType<typeof load>>) => {
    if (isReceiptReport(loaded.headers)) return undefined
    if (loaded.context.fromEmail.trim().toLowerCase() === loaded.account.email.trim().toLowerCase()) return undefined
    return readReceiptRequest(loaded.headers)
  }

  return {
    async inspect(accountId: string, messageId: string, policy: MailReadReceiptPolicy): Promise<MailReceiptInfo> {
      const loaded = load(accountId, messageId)
      if (!loaded) return {}
      const info: MailReceiptInfo = {}
      const parsedReport = isReceiptReport(loaded.headers) ? report(accountId, loaded.context.rawPath!) : undefined
      if (parsedReport) info.report = parsedReport
      const request = pendingRequest(loaded)
      if (!request) return info
      const stored = deps.database.getReceiptResponse(accountId, messageId)
      if (stored || policy !== 'always') {
        info.request = requestInfo(request.notifyTo, policy, stored)
        return info
      }
      const reason = automaticReceiptBlocker({ addresses: request.addresses, headers: loaded.headers, fromEmail: loaded.context.fromEmail, labelIds: loaded.context.labelIds })
        ?? (deps.online() ? undefined : 'Aerio is offline, so the receipt was not sent.')
      if (reason || inFlight.has(`${accountId}\u0000${messageId}`)) {
        info.request = requestInfo(request.notifyTo, policy, undefined, reason)
        return info
      }
      info.request = requestInfo(request.notifyTo, policy, await send(loaded, messageId, request, true))
      return info
    },

    async respond(accountId: string, messageId: string, decision: 'send' | 'decline', policy: MailReadReceiptPolicy): Promise<MailReceiptInfo> {
      const loaded = load(accountId, messageId)
      if (!loaded) throw new Error('The original message is not available offline')
      const request = pendingRequest(loaded)
      if (!request) throw new Error('This message did not ask for a read receipt')
      if (decision === 'send' && policy === 'never') throw new Error('Read receipts are turned off in Settings')
      const stored = deps.database.getReceiptResponse(accountId, messageId)
      // Sending is one-shot: an answered request is never sent a second time.
      if (stored?.status === 'sent') return { request: requestInfo(request.notifyTo, policy, stored) }
      if (decision === 'decline') {
        return { request: requestInfo(request.notifyTo, policy, deps.database.recordReceiptResponse(accountId, messageId, { notifyTo: request.notifyTo, originalMessageId: loaded.context.messageIdHeader, status: 'declined', automatic: false })) }
      }
      if (!deps.online()) throw new Error('Sending a read receipt requires an internet connection')
      return { request: requestInfo(request.notifyTo, policy, await send(loaded, messageId, request, false)) }
    }
  }
}

export type ReceiptService = ReturnType<typeof createReceiptService>
