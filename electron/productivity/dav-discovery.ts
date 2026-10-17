import type { DavCollectionKind } from '../../src/dav-types'
import { DavClient, DavHttpError, resolveHref, sameCollection } from './dav-client'
import {
  APPLE_ICAL_NS, CALDAV_NS, CALENDARSERVER_NS, CARDDAV_NS, childElement, childElements, DAV_NS, elementText,
  prop, propfindBody, propText, type DavResponse, type PropName
} from './dav-xml'

export type DavService = 'caldav' | 'carddav'

export interface DiscoveredCollection {
  url: string
  kind: DavCollectionKind
  name: string
  color?: string
  description?: string
  components: string[]
  readOnly: boolean
  shared: boolean
  ctag?: string
  syncToken?: string
  supportsSyncCollection: boolean
}

export interface DiscoveredService {
  principalUrl: string
  homeUrl: string
}

const HOME_PROPERTY: Record<DavService, PropName> = {
  caldav: [CALDAV_NS, 'calendar-home-set'],
  carddav: [CARDDAV_NS, 'addressbook-home-set']
}

export const COLLECTION_PROPS: PropName[] = [
  [DAV_NS, 'resourcetype'], [DAV_NS, 'displayname'], [DAV_NS, 'current-user-privilege-set'], [DAV_NS, 'sync-token'],
  [DAV_NS, 'supported-report-set'], [CALENDARSERVER_NS, 'getctag'], [APPLE_ICAL_NS, 'calendar-color'],
  [CALDAV_NS, 'supported-calendar-component-set'], [CALDAV_NS, 'calendar-description'], [CARDDAV_NS, 'addressbook-description']
]

const hrefOf = (response: DavResponse, ns: string, name: string, base: string) => {
  const href = elementText(childElement(prop(response, ns, name), DAV_NS, 'href'))
  return href ? resolveHref(href, base) : undefined
}

async function propfind(client: DavClient, url: string, props: PropName[], depth: '0' | '1') {
  return client.multistatus('PROPFIND', url, propfindBody(props), depth)
}

// RFC 6764: try the service's /.well-known path first when the user gave only a host, then the given path.
function contextCandidates(root: string, service: DavService) {
  const url = new URL(root)
  const wellKnown = new URL(`/.well-known/${service}`, url).toString()
  return url.pathname === '/' || url.pathname === '' ? [wellKnown, root] : [root, wellKnown]
}

/** Finds the principal and its calendar-home-set or addressbook-home-set for one service. */
export async function discoverService(client: DavClient, roots: string[], service: DavService): Promise<DiscoveredService | undefined> {
  const [homeNs, homeName] = HOME_PROPERTY[service]
  let authError: DavHttpError | undefined
  const tried = new Set<string>()
  for (const root of roots) {
    for (const candidate of contextCandidates(root, service)) {
      if (tried.has(candidate)) continue
      tried.add(candidate)
      try {
        const context = await propfind(client, candidate, [[DAV_NS, 'current-user-principal'], [DAV_NS, 'resourcetype'], [homeNs, homeName]], '0')
        const response = context.responses[0]
        if (!response) continue
        const principalUrl = hrefOf(response, DAV_NS, 'current-user-principal', context.url) ?? context.url
        // Some servers answer home-set on the context path itself; otherwise ask the principal.
        let homeUrl = hrefOf(response, homeNs, homeName, context.url)
        if (!homeUrl) {
          const principal = await propfind(client, principalUrl, [[homeNs, homeName], [DAV_NS, 'displayname']], '0')
          const principalResponse = principal.responses[0]
          homeUrl = principalResponse ? hrefOf(principalResponse, homeNs, homeName, principal.url) : undefined
        }
        if (homeUrl) return { principalUrl, homeUrl }
      } catch (error) {
        if (error instanceof DavHttpError && error.status === 401) authError = error
        else if (!(error instanceof DavHttpError)) throw error
        // 404/405/403 and non-DAV responses mean "not here"; keep trying other candidates.
      }
    }
  }
  if (authError) throw authError
  return undefined
}

const WRITE_PRIVILEGES = new Set(['all', 'write', 'write-content'])

export function collectionFromResponse(response: DavResponse, base: string): DiscoveredCollection | undefined {
  const resourceType = prop(response, DAV_NS, 'resourcetype')
  const isCalendar = Boolean(childElement(resourceType, CALDAV_NS, 'calendar'))
  const isAddressbook = Boolean(childElement(resourceType, CARDDAV_NS, 'addressbook'))
  if (!isCalendar && !isAddressbook) return undefined
  const url = resolveHref(response.href, base)
  const privileges = prop(response, DAV_NS, 'current-user-privilege-set')
  const granted = new Set(childElements(privileges, DAV_NS, 'privilege').flatMap((privilege) => privilege.children.filter((child) => child.ns === DAV_NS).map((child) => child.name)))
  // A missing privilege set means the server did not say; writes are attempted and a 403 is reported.
  const subscribed = Boolean(childElement(resourceType, CALENDARSERVER_NS, 'subscribed'))
  const readOnly = subscribed || (privileges !== undefined && ![...granted].some((name) => WRITE_PRIVILEGES.has(name)))
  const shared = Boolean(childElement(resourceType, CALENDARSERVER_NS, 'shared') || childElement(resourceType, CALENDARSERVER_NS, 'shared-owner'))
  const componentSet = prop(response, CALDAV_NS, 'supported-calendar-component-set')
  const components = componentSet
    ? childElements(componentSet, CALDAV_NS, 'comp').map((comp) => comp.attributes.name?.toUpperCase()).filter((name): name is string => Boolean(name))
    : isCalendar ? ['VEVENT', 'VTODO', 'VJOURNAL'] : []
  const reports = childElements(prop(response, DAV_NS, 'supported-report-set'), DAV_NS, 'supported-report')
    .flatMap((report) => childElement(report, DAV_NS, 'report')?.children ?? [])
  const syncToken = propText(response, DAV_NS, 'sync-token')
  const colorText = propText(response, APPLE_ICAL_NS, 'calendar-color')
  const color = colorText && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(colorText) ? colorText.slice(0, 7) : undefined
  const description = propText(response, isCalendar ? CALDAV_NS : CARDDAV_NS, isCalendar ? 'calendar-description' : 'addressbook-description')
  const fallbackName = decodeURIComponent(new URL(url).pathname.replace(/\/+$/, '').split('/').pop() || (isCalendar ? 'Calendar' : 'Contacts'))
  const ctag = propText(response, CALENDARSERVER_NS, 'getctag')
  return {
    url,
    kind: isCalendar ? 'calendar' : 'addressbook',
    name: (propText(response, DAV_NS, 'displayname') || fallbackName).slice(0, 200),
    ...(color ? { color } : {}),
    ...(description ? { description: description.slice(0, 1_000) } : {}),
    components,
    readOnly,
    shared,
    ...(ctag ? { ctag } : {}),
    ...(syncToken ? { syncToken } : {}),
    supportsSyncCollection: Boolean(syncToken) || reports.some((report) => report.ns === DAV_NS && report.name === 'sync-collection')
  }
}

/** Lists the calendars or address books directly inside a home set. */
export async function listCollections(client: DavClient, homeUrl: string): Promise<DiscoveredCollection[]> {
  const listing = await propfind(client, homeUrl, COLLECTION_PROPS, '1')
  return listing.responses
    .filter((response) => !sameCollection(resolveHref(response.href, listing.url), resolveHref(homeUrl, listing.url)))
    .map((response) => collectionFromResponse(response, listing.url))
    .filter((collection): collection is DiscoveredCollection => Boolean(collection))
}

export interface DiscoveryResult {
  calendar?: DiscoveredService
  contacts?: DiscoveredService
  collections: DiscoveredCollection[]
}

export async function discoverAccount(client: DavClient, roots: { calendar: string[]; contacts: string[] }): Promise<DiscoveryResult> {
  const calendar = await discoverService(client, roots.calendar, 'caldav')
  const contacts = await discoverService(client, roots.contacts, 'carddav')
  if (!calendar && !contacts) throw new Error('No CalDAV calendars or CardDAV address books were found at that address')
  // Servers that share one home set for both services are listed once.
  const listings = new Map<string, DiscoveredCollection[]>()
  const list = async (home: string) => {
    const key = home.replace(/\/+$/, '')
    if (!listings.has(key)) listings.set(key, await listCollections(client, home))
    return listings.get(key)!
  }
  const collections: DiscoveredCollection[] = []
  if (calendar) collections.push(...(await list(calendar.homeUrl)).filter((item) => item.kind === 'calendar'))
  if (contacts) collections.push(...(await list(contacts.homeUrl)).filter((item) => item.kind === 'addressbook'))
  return { ...(calendar ? { calendar } : {}), ...(contacts ? { contacts } : {}), collections }
}
