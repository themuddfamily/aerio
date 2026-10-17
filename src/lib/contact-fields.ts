// Multi-value contact helpers shared by the contact editor, the provider mappers, and IPC validation.
// `Contact.email`/`phone`/`group` stay the primary values older code reads; the lists hold every value.
import type { Contact, ContactField } from '../types'

export const CONTACT_FIELD_LIMIT = 50
export const CONTACT_GROUP_LIMIT = 100
// Roughly a 160 KB image once decoded; the editor downsizes pictures before storing them.
export const CONTACT_PHOTO_MAX_CHARS = 220_000
export const EMAIL_TYPES = ['home', 'work', 'other'] as const
export const PHONE_TYPES = ['mobile', 'home', 'work', 'other'] as const
export const ADDRESS_TYPES = ['home', 'work', 'other'] as const

const PHOTO = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/
const BIRTHDAY = /^(?:\d{4}|--)-?(\d{2})-?(\d{2})$/

export const normalizedContactEmail = (value: string) => value.trim().toLowerCase()
export const normalizedContactPhone = (value: string) => value.replace(/[^\d+]/g, '')

export function isContactPhoto(value: unknown): value is string {
  return typeof value === 'string' && value.length <= CONTACT_PHOTO_MAX_CHARS && PHOTO.test(value)
}

// Accepts YYYY-MM-DD, YYYYMMDD, and the year-less vCard forms --MM-DD / --MMDD.
export function isContactBirthday(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = BIRTHDAY.exec(value.trim())
  if (!match) return false
  const month = Number(match[1])
  const day = Number(match[2])
  return month >= 1 && month <= 12 && day >= 1 && day <= 31
}

export const contactGroupNames = (contact: Pick<Contact, 'group' | 'groups'>) => contact.groups?.length ? contact.groups : contact.group ? [contact.group] : []

// Every address a contact can be reached at, primary first and without duplicates.
export function contactEmailAddresses(contact: Pick<Contact, 'email' | 'emails'>) {
  const seen = new Set<string>()
  return [contact.email, ...(contact.emails ?? []).map((field) => field.value)].flatMap((value) => {
    const key = value ? normalizedContactEmail(value) : ''
    if (!key || seen.has(key)) return []
    seen.add(key)
    return [value.trim()]
  })
}

function cleanFields(fields: ContactField[] | undefined, normalize: (value: string) => string) {
  const seen = new Set<string>()
  const cleaned = (fields ?? []).flatMap((field) => {
    const value = field.value.trim()
    const key = normalize(value)
    if (!key || seen.has(key)) return []
    seen.add(key)
    const type = field.type?.trim()
    const parts = field.parts?.some((part) => part.trim()) ? field.parts.map((part) => part.trim()) : undefined
    return [{ value, ...(type ? { type } : {}), ...(field.preferred ? { preferred: true } : {}), ...(parts ? { parts } : {}) }]
  }).slice(0, CONTACT_FIELD_LIMIT)
  // At most one preferred value; the first one wins.
  let preferred = false
  for (const field of cleaned) {
    if (field.preferred && preferred) delete (field as ContactField).preferred
    if (field.preferred) preferred = true
  }
  return cleaned
}

const primaryOf = (fields: ContactField[]) => (fields.find((field) => field.preferred) ?? fields[0])?.value

// Normalizes the multi-value editor's lists and derives the primary email, phone, and group from them.
export function withContactFields(contact: Contact, fields: { emails: ContactField[]; phones: ContactField[]; addresses: ContactField[]; groups: string[] }, fallbackGroup: string): Contact {
  const emails = cleanFields(fields.emails, normalizedContactEmail)
  const phones = cleanFields(fields.phones, normalizedContactPhone)
  const addresses = cleanFields(fields.addresses, (value) => value.toLowerCase().replace(/\s+/g, ' '))
  const groups = fields.groups.map((group) => group.trim().slice(0, 300)).filter((group, index, all) => group && all.findIndex((item) => item.toLowerCase() === group.toLowerCase()) === index).slice(0, CONTACT_GROUP_LIMIT)
  const next: Contact = { ...contact, email: primaryOf(emails) ?? '', phone: primaryOf(phones), group: groups[0] ?? fallbackGroup }
  for (const [key, value] of [['emails', emails], ['phones', phones], ['addresses', addresses], ['groups', groups]] as const) {
    if (value.length) Object.assign(next, { [key]: value })
    else delete next[key]
  }
  if (!next.phone) delete next.phone
  return next
}

// The editor's starting rows: the stored lists, or the single legacy value when no list exists.
export function editableFields(contact: Contact | undefined) {
  const emails = contact?.emails?.length ? contact.emails : contact?.email ? [{ value: contact.email }] : []
  const phones = contact?.phones?.length ? contact.phones : contact?.phone ? [{ value: contact.phone }] : []
  return { emails: emails.map((field) => ({ ...field })), phones: phones.map((field) => ({ ...field })), addresses: (contact?.addresses ?? []).map((field) => ({ ...field })), groups: contact ? contactGroupNames(contact) : [] }
}

// Composes the display value of a structured address (PO box, extended, street, locality, region, postal code, country).
export function formatAddressParts(parts: string[]) {
  const [poBox, extended, street, locality, region, postalCode, country] = parts.map((part) => part?.trim() ?? '')
  return [poBox, extended, street, [locality, region, postalCode].filter(Boolean).join(' '), country].filter(Boolean).join(', ')
}

// A synchronized contact may have changed between opening the editor and saving it. The renderer
// sends the revision it edited; a mismatch means the provider (or another window) changed it.
export function contactEditConflict(current: { revision?: string }, edited: { revision?: unknown }) {
  if (typeof edited.revision !== 'string' || !current.revision || edited.revision === current.revision) return undefined
  return 'This contact changed since you opened it. Review the synchronized version and make your edit again.'
}
