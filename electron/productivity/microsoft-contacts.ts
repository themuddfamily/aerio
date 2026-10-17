// Rich Microsoft Graph contact mapping. Graph stores typed values in fixed slots (up to three email
// addresses, a mobile phone, home and business phone lists, and home/business/other postal
// addresses), so every slot is read and written; values that do not fit a slot are reported by
// `microsoftContactOverflow` instead of being silently dropped. Graph has no API for Outlook contact
// groups (distribution lists) on personal contacts, so categories act as groups. Contact photos use a
// separate binary endpoint and are not synchronized. A PATCH only changes the properties it sends.
import type { Contact, ContactField } from '../../src/types'
import type { SyncedContact } from '../../src/productivity-types'
import { formatAddressParts, isContactBirthday, normalizedContactEmail, contactGroupNames } from '../../src/lib/contact-fields'
import { mapMicrosoftContact } from './microsoft-connector'

interface PhysicalAddress { street?: string; city?: string; state?: string; postalCode?: string; countryOrRegion?: string }
export interface GraphRichContact {
  id: string
  '@removed'?: { reason?: string }
  changeKey?: string
  parentFolderId?: string
  displayName?: string
  givenName?: string
  surname?: string
  middleName?: string
  title?: string
  generation?: string
  nickName?: string
  emailAddresses?: { address?: string; name?: string }[]
  businessPhones?: string[]
  homePhones?: string[]
  mobilePhone?: string
  homeAddress?: PhysicalAddress
  businessAddress?: PhysicalAddress
  otherAddress?: PhysicalAddress
  birthday?: string
  businessHomePage?: string
  companyName?: string
  jobTitle?: string
  personalNotes?: string
  categories?: string[]
}

export const microsoftRichContactSelect = 'id,changeKey,parentFolderId,displayName,givenName,surname,middleName,title,generation,nickName,emailAddresses,businessPhones,homePhones,mobilePhone,homeAddress,businessAddress,otherAddress,birthday,businessHomePage,companyName,jobTitle,personalNotes,categories'
export const MICROSOFT_EMAIL_SLOTS = 3
const ADDRESS_SLOTS = [['homeAddress', 'home'], ['businessAddress', 'work'], ['otherAddress', 'other']] as const

const addressParts = (address?: PhysicalAddress) => ['', '', address?.street ?? '', address?.city ?? '', address?.state ?? '', address?.postalCode ?? '', address?.countryOrRegion ?? '']

export function mapMicrosoftRichContact(accountId: string, contact: GraphRichContact, readOnly = false): SyncedContact | undefined {
  const base = mapMicrosoftContact(accountId, contact, readOnly)
  if (!base) return
  const emails: ContactField[] = (contact.emailAddresses ?? []).flatMap((item) => item.address?.trim() ? [{ value: item.address.trim() }] : [])
  const phones: ContactField[] = [
    ...(contact.mobilePhone?.trim() ? [{ value: contact.mobilePhone.trim(), type: 'mobile' }] : []),
    ...(contact.homePhones ?? []).flatMap((value) => value.trim() ? [{ value: value.trim(), type: 'home' }] : []),
    ...(contact.businessPhones ?? []).flatMap((value) => value.trim() ? [{ value: value.trim(), type: 'work' }] : [])
  ]
  const addresses: ContactField[] = ADDRESS_SLOTS.flatMap(([key, type]) => {
    const parts = addressParts(contact[key])
    const value = formatAddressParts(parts)
    return value ? [{ value, type, parts }] : []
  })
  const urls: ContactField[] = contact.businessHomePage?.trim() ? [{ value: contact.businessHomePage.trim(), type: 'work' }] : []
  const groups = (contact.categories ?? []).map((category) => category.trim()).filter(Boolean).slice(0, 100)
  const birthday = contact.birthday?.slice(0, 10)
  const nameParts = [contact.surname, contact.givenName, contact.middleName, contact.title, contact.generation].map((part) => part ?? '')
  const providerData: Record<string, unknown> = {}
  if (contact.emailAddresses?.length) providerData.emailAddresses = contact.emailAddresses
  return {
    ...base,
    ...(emails.length ? { emails } : {}),
    ...(phones.length ? { phones } : {}),
    ...(addresses.length ? { addresses } : {}),
    ...(urls.length ? { urls } : {}),
    ...(groups.length ? { groups } : {}),
    ...(nameParts.some(Boolean) ? { nameParts } : {}),
    ...(contact.nickName?.trim() ? { nickname: contact.nickName.trim().slice(0, 500) } : {}),
    ...(birthday && isContactBirthday(birthday) ? { birthday } : {}),
    providerData
  }
}

const graphAddress = (field: ContactField | undefined): PhysicalAddress => {
  if (!field) return {}
  const parts = field.parts?.some(Boolean) ? field.parts : undefined
  if (!parts) return { street: field.value }
  return { street: [parts[0], parts[1], parts[2]].filter(Boolean).join('\n'), city: parts[3], state: parts[4], postalCode: parts[5], countryOrRegion: parts[6] }
}

const slotOf = (type: string | undefined) => {
  const label = type?.toLowerCase() ?? ''
  return /cell|mobile/.test(label) ? 'mobile' : /home/.test(label) ? 'home' : /work|business/.test(label) ? 'work' : 'other'
}

// Values the editor holds that Graph has no slot for (shown as a warning before saving).
export function microsoftContactOverflow(contact: Contact) {
  const emails = Math.max(0, (contact.emails?.length ?? (contact.email ? 1 : 0)) - MICROSOFT_EMAIL_SLOTS)
  const mobiles = (contact.phones ?? []).filter((field) => slotOf(field.type) === 'mobile').length
  const addresses = ADDRESS_SLOTS.reduce((total, [, type]) => total + Math.max(0, (contact.addresses ?? []).filter((field) => (slotOf(field.type) === 'mobile' ? 'other' : slotOf(field.type)) === type).length - 1), 0)
  const urls = Math.max(0, (contact.urls?.length ?? 0) - 1)
  return { emails, phones: Math.max(0, mobiles - 1), addresses, urls }
}

// `current` carries the raw values of the stored contact so email display names are preserved.
export function microsoftRichContactBody(contact: Contact, current?: SyncedContact) {
  const nameUnchanged = current?.name === contact.name && contact.nameParts?.some(Boolean)
  const words = contact.name.trim().split(/\s+/)
  const surname = words.length > 1 ? words.pop() : undefined
  const parts = nameUnchanged ? contact.nameParts! : undefined
  const rawEmails = Array.isArray(current?.providerData?.emailAddresses) ? current.providerData.emailAddresses as { address?: string; name?: string }[] : []
  const emails = contact.emails?.length ? contact.emails : contact.email ? [{ value: contact.email }] : []
  const phones = contact.phones?.length ? contact.phones : contact.phone ? [{ value: contact.phone, type: 'work' }] : []
  const mobile = phones.filter((field) => slotOf(field.type) === 'mobile')
  const addresses = contact.addresses ?? []
  const addressFor = (type: 'home' | 'work' | 'other') => addresses.find((field) => {
    const slot = slotOf(field.type)
    return (slot === 'mobile' ? 'other' : slot) === type
  })
  const birthday = contact.birthday && /^\d{4}-?\d{2}-?\d{2}$/.test(contact.birthday) && isContactBirthday(contact.birthday)
    ? `${contact.birthday.replace(/^(\d{4})-?(\d{2})-?(\d{2})$/, '$1-$2-$3')}T11:59:00Z`
    : undefined
  const categories = contactGroupNames(contact).filter((group) => group !== 'Outlook')
  return {
    displayName: contact.name,
    givenName: parts ? parts[1] : words.join(' ') || contact.name.trim(),
    surname: parts ? parts[0] : surname,
    ...(parts ? { middleName: parts[2], title: parts[3], generation: parts[4] } : {}),
    nickName: contact.nickname ?? '',
    emailAddresses: emails.slice(0, MICROSOFT_EMAIL_SLOTS).map((field) => {
      const raw = rawEmails.find((entry) => normalizedContactEmail(entry.address ?? '') === normalizedContactEmail(field.value))
      return { address: field.value, name: raw?.name ?? contact.name }
    }),
    mobilePhone: mobile[0]?.value ?? '',
    homePhones: phones.filter((field) => slotOf(field.type) === 'home').map((field) => field.value),
    // Additional mobile numbers and untyped numbers fall back to the business list.
    businessPhones: [...mobile.slice(1), ...phones.filter((field) => slotOf(field.type) === 'work' || slotOf(field.type) === 'other')].map((field) => field.value),
    homeAddress: graphAddress(addressFor('home')),
    businessAddress: graphAddress(addressFor('work')),
    otherAddress: graphAddress(addressFor('other')),
    // Graph cannot store a year-less birthday; leave an existing value untouched in that case.
    ...(birthday ? { birthday } : contact.birthday ? {} : { birthday: null }),
    businessHomePage: contact.urls?.[0]?.value ?? '',
    companyName: contact.company ?? '',
    jobTitle: contact.title ?? '',
    personalNotes: contact.notes ?? '',
    categories
  }
}
