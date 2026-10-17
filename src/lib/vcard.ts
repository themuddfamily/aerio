// Dependency-free vCard 3.0 (RFC 2426) and 4.0 (RFC 6350) parser and serializer. vCard 2.1 files
// are read on a best-effort basis (bare TYPE parameters and quoted-printable values).
import type { Contact, ContactField } from '../types'
import {
  allProperties, escapeText, firstProperty, foldLine, formatParam, InterchangeFormatError, paramValue,
  parseComponents, splitEscaped, unescapeText, type Component, type ContentLimits, type ContentLine
} from './content-lines'
import { CONTACT_GROUP_LIMIT, isContactPhoto } from './contact-fields'

export const VCARD_LIMITS: ContentLimits = {
  maxChars: 20 * 1024 * 1024,
  maxLines: 2_000_000,
  // Embedded PHOTO data can be long; photos over the contact photo bound are skipped.
  maxLineLength: 4 * 1024 * 1024,
  maxComponents: 50_000,
  maxPropertiesPerComponent: 1_000,
  maxDepth: 3
}
export const VCARD_MAX_CONTACTS = 20_000
const MAX_FIELDS = 50
const MAX_TEXT = 100_000

export interface VCardParseResult {
  contacts: Contact[]
  warnings: string[]
}

export interface VCardOptions {
  idFactory(): string
  color?: string
  group?: string
}

function decodeQuotedPrintable(value: string, charset = 'utf-8') {
  const bytes: number[] = []
  const source = value.replace(/=\r?\n/g, '')
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    if (character === '=' && /^[0-9A-Fa-f]{2}$/.test(source.slice(index + 1, index + 3))) {
      bytes.push(parseInt(source.slice(index + 1, index + 3), 16))
      index += 2
    } else bytes.push(...new TextEncoder().encode(character))
  }
  try { return new TextDecoder(charset).decode(new Uint8Array(bytes)) }
  catch { return new TextDecoder('utf-8').decode(new Uint8Array(bytes)) }
}

const rawValue = (line: ContentLine) => paramValue(line, 'ENCODING')?.toUpperCase() === 'QUOTED-PRINTABLE'
  ? decodeQuotedPrintable(line.value, paramValue(line, 'CHARSET'))
  : line.value

const textValue = (line: ContentLine | undefined) => line ? unescapeText(rawValue(line)).trim().slice(0, MAX_TEXT) : undefined

const typesOf = (line: ContentLine) => (line.params.TYPE ?? [])
  .flatMap((value) => value.split(','))
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean)

function fieldFrom(line: ContentLine, value: string, parts?: string[]): ContactField {
  const types = typesOf(line)
  const pref = paramValue(line, 'PREF')
  const preferred = types.includes('pref') || (pref !== undefined && Number(pref) === 1)
  const type = types.filter((item) => !['pref', 'internet', 'voice', 'x400'].includes(item)).join(',')
  return { value, ...(type ? { type } : {}), ...(preferred ? { preferred: true } : {}), ...(parts ? { parts } : {}) }
}

const primary = (fields: ContactField[]) => (fields.find((field) => field.preferred) ?? fields[0])?.value

function formatAddress(parts: string[]) {
  const [poBox, extended, street, locality, region, postalCode, country] = parts
  return [poBox, extended, street, [locality, region, postalCode].filter(Boolean).join(' '), country].filter(Boolean).join(', ')
}

function contactFromCard(card: Component, options: VCardOptions): Contact | undefined {
  const formatted = textValue(firstProperty(card, 'FN'))
  const nameLine = firstProperty(card, 'N')
  const nameParts = nameLine ? splitEscaped(rawValue(nameLine), ';').slice(0, 5).map((part) => part.trim()) : undefined
  const emails = allProperties(card, 'EMAIL').slice(0, MAX_FIELDS)
    .map((line) => fieldFrom(line, textValue(line)!.replace(/^mailto:/i, '')))
    .filter((field) => field.value && field.value.length <= 500)
  const phones = allProperties(card, 'TEL').slice(0, MAX_FIELDS)
    .map((line) => fieldFrom(line, textValue(line)!.replace(/^tel:/i, '')))
    .filter((field) => field.value && field.value.length <= 200)
  const addresses = allProperties(card, 'ADR').slice(0, MAX_FIELDS).map((line) => {
    const parts = splitEscaped(rawValue(line), ';').slice(0, 7).map((part) => part.trim())
    while (parts.length < 7) parts.push('')
    return fieldFrom(line, formatAddress(parts), parts)
  }).filter((field) => field.value)
  const urls = allProperties(card, 'URL').slice(0, MAX_FIELDS)
    .map((line) => fieldFrom(line, textValue(line)!))
    .filter((field) => field.value && field.value.length <= 2_000)
  const organization = firstProperty(card, 'ORG')
  const company = organization ? splitEscaped(rawValue(organization), ';')[0]?.trim() : undefined
  const categories = firstProperty(card, 'CATEGORIES')
  const groups = categories ? splitEscaped(rawValue(categories), ',').map((value) => unescapeText(value).trim().slice(0, 300)).filter(Boolean).slice(0, CONTACT_GROUP_LIMIT) : []
  const group = groups[0]
  const photo = photoFrom(firstProperty(card, 'PHOTO'))
  const composed = nameParts ? [nameParts[3], nameParts[1], nameParts[2], nameParts[0], nameParts[4]].filter(Boolean).join(' ') : ''
  const name = (formatted || composed || company || primary(emails) || '').slice(0, 500)
  if (!name) return undefined
  const uid = textValue(firstProperty(card, 'UID'))?.slice(0, 1_000)
  const title = textValue(firstProperty(card, 'TITLE'))
  const notes = allProperties(card, 'NOTE').map((line) => textValue(line)).filter(Boolean).join('\n\n')
  const nickname = textValue(firstProperty(card, 'NICKNAME'))
  const birthday = textValue(firstProperty(card, 'BDAY'))?.slice(0, 50)
  return {
    id: options.idFactory(),
    name,
    email: primary(emails) ?? '',
    ...(primary(phones) ? { phone: primary(phones) } : {}),
    ...(company ? { company: company.slice(0, 500) } : {}),
    ...(title ? { title: title.slice(0, 500) } : {}),
    group: (group || options.group || 'Imported').slice(0, 300),
    ...(notes ? { notes: notes.slice(0, MAX_TEXT) } : {}),
    favorite: false,
    color: options.color ?? '#4d8f78',
    ...(emails.length ? { emails } : {}),
    ...(phones.length ? { phones } : {}),
    ...(addresses.length ? { addresses } : {}),
    ...(urls.length ? { urls } : {}),
    ...(nameParts && nameParts.some(Boolean) ? { nameParts } : {}),
    ...(nickname ? { nickname: nickname.slice(0, 500) } : {}),
    ...(birthday ? { birthday } : {}),
    ...(uid ? { sourceUid: uid } : {}),
    ...(groups.length > 1 ? { groups } : {}),
    ...(photo ? { photo } : {})
  }
}

// Embedded PHOTO values: vCard 4.0 data: URIs and vCard 3.0/2.1 base64 with a TYPE. Linked
// photos and images over the stored bound are skipped.
function photoFrom(line: ContentLine | undefined) {
  if (!line) return undefined
  const value = line.value.replace(/\s+/g, '')
  if (/^data:/i.test(value)) return isContactPhoto(value) ? value : undefined
  const encoding = paramValue(line, 'ENCODING')?.toLowerCase()
  if (encoding !== 'b' && encoding !== 'base64') return undefined
  const type = (typesOf(line)[0] ?? '').replace(/^image\//, '')
  const mime = type === 'jpg' || type === 'jpeg' ? 'jpeg' : ['png', 'gif', 'webp'].includes(type) ? type : undefined
  const photo = mime ? `data:image/${mime};base64,${value}` : undefined
  return isContactPhoto(photo) ? photo : undefined
}

export function parseVCards(input: string, options: VCardOptions, limits: ContentLimits = VCARD_LIMITS, maxContacts = VCARD_MAX_CONTACTS): VCardParseResult {
  const { roots, warnings } = parseComponents(input, limits)
  const cards = roots.filter((root) => root.name === 'VCARD')
  if (!cards.length) throw new InterchangeFormatError('This is not a vCard (.vcf) file: no VCARD was found')
  if (cards.length > maxContacts) throw new InterchangeFormatError(`The file contains more than ${maxContacts.toLocaleString('en-US')} contacts`)
  const contacts: Contact[] = []
  let unnamed = 0
  let unsupported = 0
  for (const card of cards) {
    const version = firstProperty(card, 'VERSION')?.value.trim()
    if (version && !['2.1', '3.0', '4.0'].includes(version)) unsupported++
    const contact = contactFromCard(card, options)
    if (contact) contacts.push(contact)
    else unnamed++
  }
  if (unnamed) warnings.push(`${unnamed} contact${unnamed === 1 ? '' : 's'} without a name or email address ${unnamed === 1 ? 'was' : 'were'} skipped`)
  if (unsupported) warnings.push(`${unsupported} card${unsupported === 1 ? ' uses' : 's use'} an unrecognized vCard version and ${unsupported === 1 ? 'was' : 'were'} read on a best-effort basis`)
  return { contacts, warnings }
}

// --- Serialization ---------------------------------------------------------------------------

const component = (value: string | undefined) => (value ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n')

function splitName(name: string) {
  const parts = name.trim().split(/\s+/)
  return parts.length > 1 ? [parts[parts.length - 1], parts.slice(0, -1).join(' '), '', '', ''] : [name.trim(), '', '', '', '']
}

const fieldsOrPrimary = (fields: ContactField[] | undefined, value: string | undefined) =>
  fields?.length ? fields : value ? [{ value, preferred: true }] : []

function typedLine(name: string, field: ContactField, version: '3.0' | '4.0', value: string, extra: string[] = []) {
  const types = [...extra, ...(field.type ? field.type.split(',').map((item) => item.trim()).filter(Boolean) : [])]
  if (version === '3.0') {
    const all = field.preferred ? [...types, 'pref'] : types
    return `${name}${all.length ? formatParam('TYPE', all) : ''}:${value}`
  }
  return `${name}${types.length ? formatParam('TYPE', types) : ''}${field.preferred ? ';PREF=1' : ''}:${value}`
}

export function serializeVCards(contacts: Contact[], version: '3.0' | '4.0' = '3.0') {
  const lines: string[] = []
  for (const contact of contacts) {
    lines.push('BEGIN:VCARD', `VERSION:${version}`)
    if (version === '4.0') lines.push('PRODID:-//Aerio//Contacts Export//EN')
    if (contact.sourceUid) lines.push(`UID:${escapeText(contact.sourceUid)}`)
    lines.push(`FN:${escapeText(contact.name)}`)
    lines.push(`N:${(contact.nameParts?.length ? contact.nameParts : splitName(contact.name)).slice(0, 5).concat(['', '', '', '', '']).slice(0, 5).map(component).join(';')}`)
    if (contact.nickname) lines.push(`NICKNAME:${escapeText(contact.nickname)}`)
    for (const field of fieldsOrPrimary(contact.emails, contact.email)) lines.push(typedLine('EMAIL', field, version, escapeText(field.value), version === '3.0' ? ['internet'] : []))
    for (const field of fieldsOrPrimary(contact.phones, contact.phone)) lines.push(typedLine('TEL', field, version, escapeText(field.value)))
    for (const field of contact.addresses ?? []) {
      const parts = field.parts?.length ? field.parts.concat(['', '', '', '', '', '', '']).slice(0, 7) : ['', '', field.value, '', '', '', '']
      lines.push(typedLine('ADR', field, version, parts.map(component).join(';')))
    }
    for (const field of contact.urls ?? []) lines.push(typedLine('URL', field, version, field.value.replace(/[\r\n]/g, '')))
    if (contact.company) lines.push(`ORG:${component(contact.company)}`)
    if (contact.title) lines.push(`TITLE:${escapeText(contact.title)}`)
    if (contact.birthday) lines.push(`BDAY:${contact.birthday.replace(/[\r\n;:,]/g, '')}`)
    const categories = contact.groups?.length ? contact.groups : contact.group ? [contact.group] : []
    if (categories.length) lines.push(`CATEGORIES:${categories.map(component).join(',')}`)
    if (contact.photo && isContactPhoto(contact.photo)) {
      const [, mime, data] = /^data:image\/([a-z]+);base64,(.*)$/.exec(contact.photo)!
      lines.push(version === '4.0' ? `PHOTO:${contact.photo}` : `PHOTO;ENCODING=b;TYPE=${mime.toUpperCase()}:${data}`)
    }
    if (contact.notes) lines.push(`NOTE:${escapeText(contact.notes)}`)
    lines.push('END:VCARD')
  }
  return `${lines.map(foldLine).join('\r\n')}\r\n`
}
