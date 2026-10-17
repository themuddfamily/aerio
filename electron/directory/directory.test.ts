import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DirectoryEntry } from '../../src/directory-types'
import { EwsClient } from '../exchange/ews-client'
import { EwsFixtureServer } from '../exchange/ews-fixture-server'
import { GOOGLE_DIRECTORY_SCOPE, GRAPH_DIRECTORY_SCOPES, GRAPH_RESOURCE_SCOPES, mergeEntries, type FetchLike } from './directory-backends'
import { registerDirectory, validateDirectorySearch } from './directory-ipc'
import { DirectoryService, graphDirectoryAccess, isConsentDenied, markAmbiguous, type DirectoryAccountInfo, type DirectoryServiceDependencies } from './directory-service'
import { DirectoryStore } from './directory-store'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

const MS: DirectoryAccountInfo = { id: 'ms-1', provider: 'microsoft', email: 'ada@contoso.com' }
const GOOGLE: DirectoryAccountInfo = { id: 'g-1', provider: 'gmail', email: 'ada@fabrikam.com' }
const GMAIL: DirectoryAccountInfo = { id: 'g-2', provider: 'gmail', email: 'ada@gmail.com' }
const EXCHANGE: DirectoryAccountInfo = { id: 'ex-1', provider: 'exchange', email: 'ada@contoso.test' }
const IMAP: DirectoryAccountInfo = { id: 'imap-1', provider: 'imap', email: 'ada@example.org' }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

type Route = (url: URL, init?: RequestInit) => Response | undefined
function fakeFetch(...routes: Route[]) {
  const calls: { url: URL; headers: Record<string, string> }[] = []
  const fetchImpl: FetchLike = async (raw, init) => {
    const url = new URL(raw)
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
    for (const route of routes) {
      const response = route(url, init)
      if (response) return response
    }
    return json({ error: { code: 'NotFound', message: `No fake route for ${url.pathname}` } }, 404)
  }
  return { fetchImpl, calls }
}

function harness(options: {
  accounts?: DirectoryAccountInfo[]
  scopes?: Record<string, string[] | undefined>
  fetch?: FetchLike
  ews?: EwsFixtureServer
  authorize?: DirectoryServiceDependencies['authorize']
} = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'aerio-directory-'))
  const store = new DirectoryStore(join(folder, 'directory.sqlite'))
  const clients: EwsClient[] = []
  cleanup.push(() => rmSync(folder, { recursive: true, force: true }), () => store.close(), () => { for (const client of clients) client.close() })
  let online = true
  let now = Date.parse('2026-10-17T08:00:00Z')
  const scopes = options.scopes ?? {}
  const changed = vi.fn()
  const service = new DirectoryService({
    store,
    accounts: async () => options.accounts ?? [MS],
    googleToken: async () => 'google-token',
    microsoftToken: async () => 'graph-token',
    grantedScopes: (accountId) => scopes[accountId],
    ewsClient: () => {
      if (!options.ews) throw new Error('No EWS fixture')
      const client = new EwsClient({ url: options.ews.url, credentials: { auth: 'ntlm', username: 'CONTOSO\\ada', password: 'Pa55w0rd!' }, sleep: async () => undefined })
      clients.push(client)
      return client
    },
    authorize: options.authorize ?? (async () => undefined),
    online: () => online,
    fetch: options.fetch,
    now: () => now,
    changed
  })
  return {
    service, store, changed, scopes,
    setOnline(value: boolean) { online = value },
    advance(ms: number) { now += ms }
  }
}

const graphUser = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, displayName: name, mail: `${id}@contoso.com`, jobTitle: 'Engineer', department: 'Research', ...extra })
const FULL_GRAPH = ['User.ReadBasic.All', 'People.Read', 'Place.Read.All', 'GroupMember.Read.All', 'Mail.ReadWrite']

/** Graph /users listing split across pages with @odata.nextLink; `fail` makes page 2 fail. */
function graphDirectory(state: { failPage2?: boolean | 'denied'; users?: number } = {}) {
  return (url: URL): Response | undefined => {
    if (url.pathname === '/v1.0/users' && !url.searchParams.has('$search')) {
      const users = Array.from({ length: state.users ?? 5 }, (_, index) => graphUser(`user${index}`, `User ${String(index).padStart(3, '0')}`))
      const skip = Number(url.searchParams.get('$skiptoken') ?? 0)
      if (skip > 0 && state.failPage2 === 'denied') return json({ error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges to complete the operation.' } }, 403)
      if (skip > 0 && state.failPage2) return json({ error: { code: 'ServiceUnavailable', message: 'try later' } }, 503)
      const page = users.slice(skip, skip + 2)
      const next = skip + 2 < users.length ? `https://graph.microsoft.com/v1.0/users?$select=id&$top=999&$skiptoken=${skip + 2}` : undefined
      return json({ value: page, ...(next ? { '@odata.nextLink': next } : {}) })
    }
    if (url.pathname === '/v1.0/groups' && url.searchParams.get('$filter') === 'mailEnabled eq true' && !url.searchParams.has('$search')) {
      return json({ value: [{ id: 'grp-eng', displayName: 'Engineering', mail: 'engineering@contoso.com', mailEnabled: true }] })
    }
    if (url.pathname === '/v1.0/places/microsoft.graph.room') {
      return json({ value: [{ id: 'room-1', displayName: 'Lovelace Room', emailAddress: 'lovelace@contoso.com', capacity: 8, building: 'HQ' }] })
    }
    return undefined
  }
}

describe('Microsoft Graph directory', () => {
  it('lists every page of /users, groups, and rooms into the offline address book', async () => {
    const { fetchImpl, calls } = fakeFetch(graphDirectory({ users: 5 }))
    const h = harness({ fetch: fetchImpl, scopes: { [MS.id]: FULL_GRAPH } })
    const snapshot = await h.service.refresh(MS.id)
    const account = snapshot.accounts[0]
    expect(account).toMatchObject({ backend: 'microsoft-graph', consent: 'granted', cache: { entries: 7, mode: 'full', lastSuccessAt: '2026-10-17T08:00:00.000Z', refreshing: false } })
    // Three /users pages (2 + 2 + 1) followed through @odata.nextLink.
    expect(calls.filter((call) => call.url.pathname === '/v1.0/users')).toHaveLength(3)
    expect(h.store.search([MS.id], 'user 004', undefined, 10).map((entry) => entry.email)).toEqual(['user4@contoso.com'])
    expect(h.store.search([MS.id], 'lovelace', ['room'], 10)[0]).toMatchObject({ kind: 'room', capacity: 8, building: 'HQ' })
    expect(h.store.search([MS.id], 'engineering', ['group'], 10)[0]).toMatchObject({ kind: 'group', email: 'engineering@contoso.com', expandable: true })
  })

  it('searches with ConsistencyLevel: eventual and merges /me/people details by address', async () => {
    const { fetchImpl, calls } = fakeFetch((url) => {
      if (url.pathname === '/v1.0/users') return json({ value: [graphUser('ada', 'Ada Lovelace', { jobTitle: null, department: null })] })
      if (url.pathname === '/v1.0/me/people') {
        return json({ value: [
          { id: 'p1', displayName: 'Ada Lovelace', scoredEmailAddresses: [{ address: 'ada@contoso.com' }], jobTitle: 'Analyst', department: 'Engines', personType: { class: 'Person', subclass: 'OrganizationUser' } },
          { id: 'p2', displayName: 'Ada (personal)', scoredEmailAddresses: [{ address: 'ada@home.example' }], personType: { class: 'Person', subclass: 'PersonalContact' } },
          { id: 'p3', displayName: 'Ada fans', scoredEmailAddresses: [{ address: 'ada-fans@contoso.com' }], personType: { class: 'Group', subclass: 'PublicDistributionList' } }
        ] })
      }
      return undefined
    })
    const h = harness({ fetch: fetchImpl, scopes: { [MS.id]: ['User.ReadBasic.All', 'People.Read'] } })
    const result = await h.service.search({ query: 'ada' })
    expect(result.source).toBe('online')
    expect(result.entries).toEqual([
      expect.objectContaining({ kind: 'person', name: 'Ada Lovelace', email: 'ada@contoso.com', title: 'Analyst', department: 'Engines' }),
      expect.objectContaining({ kind: 'group', email: 'ada-fans@contoso.com' })
    ])
    // Without GroupMember.Read.All the group address is inserted but cannot be expanded.
    expect(result.entries[1].expandable).toBeUndefined()
    const usersCall = calls.find((call) => call.url.pathname === '/v1.0/users')!
    expect(usersCall.headers.ConsistencyLevel).toBe('eventual')
    expect(usersCall.url.searchParams.get('$search')).toBe('"displayName:ada" OR "mail:ada"')
  })

  it('explains denied consent (403 Authorization_RequestDenied) and falls back to the cache', async () => {
    const h = harness({ fetch: fakeFetch((url) => url.pathname.startsWith('/v1.0/') ? json({ error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges to complete the operation.' } }, 403) : undefined).fetchImpl, scopes: { [MS.id]: ['User.ReadBasic.All', 'People.Read'] } })
    h.store.beginRefresh(MS.id, '2026-10-16T08:00:00.000Z')
    h.store.stage(MS.id, [{ id: `${MS.id}:x`, accountId: MS.id, backend: 'microsoft-graph', kind: 'person', name: 'Ada Lovelace', email: 'ada@contoso.com' }])
    h.store.commitRefresh(MS.id, 'full', '2026-10-16T08:00:00.000Z')
    const result = await h.service.search({ query: 'ada' })
    expect(result.source).toBe('offline')
    expect(result.entries.map((entry) => entry.email)).toEqual(['ada@contoso.com'])
    expect(result.accounts[0]).toMatchObject({ source: 'offline', needsConsent: true, error: expect.stringContaining('Authorization_RequestDenied') })
    const state = (await h.service.snapshot()).accounts[0]
    expect(state.consent).toBe('denied')
    expect(state.message).toMatch(/administrator must grant consent/)
    // While denied, lookups use the cache without asking the server again.
    await h.service.search({ query: 'ada' })
  })

  it('treats a 403 on a legacy grant without a scope list as a missing permission, not a refusal', async () => {
    const h = harness({ fetch: fakeFetch(() => json({ error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges to complete the operation.' } }, 403)).fetchImpl, scopes: {} })
    const result = await h.service.search({ query: 'ada' })
    expect(result.accounts[0]).toMatchObject({ needsConsent: true, error: expect.stringContaining('Allow directory access') })
    expect((await h.service.snapshot()).accounts[0].consent).toBe('unknown')
  })

  it('reports missing permissions and requests them through an explicit reconnect', async () => {
    const authorize = vi.fn(async () => undefined)
    const h = harness({ fetch: fakeFetch(graphDirectory()).fetchImpl, scopes: { [MS.id]: ['Mail.ReadWrite'] }, authorize })
    const before = (await h.service.snapshot()).accounts[0]
    expect(before).toMatchObject({ consent: 'missing', missingScopes: GRAPH_DIRECTORY_SCOPES, missingResourceScopes: GRAPH_RESOURCE_SCOPES, capabilities: { offline: false } })
    expect((await h.service.search({ query: 'ada' })).accounts[0]).toMatchObject({ needsConsent: true })
    await expect(h.service.refresh(MS.id)).rejects.toThrow(/Allow directory access/)
    await h.service.grantAccess(MS.id)
    expect(authorize).toHaveBeenCalledWith(MS, GRAPH_DIRECTORY_SCOPES)
    await h.service.grantAccess(MS.id, 'resources')
    expect(authorize).toHaveBeenLastCalledWith(MS, [...GRAPH_DIRECTORY_SCOPES, ...GRAPH_RESOURCE_SCOPES])
  })

  it('records an administrator-consent refusal from the sign-in screen', async () => {
    const h = harness({ scopes: { [MS.id]: ['Mail.ReadWrite'] }, authorize: async () => { throw new Error('AADSTS65001: The user or administrator has not consented to use the application.') } })
    await expect(h.service.grantAccess(MS.id)).rejects.toThrow(/administrator must grant consent/)
    expect((await h.service.snapshot()).accounts[0]).toMatchObject({ consent: 'denied', message: expect.stringContaining('AADSTS65001') })
    expect(isConsentDenied('access_denied')).toBe(true)
    expect(isConsentDenied('The network is down')).toBe(false)
  })

  it('expands group members across pages and maps nested groups', async () => {
    const { fetchImpl } = fakeFetch((url) => {
      if (url.pathname === '/v1.0/groups' && url.searchParams.get('$filter') === "mail eq 'engineering@contoso.com'") return json({ value: [{ id: 'grp-eng' }] })
      if (url.pathname === '/v1.0/groups/grp-eng/members') {
        if (url.searchParams.get('$skiptoken')) return json({ value: [{ '@odata.type': '#microsoft.graph.group', id: 'grp-sub', displayName: 'Platform', mail: 'platform@contoso.com' }] })
        return json({ value: [graphUser('ada', 'Ada'), graphUser('bob', 'Bob', { mail: null })], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/groups/grp-eng/members?$skiptoken=2' })
      }
      return undefined
    })
    const h = harness({ fetch: fetchImpl, scopes: { [MS.id]: FULL_GRAPH } })
    const expansion = await h.service.expandGroup(MS.id, 'engineering@contoso.com')
    expect(expansion.members.map((member) => [member.kind, member.email])).toEqual([['person', 'ada@contoso.com'], ['group', 'platform@contoso.com']])
    expect(expansion.truncated).toBe(false)
    const basic = harness({ fetch: fetchImpl, scopes: { [MS.id]: ['User.ReadBasic.All', 'People.Read'] } })
    await expect(basic.service.expandGroup(MS.id, 'engineering@contoso.com')).rejects.toThrow(/GroupMember.Read.All/)
  })

  it('recognizes the Graph permissions behind each capability', () => {
    expect(graphDirectoryAccess(undefined)).toMatchObject({ known: false, users: true })
    expect(graphDirectoryAccess(['https://graph.microsoft.com/Directory.Read.All'])).toMatchObject({ users: true, groups: true, rooms: false, people: false })
  })
})

describe('atomic offline address book refresh', () => {
  it('keeps the previous cache and records the error when a refresh fails midway', async () => {
    const state: { failPage2?: boolean | 'denied'; users?: number } = { users: 4 }
    const h = harness({ fetch: fakeFetch(graphDirectory(state)).fetchImpl, scopes: { [MS.id]: ['User.ReadBasic.All', 'People.Read'] } })
    await h.service.refresh(MS.id)
    expect(h.store.count(MS.id)).toBe(4)
    h.advance(25 * 60 * 60_000)
    state.users = 6
    state.failPage2 = true
    await expect(h.service.refresh(MS.id)).rejects.toThrow(/previous offline address book is still used/)
    const cache = (await h.service.snapshot()).accounts[0].cache
    expect(cache).toMatchObject({ entries: 4, lastSuccessAt: '2026-10-17T08:00:00.000Z', lastAttemptAt: '2026-10-18T09:00:00.000Z', error: expect.stringContaining('503'), refreshing: false })
    expect(h.store.search([MS.id], 'user', undefined, 50)).toHaveLength(4)

    // The next successful refresh replaces the cache and clears the error.
    state.failPage2 = false
    await h.service.refresh(MS.id)
    expect((await h.service.snapshot()).accounts[0].cache).toMatchObject({ entries: 6, lastSuccessAt: '2026-10-18T09:00:00.000Z' })
    expect((await h.service.snapshot()).accounts[0].cache.error).toBeUndefined()
  })

  it('a denied listing keeps the cache and marks consent as denied', async () => {
    const state: { failPage2?: boolean | 'denied' } = {}
    const h = harness({ fetch: fakeFetch(graphDirectory(state)).fetchImpl, scopes: { [MS.id]: ['User.ReadBasic.All'] } })
    await h.service.refresh(MS.id)
    state.failPage2 = 'denied'
    await expect(h.service.refresh(MS.id)).rejects.toThrow(/Authorization_RequestDenied/)
    expect(h.store.count(MS.id)).toBe(5)
    expect((await h.service.snapshot()).accounts[0].consent).toBe('denied')
  })

  it('refreshes due caches daily and retries failures hourly, only while online', async () => {
    const { fetchImpl, calls } = fakeFetch(graphDirectory({ users: 2 }))
    const h = harness({ fetch: fetchImpl, scopes: { [MS.id]: ['User.ReadBasic.All'] } })
    await h.service.refreshDue()
    expect(calls).toHaveLength(1)
    h.advance(60 * 60_000)
    await h.service.refreshDue()
    expect(calls).toHaveLength(1)
    h.advance(24 * 60 * 60_000)
    h.setOnline(false)
    await h.service.refreshDue()
    expect(calls).toHaveLength(1)
    h.setOnline(true)
    await h.service.refreshDue()
    expect(calls).toHaveLength(2)
    // Legacy grants without a scope list are not refreshed automatically.
    const legacy = harness({ fetch: fetchImpl, scopes: {} })
    await legacy.service.refreshDue()
    expect(calls).toHaveLength(2)
  })

  it('discards staging rows left by an interrupted refresh', () => {
    const h = harness()
    const entry = (email: string): DirectoryEntry => ({ id: `${MS.id}:${email}`, accountId: MS.id, backend: 'microsoft-graph', kind: 'person', name: email, email })
    h.store.beginRefresh(MS.id, 'a')
    h.store.stage(MS.id, [entry('old@contoso.com')])
    h.store.commitRefresh(MS.id, 'full', 'a')
    h.store.beginRefresh(MS.id, 'b')
    h.store.stage(MS.id, [entry('crashed@contoso.com')])
    // A crash here leaves staging behind; the next refresh starts clean.
    h.store.beginRefresh(MS.id, 'c')
    h.store.stage(MS.id, [entry('new@contoso.com')])
    h.store.commitRefresh(MS.id, 'full', 'c')
    expect(h.store.search([MS.id], 'contoso', undefined, 10).map((item) => item.email)).toEqual(['new@contoso.com'])
  })
})

describe('offline lookup', () => {
  it('answers from the cache while offline and marks the source', async () => {
    const { fetchImpl, calls } = fakeFetch(graphDirectory({ users: 3 }))
    const h = harness({ fetch: fetchImpl, scopes: { [MS.id]: ['User.ReadBasic.All'] } })
    await h.service.refresh(MS.id)
    const before = calls.length
    h.setOnline(false)
    const result = await h.service.search({ query: 'research user 001' })
    expect(calls).toHaveLength(before)
    expect(result).toMatchObject({ source: 'offline', accounts: [{ accountId: MS.id, source: 'offline', error: 'Offline: showing the saved address book' }] })
    expect(result.entries.map((entry) => entry.email)).toEqual(['user1@contoso.com'])
    await expect(h.service.refresh(MS.id)).rejects.toThrow(/only while online/)
    await expect(h.service.expandGroup(MS.id, 'engineering@contoso.com')).rejects.toThrow(/only while online/)
  })

  it('falls back to the cache when the server cannot be reached', async () => {
    const failing: FetchLike = async () => { throw new TypeError('fetch failed') }
    const h = harness({ fetch: failing, scopes: { [MS.id]: ['User.ReadBasic.All'] } })
    h.store.remember(MS.id, [{ id: `${MS.id}:a`, accountId: MS.id, backend: 'microsoft-graph', kind: 'person', name: 'Ada Lovelace', email: 'ada@contoso.com' }])
    const result = await h.service.search({ query: 'ada' })
    expect(result.source).toBe('offline')
    expect(result.accounts[0].error).toMatch(/could not be reached/)
    expect(result.entries).toHaveLength(1)
  })
})

describe('Google Workspace directory', () => {
  it('reports that consumer Gmail and Outlook.com have no directory', async () => {
    const h = harness({ accounts: [GMAIL, IMAP, { id: 'ms-2', provider: 'microsoft', email: 'ada@outlook.com' }] })
    const [gmail, imap, outlook] = (await h.service.snapshot()).accounts
    expect(gmail).toMatchObject({ supported: false, message: expect.stringContaining('no organization directory') })
    expect(imap).toMatchObject({ supported: false })
    expect(outlook).toMatchObject({ supported: false, message: expect.stringContaining('personal Microsoft accounts') })
    await expect(h.service.grantAccess('ms-2')).rejects.toThrow(/no organization directory/)
    expect(await h.service.search({ query: 'ada' })).toMatchObject({ entries: [], source: 'none' })
    await expect(h.service.grantAccess(GMAIL.id)).rejects.toThrow(/no organization directory/)
  })

  it('searches and lists the domain directory with readMask, sources, and page tokens', async () => {
    const person = (id: string, name: string) => ({
      resourceName: `people/${id}`, names: [{ displayName: name }], emailAddresses: [{ value: `${id}@fabrikam.com`, metadata: { primary: true } }],
      organizations: [{ title: 'Designer', department: 'Studio', name: 'Fabrikam' }], phoneNumbers: [{ value: '+1 555', type: 'work' }], locations: [{ value: 'B2-114', type: 'desk', buildingId: 'B2' }]
    })
    const { fetchImpl, calls } = fakeFetch((url) => {
      if (url.pathname === '/v1/people:searchDirectoryPeople') return json({ people: [person('ana', 'Ana Gomez')] })
      if (url.pathname === '/v1/people:listDirectoryPeople') {
        return url.searchParams.get('pageToken') === 'p2' ? json({ people: [person('cy', 'Cy Young')] }) : json({ people: [person('ana', 'Ana Gomez'), person('bo', 'Bo Chen')], nextPageToken: 'p2' })
      }
      return undefined
    })
    const h = harness({ accounts: [GOOGLE], fetch: fetchImpl, scopes: { [GOOGLE.id]: [GOOGLE_DIRECTORY_SCOPE] } })
    const result = await h.service.search({ query: 'ana' })
    expect(result.entries[0]).toMatchObject({ backend: 'google-workspace', kind: 'person', email: 'ana@fabrikam.com', title: 'Designer', department: 'Studio', office: 'B2-114', building: 'B2', phone: '+1 555' })
    const search = calls[0].url
    expect(search.searchParams.get('readMask')).toBe('names,emailAddresses,organizations,phoneNumbers,locations')
    expect(search.searchParams.getAll('sources')).toEqual(['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE', 'DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT'])
    // Groups and rooms are not in the Workspace directory API.
    expect(await h.service.search({ query: 'ana', kinds: ['room'] })).toMatchObject({ entries: [] })
    await h.service.refresh(GOOGLE.id)
    expect(h.store.count(GOOGLE.id)).toBe(3)
    expect(calls.filter((call) => call.url.pathname === '/v1/people:listDirectoryPeople').map((call) => call.url.searchParams.get('pageToken'))).toEqual([null, 'p2'])
  })

  it('explains a missing directory.readonly scope and Workspace accounts without a directory', async () => {
    const insufficient = fakeFetch(() => json({ error: { status: 'PERMISSION_DENIED', message: 'Request had insufficient authentication scopes.' } }, 403))
    const h = harness({ accounts: [GOOGLE], fetch: insufficient.fetchImpl, scopes: {} })
    const result = await h.service.search({ query: 'ana' })
    expect(result.accounts[0]).toMatchObject({ needsConsent: true, error: expect.stringContaining('directory.readonly') })
    const noDomain = fakeFetch(() => json({ error: { status: 'FAILED_PRECONDITION', message: 'Must be a G Suite domain user.' } }, 400))
    const other = harness({ accounts: [GOOGLE], fetch: noDomain.fetchImpl, scopes: { [GOOGLE.id]: [GOOGLE_DIRECTORY_SCOPE] } })
    expect((await other.service.search({ query: 'ana' })).accounts[0]).toMatchObject({ source: 'none', error: expect.stringContaining('no organization directory') })
  })
})

describe('Exchange (EWS) directory', () => {
  async function exchange() {
    const server = await new EwsFixtureServer({ auth: 'ntlm' }).start()
    cleanup.push(() => server.stop())
    server.directory.push(
      { name: 'Alex Kim', email: 'alex.kim@contoso.test', title: 'Accountant', department: 'Finance', office: 'B1', phone: '+1 555 0101' },
      { name: 'Alex Kim', email: 'akim@contoso.test', title: 'Engineer', department: 'Platform', office: 'B7' },
      { name: 'Alexandra Ruiz', email: 'aruiz@contoso.test', title: 'Designer', department: 'Studio' },
      { name: 'All Finance', email: 'finance@contoso.test', mailboxType: 'PublicDL', members: ['alex.kim@contoso.test', 'aruiz@contoso.test', 'board@contoso.test'] },
      { name: 'Board', email: 'board@contoso.test', mailboxType: 'PublicDL', members: [] },
      { name: 'Conference Room Alpha', email: 'room.alpha@contoso.test' },
      { name: 'Conference Room Beta', email: 'room.beta@contoso.test' }
    )
    server.roomLists.set('rooms-hq@contoso.test', { name: 'HQ rooms', rooms: ['room.alpha@contoso.test', 'room.beta@contoso.test'] })
    return { server, h: harness({ accounts: [EXCHANGE], ews: server }) }
  }

  it('resolves ambiguous names with title, department, and office to tell them apart', async () => {
    const { h, server } = await exchange()
    const result = await h.service.search({ query: 'alex kim' })
    expect(result.entries.filter((entry) => entry.name === 'Alex Kim')).toEqual([
      expect.objectContaining({ email: 'akim@contoso.test', title: 'Engineer', department: 'Platform', office: 'B7', ambiguous: true }),
      expect.objectContaining({ email: 'alex.kim@contoso.test', title: 'Accountant', department: 'Finance', phone: '+1 555 0101', ambiguous: true })
    ])
    const request = server.log.find((entry) => entry.operation === 'ResolveNames')!.body
    expect(request).toContain('ReturnFullContactData="true"')
    expect(request).toContain('ContactDataShape="AllProperties"')
    expect(request).toContain('SearchScope="ActiveDirectory"')
    expect(markAmbiguous(result.entries).find((entry) => entry.email === 'aruiz@contoso.test')?.ambiguous).toBeUndefined()
  })

  it('returns group addresses and expands them with ExpandDL', async () => {
    const { h } = await exchange()
    const result = await h.service.search({ query: 'all finance' })
    expect(result.entries).toEqual([expect.objectContaining({ kind: 'group', email: 'finance@contoso.test', expandable: true })])
    const expansion = await h.service.expandGroup(EXCHANGE.id, 'finance@contoso.test')
    expect(expansion.members.map((member) => [member.kind, member.email])).toEqual([['person', 'alex.kim@contoso.test'], ['person', 'aruiz@contoso.test'], ['group', 'board@contoso.test']])
  })

  it('classifies rooms from room lists and finds them by any word of their name', async () => {
    const { h } = await exchange()
    const rooms = await h.service.search({ query: 'beta', kinds: ['room'] })
    expect(rooms.entries).toEqual([expect.objectContaining({ kind: 'room', email: 'room.beta@contoso.test', name: 'Conference Room Beta' })])
    const all = await h.service.search({ query: 'conference' })
    expect(all.entries.map((entry) => entry.kind)).toEqual(['room', 'room'])
  })

  it('pages FindPeople on the directory into the offline address book', async () => {
    const { h, server } = await exchange()
    for (let index = 0; index < 230; index++) server.directory.push({ name: `Person ${String(index).padStart(3, '0')}`, email: `p${index}@contoso.test` })
    await h.service.refresh(EXCHANGE.id)
    expect(server.operations().filter((operation) => operation === 'FindPeople')).toHaveLength(3)
    expect(h.store.state(EXCHANGE.id)).toMatchObject({ mode: 'full', entries: 237 })
    expect(h.store.search([EXCHANGE.id], 'alpha', ['room'], 5)).toHaveLength(1)
    expect(h.store.search([EXCHANGE.id], 'finance', ['group'], 5)[0]).toMatchObject({ email: 'finance@contoso.test', expandable: true })
  })

  it('builds an incremental cache from lookups when the server needs a query to search the directory', async () => {
    const { h, server } = await exchange()
    server.findPeopleNeedsQuery = true
    await h.service.search({ query: 'alexandra' })
    await h.service.refresh(EXCHANGE.id)
    expect(h.store.state(EXCHANGE.id)).toMatchObject({ mode: 'incremental', entries: 3 })
    h.setOnline(false)
    const offline = await h.service.search({ query: 'alexandra' })
    expect(offline).toMatchObject({ source: 'offline', entries: [expect.objectContaining({ email: 'aruiz@contoso.test', title: 'Designer' })] })
    expect((await h.service.search({ query: 'room' })).entries.map((entry) => entry.email)).toEqual(['room.alpha@contoso.test', 'room.beta@contoso.test'])
  })

  it('treats no ResolveNames match as an empty result', async () => {
    const { h } = await exchange()
    expect(await h.service.search({ query: 'zelda' })).toMatchObject({ entries: [], source: 'online' })
  })
})

describe('directory IPC', () => {
  it('validates renderer input and refuses requests while locked', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const service = { snapshot: vi.fn(), search: vi.fn(), expandGroup: vi.fn(), refresh: vi.fn(), grantAccess: vi.fn(), refreshDue: vi.fn() }
    let locked = false
    const registration = registerDirectory({ ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler) } } as never, service: () => service as never, locked: () => locked, timers: false })
    const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
    await call('directory:search', { query: 'ada', kinds: ['person', 'room'], limit: 5, mode: 'offline', accountIds: ['a'] })
    expect(service.search).toHaveBeenCalledWith({ query: 'ada', kinds: ['person', 'room'], limit: 5, mode: 'offline', accountIds: ['a'] })
    expect(() => call('directory:search', { query: 'x'.repeat(201) })).toThrow()
    expect(() => call('directory:search', { query: 'ada', kinds: ['printer'] })).toThrow(/entry types/)
    expect(() => call('directory:search', { query: 'ada', limit: 1_000 })).toThrow()
    expect(() => call('directory:grant', 'a', 'everything')).toThrow()
    expect(() => call('directory:expand-group', '', 'g@contoso.com')).toThrow(/Choose an account/)
    await call('directory:grant', 'a', 'resources')
    expect(service.grantAccess).toHaveBeenCalledWith('a', 'resources')
    locked = true
    for (const channel of ['directory:snapshot', 'directory:search', 'directory:refresh', 'directory:grant', 'directory:expand-group']) expect(() => call(channel, 'a', 'g@contoso.com')).toThrow('Unlock Aerio first')
    await registration.check()
    expect(service.refreshDue).not.toHaveBeenCalled()
    locked = false
    await registration.check()
    expect(service.refreshDue).toHaveBeenCalledTimes(1)
    registration.dispose()
    expect(validateDirectorySearch({ query: 'a' })).toEqual({ query: 'a' })
  })

  it('merges entries for one address, keeping the more specific kind', () => {
    const base = { accountId: 'a', backend: 'microsoft-graph' as const, name: 'Ops', email: 'ops@contoso.com' }
    expect(mergeEntries([{ ...base, id: '1', kind: 'person' }, { ...base, id: '2', kind: 'group', title: 'x', expandable: true }])).toEqual([{ ...base, id: '1', kind: 'group', title: 'x', expandable: true }])
  })
})

describe('profile backups', () => {
  it('leave the rebuildable directory cache out and say so in the manifest exclusions', async () => {
    const { PROFILE_BACKUP_LAYOUT } = await import('../profile-backup-layout')
    const { PROFILE_BACKUP_EXCLUSIONS } = await import('../profile-backup')
    expect(PROFILE_BACKUP_LAYOUT.databases.map((database) => database.file)).not.toContain('directory.sqlite')
    expect(PROFILE_BACKUP_EXCLUSIONS.join(' ')).toContain('directory.sqlite')
  })
})
