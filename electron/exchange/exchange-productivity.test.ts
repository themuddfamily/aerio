import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { CalendarEvent, Contact } from '../../src/types'
import { ProductivityStore } from '../productivity/store'
import { EwsClient } from './ews-client'
import { calendarProps, contactProps, EwsFixtureServer } from './ews-fixture-server'
import { EwsAuthError } from './ews-transport'
import { ExchangeProductivityService } from './exchange-productivity'
import { ExchangeStore, prepareRestoredExchangeDatabase } from './exchange-store'

const ACCOUNT = 'exchange-1'
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

async function harness(options: { pageSize?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-ews-prod-'))
  const server = await new EwsFixtureServer({ auth: 'ntlm' }).start()
  const productivity = new ProductivityStore(join(directory, 'productivity.sqlite'))
  let store = new ExchangeStore(join(directory, 'exchange.sqlite'))
  let online = true
  const clients: EwsClient[] = []
  const make = () => new ExchangeProductivityService({
    store, productivity: () => productivity, online: () => online, pageSize: options.pageSize,
    client: () => { const client = new EwsClient({ url: server.url, credentials: { auth: 'ntlm', username: 'CONTOSO\\ada', password: 'Pa55w0rd!' }, sleep: async () => undefined }); clients.push(client); return client }
  })
  let service = make()
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }), () => server.stop(), () => productivity.close(), () => store.close(), () => { for (const client of clients) client.close() })
  service.addAccount(ACCOUNT, '15.2.1118.7 (Exchange 2019)')
  return {
    server, productivity, directory,
    get service() { return service },
    get store() { return store },
    setOnline(value: boolean) { online = value },
    /** Simulates an app restart: new store connection, new service. */
    restart() { store.close(); store = new ExchangeStore(join(directory, 'exchange.sqlite')); service = make(); return service },
    snapshot: () => productivity.snapshot(),
    event: (title: string) => productivity.snapshot().events.find((event) => event.title === title),
    contact: (name: string) => productivity.snapshot().contacts.find((contact) => contact.name === name)
  }
}

const draft = (calendarId: string, overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'new-event', calendarId, title: 'Planning', start: '2026-10-21T09:00:00.000Z', end: '2026-10-21T10:00:00.000Z', color: '#000000', attendees: [], reminderMinutes: 15, ...overrides
})
const person = (overrides: Partial<Contact> = {}): Contact => ({ id: 'new-contact', name: 'Katherine Johnson', email: 'kj@contoso.test', group: 'Contacts', favorite: false, color: '#000', ...overrides })
const WEEKLY = '<t:Recurrence><t:WeeklyRecurrence><t:Interval>1</t:Interval><t:DaysOfWeek>Monday Wednesday</t:DaysOfWeek><t:FirstDayOfWeek>Monday</t:FirstDayOfWeek></t:WeeklyRecurrence><t:NumberedRecurrence><t:StartDate>2026-10-05Z</t:StartDate><t:NumberOfOccurrences>6</t:NumberOfOccurrences></t:NumberedRecurrence></t:Recurrence>'

describe('Exchange Calendar and Contacts synchronization', () => {
  it('discovers calendar and contacts folders with write capability and maps items into the productivity store', async () => {
    const h = await harness()
    const shared = h.server.addFolder('Team calendar', 'IPF.Appointment')
    shared.canWrite = false
    h.server.addItem(h.server.folder('calendar').id, 'calendar', calendarProps({ subject: 'Standup', start: '2026-10-05T09:00:00Z', end: '2026-10-05T09:15:00Z', location: 'Room 1', body: 'Daily', attendees: ['grace@contoso.test'], recurrence: WEEKLY }))
    h.server.addItem(shared.id, 'calendar', calendarProps({ subject: 'Team offsite', start: '2026-10-09T09:00:00Z', end: '2026-10-09T17:00:00Z' }))
    h.server.addItem(h.server.folder('contacts').id, 'contact', contactProps({ name: 'Grace Hopper', given: 'Grace', surname: 'Hopper', email: 'grace@contoso.test', phone: '+1 555 0100', company: 'Navy' }))
    await h.service.sync(ACCOUNT)
    const snapshot = h.snapshot()
    expect(snapshot.calendars.map((calendar) => [calendar.name, calendar.provider, calendar.canWrite, calendar.primary]).sort()).toEqual([['Calendar', 'exchange', true, true], ['Team calendar', 'exchange', false, false]])
    expect(h.event('Standup')).toMatchObject({ provider: 'exchange', start: '2026-10-05T09:00:00.000Z', location: 'Room 1', description: 'Daily', attendees: ['grace@contoso.test'], recurrenceRule: 'FREQ=WEEKLY;COUNT=6;BYDAY=MO,WE', readOnly: false })
    expect(h.event('Team offsite')).toMatchObject({ readOnly: true })
    expect(h.contact('Grace Hopper')).toMatchObject({ provider: 'exchange', email: 'grace@contoso.test', phone: '+1 555 0100', company: 'Navy', readOnly: false })
    expect(h.contact('Grace Hopper')?.revision).toMatch(/^ck/)
    expect(h.service.writableFolders(ACCOUNT).map((folder) => folder.kind).sort()).toEqual(['calendar', 'contacts'])
  })

  it('pages SyncFolderItems, keeps per-folder checkpoints, and restarts a folder after an invalid sync state', async () => {
    const h = await harness({ pageSize: 2 })
    const calendar = h.server.folder('calendar')
    const items = Array.from({ length: 5 }, (_, index) => h.server.addItem(calendar.id, 'calendar', calendarProps({ subject: `Event ${index}`, start: `2026-10-1${index}T09:00:00Z`, end: `2026-10-1${index}T10:00:00Z` })))
    await h.service.sync(ACCOUNT)
    expect(h.snapshot().events).toHaveLength(5)
    const calendarPulls = () => h.server.log.filter((entry) => entry.operation === 'SyncFolderItems' && entry.body.includes(calendar.id))
    expect(calendarPulls().length).toBe(3)
    const before = calendarPulls().length
    h.server.touch(items[0].id, (item) => item.props.set('Subject', '<t:Subject>Renamed elsewhere</t:Subject>'))
    await h.service.sync(ACCOUNT)
    expect(calendarPulls().slice(before)[0].body).toContain('<m:SyncState>')
    expect(h.event('Renamed elsewhere')).toBeTruthy()
    h.server.invalidateSyncStates()
    h.server.items.delete(items[1].id)
    await h.service.sync(ACCOUNT)
    expect(h.snapshot().events.map((event) => event.title).sort()).toEqual(['Event 2', 'Event 3', 'Event 4', 'Renamed elsewhere'])
  })
})

describe('Exchange Calendar and Contacts writes', () => {
  it('creates, updates with the ChangeKey, and deletes events', async () => {
    const h = await harness()
    await h.service.sync(ACCOUNT)
    const calendar = h.snapshot().calendars.find((item) => item.primary)!
    await h.service.createEvent(calendar, draft(calendar.id, { location: 'Room 4' }))
    const create = h.server.log.find((entry) => entry.operation === 'CreateItem')!
    expect(create.body).toContain('SendMeetingInvitations="SendToNone"')
    expect(create.body).toContain('<t:StartTimeZone Id=')
    const created = h.event('Planning')!
    expect(created.remoteId).toMatch(/^C/)
    expect(h.service.pendingWrites(ACCOUNT)).toBe(0)
    await h.service.updateEvent(created, { ...created, title: 'Planning (moved)', start: '2026-10-21T11:00:00.000Z', end: '2026-10-21T12:00:00.000Z' })
    const update = h.server.log.filter((entry) => entry.operation === 'UpdateItem').at(-1)!
    expect(update.body).toContain('ConflictResolution="NeverOverwrite"')
    expect(update.body).toMatch(/<t:ItemId Id="[^"]+" ChangeKey="ck\d+"\/>/)
    expect(update.body).toContain('item:Subject')
    expect(update.body).not.toContain('calendar:Location')
    expect(h.event('Planning (moved)')).toMatchObject({ start: '2026-10-21T11:00:00.000Z' })
    await h.service.deleteEvent(h.event('Planning (moved)')!)
    expect(h.server.items.has(created.remoteId)).toBe(false)
    expect(h.event('Planning (moved)')).toBeUndefined()
  })

  it('sends a stale edit to conflict review on ErrorIrresolvableConflict and resolves it either way', async () => {
    const h = await harness()
    const item = h.server.addItem(h.server.folder('calendar').id, 'calendar', calendarProps({ subject: 'Budget review', start: '2026-10-22T09:00:00Z', end: '2026-10-22T10:00:00Z' }))
    await h.service.sync(ACCOUNT)
    const synced = h.event('Budget review')!
    h.server.touch(item.id, (value) => value.props.set('Subject', '<t:Subject>Budget review (server)</t:Subject>'))
    await h.service.updateEvent(synced, { ...synced, title: 'Budget review (mine)' })
    const [review] = h.service.review()
    expect(review).toMatchObject({ kind: 'event', action: 'update', status: 'conflict', title: 'Budget review (mine)', serverTitle: 'Budget review (server)', serverDeleted: false })
    // Nothing was overwritten, the local version stays visible, and further edits wait for a decision.
    expect(h.server.items.get(item.id)?.props.get('Subject')).toContain('(server)')
    expect(h.event('Budget review (mine)')).toBeTruthy()
    await expect(h.service.updateEvent(h.event('Budget review (mine)')!, { ...synced, title: 'Again' })).rejects.toThrow(/conflict/)
    await h.service.resolve(review.id, 'keep-local')
    expect(h.server.items.get(item.id)?.props.get('Subject')).toContain('(mine)')
    expect(h.service.review()).toEqual([])

    h.server.touch(item.id, (value) => value.props.set('Location', '<t:Location>Elsewhere</t:Location>'))
    const current = h.event('Budget review (mine)')!
    await h.service.updateEvent(current, { ...current, title: 'Budget review (second)' })
    const [second] = h.service.review()
    await h.service.resolve(second.id, 'keep-server')
    expect(h.event('Budget review (mine)')).toMatchObject({ location: 'Elsewhere' })
    expect(h.service.review()).toEqual([])
  })

  it('treats a delete of an item changed on the server as a conflict', async () => {
    const h = await harness()
    const item = h.server.addItem(h.server.folder('contacts').id, 'contact', contactProps({ name: 'Edsger Dijkstra', email: 'ewd@contoso.test' }))
    await h.service.sync(ACCOUNT)
    h.server.touch(item.id, (value) => value.props.set('CompanyName', '<t:CompanyName>Burroughs</t:CompanyName>'))
    await h.service.deleteContact(h.contact('Edsger Dijkstra')!)
    expect(h.server.items.has(item.id)).toBe(true)
    expect(h.service.review()[0]).toMatchObject({ kind: 'contact', action: 'delete', status: 'conflict' })
  })

  it('creates and edits contacts, writing only changed fields with indexed email updates', async () => {
    const h = await harness()
    await h.service.sync(ACCOUNT)
    const created = await h.service.createContact(ACCOUNT, person({ phone: '+1 555 0101', company: 'NASA' }))
    expect(created).toMatchObject({ name: 'Katherine Johnson', provider: 'exchange' })
    const create = h.server.log.find((entry) => entry.operation === 'CreateItem')!.body
    expect(create).toContain('<t:Entry Key="EmailAddress1">kj@contoso.test</t:Entry>')
    expect(create).toContain('<t:Entry Key="MobilePhone">+1 555 0101</t:Entry>')
    const synced = h.contact('Katherine Johnson')!
    await h.service.updateContact(synced, { ...synced, email: 'katherine@contoso.test' })
    const update = h.server.log.filter((entry) => entry.operation === 'UpdateItem').at(-1)!.body
    expect(update).toContain('FieldIndex="EmailAddress1"')
    expect(update).not.toContain('contacts:CompanyName')
    expect(h.contact('Katherine Johnson')).toMatchObject({ email: 'katherine@contoso.test', company: 'NASA' })
  })

  it('keeps writes in a durable queue while offline and across a restart, then sends them in order', async () => {
    const h = await harness()
    await h.service.sync(ACCOUNT)
    const calendar = h.snapshot().calendars.find((item) => item.primary)!
    h.setOnline(false)
    await h.service.createEvent(calendar, draft(calendar.id, { title: 'Written offline' }))
    expect(h.event('Written offline')).toMatchObject({ provider: 'exchange' })
    expect(h.service.pendingWrites(ACCOUNT)).toBe(1)
    expect(h.server.operations()).not.toContain('CreateItem')
    const restarted = h.restart()
    expect(restarted.pendingWrites(ACCOUNT)).toBe(1)
    h.setOnline(true)
    await restarted.flushAll()
    expect(restarted.pendingWrites(ACCOUNT)).toBe(0)
    expect(h.server.operations().filter((operation) => operation === 'CreateItem')).toHaveLength(1)
    expect(h.event('Written offline')?.remoteId).toMatch(/^C/)
  })

  it('marks the account for re-authentication when the session expires and resumes after new credentials', async () => {
    const h = await harness()
    await h.service.sync(ACCOUNT)
    h.server.expireSessions()
    await expect(h.service.sync(ACCOUNT)).rejects.toBeInstanceOf(EwsAuthError)
    expect(h.store.account(ACCOUNT)).toMatchObject({ status: 'needs-auth' })
    expect(h.snapshot().sync.find((state) => state.accountId === ACCOUNT)).toMatchObject({ phase: 'error' })
    // Writes made meanwhile are queued, not sent with failing credentials.
    const calendar = h.snapshot().calendars.find((item) => item.primary)!
    await h.service.createEvent(calendar, draft(calendar.id, { title: 'During expiry' }))
    expect(h.service.pendingWrites(ACCOUNT)).toBe(1)
    h.server.expireSessions(false)
    await h.service.credentialsUpdated(ACCOUNT)
    expect(h.store.account(ACCOUNT)).toMatchObject({ status: 'ready' })
    expect(h.service.pendingWrites(ACCOUNT)).toBe(0)
  })

  it('deletes and edits one generated occurrence through OccurrenceItemId and edits the whole series', async () => {
    const h = await harness()
    h.server.addItem(h.server.folder('calendar').id, 'calendar', calendarProps({ subject: 'Standup', start: '2026-10-05T09:00:00Z', end: '2026-10-05T09:15:00Z', recurrence: WEEKLY }))
    await h.service.sync(ACCOUNT)
    const master = h.event('Standup')!
    const target = h.service.occurrenceTarget(`${master.id}::${Date.parse('2026-10-07T09:00:00Z')}`)!
    expect(target.originalStart).toBe('2026-10-07T09:00:00.000Z')
    await h.service.changeOccurrence(target.master, target.originalStart)
    expect(h.server.deletedOccurrences).toEqual([{ masterId: master.remoteId, instanceIndex: 2 }])
    expect(h.server.log.filter((entry) => entry.operation === 'DeleteItem').at(-1)?.body).toContain('AffectedTaskOccurrences="SpecifiedOccurrenceOnly"')
    await expect(h.service.writeSeries(master, 'following', { ...master })).rejects.toThrow(/cannot split a repeating series/)
    await h.service.writeSeries(h.event('Standup')!, 'series', { ...h.event('Standup')!, title: 'Daily standup' })
    expect(h.event('Daily standup')).toMatchObject({ recurrenceRule: master.recurrenceRule })
  })

  it('holds queued writes after a profile restore so they are not resent silently', async () => {
    const h = await harness()
    await h.service.sync(ACCOUNT)
    const calendar = h.snapshot().calendars.find((item) => item.primary)!
    h.setOnline(false)
    await h.service.createEvent(calendar, draft(calendar.id, { title: 'Before backup' }))
    const db = new DatabaseSync(join(h.directory, 'exchange.sqlite'))
    expect(prepareRestoredExchangeDatabase(db)).toEqual({ held: 1, accounts: 1 })
    db.close()
    const restored = h.restart()
    expect(restored.review()).toEqual([expect.objectContaining({ status: 'held', title: 'Before backup' })])
  })
})
