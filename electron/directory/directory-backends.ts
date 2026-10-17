import type { DirectoryBackendId, DirectoryEntry, DirectoryEntryKind } from '../../src/directory-types'
import type { EwsClient } from '../exchange/ews-client'
import { EwsError } from '../exchange/ews-client'
import { expandDistributionList, findPeople, listRooms, resolveNames, type EwsDirectoryMailbox, type EwsPersona } from '../exchange/ews-directory'

// Read-only organization directory backends (E41): Microsoft Graph, the Google Workspace
// directory (People API), and on-premises Exchange (EWS). Every backend searches, expands groups
// where the server can, and lists the directory for the offline address book. Nothing here writes
// to a directory.

export const MAX_GROUP_MEMBERS = 500
/** Safety bounds for a full listing (offline address book). */
export const MAX_LISTING_ENTRIES = 100_000
const REQUEST_TIMEOUT_MS = 20_000

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** The provider refused the request for lack of permission, or an administrator denied consent. */
export class DirectoryPermissionError extends Error {
  constructor(message: string, readonly denied: boolean, readonly scopes: string[] = []) {
    super(message)
    this.name = 'DirectoryPermissionError'
  }
}

/** The account has no organization directory (consumer Gmail, IMAP). */
export class DirectoryUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DirectoryUnavailableError'
  }
}

/** Network failures and 5xx/429 answers: the offline cache is used instead. */
export class DirectoryServiceError extends Error {
  constructor(message: string, readonly transient: boolean) {
    super(message)
    this.name = 'DirectoryServiceError'
  }
}

export interface DirectoryBackend {
  readonly id: DirectoryBackendId
  search(query: string, kinds: DirectoryEntryKind[], limit: number): Promise<DirectoryEntry[]>
  expandGroup(groupEmail: string): Promise<{ members: DirectoryEntry[]; truncated: boolean }>
  /**
   * Lists the directory page by page into `sink`. 'incremental' means the server offers no full
   * listing (only rooms were listed); the cache then also keeps entries learned from lookups.
   */
  list(sink: (entries: DirectoryEntry[]) => void): Promise<'full' | 'incremental'>
}

const entryId = (accountId: string, value: string) => `${accountId}:${value}`
const usable = (email: string | undefined | null): email is string => typeof email === 'string' && /^[^\s@]+@[^\s@]+$/.test(email.trim())

/** Merges entries for the same address; the first non-empty value of each field wins. */
export function mergeEntries(entries: DirectoryEntry[]) {
  const byEmail = new Map<string, DirectoryEntry>()
  for (const entry of entries) {
    const key = entry.email.toLowerCase()
    const current = byEmail.get(key)
    if (!current) { byEmail.set(key, { ...entry }); continue }
    for (const [field, value] of Object.entries(entry) as [keyof DirectoryEntry, unknown][]) {
      if (value !== undefined && value !== '' && (current[field] === undefined || current[field] === '')) (current as unknown as Record<string, unknown>)[field] = value
    }
    // A group or room classification is more specific than "person".
    if (current.kind === 'person' && entry.kind !== 'person') current.kind = entry.kind
    if (entry.expandable) current.expandable = true
  }
  return [...byEmail.values()]
}

const matches = (query: string, ...values: (string | undefined)[]) => {
  const haystack = values.filter(Boolean).join(' ').toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word))
}

async function timedFetch(fetchImpl: FetchLike, url: string, init: RequestInit) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } catch (error) {
    throw new DirectoryServiceError(error instanceof Error && error.name === 'AbortError' ? 'The directory did not answer in time' : 'The directory could not be reached', true)
  } finally {
    clearTimeout(timer)
  }
}

// --- Microsoft Graph ---------------------------------------------------------------------------

export const GRAPH_DIRECTORY_SCOPES = ['User.ReadBasic.All', 'People.Read']
export const GRAPH_RESOURCE_SCOPES = ['Place.Read.All', 'GroupMember.Read.All']
const GRAPH = 'https://graph.microsoft.com/v1.0'
const USER_SELECT = 'id,displayName,mail,userPrincipalName,jobTitle,department,companyName,officeLocation,businessPhones,mobilePhone'
const GROUP_SELECT = 'id,displayName,mail,description,mailEnabled'

export interface GraphDirectoryAccess {
  /** /users (User.ReadBasic.All or broader). */
  users: boolean
  /** /me/people (People.Read): ranked people and mail-enabled groups. */
  people: boolean
  /** /groups and group members (GroupMember.Read.All, Group.Read.All, Directory.Read.All). */
  groups: boolean
  /** /places rooms (Place.Read.All). */
  rooms: boolean
  /**
   * The grant's scope list is known. Graph answers a missing scope with the same 403
   * Authorization_RequestDenied as an administrator's refusal, so only a known grant that
   * includes the permission makes that answer a denial.
   */
  known?: boolean
}

interface GraphUser { id?: string; displayName?: string; mail?: string | null; userPrincipalName?: string; jobTitle?: string | null; department?: string | null; companyName?: string | null; officeLocation?: string | null; businessPhones?: string[]; mobilePhone?: string | null; '@odata.type'?: string }
interface GraphGroup { id?: string; displayName?: string; mail?: string | null; mailEnabled?: boolean; '@odata.type'?: string }
interface GraphRoom { id?: string; displayName?: string; emailAddress?: string; capacity?: number | null; building?: string | null; floorLabel?: string | null; '@odata.type'?: string }
interface GraphPerson {
  id?: string
  displayName?: string
  jobTitle?: string | null
  department?: string | null
  companyName?: string | null
  officeLocation?: string | null
  scoredEmailAddresses?: { address?: string }[]
  phones?: { type?: string; number?: string }[]
  personType?: { class?: string; subclass?: string }
}
interface GraphPage<T> { value?: T[]; '@odata.nextLink'?: string }

export const GRAPH_DENIED_MESSAGE = 'Your organization has not allowed Aerio to read the directory (Authorization_RequestDenied). An administrator must grant consent for User.ReadBasic.All and People.Read in Microsoft Entra ID (Enterprise applications › Aerio › Permissions), or allow users to consent to these permissions. Personal contacts and recent recipients keep working meanwhile.'
const GRAPH_MISSING_MESSAGE = 'Aerio needs permission to read your organization’s directory (User.ReadBasic.All, People.Read). Choose Allow directory access and approve it on Microsoft’s consent screen.'

export class GraphDirectoryBackend implements DirectoryBackend {
  readonly id = 'microsoft-graph' as const

  constructor(
    private readonly accountId: string,
    private readonly token: () => Promise<string>,
    private readonly access: GraphDirectoryAccess,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init)
  ) {}

  private async get<T>(url: string, eventual: boolean): Promise<T> {
    if (!url.startsWith(`${GRAPH}/`)) throw new DirectoryServiceError('Microsoft Graph returned an unexpected next-page address', false)
    const response = await timedFetch(this.fetchImpl, url, {
      headers: { Authorization: `Bearer ${await this.token()}`, Accept: 'application/json', ...(eventual ? { ConsistencyLevel: 'eventual' } : {}) }
    })
    if (response.ok) return await response.json() as T
    let code = ''
    let message = ''
    try {
      const body = await response.json() as { error?: { code?: string; message?: string } }
      code = body.error?.code ?? ''
      message = body.error?.message ?? ''
    } catch { /* Not JSON. */ }
    if (response.status === 401 || response.status === 403) {
      const denied = code === 'Authorization_RequestDenied' && this.access.known !== false
      throw new DirectoryPermissionError(denied ? GRAPH_DENIED_MESSAGE : GRAPH_MISSING_MESSAGE, denied, GRAPH_DIRECTORY_SCOPES)
    }
    const transient = response.status === 429 || response.status >= 500
    throw new DirectoryServiceError(`Microsoft Graph refused the directory request (${response.status}${code ? ` ${code}` : ''})${message ? `: ${message}` : ''}`, transient)
  }

  /** Follows @odata.nextLink until `max` items or the last page. */
  private async collect<T>(url: string, eventual: boolean, max: number, onPage?: (items: T[]) => void) {
    const items: T[] = []
    let next: string | undefined = url
    let count = 0
    while (next && count < max) {
      const page: GraphPage<T> = await this.get<GraphPage<T>>(next, eventual)
      const values = (page.value ?? []).slice(0, max - count)
      count += values.length
      if (onPage) onPage(values)
      else items.push(...values)
      next = page['@odata.nextLink']
    }
    return items
  }

  private user(user: GraphUser): DirectoryEntry | undefined {
    const email = user.mail ?? undefined
    if (!usable(email) || !user.id) return undefined
    const phone = user.businessPhones?.find(Boolean)
    return {
      id: entryId(this.accountId, user.id), accountId: this.accountId, backend: this.id, kind: 'person', name: user.displayName?.trim() || email, email,
      ...(user.jobTitle ? { title: user.jobTitle } : {}), ...(user.department ? { department: user.department } : {}),
      ...(user.companyName ? { company: user.companyName } : {}), ...(user.officeLocation ? { office: user.officeLocation } : {}),
      ...(phone ? { phone } : {}), ...(user.mobilePhone ? { mobile: user.mobilePhone } : {})
    }
  }

  private group(group: GraphGroup): DirectoryEntry | undefined {
    const email = group.mail ?? undefined
    if (!usable(email) || !group.id) return undefined
    return { id: entryId(this.accountId, group.id), accountId: this.accountId, backend: this.id, kind: 'group', name: group.displayName?.trim() || email, email, ...(this.access.groups ? { expandable: true } : {}) }
  }

  private room(room: GraphRoom): DirectoryEntry | undefined {
    if (!usable(room.emailAddress) || !room.id) return undefined
    return {
      id: entryId(this.accountId, room.id), accountId: this.accountId, backend: this.id, kind: 'room', name: room.displayName?.trim() || room.emailAddress, email: room.emailAddress,
      ...(typeof room.capacity === 'number' ? { capacity: room.capacity } : {}), ...(room.building ? { building: room.building } : {}),
      ...(room.floorLabel ? { office: room.floorLabel } : {})
    }
  }

  private person(person: GraphPerson): DirectoryEntry | undefined {
    const email = person.scoredEmailAddresses?.find((address) => usable(address.address))?.address
    if (!usable(email) || !person.id) return undefined
    const type = person.personType?.class?.toLowerCase()
    const subclass = person.personType?.subclass?.toLowerCase() ?? ''
    // Personal and implicit contacts are not directory entries; they are already in Contacts or suggestions.
    if (type === 'person' && subclass !== 'organizationuser' && subclass !== 'organizationcontact') return undefined
    const kind: DirectoryEntryKind = type === 'group' ? 'group' : 'person'
    const phone = person.phones?.find((item) => item.type === 'business')?.number
    const mobile = person.phones?.find((item) => item.type === 'mobile')?.number
    return {
      id: entryId(this.accountId, `people:${email.toLowerCase()}`), accountId: this.accountId, backend: this.id, kind, name: person.displayName?.trim() || email, email,
      ...(person.jobTitle ? { title: person.jobTitle } : {}), ...(person.department ? { department: person.department } : {}),
      ...(person.companyName ? { company: person.companyName } : {}), ...(person.officeLocation ? { office: person.officeLocation } : {}),
      ...(phone ? { phone } : {}), ...(mobile ? { mobile } : {}),
      ...(kind === 'group' && this.access.groups ? { expandable: true } : {})
    }
  }

  private async rooms() {
    return (await this.collect<GraphRoom>(`${GRAPH}/places/microsoft.graph.room?$top=100`, false, 5_000)).map((room) => this.room(room)).filter((entry): entry is DirectoryEntry => Boolean(entry))
  }

  async search(query: string, kinds: DirectoryEntryKind[], limit: number) {
    const term = query.replace(/["\\]/g, ' ').trim()
    if (!term) return []
    const top = Math.min(Math.max(limit, 1), 50)
    const wants = (kind: DirectoryEntryKind) => kinds.includes(kind)
    const search = encodeURIComponent(`"displayName:${term}" OR "mail:${term}"`)
    const tasks: Promise<DirectoryEntry[]>[] = []
    if (this.access.people && (wants('person') || wants('group'))) {
      tasks.push(this.get<GraphPage<GraphPerson>>(`${GRAPH}/me/people?$search=${encodeURIComponent(`"${term}"`)}&$top=${top}&$select=id,displayName,scoredEmailAddresses,jobTitle,department,companyName,officeLocation,phones,personType`, false)
        .then((page) => (page.value ?? []).map((person) => this.person(person)).filter((entry): entry is DirectoryEntry => Boolean(entry))))
    }
    if (this.access.users && wants('person')) {
      tasks.push(this.get<GraphPage<GraphUser>>(`${GRAPH}/users?$search=${search}&$select=${USER_SELECT}&$top=${top}&$count=true`, true)
        .then((page) => (page.value ?? []).map((user) => this.user(user)).filter((entry): entry is DirectoryEntry => Boolean(entry))))
    }
    if (this.access.groups && wants('group')) {
      tasks.push(this.get<GraphPage<GraphGroup>>(`${GRAPH}/groups?$search=${search}&$filter=${encodeURIComponent('mailEnabled eq true')}&$select=${GROUP_SELECT}&$top=${top}&$count=true`, true)
        .then((page) => (page.value ?? []).map((group) => this.group(group)).filter((entry): entry is DirectoryEntry => Boolean(entry))))
    }
    if (this.access.rooms && wants('room')) {
      // /places has no $search; rooms are listed (a bounded set) and filtered here.
      tasks.push(this.rooms().then((rooms) => rooms.filter((room) => matches(term, room.name, room.email, room.building, room.office))))
    }
    if (!tasks.length) throw new DirectoryPermissionError(GRAPH_MISSING_MESSAGE, false, GRAPH_DIRECTORY_SCOPES)
    const settled = await Promise.allSettled(tasks)
    const fulfilled = settled.filter((result): result is PromiseFulfilledResult<DirectoryEntry[]> => result.status === 'fulfilled')
    if (!fulfilled.length) throw (settled[0] as PromiseRejectedResult).reason
    return mergeEntries(fulfilled.flatMap((result) => result.value)).filter((entry) => kinds.includes(entry.kind)).slice(0, limit)
  }

  async expandGroup(groupEmail: string) {
    if (!this.access.groups) throw new DirectoryPermissionError('Listing group members needs the GroupMember.Read.All permission, which usually requires an administrator. Choose Allow rooms and groups, or insert the group address instead.', false, GRAPH_RESOURCE_SCOPES)
    const filter = encodeURIComponent(`mail eq '${groupEmail.replaceAll("'", "''")}'`)
    const groups = await this.get<GraphPage<GraphGroup>>(`${GRAPH}/groups?$filter=${filter}&$select=id`, false)
    const id = groups.value?.[0]?.id
    if (!id) throw new DirectoryServiceError('That group was not found in the directory', false)
    const raw = await this.collect<GraphUser & GraphGroup>(`${GRAPH}/groups/${encodeURIComponent(id)}/members?$select=${USER_SELECT},mailEnabled&$top=100`, false, MAX_GROUP_MEMBERS + 1)
    const members = raw.slice(0, MAX_GROUP_MEMBERS).map((member) => member['@odata.type'] === '#microsoft.graph.group' ? this.group(member) : this.user(member)).filter((entry): entry is DirectoryEntry => Boolean(entry))
    return { members, truncated: raw.length > MAX_GROUP_MEMBERS }
  }

  async list(sink: (entries: DirectoryEntry[]) => void) {
    if (!this.access.users) throw new DirectoryPermissionError(GRAPH_MISSING_MESSAGE, false, GRAPH_DIRECTORY_SCOPES)
    await this.collect<GraphUser>(`${GRAPH}/users?$select=${USER_SELECT}&$top=999`, false, MAX_LISTING_ENTRIES, (page) => sink(page.map((user) => this.user(user)).filter((entry): entry is DirectoryEntry => Boolean(entry))))
    if (this.access.groups) {
      await this.collect<GraphGroup>(`${GRAPH}/groups?$filter=${encodeURIComponent('mailEnabled eq true')}&$select=${GROUP_SELECT}&$top=999`, false, MAX_LISTING_ENTRIES, (page) => sink(page.map((group) => this.group(group)).filter((entry): entry is DirectoryEntry => Boolean(entry))))
    }
    if (this.access.rooms) sink(await this.rooms())
    return 'full' as const
  }
}

// --- Google Workspace directory (People API) ---------------------------------------------------

export const GOOGLE_DIRECTORY_SCOPE = 'https://www.googleapis.com/auth/directory.readonly'
const PEOPLE = 'https://people.googleapis.com/v1'
const READ_MASK = 'names,emailAddresses,organizations,phoneNumbers,locations'
const SOURCES = ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE', 'DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT']
export const GOOGLE_NO_DIRECTORY_MESSAGE = 'This Google account has no organization directory. Directory lookup needs a Google Workspace account; personal Gmail accounts use Contacts and recent recipients only.'
const GOOGLE_MISSING_MESSAGE = 'Aerio needs permission to see your organization’s directory (directory.readonly). Choose Allow directory access and approve it on Google’s consent screen.'
const GOOGLE_DENIED_MESSAGE = 'Your Google Workspace administrator does not allow directory lookups for this account (contact sharing is turned off or the directory scope is blocked). Personal contacts and recent recipients keep working.'
const CONSUMER_GOOGLE_DOMAINS = new Set(['gmail.com', 'googlemail.com'])

export const isConsumerGoogleAccount = (email: string) => CONSUMER_GOOGLE_DOMAINS.has(email.split('@').at(-1)?.toLowerCase() ?? '')
// Microsoft personal accounts (Outlook.com) have no organization directory.
const CONSUMER_MICROSOFT_DOMAINS = new Set(['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'passport.com', 'outlook.co.uk', 'hotmail.co.uk', 'live.co.uk'])
export const isConsumerMicrosoftAccount = (email: string) => CONSUMER_MICROSOFT_DOMAINS.has(email.split('@').at(-1)?.toLowerCase() ?? '')
export const MICROSOFT_NO_DIRECTORY_MESSAGE = 'Outlook.com and other personal Microsoft accounts have no organization directory. Directory lookup needs a work or school (Microsoft 365) account.'

interface GooglePerson {
  resourceName?: string
  names?: { displayName?: string; metadata?: { primary?: boolean } }[]
  emailAddresses?: { value?: string; metadata?: { primary?: boolean } }[]
  organizations?: { name?: string; title?: string; department?: string; metadata?: { primary?: boolean } }[]
  phoneNumbers?: { value?: string; type?: string; metadata?: { primary?: boolean } }[]
  locations?: { value?: string; type?: string; buildingId?: string; metadata?: { primary?: boolean } }[]
}
interface GoogleDirectoryPage { people?: GooglePerson[]; nextPageToken?: string }

const primary = <T extends { metadata?: { primary?: boolean } }>(values: T[] | undefined) => values?.find((value) => value.metadata?.primary) ?? values?.[0]

export class GoogleDirectoryBackend implements DirectoryBackend {
  readonly id = 'google-workspace' as const

  constructor(
    private readonly accountId: string,
    private readonly token: () => Promise<string>,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init)
  ) {}

  private async get(path: string, params: Record<string, string | number | undefined>): Promise<GoogleDirectoryPage> {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value))
    for (const source of SOURCES) search.append('sources', source)
    const response = await timedFetch(this.fetchImpl, `${PEOPLE}/${path}?${search}`, { headers: { Authorization: `Bearer ${await this.token()}`, Accept: 'application/json' } })
    if (response.ok) return await response.json() as GoogleDirectoryPage
    let status = ''
    let message = ''
    try {
      const body = await response.json() as { error?: { status?: string; message?: string } }
      status = body.error?.status ?? ''
      message = body.error?.message ?? ''
    } catch { /* Not JSON. */ }
    if (response.status === 400 && (status === 'FAILED_PRECONDITION' || /domain|g suite|workspace/i.test(message))) throw new DirectoryUnavailableError(GOOGLE_NO_DIRECTORY_MESSAGE)
    if (response.status === 401 || response.status === 403) {
      if (/rate ?limit|quota/i.test(message)) throw new DirectoryServiceError('Google is limiting directory requests; try again shortly', true)
      const missingScope = /insufficient|scope/i.test(message) || status === 'UNAUTHENTICATED'
      throw new DirectoryPermissionError(missingScope ? GOOGLE_MISSING_MESSAGE : GOOGLE_DENIED_MESSAGE, !missingScope, [GOOGLE_DIRECTORY_SCOPE])
    }
    throw new DirectoryServiceError(`Google refused the directory request (${response.status}${status ? ` ${status}` : ''})`, response.status === 429 || response.status >= 500)
  }

  private entry(person: GooglePerson): DirectoryEntry | undefined {
    const email = primary(person.emailAddresses)?.value
    if (!usable(email) || !person.resourceName) return undefined
    const organization = primary(person.organizations)
    const phone = person.phoneNumbers?.find((item) => item.type === 'work')?.value ?? primary(person.phoneNumbers)?.value
    const mobile = person.phoneNumbers?.find((item) => item.type === 'mobile')?.value
    const location = person.locations?.find((item) => item.type === 'desk') ?? primary(person.locations)
    return {
      id: entryId(this.accountId, person.resourceName), accountId: this.accountId, backend: this.id, kind: 'person',
      name: primary(person.names)?.displayName?.trim() || email, email,
      ...(organization?.title ? { title: organization.title } : {}), ...(organization?.department ? { department: organization.department } : {}),
      ...(organization?.name ? { company: organization.name } : {}), ...(location?.value ? { office: location.value } : {}),
      ...(location?.buildingId ? { building: location.buildingId } : {}),
      ...(phone ? { phone } : {}), ...(mobile && mobile !== phone ? { mobile } : {})
    }
  }

  async search(query: string, kinds: DirectoryEntryKind[], limit: number) {
    // The Workspace directory API lists people and shared domain contacts, not groups or resources.
    if (!kinds.includes('person') || !query.trim()) return []
    const page = await this.get('people:searchDirectoryPeople', { query: query.trim(), readMask: READ_MASK, pageSize: Math.min(Math.max(limit, 1), 100) })
    return mergeEntries((page.people ?? []).map((person) => this.entry(person)).filter((entry): entry is DirectoryEntry => Boolean(entry))).slice(0, limit)
  }

  async expandGroup(): Promise<{ members: DirectoryEntry[]; truncated: boolean }> {
    throw new DirectoryServiceError('Google Workspace does not let Aerio list group members; insert the group address instead.', false)
  }

  async list(sink: (entries: DirectoryEntry[]) => void) {
    let pageToken: string | undefined
    let total = 0
    do {
      const page = await this.get('people:listDirectoryPeople', { readMask: READ_MASK, pageSize: 1_000, pageToken })
      const entries = (page.people ?? []).map((person) => this.entry(person)).filter((entry): entry is DirectoryEntry => Boolean(entry))
      total += entries.length
      sink(entries)
      pageToken = page.nextPageToken
    } while (pageToken && total < MAX_LISTING_ENTRIES)
    return 'full' as const
  }
}

// --- Exchange Server (EWS) ---------------------------------------------------------------------

const GROUP_MAILBOX_TYPES = new Set(['publicdl', 'privatedl', 'groupmailbox'])
const GROUP_PERSONA_TYPES = new Set(['distributionlist', 'moderngroup', 'unifiedgroup'])
const ROOM_CACHE_MS = 60 * 60_000
const FIND_PEOPLE_PAGE = 100

/** Room addresses per account, refreshed hourly; room lists change rarely. */
export class EwsRoomCache {
  private readonly cache = new Map<string, { at: number; rooms: EwsDirectoryMailbox[] }>()
  constructor(private readonly now: () => number = Date.now) {}
  async rooms(accountId: string, client: EwsClient) {
    const cached = this.cache.get(accountId)
    if (cached && this.now() - cached.at < ROOM_CACHE_MS) return cached.rooms
    const rooms = await listRooms(client)
    this.cache.set(accountId, { at: this.now(), rooms })
    return rooms
  }
  clear(accountId: string) { this.cache.delete(accountId) }
}

const ewsError = (error: unknown) => {
  if (error instanceof EwsError && /AccessDenied/.test(error.code)) return new DirectoryPermissionError(`Exchange refused the directory lookup: ${error.message}`, true)
  return error
}

export class EwsDirectoryBackend implements DirectoryBackend {
  readonly id = 'exchange-ews' as const

  constructor(private readonly accountId: string, private readonly client: EwsClient, private readonly roomCache: EwsRoomCache) {}

  private kindOf(mailboxType: string | undefined, email: string, rooms: Set<string>): DirectoryEntryKind {
    if (rooms.has(email.toLowerCase())) return 'room'
    return GROUP_MAILBOX_TYPES.has(mailboxType?.toLowerCase() ?? '') ? 'group' : 'person'
  }

  private async roomSet() {
    try {
      return await this.roomCache.rooms(this.accountId, this.client)
    } catch {
      // Servers without room lists (or that refuse GetRoomLists) still resolve people and groups.
      return []
    }
  }

  private fromMailbox(mailbox: EwsDirectoryMailbox, rooms: Set<string>, extra: Partial<DirectoryEntry> = {}): DirectoryEntry {
    const kind = this.kindOf(mailbox.mailboxType, mailbox.email, rooms)
    return {
      id: entryId(this.accountId, mailbox.email.toLowerCase()), accountId: this.accountId, backend: this.id, kind, name: mailbox.name || mailbox.email, email: mailbox.email,
      ...(kind === 'group' ? { expandable: true } : {}), ...extra
    }
  }

  async search(query: string, kinds: DirectoryEntryKind[], limit: number) {
    const term = query.trim()
    if (!term) return []
    try {
      const roomList = await this.roomSet()
      const rooms = new Set(roomList.map((room) => room.email.toLowerCase()))
      const resolved = await resolveNames(this.client, term)
      const entries = resolved.resolutions
        .filter((resolution) => !resolution.mailbox.routingType || resolution.mailbox.routingType.toUpperCase() === 'SMTP')
        .map((resolution) => this.fromMailbox(resolution.mailbox, rooms, {
          ...(resolution.contact?.displayName ? { name: resolution.contact.displayName } : {}),
          ...(resolution.contact?.jobTitle ? { title: resolution.contact.jobTitle } : {}),
          ...(resolution.contact?.department ? { department: resolution.contact.department } : {}),
          ...(resolution.contact?.company ? { company: resolution.contact.company } : {}),
          ...(resolution.contact?.office ? { office: resolution.contact.office } : {}),
          ...(resolution.contact?.businessPhone ? { phone: resolution.contact.businessPhone } : {}),
          ...(resolution.contact?.mobilePhone ? { mobile: resolution.contact.mobilePhone } : {})
        }))
      // ResolveNames matches names from the start; room lists also match words inside room names.
      if (kinds.includes('room')) entries.push(...roomList.filter((room) => matches(term, room.name, room.email)).map((room) => this.fromMailbox(room, rooms)))
      return mergeEntries(entries).filter((entry) => kinds.includes(entry.kind)).slice(0, limit)
    } catch (error) { throw ewsError(error) }
  }

  async expandGroup(groupEmail: string) {
    try {
      const rooms = new Set((await this.roomSet()).map((room) => room.email.toLowerCase()))
      const expansion = await expandDistributionList(this.client, groupEmail)
      const members = expansion.members.slice(0, MAX_GROUP_MEMBERS).map((member) => this.fromMailbox(member, rooms))
      return { members, truncated: !expansion.includesLastItemInRange || expansion.members.length > MAX_GROUP_MEMBERS }
    } catch (error) { throw ewsError(error) }
  }

  private persona(persona: EwsPersona, rooms: Set<string>): DirectoryEntry | undefined {
    if (!usable(persona.email)) return undefined
    const type = persona.personaType?.toLowerCase() ?? ''
    const kind: DirectoryEntryKind = rooms.has(persona.email.toLowerCase()) || type === 'room' ? 'room'
      : GROUP_PERSONA_TYPES.has(type) || GROUP_MAILBOX_TYPES.has(persona.mailboxType?.toLowerCase() ?? '') ? 'group' : 'person'
    return {
      id: entryId(this.accountId, persona.email.toLowerCase()), accountId: this.accountId, backend: this.id, kind, name: persona.displayName, email: persona.email,
      ...(persona.title ? { title: persona.title } : {}), ...(persona.department ? { department: persona.department } : {}),
      ...(persona.company ? { company: persona.company } : {}), ...(persona.office ? { office: persona.office } : {}),
      ...(kind === 'group' ? { expandable: true } : {})
    }
  }

  async list(sink: (entries: DirectoryEntry[]) => void) {
    try {
      this.roomCache.clear(this.accountId)
      const roomList = await this.roomSet()
      const rooms = new Set(roomList.map((room) => room.email.toLowerCase()))
      sink(roomList.map((room) => this.fromMailbox(room, rooms)))
      let offset = 0
      let first = true
      for (;;) {
        let page
        try {
          page = await findPeople(this.client, { offset, max: FIND_PEOPLE_PAGE })
        } catch (error) {
          // A server that only searches the directory with a query string has no full listing:
          // the cache keeps rooms plus the entries learned from online lookups.
          if (first && error instanceof EwsError) return 'incremental' as const
          throw error
        }
        first = false
        sink(page.personas.map((persona) => this.persona(persona, rooms)).filter((entry): entry is DirectoryEntry => Boolean(entry)))
        offset += page.personas.length
        if (!page.personas.length || (page.total !== undefined && offset >= page.total) || page.personas.length < FIND_PEOPLE_PAGE || offset >= MAX_LISTING_ENTRIES) break
      }
      return 'full' as const
    } catch (error) { throw ewsError(error) }
  }
}
