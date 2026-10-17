import { afterEach, describe, expect, it } from 'vitest'
import type { CalendarEvent, Contact } from '../../src/types'
import { ICS, VCF } from './dav-fixture-server'
import { createDavHarness, type DavHarness } from './dav-test-harness'

let harness: DavHarness | undefined
afterEach(async () => { await harness?.close(); harness = undefined })

const draft = (calendarId: string, overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'event-new', calendarId, title: 'Planning', start: '2026-10-21T09:00:00.000Z', end: '2026-10-21T10:00:00.000Z',
  color: '#000000', attendees: [], reminderMinutes: 0, ...overrides
})
const person = (overrides: Partial<Contact> = {}): Contact => ({ id: 'contact-new', name: 'Katherine Johnson', email: 'kj@example.com', group: 'Contacts', favorite: false, color: '#4d8f78', ...overrides })

async function ready(options = {}) {
  harness = await createDavHarness(options)
  const account = await harness.add()
  const calendar = harness.productivity.snapshot().calendars.find((item) => item.name === 'Work')!
  return { h: harness, account, calendar }
}

const eventNamed = (h: DavHarness, title: string) => h.productivity.snapshot().events.find((event) => event.title === title)

describe('CalDAV/CardDAV writes', () => {
  it('creates events with If-None-Match: * and shows them at once', async () => {
    const { h, calendar } = await ready()
    await h.service.createEvent(calendar, draft(calendar.id))
    const put = h.requests('PUT')[0]
    expect(put.headers['if-none-match']).toBe('*')
    expect(put.headers['content-type']).toMatch(/text\/calendar/)
    expect(put.body).toContain('SUMMARY:Planning')
    const event = eventNamed(h, 'Planning')!
    expect(event).toMatchObject({ provider: 'dav', calendarId: calendar.id, readOnly: false })
    expect(h.work.resources.size).toBe(1)
    expect(h.service.snapshot().accounts[0].pendingWrites).toBe(0)
  })

  it('updates with If-Match and keeps properties Aerio does not edit', async () => {
    const { h, account, calendar } = await ready()
    h.server.write(h.work, 'sync.ics', ICS('sync', 'Sync', 'ORGANIZER;CN=Ada:mailto:ada@example.com\nATTENDEE;CN=Grace;PARTSTAT=ACCEPTED:mailto:grace@example.com\nX-CUSTOM:keep me\nSEQUENCE:2\nBEGIN:VALARM\nACTION:AUDIO\nTRIGGER:-PT5M\nEND:VALARM'))
    await h.service.sync(account.id)
    const current = eventNamed(h, 'Sync')!
    const etag = h.work.resources.get('sync.ics')!.etag
    await h.service.updateEvent(current, { ...current, title: 'Sync (moved)', start: '2026-10-20T11:00:00.000Z', end: '2026-10-20T12:00:00.000Z' })
    const put = h.requests('PUT').at(-1)!
    expect(put.headers['if-match']).toBe(etag)
    const stored = h.work.resources.get('sync.ics')!.data
    expect(stored).toContain('SUMMARY:Sync (moved)')
    expect(stored).toContain('X-CUSTOM:keep me')
    expect(stored).toContain('ORGANIZER;CN=Ada:mailto:ada@example.com')
    expect(stored).toContain('PARTSTAT=ACCEPTED')
    expect(stored).toContain('ACTION:AUDIO')
    expect(stored).toContain('SEQUENCE:3')
    expect(stored).toContain('UID:sync')
    expect(eventNamed(h, 'Sync (moved)')!.start).toBe('2026-10-20T11:00:00.000Z')
  })

  it('deletes with If-Match, and deleting one occurrence adds an EXDATE instead', async () => {
    const { h, account } = await ready()
    h.server.write(h.work, 'gone.ics', ICS('gone', 'Gone soon'))
    h.server.write(h.work, 'weekly.ics', [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:weekly', 'DTSTART:20261019T090000Z', 'DTEND:20261019T093000Z', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Weekly', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:weekly', 'RECURRENCE-ID:20261026T090000Z', 'DTSTART:20261026T100000Z', 'DTEND:20261026T103000Z', 'SUMMARY:Weekly (late)', 'END:VEVENT', 'END:VCALENDAR', ''
    ].join('\r\n'))
    await h.service.sync(account.id)
    await h.service.deleteEvent(eventNamed(h, 'Gone soon')!)
    expect(h.requests('DELETE')[0].headers['if-match']).toMatch(/^"e\d+"$/)
    expect(h.work.resources.has('gone.ics')).toBe(false)

    await h.service.deleteEvent(eventNamed(h, 'Weekly (late)')!)
    const weekly = h.work.resources.get('weekly.ics')!.data
    expect(weekly).toContain('EXDATE:20261026T090000Z')
    expect(weekly).not.toContain('Weekly (late)')
    expect(eventNamed(h, 'Weekly')!.recurrenceExceptions).toEqual(['2026-10-26T09:00:00.000Z'])
  })

  it('refuses writes to read-only collections without contacting the server', async () => {
    const { h, account } = await ready()
    h.server.write(h.holidays, 'day.ics', ICS('day', 'Holiday'))
    await h.service.sync(account.id)
    const holidays = h.productivity.snapshot().calendars.find((item) => item.name === 'Holidays')!
    const writes = () => h.requests().filter((request) => request.method === 'PUT' || request.method === 'DELETE').length
    await expect(h.service.createEvent(holidays, draft(holidays.id))).rejects.toThrow(/read-only/)
    await expect(h.service.updateEvent(eventNamed(h, 'Holiday')!, { ...eventNamed(h, 'Holiday')!, title: 'x' })).rejects.toThrow(/read-only/)
    await expect(h.service.deleteEvent(eventNamed(h, 'Holiday')!)).rejects.toThrow(/read-only/)
    expect(writes()).toBe(0)
  })

  it('moves a write the server refuses (403) into review instead of dropping it', async () => {
    const { h, account } = await ready({ privileges: false })
    // Without a privilege set the shared calendar looks writable; the server still refuses.
    const holidays = h.productivity.snapshot().calendars.find((item) => item.name === 'Holidays')!
    await h.service.createEvent(holidays, draft(holidays.id, { title: 'Sneaky' }))
    const [item] = h.service.snapshot().review
    expect(item).toMatchObject({ status: 'failed', action: 'create', title: 'Sneaky', accountId: account.id })
    expect(item.error).toMatch(/read-only/)
    expect(eventNamed(h, 'Sneaky')).toBeDefined()
    await h.service.resolve(item.id, 'keep-server')
    expect(eventNamed(h, 'Sneaky')).toBeUndefined()
    expect(h.service.snapshot().review).toEqual([])
  })

  it('reads back the stored copy when the server rewrites the item and omits the ETag', async () => {
    const { h, calendar } = await ready({ rewriteOnPut: (data: string) => data.replace('SUMMARY:Planning', 'SUMMARY:Planning (server)') })
    await h.service.createEvent(calendar, draft(calendar.id))
    expect(h.requests('GET').length).toBeGreaterThan(0)
    expect(eventNamed(h, 'Planning (server)')).toBeDefined()
    const [resource] = h.store.resources(calendar.id)
    expect(resource.etag).toMatch(/^"e\d+"$/)
  })

  it('creates, updates, and deletes contacts while keeping vCard properties Aerio does not edit', async () => {
    const { h, account } = await ready()
    const created = await h.service.createContact(account.id, person())
    expect(created).toMatchObject({ name: 'Katherine Johnson', provider: 'dav', folderId: expect.any(String) })
    const createdPut = h.requests('PUT').at(-1)!
    expect(createdPut.headers['content-type']).toMatch(/text\/vcard/)
    expect(createdPut.body).not.toContain('CATEGORIES')

    h.server.write(h.contacts, 'photo.vcf', VCF('photo', 'Mary Jackson', 'PHOTO;ENCODING=b;TYPE=JPEG:AAAA\nX-SOCIALPROFILE:twitter\nEMAIL:mary@example.com'))
    await h.service.sync(account.id)
    const mary = h.productivity.snapshot().contacts.find((contact) => contact.name === 'Mary Jackson')!
    const updated = await h.service.updateContact(mary, { ...mary, title: 'Engineer' })
    expect(updated.title).toBe('Engineer')
    const stored = h.contacts.resources.get('photo.vcf')!.data
    expect(stored).toMatch(/^BEGIN:VCARD\r\nVERSION:3.0/)
    expect(stored).toContain('PHOTO;ENCODING=b;TYPE=JPEG:AAAA')
    expect(stored).toContain('X-SOCIALPROFILE:twitter')
    expect(stored).toContain('TITLE:Engineer')
    expect(stored).toContain('UID:photo')

    await h.service.deleteContact(updated)
    expect(h.contacts.resources.has('photo.vcf')).toBe(false)
    expect(h.productivity.snapshot().contacts.map((contact) => contact.name)).toEqual(['Katherine Johnson'])
  })
})

describe('CalDAV/CardDAV offline queue', () => {
  it('queues writes while offline, coalesces them, and sends them in order when back online', async () => {
    const { h, calendar } = await ready()
    h.state.online = false
    const mark = h.requests().length
    await h.service.createEvent(calendar, draft(calendar.id, { title: 'Offline one' }))
    const pending = eventNamed(h, 'Offline one')!
    await h.service.updateEvent(pending, { ...pending, title: 'Offline renamed' })
    expect(h.server.requests.length).toBe(mark)
    expect(h.service.snapshot().accounts[0].pendingWrites).toBe(1)
    expect(eventNamed(h, 'Offline renamed')).toBeDefined()

    // A queued create that is deleted before it was sent never reaches the server.
    await h.service.createEvent(calendar, draft(calendar.id, { title: 'Never sent' }))
    await h.service.deleteEvent(eventNamed(h, 'Never sent')!)
    expect(h.service.snapshot().accounts[0].pendingWrites).toBe(1)

    h.state.online = true
    await h.service.flushAll()
    const puts = h.requests('PUT')
    expect(puts).toHaveLength(1)
    expect(puts[0].headers['if-none-match']).toBe('*')
    expect(puts[0].body).toContain('SUMMARY:Offline renamed')
    expect(h.service.snapshot().accounts[0].pendingWrites).toBe(0)
  })

  it('keeps writes queued with backoff on network failures and server errors', async () => {
    const { h, calendar } = await ready()
    h.state.fetch = async () => { throw new TypeError('fetch failed') }
    await h.service.createEvent(calendar, draft(calendar.id, { title: 'Unreachable' }))
    let [operation] = h.store.operations()
    expect(operation).toMatchObject({ status: 'queued', attempts: 1 })
    expect(operation.error).toMatch(/could not be reached/)
    expect(Date.parse(operation.nextAttemptAt!)).toBeGreaterThan(Date.now())
    h.state.fetch = undefined
    // Not yet due: the backoff holds the write.
    await h.service.flushAll()
    expect(h.requests('PUT')).toHaveLength(0)
    h.store.saveOperation({ ...operation, nextAttemptAt: undefined })
    h.server.failures.PUT = [503]
    await h.service.flushAll()
    ;[operation] = h.store.operations()
    expect(operation).toMatchObject({ status: 'queued', attempts: 2 })
    h.store.saveOperation({ ...operation, nextAttemptAt: undefined })
    await h.service.flushAll()
    expect(h.store.operations()).toEqual([])
    expect(h.work.resources.size).toBe(1)
  })

  it('durably keeps queued writes across a restart of the store', async () => {
    const { h, calendar } = await ready()
    h.state.online = false
    await h.service.createEvent(calendar, draft(calendar.id, { title: 'Survives' }))
    // The projection is rebuilt from the durable queue, not from memory.
    h.productivity.removeAccount(calendar.accountId)
    h.service.project(calendar.accountId)
    expect(eventNamed(h, 'Survives')).toBeDefined()
    h.state.online = true
    await h.service.sync(calendar.accountId)
    expect([...h.work.resources.values()][0].data).toContain('SUMMARY:Survives')
  })
})

describe('CalDAV/CardDAV conflicts', () => {
  async function conflicted() {
    const { h, account } = await ready()
    h.server.write(h.work, 'shared.ics', ICS('shared', 'Original'))
    await h.service.sync(account.id)
    const current = eventNamed(h, 'Original')!
    // Another client edits the same event before Aerio's change is sent.
    h.server.write(h.work, 'shared.ics', ICS('shared', 'Their edit'))
    await h.service.updateEvent(current, { ...current, title: 'My edit' })
    return { h, account }
  }

  it('turns a 412 into a review item and never overwrites the server copy', async () => {
    const { h, account } = await conflicted()
    expect(h.requests('PUT').at(-1)!.headers['if-match']).toBeDefined()
    expect(h.work.resources.get('shared.ics')!.data).toContain('SUMMARY:Their edit')
    const [item] = h.service.snapshot().review
    expect(item).toMatchObject({ status: 'conflict', title: 'My edit', serverTitle: 'Their edit', serverDeleted: false })
    // The local version stays visible until the user decides.
    expect(eventNamed(h, 'My edit')).toBeDefined()
    // Further edits wait for the decision, and a sync does not resend it.
    await expect(h.service.updateEvent(eventNamed(h, 'My edit')!, { ...eventNamed(h, 'My edit')!, title: 'again' })).rejects.toThrow(/conflict/)
    const puts = h.requests('PUT').length
    await h.service.sync(account.id)
    expect(h.requests('PUT')).toHaveLength(puts)
    expect(h.work.resources.get('shared.ics')!.data).toContain('SUMMARY:Their edit')
  })

  it('keeps the server version when chosen', async () => {
    const { h } = await conflicted()
    await h.service.resolve(h.service.snapshot().review[0].id, 'keep-server')
    expect(eventNamed(h, 'Their edit')).toBeDefined()
    expect(eventNamed(h, 'My edit')).toBeUndefined()
    expect(h.work.resources.get('shared.ics')!.data).toContain('SUMMARY:Their edit')
  })

  it('sends the local version against the server revision when chosen, still conditionally', async () => {
    const { h } = await conflicted()
    const serverEtag = h.work.resources.get('shared.ics')!.etag
    await h.service.resolve(h.service.snapshot().review[0].id, 'keep-local')
    const put = h.requests('PUT').at(-1)!
    expect(put.headers['if-match']).toBe(serverEtag)
    expect(h.work.resources.get('shared.ics')!.data).toContain('SUMMARY:My edit')
    expect(h.service.snapshot().review).toEqual([])
  })

  it('reports an item deleted on the server and can recreate it', async () => {
    const { h, account } = await ready()
    h.server.write(h.contacts, 'gone.vcf', VCF('gone', 'Dorothy Vaughan'))
    await h.service.sync(account.id)
    const dorothy = h.productivity.snapshot().contacts[0]
    h.server.remove(h.contacts, 'gone.vcf')
    await h.service.updateContact(dorothy, { ...dorothy, title: 'Supervisor' })
    const [item] = h.service.snapshot().review
    expect(item).toMatchObject({ status: 'conflict', serverDeleted: true, kind: 'contact' })
    await h.service.resolve(item.id, 'keep-local')
    expect(h.requests('PUT').at(-1)!.headers['if-none-match']).toBe('*')
    expect(h.contacts.resources.get('gone.vcf')!.data).toContain('TITLE:Supervisor')
  })

  it('treats a delete that races a server change as a conflict', async () => {
    const { h, account } = await ready()
    h.server.write(h.work, 'race.ics', ICS('race', 'Race'))
    await h.service.sync(account.id)
    const race = eventNamed(h, 'Race')!
    h.server.write(h.work, 'race.ics', ICS('race', 'Race updated'))
    await h.service.deleteEvent(race)
    expect(h.work.resources.has('race.ics')).toBe(true)
    const [item] = h.service.snapshot().review
    expect(item).toMatchObject({ action: 'delete', status: 'conflict' })
    // The deleted event stays hidden locally until the decision.
    expect(eventNamed(h, 'Race updated')).toBeUndefined()
    await h.service.resolve(item.id, 'keep-server')
    expect(eventNamed(h, 'Race updated')).toBeDefined()
  })

  it('rejects unknown review ids and resolutions', async () => {
    const { h } = await conflicted()
    expect(() => h.service.resolve('missing', 'keep-server')).toThrow(/no longer needs review/)
    expect(() => h.service.resolve(h.service.snapshot().review[0].id, 'merge' as never)).toThrow(/Choose how/)
  })
})
