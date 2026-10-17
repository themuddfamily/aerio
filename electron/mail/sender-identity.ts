import type { MailAccountSummary, MailDraftInput } from '../../src/mail-types'
import { primaryIdentityId, type MailSenderIdentity } from '../../src/mail-identity-types'
import type { DiscoveredSenderIdentity } from './identity-store'

/** A sender problem the user must fix; the draft is kept and never silently re-addressed. */
export class SenderIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SenderIdentityError'
  }
}

export interface GmailSendAs {
  sendAsEmail?: string
  displayName?: string
  replyToAddress?: string
  signature?: string
  isPrimary?: boolean
  verificationStatus?: string
}

export interface MicrosoftUserAddresses {
  mail?: string | null
  proxyAddresses?: string[]
}

/** Formats `Name <email>`, quoting display names that contain RFC 5322 specials. */
export function formatSenderAddress(name: string, email: string) {
  const cleanName = name.replaceAll(/[\r\n]+/g, ' ').trim()
  const cleanEmail = email.replaceAll(/[\r\n<>]+/g, '').trim()
  if (!cleanName) return cleanEmail
  const display = /^[\p{L}\p{N}!#$%&'*+\-/=?^_`{|}~ ]+$/u.test(cleanName) ? cleanName : `"${cleanName.replaceAll(/["\\]/g, '\\$&')}"`
  return `${display} <${cleanEmail}>`
}

/** Gmail users.settings.sendAs.list; only `accepted` aliases (and the primary address) may send. */
export function parseGmailSendAs(value: { sendAs?: GmailSendAs[] } | undefined): DiscoveredSenderIdentity[] {
  return (value?.sendAs ?? []).filter((item) => typeof item?.sendAsEmail === 'string' && item.sendAsEmail.trim()).map((item) => ({
    email: item.sendAsEmail!.trim(),
    name: item.displayName?.trim() || undefined,
    replyTo: item.replyToAddress?.trim() ? [item.replyToAddress.trim()] : [],
    status: item.isPrimary || !item.verificationStatus || item.verificationStatus === 'accepted' ? 'verified' : 'pending',
    signatureHtml: item.signature?.trim() || undefined
  }))
}

/**
 * Microsoft Graph exposes the mailbox's own SMTP proxy addresses. Whether an
 * alias may be used as From depends on the tenant (SendFromAliasEnabled), so
 * they stay unverified; shared/send-as mailboxes are not discoverable with
 * delegated mail scopes and are added manually.
 */
export function parseMicrosoftProxyAddresses(value: MicrosoftUserAddresses | undefined, primaryEmail: string): DiscoveredSenderIdentity[] {
  const addresses = (value?.proxyAddresses ?? [])
    .filter((item) => typeof item === 'string' && /^smtp:/i.test(item))
    .map((item) => item.slice(5).trim())
  if (value?.mail) addresses.push(value.mail.trim())
  const seen = new Set([primaryEmail.trim().toLowerCase()])
  return addresses.filter((email) => {
    const key = email.toLowerCase()
    if (!email || seen.has(key)) return false
    seen.add(key)
    return true
  }).map((email) => ({ email, status: 'unverified' as const }))
}

export interface ResolvedSender {
  /** Formatted From header value. */
  from: string
  email: string
  identity?: MailSenderIdentity
}

/**
 * Resolves the draft's From. `strict` (delivery) refuses addresses the
 * provider has not authorized; draft saves fall back to the primary address
 * for a missing identity so editing never fails because of an alias.
 */
export function resolveDraftSender(account: MailAccountSummary, identity: MailSenderIdentity | undefined, input: Pick<MailDraftInput, 'fromIdentityId'>, strict: boolean): ResolvedSender {
  const primary = { from: formatSenderAddress(account.displayName, account.email), email: account.email }
  if (!input.fromIdentityId || input.fromIdentityId === primaryIdentityId(account.id)) return primary
  if (!identity || identity.accountId !== account.id) {
    if (!strict) return primary
    throw new SenderIdentityError(`The From address chosen for this message is no longer configured for ${account.email}. Choose another From address; the message was kept as a draft.`)
  }
  if (strict && account.provider === 'gmail' && identity.status === 'pending') {
    throw new SenderIdentityError(`Gmail has not finished verifying ${identity.email}. Confirm it in Gmail settings, refresh sender addresses, then send again; the message was kept as a draft.`)
  }
  if (strict && account.provider === 'gmail' && identity.source === 'manual') {
    // Gmail silently rewrites an unauthorized From to the primary address, so refuse before sending.
    throw new SenderIdentityError(`Gmail has not authorized ${identity.email} for this account. Add it under Gmail settings → Accounts → “Send mail as”, refresh sender addresses, then send again; the message was kept as a draft.`)
  }
  return { from: formatSenderAddress(identity.name, identity.email), email: identity.email, identity }
}

/**
 * Turns a provider rejection of a non-primary From into an actionable error.
 * Returns undefined for unrelated failures so the original error is reported.
 */
export function describeSenderRejection(error: unknown, provider: MailAccountSummary['provider'], sender: ResolvedSender): SenderIdentityError | undefined {
  if (!sender.identity || error instanceof SenderIdentityError) return
  const message = error instanceof Error ? error.message : String(error)
  const status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : undefined
  const responseCode = typeof (error as { responseCode?: unknown })?.responseCode === 'number' ? (error as { responseCode: number }).responseCode : undefined
  const mentionsSender = /send ?as|sendas|on behalf|from address|from header|sender|not owned|not allowed to send|not authori[sz]ed to send|mailbox unavailable/i.test(message)
  const rejected = provider === 'gmail'
    ? (status === 400 || status === 403) && mentionsSender
    : provider === 'microsoft'
      ? /ErrorSendAsDenied|ErrorSendOnBehalfOfDenied/i.test(message) || (status === 403 && mentionsSender)
      : (responseCode !== undefined && [550, 551, 553, 554].includes(responseCode) && mentionsSender) || /sender address rejected|not owned by (?:the )?user/i.test(message)
  if (!rejected) return
  return new SenderIdentityError(`${providerName(provider)} refused to send as ${sender.email}. This account may not have permission to use that address. The message was kept as a draft — choose another From address or update the alias permissions. (${message})`)
}

const providerName = (provider: MailAccountSummary['provider']) =>
  provider === 'gmail' ? 'Gmail' : provider === 'microsoft' ? 'Microsoft' : 'The mail server'
