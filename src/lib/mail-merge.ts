// Mail merge variables, recipient lists, and provider sending limits. Shared by
// the renderer preview and the worker so what is previewed is what is sent.
import type { Contact } from '../types'
import type { MailProviderId } from '../mail-types'
import type { MailMergeLimits, MailMergeMessageInput, MailMergeRecipientInput } from '../mail-merge-types'
import { isCompleteMailAddress } from './mail-address'
import { parseCsv } from './contact-csv'

export const MAIL_MERGE_MAX_RECIPIENTS = 5_000
export const MAIL_MERGE_MAX_FIELDS = 50
export const MAIL_MERGE_MAX_FIELD_LENGTH = 1_000
export const MAIL_MERGE_MAX_PER_MINUTE = 60

/** Normalizes a variable or column name: `First Name`, `first_name`, and `firstName` are the same key. */
export const mergeKey = (value: string) => value.normalize('NFKC').toLowerCase().replaceAll(/[^\p{L}\p{N}]+/gu, '')

const PLACEHOLDER = /\{\{([^{}<>]{1,200})\}\}/g
const escapeHtml = (value: string) => value
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
const decodeHtmlSpaces = (value: string) => value.replaceAll(/&nbsp;|&#160;|\u00a0/g, ' ')
const singleLine = (value: string) => value.replaceAll(/[\r\n\u2028\u2029]+/g, ' ')

/** Every variable available to one recipient, keyed by `mergeKey`. */
export function mergeVariables(recipient: MailMergeRecipientInput): Map<string, string> {
  const variables = new Map<string, string>()
  for (const [key, value] of Object.entries(recipient.fields ?? {})) if (value.trim()) variables.set(mergeKey(key), value.trim())
  const [first, ...rest] = (recipient.name ?? '').trim().split(/\s+/)
  const builtIn: Record<string, string | undefined> = {
    email: recipient.email,
    name: recipient.name ?? ([recipient.firstName, recipient.lastName].filter(Boolean).join(' ') || undefined),
    firstname: recipient.firstName ?? first,
    lastname: recipient.lastName ?? (rest.length ? rest.join(' ') : undefined),
    company: recipient.company
  }
  // Named fields win over same-named custom columns only when they have a value.
  for (const [key, value] of Object.entries(builtIn)) if (value?.trim()) variables.set(key, value.trim())
  return variables
}

export type MergeRenderMode = 'text' | 'html' | 'header'

export interface MergeRenderResult {
  value: string
  /** Variables with neither a value nor a fallback; they render as empty text. */
  missing: string[]
}

/**
 * Replaces `{{name}}` and `{{name|fallback}}`. HTML mode escapes substituted
 * values (fallbacks were typed into the editor and are already HTML text);
 * header mode removes line breaks so a value can never add a header.
 */
export function renderMergeTemplate(template: string, variables: Map<string, string>, mode: MergeRenderMode): MergeRenderResult {
  const missing = new Set<string>()
  const value = template.replace(PLACEHOLDER, (_match, body: string) => {
    const source = mode === 'html' ? decodeHtmlSpaces(body) : body
    const separator = source.indexOf('|')
    const name = (separator === -1 ? source : source.slice(0, separator)).trim()
    const fallback = separator === -1 ? undefined : source.slice(separator + 1).trim()
    const found = variables.get(mergeKey(name))
    if (found === undefined && fallback === undefined) missing.add(name)
    const replacement = found === undefined ? fallback ?? '' : mode === 'html' ? escapeHtml(found) : found
    return mode === 'header' ? singleLine(replacement) : replacement
  })
  return { value: mode === 'header' ? singleLine(value) : value, missing: [...missing] }
}

export interface MergePlaceholder {
  name: string
  /** Every use of this variable has a `|fallback`. */
  fallback: boolean
}

/** Variables used in a message, in first-use order. */
export function mergePlaceholders(...templates: (string | undefined)[]): MergePlaceholder[] {
  const found = new Map<string, MergePlaceholder>()
  for (const template of templates) {
    for (const match of (template ?? '').matchAll(PLACEHOLDER)) {
      const body = decodeHtmlSpaces(match[1])
      const name = body.split('|')[0].trim()
      if (!name) continue
      const existing = found.get(mergeKey(name))
      const fallback = body.includes('|')
      found.set(mergeKey(name), { name: existing?.name ?? name, fallback: (existing?.fallback ?? true) && fallback })
    }
  }
  return [...found.values()]
}

export interface RenderedMergeMessage {
  subject: string
  text: string
  html?: string
  missing: string[]
}

export function renderMergeMessage(message: Pick<MailMergeMessageInput, 'subject' | 'text' | 'html'>, recipient: MailMergeRecipientInput): RenderedMergeMessage {
  const variables = mergeVariables(recipient)
  const subject = renderMergeTemplate(message.subject, variables, 'header')
  const text = renderMergeTemplate(message.text, variables, 'text')
  const html = message.html === undefined ? undefined : renderMergeTemplate(message.html, variables, 'html')
  return {
    subject: subject.value.trim(),
    text: text.value,
    ...(html ? { html: html.value } : {}),
    missing: [...new Set([...subject.missing, ...text.missing, ...(html?.missing ?? [])])]
  }
}

/** The single To value for one delivery: `"Name" <email>` or the bare address. */
export function mergeRecipientAddress(recipient: Pick<MailMergeRecipientInput, 'email' | 'name' | 'firstName' | 'lastName'>) {
  const email = singleLine(recipient.email).trim()
  const name = singleLine(recipient.name ?? [recipient.firstName, recipient.lastName].filter(Boolean).join(' ')).replaceAll(/["\\<>]/g, '').trim()
  return name ? `"${name}" <${email}>` : email
}

const bareEmail = (value: string) => (value.match(/<([^<>]+)>\s*$/)?.[1] ?? value).trim()

export interface MergeRecipientList {
  recipients: MailMergeRecipientInput[]
  invalid: string[]
  duplicates: number
  /** Custom CSV columns, beyond the built-in name/email/company fields. */
  columns: string[]
}

const clip = (value: string | undefined) => value?.replaceAll(/[\r\n]+/g, ' ').trim().slice(0, MAIL_MERGE_MAX_FIELD_LENGTH) || undefined

/** Drops invalid addresses and keeps the first entry for each address (case-insensitive). */
export function normalizeMergeRecipients(entries: MailMergeRecipientInput[]): Omit<MergeRecipientList, 'columns'> {
  const seen = new Set<string>()
  const recipients: MailMergeRecipientInput[] = []
  const invalid: string[] = []
  let duplicates = 0
  for (const entry of entries) {
    const email = bareEmail(singleLine(entry.email ?? ''))
    if (!isCompleteMailAddress(email) || email.includes(',') || email.includes(';')) {
      if (entry.email?.trim()) invalid.push(entry.email.trim())
      continue
    }
    const key = email.toLowerCase()
    if (seen.has(key)) { duplicates++; continue }
    seen.add(key)
    const fields = Object.fromEntries(Object.entries(entry.fields ?? {}).slice(0, MAIL_MERGE_MAX_FIELDS)
      .map(([name, value]) => [name.slice(0, 100), clip(value) ?? '']).filter(([name, value]) => name && value))
    recipients.push({
      email,
      ...(clip(entry.name) ? { name: clip(entry.name) } : {}),
      ...(clip(entry.firstName) ? { firstName: clip(entry.firstName) } : {}),
      ...(clip(entry.lastName) ? { lastName: clip(entry.lastName) } : {}),
      ...(clip(entry.company) ? { company: clip(entry.company) } : {}),
      ...(Object.keys(fields).length ? { fields } : {})
    })
  }
  return { recipients, invalid, duplicates }
}

const BUILT_IN_COLUMNS: Record<string, keyof Omit<MailMergeRecipientInput, 'fields'>> = {
  email: 'email', emailaddress: 'email', email1: 'email', emailaddress1: 'email', mail: 'email', email1value: 'email',
  name: 'name', fullname: 'name', displayname: 'name',
  firstname: 'firstName', givenname: 'firstName', first: 'firstName',
  lastname: 'lastName', surname: 'lastName', familyname: 'lastName', last: 'lastName',
  company: 'company', organization: 'company', organisation: 'company', organizationname: 'company'
}

/**
 * Parses pasted text: a CSV with a header row containing an email column, or
 * plain addresses separated by commas, semicolons, or new lines.
 */
export function parseMergeRecipientList(input: string): MergeRecipientList {
  const text = input.trim()
  if (!text) return { recipients: [], invalid: [], duplicates: 0, columns: [] }
  const firstLine = text.split(/\r?\n/, 1)[0]
  const firstCells = firstLine.split(/[,;\t]/).map((cell) => mergeKey(cell.replaceAll('"', '')))
  if (!firstLine.includes('@') && firstCells.some((cell) => BUILT_IN_COLUMNS[cell] === 'email')) {
    const table = parseCsv(text)
    const roles = table.headers.map((header) => BUILT_IN_COLUMNS[mergeKey(header)])
    const emailColumn = roles.indexOf('email')
    const columns = table.headers.filter((header, index) => !roles[index] && mergeKey(header))
    const entries = table.rows.map((row): MailMergeRecipientInput => {
      const entry: MailMergeRecipientInput = { email: row[emailColumn] ?? '', fields: {} }
      table.headers.forEach((header, index) => {
        const value = row[index] ?? ''
        const role = roles[index]
        if (role && role !== 'email' && !entry[role]) entry[role] = value
        else if (!role) entry.fields![header] = value
        // Every column also stays addressable by its own header, e.g. {{Given Name}}.
        if (role && role !== 'email' && value) entry.fields![header] = value
      })
      return entry
    })
    return { ...normalizeMergeRecipients(entries), columns }
  }
  const entries = splitAddressList(text).map((value): MailMergeRecipientInput => {
    const name = value.match(/^\s*"?([^"<]*?)"?\s*<[^<>]+>\s*$/)?.[1]?.trim()
    return { email: bareEmail(value), ...(name ? { name } : {}) }
  })
  return { ...normalizeMergeRecipients(entries), columns: [] }
}

function splitAddressList(value: string) {
  const addresses: string[] = []
  let current = ''
  let quoted = false
  let angle = 0
  for (const character of value) {
    if (character === '"') quoted = !quoted
    if (!quoted && character === '<') angle++
    if (!quoted && character === '>') angle = Math.max(0, angle - 1)
    if (!quoted && angle === 0 && /[,;\r\n\t]/.test(character)) {
      if (current.trim()) addresses.push(current.trim())
      current = ''
    } else current += character
  }
  if (current.trim()) addresses.push(current.trim())
  return addresses
}

/** Maps address-book contacts to merge recipients; contacts without an address are left out. */
export function mergeRecipientsFromContacts(contacts: Contact[]): MailMergeRecipientInput[] {
  return contacts.filter((contact) => contact.email).map((contact) => ({
    email: contact.email,
    name: contact.name,
    // vCard N order: family, given, additional, prefix, suffix.
    ...(contact.nameParts?.[1] ? { firstName: contact.nameParts[1] } : {}),
    ...(contact.nameParts?.[0] ? { lastName: contact.nameParts[0] } : {}),
    ...(contact.company ? { company: contact.company } : {}),
    fields: { ...(contact.title ? { title: contact.title } : {}), ...(contact.group ? { group: contact.group } : {}), ...(contact.nickname ? { nickname: contact.nickname } : {}) }
  }))
}

export interface MailMergeProviderLimits extends MailMergeLimits {
  /** The highest daily cap Aerio accepts for this kind of account. */
  maxDailyCap: number
  label: string
}

const CONSUMER_GOOGLE = /@(gmail|googlemail)\.com$/i
const CONSUMER_MICROSOFT = /@(outlook|hotmail|live|msn)\.[a-z.]+$/i

/**
 * Conservative defaults below published provider limits, so a merge does not
 * trip abuse detection or lock the account out of sending for a day.
 */
export function mailMergeProviderLimits(provider: MailProviderId | undefined, email = ''): MailMergeProviderLimits {
  if (provider === 'gmail') {
    return CONSUMER_GOOGLE.test(email)
      ? { perMinute: 20, dailyCap: 400, maxDailyCap: 500, label: 'Gmail (personal) allows about 500 recipients a day' }
      : { perMinute: 20, dailyCap: 1_500, maxDailyCap: 2_000, label: 'Google Workspace allows about 2,000 messages a day' }
  }
  if (provider === 'microsoft') {
    return CONSUMER_MICROSOFT.test(email)
      ? { perMinute: 10, dailyCap: 250, maxDailyCap: 300, label: 'Outlook.com allows about 300 recipients a day' }
      : { perMinute: 20, dailyCap: 2_000, maxDailyCap: 10_000, label: 'Microsoft 365 allows 30 messages a minute and 10,000 recipients a day' }
  }
  if (provider === 'icloud') return { perMinute: 10, dailyCap: 500, maxDailyCap: 1_000, label: 'iCloud Mail allows about 1,000 messages a day' }
  if (provider === 'yahoo') return { perMinute: 10, dailyCap: 300, maxDailyCap: 500, label: 'Yahoo Mail allows about 500 messages a day' }
  if (provider === 'fastmail') return { perMinute: 10, dailyCap: 500, maxDailyCap: 2_000, label: 'Fastmail limits depend on your plan' }
  return { perMinute: 10, dailyCap: 200, maxDailyCap: 2_000, label: 'Your mail server’s limits are unknown; start low' }
}

/** Clamps user-chosen limits to 1…provider maximum. */
export function clampMailMergeLimits(value: Partial<MailMergeLimits> | undefined, provider: MailProviderId | undefined, email?: string): MailMergeLimits {
  const defaults = mailMergeProviderLimits(provider, email)
  const whole = (input: unknown, fallback: number, max: number) => {
    const number = typeof input === 'number' && Number.isFinite(input) ? Math.floor(input) : fallback
    return Math.min(max, Math.max(1, number))
  }
  return {
    perMinute: whole(value?.perMinute, defaults.perMinute, MAIL_MERGE_MAX_PER_MINUTE),
    dailyCap: whole(value?.dailyCap, defaults.dailyCap, defaults.maxDailyCap)
  }
}

/** Rough finish estimate for the confirm step, ignoring provider latency. */
export function mailMergeDuration(count: number, limits: MailMergeLimits) {
  const days = Math.max(0, Math.ceil(count / limits.dailyCap) - 1)
  const minutes = Math.ceil(Math.min(count, limits.dailyCap) / limits.perMinute)
  return { days, minutes }
}
