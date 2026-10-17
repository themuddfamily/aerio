import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CALDAV_NS, CARDDAV_NS, childElement, childElements, DAV_NS, elementText, escapeXml, parseXml } from './dav-xml'

// An in-process CalDAV/CardDAV server on 127.0.0.1 for tests. It models just enough of RFC 4791,
// RFC 6352, RFC 6578, and RFC 6764 to exercise discovery, privileges, sync-collection, ctag/ETag
// fallback, multiget, conditional writes, and server quirks (no ETag on PUT, truncated sync).

export interface FixtureResource { data: string; etag: string }

export interface FixtureCollection {
  path: string
  kind: 'calendar' | 'addressbook'
  name: string
  color?: string
  components?: string[]
  readOnly?: boolean
  shared?: boolean
  subscribed?: boolean
  resources: Map<string, FixtureResource>
  revision: number
  changes: { name: string; revision: number; deleted: boolean }[]
}

export interface DavFixtureOptions {
  username?: string
  password?: string
  syncCollection?: boolean
  multiget?: boolean
  wellKnown?: boolean
  privileges?: boolean
  ctag?: boolean
  // Simulates servers (iCloud, some Nextcloud apps) that store a modified copy and omit the ETag.
  rewriteOnPut?: (data: string) => string
  // Return at most this many changes per sync-collection response, then 507 for the rest.
  syncPageSize?: number
}

export interface FixtureRequest { method: string; path: string; headers: IncomingMessage['headers']; body: string }

const PREFIXES = `xmlns:d="DAV:" xmlns:c="${CALDAV_NS}" xmlns:card="${CARDDAV_NS}" xmlns:cs="http://calendarserver.org/ns/" xmlns:ical="http://apple.com/ns/ical/"`

export class DavFixtureServer {
  readonly requests: FixtureRequest[] = []
  readonly collections = new Map<string, FixtureCollection>()
  invalidateSyncTokens = false
  // Status codes to answer the next matching requests with, e.g. { PUT: [503] }.
  failures: Record<string, number[]> = {}
  private server?: Server
  private revision = 1
  private etagCounter = 1
  private readonly options: Required<Omit<DavFixtureOptions, 'rewriteOnPut' | 'syncPageSize'>> & Pick<DavFixtureOptions, 'rewriteOnPut' | 'syncPageSize'>

  constructor(options: DavFixtureOptions = {}) {
    this.options = {
      username: 'ada@example.com', password: 'app-password', syncCollection: true, multiget: true, wellKnown: true, privileges: true, ctag: true,
      ...options
    }
  }

  get url() {
    const address = this.server?.address() as AddressInfo | undefined
    if (!address) throw new Error('The fixture server is not running')
    return `http://127.0.0.1:${address.port}/`
  }

  // Paths are kept decoded; '@' is legal in a URL path, so hrefs use the user name as is.
  get user() { return this.options.username }
  get calendarHome() { return `/calendars/${this.user}/` }
  get addressbookHome() { return `/addressbooks/${this.user}/` }

  async start() {
    this.server = createServer((request, response) => void this.handle(request, response))
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    return this
  }

  async stop() {
    await new Promise<void>((resolve) => this.server ? this.server.close(() => resolve()) : resolve())
  }

  addCollection(input: Omit<FixtureCollection, 'resources' | 'revision' | 'changes' | 'path'> & { slug: string }) {
    const home = input.kind === 'calendar' ? this.calendarHome : this.addressbookHome
    const collection: FixtureCollection = { ...input, path: `${home}${input.slug}/`, resources: new Map(), revision: this.revision, changes: [] }
    this.collections.set(collection.path, collection)
    return collection
  }

  /** Simulates another client writing a resource. */
  write(collection: FixtureCollection, name: string, data: string) {
    const etag = `"e${this.etagCounter++}"`
    collection.resources.set(name, { data, etag })
    this.bump(collection, name, false)
    return etag
  }

  remove(collection: FixtureCollection, name: string) {
    collection.resources.delete(name)
    this.bump(collection, name, true)
  }

  resource(collection: FixtureCollection, name: string) {
    return collection.resources.get(name)
  }

  private bump(collection: FixtureCollection, name: string, deleted: boolean) {
    collection.revision = ++this.revision
    collection.changes = collection.changes.filter((change) => change.name !== name)
    collection.changes.push({ name, revision: collection.revision, deleted })
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks).toString('utf8')
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://fixture').pathname)
    const method = request.method ?? 'GET'
    this.requests.push({ method, path, headers: request.headers, body })
    const send = (status: number, text = '', headers: Record<string, string> = {}) => {
      response.writeHead(status, { 'Content-Type': 'application/xml; charset=utf-8', ...headers })
      response.end(text)
    }
    const expected = `Basic ${Buffer.from(`${this.options.username}:${this.options.password}`).toString('base64')}`
    if (request.headers.authorization !== expected) return send(401, '', { 'WWW-Authenticate': 'Basic realm="fixture"' })
    const failure = this.failures[method]?.shift()
    if (failure) return send(failure)
    if (path.startsWith('/.well-known/')) return this.options.wellKnown ? send(301, '', { Location: '/dav/' }) : send(404)
    try {
      if (method === 'PROPFIND') return this.propfind(path, request.headers.depth === '1' ? 1 : 0, body, send)
      if (method === 'REPORT') return this.report(path, body, send)
      // Collection management (RFC 4791 MKCALENDAR, RFC 4918 PROPPATCH/DELETE) for task lists.
      const collectionPath = path.endsWith('/') ? path : `${path}/`
      if (method === 'MKCALENDAR') {
        if (this.collections.has(collectionPath) || !collectionPath.startsWith(this.calendarHome)) return send(405)
        const root = parseXml(body)
        const props = childElement(childElement(root, DAV_NS, 'set'), DAV_NS, 'prop')
        const components = childElements(childElement(props, CALDAV_NS, 'supported-calendar-component-set'), CALDAV_NS, 'comp').map((comp) => comp.attributes.name)
        const created: FixtureCollection = { path: collectionPath, kind: 'calendar', name: elementText(childElement(props, DAV_NS, 'displayname')) ?? 'Untitled', components: components.length ? components : undefined, resources: new Map(), revision: ++this.revision, changes: [] }
        this.collections.set(collectionPath, created)
        return send(201)
      }
      if (method === 'PROPPATCH' || (method === 'DELETE' && path.endsWith('/'))) {
        const target = this.collections.get(collectionPath)
        if (!target) return send(404)
        if (target.readOnly) return send(403)
        if (method === 'DELETE') { this.collections.delete(collectionPath); return send(204) }
        const name = elementText(childElement(childElement(childElement(parseXml(body), DAV_NS, 'set'), DAV_NS, 'prop'), DAV_NS, 'displayname'))
        if (name) { target.name = name; target.revision = ++this.revision }
        return send(207, this.multistatus([`<d:response><d:href>${escapeXml(collectionPath)}</d:href><d:propstat><d:prop><d:displayname/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`]))
      }
      const [collection, name] = this.locate(path)
      if (!collection || !name) return send(method === 'GET' ? 404 : 405)
      const existing = collection.resources.get(name)
      const ifMatch = request.headers['if-match']
      const ifNoneMatch = request.headers['if-none-match']
      if (method === 'GET') return existing ? send(200, existing.data, { ETag: existing.etag, 'Content-Type': collection.kind === 'calendar' ? 'text/calendar' : 'text/vcard' }) : send(404)
      if (collection.readOnly || collection.subscribed) return send(403, `<d:error ${PREFIXES}><d:need-privileges/></d:error>`)
      if (method === 'PUT') {
        if (ifNoneMatch === '*' && existing) return send(412)
        if (ifMatch && (!existing || ifMatch !== existing.etag)) return send(412)
        const stored = this.options.rewriteOnPut ? this.options.rewriteOnPut(body) : body
        const etag = this.write(collection, name, stored)
        return send(existing ? 204 : 201, '', this.options.rewriteOnPut ? {} : { ETag: etag })
      }
      if (method === 'DELETE') {
        if (!existing) return send(404)
        if (ifMatch && ifMatch !== existing.etag) return send(412)
        this.remove(collection, name)
        return send(204)
      }
      return send(405)
    } catch (error) {
      return send(500, error instanceof Error ? error.message : 'error')
    }
  }

  private locate(path: string): [FixtureCollection | undefined, string | undefined] {
    const slash = path.lastIndexOf('/')
    const collection = this.collections.get(path.slice(0, slash + 1))
    return [collection, path.slice(slash + 1) || undefined]
  }

  private collectionProps(collection: FixtureCollection) {
    const props: Record<string, string> = {
      '{DAV:}resourcetype': `<d:resourcetype><d:collection/>${collection.kind === 'calendar' ? '<c:calendar/>' : '<card:addressbook/>'}${collection.shared ? '<cs:shared/>' : ''}${collection.subscribed ? '<cs:subscribed/>' : ''}</d:resourcetype>`,
      '{DAV:}displayname': `<d:displayname>${escapeXml(collection.name)}</d:displayname>`,
      '{DAV:}supported-report-set': `<d:supported-report-set>${collection.kind === 'calendar' ? '<d:supported-report><d:report><c:calendar-multiget/></d:report></d:supported-report>' : '<d:supported-report><d:report><card:addressbook-multiget/></d:report></d:supported-report>'}${this.options.syncCollection ? '<d:supported-report><d:report><d:sync-collection/></d:report></d:supported-report>' : ''}</d:supported-report-set>`
    }
    if (this.options.syncCollection) props['{DAV:}sync-token'] = `<d:sync-token>http://fixture/sync/${collection.revision}</d:sync-token>`
    if (this.options.ctag) props['{http://calendarserver.org/ns/}getctag'] = `<cs:getctag>ctag-${collection.revision}</cs:getctag>`
    if (this.options.privileges) {
      const privileges = collection.readOnly ? ['read', 'read-current-user-privilege-set'] : ['read', 'write', 'write-content', 'bind', 'unbind']
      props['{DAV:}current-user-privilege-set'] = `<d:current-user-privilege-set>${privileges.map((name) => `<d:privilege><d:${name}/></d:privilege>`).join('')}</d:current-user-privilege-set>`
    }
    if (collection.color) props['{http://apple.com/ns/ical/}calendar-color'] = `<ical:calendar-color>${collection.color}FF</ical:calendar-color>`
    if (collection.kind === 'calendar' && collection.components) {
      props[`{${CALDAV_NS}}supported-calendar-component-set`] = `<c:supported-calendar-component-set>${collection.components.map((name) => `<c:comp name="${name}"/>`).join('')}</c:supported-calendar-component-set>`
    }
    return props
  }

  private resourceProps(collection: FixtureCollection, resource: FixtureResource, withData = false) {
    const props: Record<string, string> = {
      '{DAV:}getetag': `<d:getetag>${escapeXml(resource.etag)}</d:getetag>`,
      '{DAV:}getcontenttype': `<d:getcontenttype>${collection.kind === 'calendar' ? 'text/calendar; charset=utf-8' : 'text/vcard; charset=utf-8'}</d:getcontenttype>`,
      '{DAV:}resourcetype': '<d:resourcetype/>'
    }
    if (withData) {
      props[collection.kind === 'calendar' ? `{${CALDAV_NS}}calendar-data` : `{${CARDDAV_NS}}address-data`] = collection.kind === 'calendar'
        ? `<c:calendar-data>${escapeXml(resource.data)}</c:calendar-data>`
        : `<card:address-data><![CDATA[${resource.data}]]></card:address-data>`
    }
    return props
  }

  private response(href: string, available: Record<string, string>, requested: string[] | undefined) {
    const names = requested ?? Object.keys(available)
    const found = names.filter((name) => available[name])
    const missing = names.filter((name) => !available[name])
    const missingXml = missing.map((name) => {
      const match = /^\{(.*)\}(.*)$/.exec(name)!
      return `<x:${match[2]} xmlns:x="${match[1]}"/>`
    }).join('')
    return `<d:response><d:href>${escapeXml(href)}</d:href>${found.length ? `<d:propstat><d:prop>${found.map((name) => available[name]).join('')}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>` : ''}${missing.length ? `<d:propstat><d:prop>${missingXml}</d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>` : ''}</d:response>`
  }

  private multistatus(responses: string[], extra = '') {
    return `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus ${PREFIXES}>${responses.join('')}${extra}</d:multistatus>`
  }

  private propfind(path: string, depth: 0 | 1, body: string, send: (status: number, text?: string) => void) {
    const requested = body.trim() ? childElement(parseXml(body), DAV_NS, 'prop')?.children : undefined
    const names = requested?.map((element) => `{${element.ns}}${element.name}`)
    const principal = `/principals/${this.user}/`
    const principalProps = {
      '{DAV:}current-user-principal': `<d:current-user-principal><d:href>${principal}</d:href></d:current-user-principal>`,
      '{DAV:}resourcetype': '<d:resourcetype><d:collection/></d:resourcetype>'
    }
    if (path === '/' || path === '/dav/') return send(207, this.multistatus([this.response(path, principalProps, names)]))
    if (path === principal) {
      return send(207, this.multistatus([this.response(path, {
        ...principalProps,
        '{DAV:}displayname': '<d:displayname>Ada</d:displayname>',
        [`{${CALDAV_NS}}calendar-home-set`]: `<c:calendar-home-set><d:href>${this.calendarHome}</d:href></c:calendar-home-set>`,
        [`{${CARDDAV_NS}}addressbook-home-set`]: `<card:addressbook-home-set><d:href>${this.addressbookHome}</d:href></card:addressbook-home-set>`
      }, names)]))
    }
    if (path === this.calendarHome || path === this.addressbookHome) {
      const children = depth === 1 ? [...this.collections.values()].filter((collection) => collection.path.startsWith(path)).map((collection) => this.response(collection.path, this.collectionProps(collection), names)) : []
      return send(207, this.multistatus([this.response(path, { '{DAV:}resourcetype': '<d:resourcetype><d:collection/></d:resourcetype>' }, names), ...children]))
    }
    const collection = this.collections.get(path.endsWith('/') ? path : `${path}/`)
    if (collection) {
      const members = depth === 1 ? [...collection.resources].map(([name, resource]) => this.response(`${collection.path}${encodeURIComponent(name)}`, this.resourceProps(collection, resource), names)) : []
      return send(207, this.multistatus([this.response(collection.path, this.collectionProps(collection), names), ...members]))
    }
    return send(404)
  }

  private report(path: string, body: string, send: (status: number, text?: string) => void) {
    const collection = this.collections.get(path.endsWith('/') ? path : `${path}/`)
    if (!collection) return send(404)
    const root = parseXml(body)
    if (root.ns === DAV_NS && root.name === 'sync-collection') {
      if (!this.options.syncCollection) return send(501)
      const token = elementText(childElement(root, DAV_NS, 'sync-token')) ?? ''
      const match = /^http:\/\/fixture\/sync\/(\d+)$/.exec(token)
      if (token && (this.invalidateSyncTokens || !match)) return send(403, `<d:error ${PREFIXES}><d:valid-sync-token/></d:error>`)
      const since = match ? Number(match[1]) : 0
      const changes = token
        ? collection.changes.filter((change) => change.revision > since)
        : [...collection.resources.keys()].map((name) => ({ name, revision: collection.changes.find((change) => change.name === name)?.revision ?? collection.revision, deleted: false }))
      changes.sort((a, b) => a.revision - b.revision)
      const page = this.options.syncPageSize && changes.length > this.options.syncPageSize ? changes.slice(0, this.options.syncPageSize) : changes
      const truncated = page.length < changes.length
      const responses = page.map((change) => {
        const href = `${collection.path}${encodeURIComponent(change.name)}`
        const resource = collection.resources.get(change.name)
        return change.deleted || !resource
          ? `<d:response><d:href>${escapeXml(href)}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`
          : this.response(href, this.resourceProps(collection, resource), ['{DAV:}getetag', '{DAV:}getcontenttype'])
      })
      if (truncated) responses.push(`<d:response><d:href>${collection.path}</d:href><d:status>HTTP/1.1 507 Insufficient Storage</d:status></d:response>`)
      const nextToken = truncated ? page[page.length - 1].revision : collection.revision
      return send(207, this.multistatus(responses, `<d:sync-token>http://fixture/sync/${nextToken}</d:sync-token>`))
    }
    if ((root.ns === CALDAV_NS && root.name === 'calendar-multiget') || (root.ns === CARDDAV_NS && root.name === 'addressbook-multiget')) {
      if (!this.options.multiget) return send(501)
      const responses = childElements(root, DAV_NS, 'href').map((element) => {
        const href = elementText(element)!
        const [owner, name] = this.locate(decodeURIComponent(href))
        const resource = owner && name ? owner.resources.get(name) : undefined
        return resource ? this.response(href, this.resourceProps(owner!, resource, true), undefined) : `<d:response><d:href>${escapeXml(href)}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`
      })
      return send(207, this.multistatus(responses))
    }
    return send(501)
  }
}

// --- Test harness ---------------------------------------------------------------------------------

export const ICS = (uid: string, summary: string, extra = '') => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Fixture//EN', 'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260101T000000Z',
  'DTSTART:20261020T090000Z', 'DTEND:20261020T100000Z', `SUMMARY:${summary}`, ...(extra ? extra.split('\n') : []), 'END:VEVENT', 'END:VCALENDAR', ''
].join('\r\n')

/** A calendar object with one VTODO; `extra` lines go inside the VTODO, `after` after it (overrides). */
export const VTODO = (uid: string, summary: string, extra = '', after = '') => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Fixture//EN', 'BEGIN:VTODO', `UID:${uid}`, 'DTSTAMP:20260101T000000Z',
  `SUMMARY:${summary}`, ...(extra ? extra.split('\n') : []), 'END:VTODO', ...(after ? after.split('\n') : []), 'END:VCALENDAR', ''
].join('\r\n')

export const VCF = (uid: string, name: string, extra = '') => [
  'BEGIN:VCARD', 'VERSION:3.0', `UID:${uid}`, `FN:${name}`, `N:${name.split(' ').reverse().join(';')};;;`, ...(extra ? extra.split('\n') : []), 'END:VCARD', ''
].join('\r\n')

/** One writable calendar, a read-only shared calendar, a tasks-only calendar, and an address book. */
export async function startStandardFixture(options: DavFixtureOptions = {}) {
  const server = await new DavFixtureServer(options).start()
  const work = server.addCollection({ slug: 'work', kind: 'calendar', name: 'Work', color: '#aa3300', components: ['VEVENT'] })
  const holidays = server.addCollection({ slug: 'holidays', kind: 'calendar', name: 'Holidays', components: ['VEVENT'], readOnly: true, shared: true })
  const tasks = server.addCollection({ slug: 'tasks', kind: 'calendar', name: 'Reminders', components: ['VTODO'] })
  const contacts = server.addCollection({ slug: 'contacts', kind: 'addressbook', name: 'Contacts' })
  return { server, work, holidays, tasks, contacts }
}
