import { EwsError, type EwsClient } from './ews-client'
import { m, t, text, ts, tText, xmlText, type EwsResponseMessage, type XmlElement } from './ews-xml'

// Directory operations over the shared EWS client (E41): ResolveNames against Active Directory
// with full contact data, ExpandDL for distribution groups, GetRoomLists/GetRooms for room
// resources, and FindPeople on the directory for a paged global address list. Each helper is a
// thin wrapper over EwsClient.call() that returns parsed values; item-level failures become
// EwsError with the EWS ResponseCode.

export interface EwsDirectoryMailbox {
  name: string
  email: string
  routingType?: string
  /** Mailbox, PublicDL, PrivateDL, Contact, GroupMailbox, PublicFolder, ... */
  mailboxType?: string
}

export interface EwsDirectoryContact {
  displayName?: string
  jobTitle?: string
  department?: string
  company?: string
  office?: string
  businessPhone?: string
  mobilePhone?: string
}

export interface EwsResolution {
  mailbox: EwsDirectoryMailbox
  contact?: EwsDirectoryContact
}

export interface EwsPersona {
  id: string
  /** Person, DistributionList, Room, ... as reported by the server. */
  personaType?: string
  displayName: string
  email?: string
  mailboxType?: string
  title?: string
  department?: string
  company?: string
  office?: string
}

/** Most EWS answers are plain text inside types-namespace elements. */
function mailbox(element: XmlElement | undefined): EwsDirectoryMailbox | undefined {
  const email = tText(element, 'EmailAddress')?.trim()
  if (!email) return undefined
  return {
    name: tText(element, 'Name')?.trim() || email,
    email,
    ...(tText(element, 'RoutingType') ? { routingType: tText(element, 'RoutingType') } : {}),
    ...(tText(element, 'MailboxType') ? { mailboxType: tText(element, 'MailboxType') } : {})
  }
}

function phone(contact: XmlElement | undefined, key: string) {
  return ts(t(contact, 'PhoneNumbers'), 'Entry').find((entry) => entry.attributes.Key === key)
}

function contactData(element: XmlElement | undefined): EwsDirectoryContact | undefined {
  if (!element) return undefined
  const business = text(phone(element, 'BusinessPhone'))?.trim()
  const mobile = text(phone(element, 'MobilePhone'))?.trim()
  return {
    ...(tText(element, 'DisplayName') ? { displayName: tText(element, 'DisplayName') } : {}),
    ...(tText(element, 'JobTitle') ? { jobTitle: tText(element, 'JobTitle') } : {}),
    ...(tText(element, 'Department') ? { department: tText(element, 'Department') } : {}),
    ...(tText(element, 'CompanyName') ? { company: tText(element, 'CompanyName') } : {}),
    ...(tText(element, 'OfficeLocation') ? { office: tText(element, 'OfficeLocation') } : {}),
    ...(business ? { businessPhone: business } : {}),
    ...(mobile ? { mobilePhone: mobile } : {})
  }
}

const failure = (message: EwsResponseMessage | undefined, operation: string) =>
  new EwsError(message?.message ?? `${operation} failed (${message?.code ?? 'no response'})`, message?.code ?? 'ErrorInternalServerError')

export interface ResolveNamesResult {
  resolutions: EwsResolution[]
  /** The server reported several matches (ErrorNameResolutionMultipleResults). */
  ambiguous: boolean
  includesLastItemInRange: boolean
}

/**
 * ResolveNames in Active Directory with the directory contact (title, department, phones).
 * No match is an empty result, not an error.
 */
export async function resolveNames(client: EwsClient, entry: string): Promise<ResolveNamesResult> {
  const body = `<m:ResolveNames ReturnFullContactData="true" SearchScope="ActiveDirectory" ContactDataShape="AllProperties"><m:UnresolvedEntry>${xmlText(entry)}</m:UnresolvedEntry></m:ResolveNames>`
  const [message] = await client.call('ResolveNames', body)
  if (!message) throw failure(message, 'ResolveNames')
  if (message.code === 'ErrorNameResolutionNoResults') return { resolutions: [], ambiguous: false, includesLastItemInRange: true }
  if (message.responseClass === 'Error') throw failure(message, 'ResolveNames')
  const set = m(message.element, 'ResolutionSet')
  const resolutions: EwsResolution[] = []
  for (const resolution of ts(set, 'Resolution')) {
    const value = mailbox(t(resolution, 'Mailbox'))
    if (!value) continue
    const contact = contactData(t(resolution, 'Contact'))
    resolutions.push({ mailbox: value, ...(contact ? { contact } : {}) })
  }
  return {
    resolutions,
    ambiguous: message.code === 'ErrorNameResolutionMultipleResults' || resolutions.length > 1,
    includesLastItemInRange: set?.attributes.IncludesLastItemInRange !== 'false'
  }
}

/** ExpandDL: the members of a distribution group (nested groups are returned, not expanded). */
export async function expandDistributionList(client: EwsClient, email: string) {
  const [message] = await client.call('ExpandDL', `<m:ExpandDL><m:Mailbox><t:EmailAddress>${xmlText(email)}</t:EmailAddress></m:Mailbox></m:ExpandDL>`)
  if (!message || message.responseClass === 'Error') throw failure(message, 'ExpandDL')
  const expansion = m(message.element, 'DLExpansion')
  return {
    members: ts(expansion, 'Mailbox').map(mailbox).filter((value): value is EwsDirectoryMailbox => Boolean(value)),
    includesLastItemInRange: expansion?.attributes.IncludesLastItemInRange !== 'false'
  }
}

/** GetRoomLists: the organization's room lists (distribution groups of rooms). */
export async function getRoomLists(client: EwsClient) {
  const [message] = await client.call('GetRoomLists', '<m:GetRoomLists/>')
  if (!message || message.responseClass === 'Error') throw failure(message, 'GetRoomLists')
  return ts(m(message.element, 'RoomLists'), 'Address').map(mailbox).filter((value): value is EwsDirectoryMailbox => Boolean(value))
}

/** GetRooms: the rooms in one room list. */
export async function getRooms(client: EwsClient, roomListEmail: string) {
  const [message] = await client.call('GetRooms', `<m:GetRooms><m:RoomList><t:EmailAddress>${xmlText(roomListEmail)}</t:EmailAddress></m:RoomList></m:GetRooms>`)
  if (!message) throw failure(message, 'GetRooms')
  // An empty room list answers ErrorNameResolutionNoResults on some builds.
  if (message.code === 'ErrorNameResolutionNoResults') return []
  if (message.responseClass === 'Error') throw failure(message, 'GetRooms')
  return ts(m(message.element, 'Rooms'), 'Room').map((room) => mailbox(t(room, 'Id'))).filter((value): value is EwsDirectoryMailbox => Boolean(value))
}

/** All rooms across the room lists; duplicates (a room in two lists) are removed. */
export async function listRooms(client: EwsClient) {
  const rooms = new Map<string, EwsDirectoryMailbox>()
  for (const list of await getRoomLists(client)) {
    for (const room of await getRooms(client, list.email)) rooms.set(room.email.toLowerCase(), room)
  }
  return [...rooms.values()]
}

const PERSONA_PROPERTIES = ['persona:DisplayName', 'persona:EmailAddress', 'persona:PersonaType', 'persona:Title', 'persona:Department', 'persona:CompanyName']

function persona(element: XmlElement): EwsPersona | undefined {
  const id = t(element, 'PersonaId')?.attributes.Id
  const address = mailbox(t(element, 'EmailAddress'))
  const displayName = tText(element, 'DisplayName')?.trim() || address?.name
  if (!id || !displayName) return undefined
  const office = tText(element, 'OfficeLocation') ?? text(t(t(t(element, 'OfficeLocations'), 'StringAttributedValue'), 'Value'))
  return {
    id,
    displayName,
    ...(tText(element, 'PersonaType') ? { personaType: tText(element, 'PersonaType') } : {}),
    ...(address ? { email: address.email, ...(address.mailboxType ? { mailboxType: address.mailboxType } : {}) } : {}),
    ...(tText(element, 'Title') ? { title: tText(element, 'Title') } : {}),
    ...(tText(element, 'Department') ? { department: tText(element, 'Department') } : {}),
    ...(tText(element, 'CompanyName') ? { company: tText(element, 'CompanyName') } : {}),
    ...(office?.trim() ? { office: office.trim() } : {})
  }
}

export interface FindPeoplePage {
  personas: EwsPersona[]
  total?: number
}

/**
 * FindPeople on the directory (the global address list) with indexed paging. Some servers
 * require a query string for directory searches; they answer with an error that callers treat
 * as "no full listing available".
 */
export async function findPeople(client: EwsClient, options: { offset: number; max: number; query?: string }): Promise<FindPeoplePage> {
  const body = '<m:FindPeople>' +
    `<m:PersonaShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties>${PERSONA_PROPERTIES.map((uri) => `<t:FieldURI FieldURI="${uri}"/>`).join('')}</t:AdditionalProperties></m:PersonaShape>` +
    `<m:IndexedPageItemView BasePoint="Beginning" MaxEntriesReturned="${options.max}" Offset="${options.offset}"/>` +
    '<m:ParentFolderId><t:DistinguishedFolderId Id="directory"/></m:ParentFolderId>' +
    (options.query ? `<m:QueryString>${xmlText(options.query)}</m:QueryString>` : '') +
    '</m:FindPeople>'
  const [message] = await client.call('FindPeople', body)
  if (!message || message.responseClass === 'Error') throw failure(message, 'FindPeople')
  const totalText = text(m(message.element, 'TotalNumberOfPeopleInView'))
  const total = Number(totalText)
  return {
    personas: ts(m(message.element, 'People'), 'Persona').map(persona).filter((value): value is EwsPersona => Boolean(value)),
    ...(totalText && Number.isFinite(total) ? { total } : {})
  }
}

