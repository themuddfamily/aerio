// Rich Google People mapping: every typed email, phone, address, URL, birthday, nickname, photo,
// and contact-group membership, plus the contactGroups API. Writes merge the edited values into the
// raw provider entries kept in `providerData`, so labels and structured parts Aerio does not model
// survive an edit. Fields outside `googleUpdatePersonFields` are never sent and stay untouched.
import type { Contact, ContactField } from '../../src/types'
import type { SyncedContact, SyncedContactGroup } from '../../src/productivity-types'
import { formatAddressParts, isContactBirthday, isContactPhoto, normalizedContactEmail, normalizedContactPhone, CONTACT_FIELD_LIMIT } from '../../src/lib/contact-fields'
import { mapGoogleContact } from './google-connector'

type Raw = Record<string, unknown>
interface GoogleDate { year?: number; month?: number; day?: number }
export interface GoogleRichPerson {
  resourceName: string
  etag?: string
  metadata?: { deleted?: boolean; sources?: { type?: string; id?: string; etag?: string }[] }
  names?: ({ displayName?: string; givenName?: string; familyName?: string; middleName?: string; honorificPrefix?: string; honorificSuffix?: string } & Raw)[]
  nicknames?: ({ value?: string } & Raw)[]
  emailAddresses?: ({ value?: string; type?: string; metadata?: { primary?: boolean } } & Raw)[]
  phoneNumbers?: ({ value?: string; type?: string; metadata?: { primary?: boolean } } & Raw)[]
  addresses?: ({ formattedValue?: string; type?: string; poBox?: string; extendedAddress?: string; streetAddress?: string; city?: string; region?: string; postalCode?: string; country?: string; metadata?: { primary?: boolean } } & Raw)[]
  birthdays?: ({ date?: GoogleDate; text?: string } & Raw)[]
  urls?: ({ value?: string; type?: string } & Raw)[]
  photos?: { url?: string; default?: boolean; metadata?: { primary?: boolean } }[]
  organizations?: ({ name?: string; title?: string } & Raw)[]
  biographies?: ({ value?: string; contentType?: string } & Raw)[]
  memberships?: { contactGroupMembership?: { contactGroupResourceName?: string } }[]
}
export interface GoogleContactGroup {
  resourceName: string
  etag?: string
  name?: string
  formattedName?: string
  groupType?: 'USER_CONTACT_GROUP' | 'SYSTEM_CONTACT_GROUP' | 'GROUP_TYPE_UNSPECIFIED'
  memberCount?: number
  metadata?: { deleted?: boolean }
}

export const googleRichContactFields = 'names,nicknames,emailAddresses,phoneNumbers,addresses,birthdays,urls,photos,organizations,biographies,memberships,metadata'
export const googleUpdatePersonFields = 'names,nicknames,emailAddresses,phoneNumbers,addresses,birthdays,urls,organizations,biographies'
export const googleContactGroupFields = 'name,groupType,memberCount,metadata'
const preservedKeys = ['names', 'nicknames', 'emailAddresses', 'phoneNumbers', 'addresses', 'birthdays', 'urls', 'organizations', 'biographies'] as const
// System groups that behave like user-visible lists; the rest (myContacts, all, blocked, chatBuddies) are bookkeeping.
const LIST_SYSTEM_GROUPS = new Set(['contactGroups/friends', 'contactGroups/family', 'contactGroups/coworkers'])
// Output-only entry metadata the People API rejects or ignores on write.
const OUTPUT_ONLY = new Set(['metadata', 'formattedType', 'displayName', 'displayNameLastFirst', 'canonicalForm'])

const typed = (value: string | undefined, type: string | undefined, primary: boolean | undefined): ContactField | undefined => {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  const label = type?.trim().toLowerCase()
  return { value: trimmed.slice(0, 2_000), ...(label ? { type: label.slice(0, 200) } : {}), ...(primary ? { preferred: true } : {}) }
}

const googleBirthday = (birthday?: { date?: GoogleDate; text?: string }) => {
  const date = birthday?.date
  if (date?.month && date.day) {
    const mmdd = `${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`
    return date.year ? `${String(date.year).padStart(4, '0')}-${mmdd}` : `--${mmdd}`
  }
  return birthday?.text?.trim().slice(0, 50) || undefined
}

export function mapGoogleContactGroup(accountId: string, group: GoogleContactGroup, writable: boolean): SyncedContactGroup | undefined {
  if (group.metadata?.deleted) return undefined
  const system = group.groupType === 'SYSTEM_CONTACT_GROUP'
  if (system && !LIST_SYSTEM_GROUPS.has(group.resourceName)) return undefined
  const name = (group.formattedName || group.name || '').trim()
  if (!name) return undefined
  return {
    id: `${accountId}:google-group:${group.resourceName}`,
    remoteId: group.resourceName,
    accountId,
    provider: 'gmail',
    name: name.slice(0, 300),
    system,
    readOnly: !writable,
    ...(group.etag ? { revision: group.etag } : {}),
    ...(group.memberCount !== undefined ? { memberCount: group.memberCount } : {})
  }
}

export function mapGoogleRichContact(accountId: string, person: GoogleRichPerson, readOnly = false, groupNames = new Map<string, string>()): SyncedContact | undefined {
  const base = mapGoogleContact(accountId, person, readOnly)
  if (!base) return
  const emails = (person.emailAddresses ?? []).flatMap((item) => typed(item.value, item.type, item.metadata?.primary) ?? []).slice(0, CONTACT_FIELD_LIMIT)
  const phones = (person.phoneNumbers ?? []).flatMap((item) => typed(item.value, item.type, item.metadata?.primary) ?? []).slice(0, CONTACT_FIELD_LIMIT)
  const addresses = (person.addresses ?? []).flatMap((item) => {
    const parts = [item.poBox, item.extendedAddress, item.streetAddress, item.city, item.region, item.postalCode, item.country].map((part) => (part ?? '').slice(0, 2_000))
    const field = typed(item.formattedValue?.replace(/\s*\n\s*/g, ', ') || formatAddressParts(parts), item.type, item.metadata?.primary)
    return field ? [{ ...field, ...(parts.some(Boolean) ? { parts } : {}) }] : []
  }).slice(0, CONTACT_FIELD_LIMIT)
  const urls = (person.urls ?? []).flatMap((item) => typed(item.value, item.type, false) ?? []).slice(0, CONTACT_FIELD_LIMIT)
  const groupIds = (person.memberships ?? []).flatMap((membership) => membership.contactGroupMembership?.contactGroupResourceName ?? [])
  const groups = groupIds.flatMap((id) => groupNames.get(id) ?? [])
  const name = person.names?.[0]
  const nameParts = name && [name.familyName, name.givenName, name.middleName, name.honorificPrefix, name.honorificSuffix].map((part) => part ?? '')
  const birthday = googleBirthday(person.birthdays?.[0])
  const nickname = person.nicknames?.[0]?.value?.trim()
  const photoUrl = person.photos?.find((photo) => !photo.default && photo.url)?.url
  const providerData: Record<string, unknown> = {}
  for (const key of preservedKeys) if (person[key]?.length) providerData[key] = person[key]
  if (photoUrl) providerData.photoUrl = photoUrl
  const primaryEmail = (emails.find((field) => field.preferred) ?? emails[0])?.value
  const primaryPhone = (phones.find((field) => field.preferred) ?? phones[0])?.value
  return {
    ...base,
    email: primaryEmail ?? '',
    ...(primaryPhone ? { phone: primaryPhone } : {}),
    group: groups[0] ?? 'Google',
    ...(emails.length ? { emails } : {}),
    ...(phones.length ? { phones } : {}),
    ...(addresses.length ? { addresses } : {}),
    ...(urls.length ? { urls } : {}),
    ...(groups.length ? { groups } : {}),
    ...(groupIds.length ? { groupIds } : {}),
    ...(nameParts?.some(Boolean) ? { nameParts } : {}),
    ...(nickname ? { nickname: nickname.slice(0, 500) } : {}),
    ...(birthday ? { birthday } : {}),
    favorite: groupIds.includes('contactGroups/starred'),
    providerData
  }
}

const writable = (raw: Raw | undefined) => Object.fromEntries(Object.entries(raw ?? {}).filter(([key]) => !OUTPUT_ONLY.has(key)))

// Pairs each edited value with the raw entry that held the same value, so unknown keys are kept.
function mergeEntries(fields: ContactField[] | undefined, raw: unknown, rawValue: (entry: Raw) => string | undefined, normalize: (value: string) => string, build: (field: ContactField, previous: Raw) => Raw) {
  const previous = Array.isArray(raw) ? raw as Raw[] : []
  const used = new Set<number>()
  return (fields ?? []).map((field) => {
    const index = previous.findIndex((entry, position) => !used.has(position) && normalize(rawValue(entry) ?? '') === normalize(field.value))
    if (index >= 0) used.add(index)
    return build(field, index >= 0 ? writable(previous[index]) : {})
  })
}

const typeKey = (field: ContactField) => field.type ? { type: field.type } : {}

function googleBirthdayBody(birthday: string | undefined, raw: unknown) {
  if (!birthday) return []
  const previous = Array.isArray(raw) ? raw[0] as { date?: GoogleDate; text?: string } | undefined : undefined
  if (previous && googleBirthday(previous) === birthday) return [writable(previous as Raw)]
  if (!isContactBirthday(birthday)) return [{ text: birthday }]
  const digits = birthday.replace(/-/g, '')
  const date: GoogleDate = digits.length === 8 ? { year: Number(digits.slice(0, 4)), month: Number(digits.slice(4, 6)), day: Number(digits.slice(6, 8)) } : { month: Number(digits.slice(0, 2)), day: Number(digits.slice(2, 4)) }
  return [{ date }]
}

function googleNames(contact: Contact, raw: unknown, previousName?: string) {
  const previous = Array.isArray(raw) ? raw[0] as Raw | undefined : undefined
  if (previous && previousName !== undefined && previousName.trim() === contact.name.trim()) return [writable(previous)]
  const parts = contact.nameParts?.some(Boolean) && previousName === contact.name ? contact.nameParts : undefined
  if (parts) return [{ ...writable(previous), familyName: parts[0] || undefined, givenName: parts[1] || undefined, middleName: parts[2] || undefined, honorificPrefix: parts[3] || undefined, honorificSuffix: parts[4] || undefined }]
  const words = contact.name.trim().split(/\s+/)
  const familyName = words.length > 1 ? words.pop() : undefined
  return [{ givenName: words.join(' ') || contact.name.trim(), familyName }]
}

// `current` is the stored synchronized contact (with its raw provider values); absent on create.
export function googleRichContactBody(contact: Contact, current?: SyncedContact) {
  const raw = current?.providerData ?? {}
  const organizations = Array.isArray(raw.organizations) ? raw.organizations as Raw[] : []
  const biographies = Array.isArray(raw.biographies) ? raw.biographies as Raw[] : []
  const emails = contact.emails?.length ? contact.emails : contact.email ? [{ value: contact.email }] : []
  const phones = contact.phones?.length ? contact.phones : contact.phone ? [{ value: contact.phone }] : []
  const nickname = contact.nickname?.trim()
  return {
    ...(current?.revision ? { metadata: { sources: [{ type: 'CONTACT', id: current.remoteId.split('/').at(-1), etag: current.revision }] } } : {}),
    names: googleNames(contact, raw.names, current?.name),
    nicknames: nickname ? mergeEntries([{ value: nickname }], raw.nicknames, (entry) => entry.value as string, (value) => value.trim(), (field, previous) => ({ ...previous, value: field.value })).slice(0, 1) : [],
    emailAddresses: mergeEntries(emails, raw.emailAddresses, (entry) => entry.value as string, normalizedContactEmail, (field, previous) => ({ ...previous, value: field.value, ...typeKey(field) })),
    phoneNumbers: mergeEntries(phones, raw.phoneNumbers, (entry) => entry.value as string, normalizedContactPhone, (field, previous) => ({ ...previous, value: field.value, ...typeKey(field) })),
    addresses: mergeEntries(contact.addresses, raw.addresses, (entry) => (entry.formattedValue as string | undefined)?.replace(/\s*\n\s*/g, ', ') ?? formatAddressParts([entry.poBox, entry.extendedAddress, entry.streetAddress, entry.city, entry.region, entry.postalCode, entry.country].map((part) => String(part ?? ''))), (value) => value.toLowerCase().replace(/\s+/g, ' '), (field, previous) => {
      if (field.parts?.some(Boolean)) {
        const [poBox, extendedAddress, streetAddress, city, region, postalCode, country] = field.parts
        // Structured parts win; Google recomposes the formatted value from them.
        return { ...previous, formattedValue: undefined, poBox, extendedAddress, streetAddress, city, region, postalCode, country, ...typeKey(field) }
      }
      return Object.keys(previous).length ? { ...previous, ...typeKey(field) } : { formattedValue: field.value, ...typeKey(field) }
    }),
    birthdays: googleBirthdayBody(contact.birthday, raw.birthdays),
    urls: mergeEntries(contact.urls, raw.urls, (entry) => entry.value as string, (value) => value.trim().toLowerCase(), (field, previous) => ({ ...previous, value: field.value, ...typeKey(field) })),
    organizations: contact.company || contact.title
      ? [{ ...writable(organizations[0]), name: contact.company, title: contact.title }, ...organizations.slice(1).map(writable)]
      : organizations.slice(1).map(writable),
    biographies: contact.notes ? [{ contentType: 'TEXT_PLAIN', ...writable(biographies[0]), value: contact.notes }] : []
  }
}

// The People API takes raw base64 bytes for photos.
export const googlePhotoBytes = (photo: string | undefined) => isContactPhoto(photo) ? photo.slice(photo.indexOf(',') + 1) : undefined

const PHOTO_FETCH_LIMIT = 300
const PHOTO_MAX_BYTES = 160_000

// Google serves contact photos from googleusercontent.com, which the renderer's CSP does not load,
// so thumbnails are fetched here and cached as data: URLs. Unchanged URLs reuse the cached image.
export async function attachGooglePhotos(contacts: SyncedContact[], previous: SyncedContact[], fetcher: typeof fetch = fetch) {
  const cached = new Map(previous.flatMap((contact) => contact.photo && typeof contact.providerData?.photoUrl === 'string' ? [[contact.providerData.photoUrl, contact.photo] as const] : []))
  let fetched = 0
  for (const contact of contacts) {
    const url = contact.providerData?.photoUrl
    if (typeof url !== 'string' || !/^https:\/\/[a-z0-9.-]+\.googleusercontent\.com\//i.test(url)) continue
    const known = cached.get(url)
    if (known) {
      contact.photo = known
      continue
    }
    if (fetched >= PHOTO_FETCH_LIMIT) continue
    fetched += 1
    try {
      const response = await fetcher(url.replace(/=s\d+(?:-[a-z]+)?$/i, '') + '=s128')
      const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
      if (!response.ok || !type || !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(type)) continue
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.byteLength > PHOTO_MAX_BYTES) continue
      const photo = `data:${type};base64,${bytes.toString('base64')}`
      if (isContactPhoto(photo)) contact.photo = photo
    } catch {
      // Photos are best effort; the contact still synchronizes without one.
    }
  }
  return contacts
}
