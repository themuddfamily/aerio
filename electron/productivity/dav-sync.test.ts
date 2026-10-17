import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ICS, VCF, DavFixtureServer } from './dav-fixture-server'
import { createDavHarness, type DavHarness } from './dav-test-harness'
import { DavClient } from './dav-client'
import { discoverAccount } from './dav-discovery'

let harness: DavHarness | undefined
afterEach(async () => { await harness?.close(); harness = undefined })

const reports = (h: DavHarness, root: string) => h.requests('REPORT').filter((request) => request.body.includes(root))

describe('CalDAV/CardDAV discovery and capabilities', () => {
  it('discovers through .well-known and current-user-principal, and reports read-only, shared, and component sets', async () => {
    harness = await createDavHarness()
    const account = await harness.add()
    expect(harness.requests().some((request) => request.path === '/.well-known/caldav')).toBe(true)
    expect(account.calendarHomeUrl).toBe(`${harness.server.url}calendars/ada@example.com/`)
    const collections = harness.service.snapshot().collections
    const byName = Object.fromEntries(collections.map((collection) => [collection.name, collection]))
    expect(byName.Work).toMatchObject({ kind: 'calendar', readOnly: false, shared: false, color: '#aa3300', components: ['VEVENT'], syncMode: 'sync-collection' })
    expect(byName.Holidays).toMatchObject({ readOnly: true, shared: true })
    expect(byName.Reminders.components).toEqual(['VTODO'])
    expect(byName.Contacts).toMatchObject({ kind: 'addressbook', readOnly: false })
    // Tasks-only calendars are listed for transparency but do not become event calendars.
    const calendars = harness.productivity.snapshot().calendars
    expect(calendars.map((calendar) => calendar.name).sort()).toEqual(['Holidays', 'Work'])
    expect(calendars.find((calendar) => calendar.name === 'Holidays')).toMatchObject({ canWrite: false, provider: 'dav' })
    expect(calendars.find((calendar) => calendar.name === 'Work')).toMatchObject({ canWrite: true, primary: true })
  })

  it('stores the app password only through secure storage and rejects bad credentials before saving anything', async () => {
    harness = await createDavHarness()
    await expect(harness.add({ password: 'wrong' })).rejects.toThrow(/rejected the user name or app password/)
    expect(harness.service.snapshot().accounts).toEqual([])
    const account = await harness.add()
    const file = readFileSync(join(harness.directory, 'dav-credentials.dat'), 'utf8')
    expect(file).not.toContain('app-password')
    expect(harness.credentials.password(account.id)).toBe('app-password')
    expect(JSON.stringify(harness.service.snapshot())).not.toContain('app-password')
    await expect(harness.add()).rejects.toThrow(/already connected/)
  })

  it('refuses plain HTTP to non-loopback servers and embedded credentials', async () => {
    harness = await createDavHarness()
    await expect(harness.add({ serverUrl: 'http://dav.example.com/' })).rejects.toThrow(/must use https/)
    await expect(harness.add({ serverUrl: 'https://ada:secret@dav.example.com/' })).rejects.toThrow(/Remove the user name/)
  })

  it('discovers calendars and contacts on separate hosts (iCloud and Fastmail layout)', async () => {
    const calendars = await new DavFixtureServer({ wellKnown: false }).start()
    const contacts = await new DavFixtureServer().start()
    try {
      calendars.addCollection({ slug: 'home', kind: 'calendar', name: 'Home', components: ['VEVENT', 'VTODO'] })
      contacts.addCollection({ slug: 'card', kind: 'addressbook', name: 'Card' })
      const client = new DavClient({ username: 'ada@example.com', password: 'app-password' })
      const result = await discoverAccount(client, { calendar: [calendars.url], contacts: [contacts.url] })
      expect(result.collections.map((collection) => [collection.kind, collection.name, new URL(collection.url).port])).toEqual([
        ['calendar', 'Home', new URL(calendars.url).port], ['addressbook', 'Card', new URL(contacts.url).port]
      ])
      // Without .well-known the given root is asked for current-user-principal directly.
      expect(calendars.requests.some((request) => request.method === 'PROPFIND' && request.path === '/')).toBe(true)
    } finally {
      await calendars.stop()
      await contacts.stop()
    }
  })
})

describe('CalDAV/CardDAV incremental synchronization', () => {
  it('pulls with sync-collection and multiget, then fetches only what changed', async () => {
    harness = await createDavHarness()
    harness.server.write(harness.work, 'standup.ics', ICS('standup', 'Standup'))
    harness.server.write(harness.holidays, 'new-year.ics', ICS('new-year', 'New Year'))
    harness.server.write(harness.contacts, 'grace.vcf', VCF('grace', 'Grace Hopper', 'EMAIL;TYPE=work:grace@example.com'))
    const account = await harness.add()
    const first = harness.productivity.snapshot()
    expect(first.events.map((event) => event.title).sort()).toEqual(['New Year', 'Standup'])
    expect(first.events.find((event) => event.title === 'New Year')!.readOnly).toBe(true)
    expect(first.contacts).toMatchObject([{ name: 'Grace Hopper', email: 'grace@example.com', provider: 'dav', readOnly: false }])
    expect(first.contacts[0].revision).toMatch(/^"e\d+"$/)
    expect(reports(harness, 'calendar-multiget').length).toBeGreaterThan(0)

    const before = harness.requests().length
    await harness.service.sync(account.id)
    const quiet = harness.server.requests.slice(before)
    expect(quiet.filter((request) => request.body.includes('multiget'))).toEqual([])
    expect(quiet.filter((request) => request.method === 'GET')).toEqual([])

    harness.server.write(harness.work, 'review.ics', ICS('review', 'Review'))
    harness.server.remove(harness.work, 'standup.ics')
    const mark = harness.requests().length
    await harness.service.sync(account.id)
    const multiget = harness.server.requests.slice(mark).filter((request) => request.body.includes('calendar-multiget'))
    expect(multiget).toHaveLength(1)
    expect(multiget[0].body).toContain('review.ics')
    expect(multiget[0].body).not.toContain('new-year.ics')
    expect(harness.productivity.snapshot().events.map((event) => event.title).sort()).toEqual(['New Year', 'Review'])
  })

  it('restarts from an empty token when the server invalidates the sync token', async () => {
    harness = await createDavHarness()
    harness.server.write(harness.work, 'a.ics', ICS('a', 'Alpha'))
    const account = await harness.add()
    harness.server.invalidateSyncTokens = true
    harness.server.write(harness.work, 'b.ics', ICS('b', 'Beta'))
    // A resource that vanished without a change-log entry is still removed by the full listing.
    harness.work.resources.delete('a.ics')
    await harness.service.sync(account.id)
    expect(harness.productivity.snapshot().events.map((event) => event.title)).toEqual(['Beta'])
    expect(harness.requests('REPORT').some((request) => request.body.includes('<d:sync-token></d:sync-token>'))).toBe(true)
  })

  it('follows truncated (507) sync-collection pages to the end', async () => {
    harness = await createDavHarness({ syncPageSize: 1 })
    for (const name of ['one', 'two', 'three']) harness.server.write(harness.work, `${name}.ics`, ICS(name, name))
    await harness.add()
    expect(harness.productivity.snapshot().events.map((event) => event.title).sort()).toEqual(['one', 'three', 'two'])
  })

  it('falls back to ctag and ETag comparison when sync-collection is unavailable', async () => {
    harness = await createDavHarness({ syncCollection: false })
    harness.server.write(harness.work, 'a.ics', ICS('a', 'Alpha'))
    const account = await harness.add()
    expect(harness.service.snapshot().collections.find((collection) => collection.name === 'Work')!.syncMode).toBe('ctag')
    expect(harness.productivity.snapshot().events.map((event) => event.title)).toContain('Alpha')

    const mark = harness.requests().length
    await harness.service.sync(account.id)
    const unchanged = harness.server.requests.slice(mark).filter((request) => request.path.endsWith('/work/'))
    // Unchanged ctag: one Depth 0 PROPFIND and no member listing.
    expect(unchanged.map((request) => [request.method, request.headers.depth])).toEqual([['PROPFIND', '0']])

    harness.server.write(harness.work, 'a.ics', ICS('a', 'Alpha renamed'))
    harness.server.write(harness.work, 'b.ics', ICS('b', 'Beta'))
    await harness.service.sync(account.id)
    expect(harness.productivity.snapshot().events.map((event) => event.title).sort()).toEqual(['Alpha renamed', 'Beta'])
    harness.server.remove(harness.work, 'a.ics')
    await harness.service.sync(account.id)
    expect(harness.productivity.snapshot().events.map((event) => event.title)).toEqual(['Beta'])
  })

  it('reads resources one at a time when multiget is unsupported', async () => {
    harness = await createDavHarness({ multiget: false })
    harness.server.write(harness.contacts, 'linus.vcf', VCF('linus', 'Linus Pauling'))
    await harness.add()
    expect(harness.productivity.snapshot().contacts.map((contact) => contact.name)).toEqual(['Linus Pauling'])
    expect(harness.requests('GET').some((request) => request.path.endsWith('linus.vcf'))).toBe(true)
  })

  it('treats a missing privilege set as writable and skips contact-group cards', async () => {
    harness = await createDavHarness({ privileges: false })
    harness.server.write(harness.contacts, 'group.vcf', VCF('group', 'Team', 'X-ADDRESSBOOKSERVER-KIND:group'))
    harness.server.write(harness.contacts, 'ada.vcf', VCF('ada', 'Ada Lovelace'))
    await harness.add()
    expect(harness.service.snapshot().collections.find((collection) => collection.name === 'Holidays')!.readOnly).toBe(false)
    expect(harness.productivity.snapshot().contacts.map((contact) => contact.name)).toEqual(['Ada Lovelace'])
  })

  it('keeps the last good cache and marks the account when the password stops working', async () => {
    harness = await createDavHarness()
    harness.server.write(harness.work, 'a.ics', ICS('a', 'Alpha'))
    const account = await harness.add()
    harness.credentials.save(account.id, 'revoked')
    await expect(harness.service.sync(account.id)).rejects.toThrow()
    expect(harness.service.snapshot().accounts[0]).toMatchObject({ status: 'needs-auth' })
    expect(harness.productivity.snapshot().events.map((event) => event.title)).toEqual(['Alpha'])
    expect(harness.productivity.snapshot().sync.filter((state) => state.accountId === account.id).every((state) => state.phase === 'error')).toBe(true)
    await harness.service.updatePassword(account.id, 'app-password')
    expect(harness.service.snapshot().accounts[0]).toMatchObject({ status: 'ready' })
  })

  it('removes calendars the server no longer lists and lets collections be hidden', async () => {
    harness = await createDavHarness()
    const account = await harness.add()
    const holidays = harness.service.snapshot().collections.find((collection) => collection.name === 'Holidays')!
    harness.service.setCollectionEnabled(holidays.id, false)
    expect(harness.productivity.snapshot().calendars.map((calendar) => calendar.name)).toEqual(['Work'])
    harness.server.collections.delete(harness.work.path)
    await harness.service.sync(account.id)
    expect(harness.service.snapshot().collections.map((collection) => collection.name)).not.toContain('Work')
    harness.service.removeAccount(account.id)
    expect(harness.service.snapshot().accounts).toEqual([])
    expect(harness.productivity.snapshot().calendars).toEqual([])
    expect(harness.credentials.has(account.id)).toBe(false)
  })
})
