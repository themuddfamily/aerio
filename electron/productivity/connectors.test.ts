import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SyncedCalendar, SyncedCalendarEvent, SyncedContact } from '../../src/productivity-types'
import { GoogleProductivityConnector, googleContactBody, googleEventBody, mapGoogleContact, mapGoogleEvent } from './google-connector'
import { MicrosoftProductivityConnector, mapMicrosoftContact, mapMicrosoftEvent, microsoftContactBody, microsoftEventBody } from './microsoft-connector'
import { ProductivityApiError, retryingJson } from './connector'

const googleCalendar: SyncedCalendar = {
  id: 'a:google-calendar:primary', remoteId: 'primary', accountId: 'a', provider: 'gmail', name: 'Main', color: '#6558e8', primary: true, canWrite: true
}
const microsoftCalendar: SyncedCalendar = {
  id: 'b:microsoft-calendar:main', remoteId: 'main', accountId: 'b', provider: 'microsoft', name: 'Main', color: '#3b6fd8', primary: true, canWrite: true
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('productivity connector mapping', () => {
  it('normalizes Google events and contacts into Aerio records', () => {
    expect(mapGoogleEvent('a', googleCalendar, {
      id: 'event-1', summary: 'Design review', start: { dateTime: '2026-08-01T09:00:00Z' }, end: { dateTime: '2026-08-01T10:00:00Z' },
      attendees: [{ email: 'person@example.com' }], recurrence: ['RRULE:FREQ=WEEKLY']
    })).toMatchObject({ title: 'Design review', recurrence: 'weekly', attendees: ['person@example.com'], provider: 'gmail' })
    expect(mapGoogleContact('a', {
      resourceName: 'people/1', names: [{ displayName: 'Grace Hopper' }], emailAddresses: [{ value: 'grace@example.com' }],
      organizations: [{ name: 'Navy', title: 'Rear admiral' }]
    })).toMatchObject({ name: 'Grace Hopper', email: 'grace@example.com', company: 'Navy', provider: 'gmail' })
  })

  it('normalizes Microsoft dates as UTC and keeps read-only event state', () => {
    expect(mapMicrosoftEvent('b', { ...microsoftCalendar, canWrite: false }, {
      id: 'event-2', subject: 'Roadmap', start: { dateTime: '2026-08-01T11:00:00.0000000' }, end: { dateTime: '2026-08-01T12:00:00.0000000' },
      attendees: [{ emailAddress: { address: 'team@example.com' } }]
    })).toMatchObject({ start: '2026-08-01T11:00:00.0000000Z', readOnly: true, provider: 'microsoft' })
    expect(mapMicrosoftContact('b', {
      id: 'contact-2', givenName: 'Katherine', surname: 'Johnson', emailAddresses: [{ address: 'kj@example.com' }]
    })).toMatchObject({ name: 'Katherine Johnson', email: 'kj@example.com', provider: 'microsoft' })
  })

  it('builds a Google Calendar write payload from the Aerio editor', () => {
    expect(googleEventBody({
      id: 'local-event', calendarId: googleCalendar.id, title: 'Planning',
      start: '2026-08-01T09:00:00.000Z', end: '2026-08-01T10:00:00.000Z',
      location: 'Studio', description: 'Weekly planning', color: '#6558e8',
      attendees: ['team@example.com'], reminderMinutes: 15, recurrence: 'weekly'
    })).toEqual({
      summary: 'Planning', description: 'Weekly planning', location: 'Studio',
      start: { dateTime: '2026-08-01T09:00:00.000Z' }, end: { dateTime: '2026-08-01T10:00:00.000Z' },
      attendees: [{ email: 'team@example.com' }],
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] },
      recurrence: ['RRULE:FREQ=WEEKLY']
    })
  })

  it('covers Google event defaults, recurrence variants, and invalid records', () => {
    expect(mapGoogleEvent('a', googleCalendar, { id: 'missing', start: {}, end: { date: '2026-08-02' } })).toBeUndefined()
    expect(mapGoogleEvent('a', googleCalendar, { id: 'cancelled', status: 'cancelled', start: { date: '2026-08-01' }, end: { date: '2026-08-02' } })).toBeUndefined()
    expect(mapGoogleEvent('a', { ...googleCalendar, canWrite: false }, {
      id: 'defaults', summary: ' ', start: { date: '2026-08-01' }, end: { date: '2026-08-02' },
      attendees: [{}, { email: 'ada@example.test' }], reminders: { useDefault: true }, recurrence: ['EXDATE:value', 'RRULE:FREQ=DAILY']
    })).toMatchObject({ title: '(Untitled event)', attendees: ['ada@example.test'], reminderMinutes: 30, recurrence: 'daily', readOnly: true })
    expect(mapGoogleEvent('a', googleCalendar, { id: 'monthly', start: { date: '2026-08-01' }, end: { date: '2026-08-02' }, recurrence: ['RRULE:FREQ=MONTHLY'] }))
      .toMatchObject({ recurrence: 'monthly' })
    expect(mapGoogleEvent('a', googleCalendar, { id: 'other', start: { date: '2026-08-01' }, end: { date: '2026-08-02' }, recurrence: ['RRULE:FREQ=YEARLY'] }))
      .toMatchObject({ recurrence: 'none' })
  })

  it('covers Google contact groups, optional fields, and nameless records', () => {
    expect(mapGoogleContact('a', { resourceName: 'people/missing' })).toBeUndefined()
    expect(mapGoogleContact('a', {
      resourceName: 'people/starred', names: [{ displayName: '  Ada  ' }], phoneNumbers: [{ value: '+1' }],
      biographies: [{ value: 'Notes' }], memberships: [{ contactGroupMembership: {} }, { contactGroupMembership: { contactGroupResourceName: 'contactGroups/starred' } }]
    })).toMatchObject({ name: 'Ada', email: '', phone: '+1', group: 'starred', notes: 'Notes', favorite: true })
    expect(mapGoogleContact('a', { resourceName: 'people/plain', names: [{ displayName: 'Grace' }] })).toMatchObject({ group: 'Google', favorite: false })
  })

  it('builds a minimal non-recurring Google event body', () => {
    expect(googleEventBody({
      id: 'id', calendarId: 'calendar', title: 'Title', start: 'start', end: 'end', color: '#fff', attendees: [], reminderMinutes: 30
    })).toMatchObject({ description: undefined, location: undefined, recurrence: undefined })
  })

  it('covers Microsoft mapping defaults, recurrence, offsets, and invalid records', () => {
    expect(mapMicrosoftEvent('b', microsoftCalendar, { id: 'missing' })).toBeUndefined()
    expect(mapMicrosoftEvent('b', microsoftCalendar, { id: 'cancelled', isCancelled: true, start: { dateTime: 'a' }, end: { dateTime: 'b' } })).toBeUndefined()
    for (const [type, expected] of [['daily', 'daily'], ['relativeWeekly', 'weekly'], ['absoluteMonthly', 'monthly'], ['absoluteYearly', 'none']] as const) {
      expect(mapMicrosoftEvent('b', microsoftCalendar, {
        id: type, subject: ' ', start: { dateTime: '2026-08-01T10:00:00+01:00' }, end: { dateTime: '2026-08-01T11:00:00Z' },
        attendees: [{}, { emailAddress: { address: 'ada@example.test' } }], recurrence: { pattern: { type } }, isOrganizer: false
      })).toMatchObject({ title: '(Untitled event)', start: '2026-08-01T10:00:00+01:00', recurrence: expected, attendees: ['ada@example.test'], readOnly: true })
    }
  })

  it('covers Microsoft contact name, phone, group, and missing-name fallbacks', () => {
    expect(mapMicrosoftContact('b', { id: 'missing' })).toBeUndefined()
    expect(mapMicrosoftContact('b', {
      id: 'full', displayName: ' Ada ', mobilePhone: '+1', businessPhones: ['office'], categories: ['Friends'], personalNotes: 'Notes'
    })).toMatchObject({ name: 'Ada', email: '', phone: '+1', group: 'Friends', notes: 'Notes' })
    expect(mapMicrosoftContact('b', { id: 'business', givenName: 'Grace', businessPhones: ['office'] })).toMatchObject({ name: 'Grace', phone: 'office', group: 'Outlook' })
  })

  it('creates, updates, and deletes events through Google Calendar', async () => {
    const remote = {
      id: 'remote-event', summary: 'Planning',
      start: { dateTime: '2026-08-01T09:00:00.000Z' }, end: { dateTime: '2026-08-01T10:00:00.000Z' }
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => remote })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ...remote, summary: 'Updated planning' }) })
      .mockResolvedValueOnce({ ok: true, status: 204 })
    vi.stubGlobal('fetch', fetchMock)
    const connector = new GoogleProductivityConnector('a', async () => 'token', true)
    const input = {
      id: 'local-event', calendarId: googleCalendar.id, title: 'Planning',
      start: remote.start.dateTime, end: remote.end.dateTime, color: googleCalendar.color,
      attendees: [], reminderMinutes: 15, recurrence: 'none' as const
    }
    const created = await connector.createEvent(googleCalendar, input)
    expect(created).toMatchObject({ id: 'a:google-event:primary:remote-event', remoteId: 'remote-event', readOnly: false })
    const updated = await connector.updateEvent(googleCalendar, created as SyncedCalendarEvent, { ...input, id: created.id, title: 'Updated planning' })
    expect(updated.title).toBe('Updated planning')
    await connector.deleteEvent(googleCalendar, updated)
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      ['https://www.googleapis.com/calendar/v3/calendars/primary/events', 'POST'],
      ['https://www.googleapis.com/calendar/v3/calendars/primary/events/remote-event', 'PATCH'],
      ['https://www.googleapis.com/calendar/v3/calendars/primary/events/remote-event', 'DELETE']
    ])
  })

  it('rejects Google writes for foreign, read-only, or unauthorized calendars', async () => {
    const writable = new GoogleProductivityConnector('a', async () => 'token', true)
    const unauthorized = new GoogleProductivityConnector('a', async () => 'token', false)
    const event = { id: 'id', calendarId: 'calendar', title: 'Title', start: 'start', end: 'end', color: '#fff', attendees: [], reminderMinutes: 30 }
    for (const calendar of [
      { ...googleCalendar, accountId: 'other' },
      { ...googleCalendar, provider: 'microsoft' as const },
      { ...googleCalendar, canWrite: false }
    ]) await expect(writable.createEvent(calendar, event)).rejects.toThrow('Reconnect this Google account')
    await expect(unauthorized.createEvent(googleCalendar, event)).rejects.toThrow('Reconnect this Google account')
  })

  it('rejects a malformed Google write response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'broken' }) }))
    const connector = new GoogleProductivityConnector('a', async () => 'token', true)
    await expect(connector.createEvent(googleCalendar, {
      id: 'id', calendarId: googleCalendar.id, title: 'Title', start: 'start', end: 'end', color: '#fff', attendees: [], reminderMinutes: 30
    })).rejects.toThrow('did not return valid event details')
  })

  it('creates, updates, and deletes events through Microsoft Calendar', async () => {
    const input = {
      id: 'local-event', calendarId: microsoftCalendar.id, title: 'Planning',
      start: '2026-08-03T09:00:00.000Z', end: '2026-08-03T10:00:00.000Z', color: microsoftCalendar.color,
      location: 'Studio', description: 'Weekly planning', attendees: ['team@example.test'], reminderMinutes: 10, recurrence: 'weekly' as const
    }
    expect(microsoftEventBody(input)).toMatchObject({
      subject: 'Planning', reminderMinutesBeforeStart: 10,
      recurrence: { pattern: { type: 'weekly', daysOfWeek: ['monday'] }, range: { type: 'noEnd', startDate: '2026-08-03' } }
    })
    const remote = { id: 'remote-event', subject: 'Planning', start: { dateTime: input.start }, end: { dateTime: input.end }, reminderMinutesBeforeStart: 10 }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => remote })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ...remote, subject: 'Updated' }) })
      .mockResolvedValueOnce({ ok: true, status: 204 })
    vi.stubGlobal('fetch', fetchMock)
    const connector = new MicrosoftProductivityConnector('b', async () => 'token', true)
    const created = await connector.createEvent(microsoftCalendar, input)
    const updated = await connector.updateEvent(microsoftCalendar, created, { ...input, id: created.id, title: 'Updated' })
    expect(updated).toMatchObject({ title: 'Updated', reminderMinutes: 10, readOnly: false })
    await connector.deleteEvent(microsoftCalendar, updated)
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      ['https://graph.microsoft.com/v1.0/me/calendars/main/events', 'POST'],
      ['https://graph.microsoft.com/v1.0/me/calendars/main/events/remote-event', 'PATCH'],
      ['https://graph.microsoft.com/v1.0/me/calendars/main/events/remote-event', 'DELETE']
    ])
  })

  it('creates, updates, and deletes Google contacts with revision protection', async () => {
    const input = { id: 'local', name: 'Ada Lovelace', email: 'ada@example.test', phone: '+44', company: 'Analytical', title: 'Programmer', group: 'Contacts', notes: 'First programmer', favorite: false, color: '#4d8f78' }
    expect(googleContactBody(input, 'revision-1', 'people/ada')).toMatchObject({
      metadata: { sources: [{ type: 'CONTACT', id: 'ada', etag: 'revision-1' }] },
      names: [{ givenName: 'Ada', familyName: 'Lovelace' }], emailAddresses: [{ value: 'ada@example.test' }]
    })
    const remote = { resourceName: 'people/ada', metadata: { sources: [{ type: 'CONTACT', id: 'ada', etag: 'revision-1' }] }, names: [{ displayName: 'Ada Lovelace' }], emailAddresses: [{ value: input.email }] }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => remote })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ...remote, metadata: { sources: [{ type: 'CONTACT', id: 'ada', etag: 'revision-2' }] } }) })
      .mockResolvedValueOnce({ ok: true, status: 204 })
    vi.stubGlobal('fetch', fetchMock)
    const connector = new GoogleProductivityConnector('a', async () => 'token', true, true)
    const created = await connector.createContact(input)
    expect(created).toMatchObject({ id: 'a:google-contact:people/ada', revision: 'revision-1', readOnly: false })
    const updated = await connector.updateContact(created, { ...input, id: created.id, name: 'Ada King' })
    expect(updated.revision).toBe('revision-2')
    await connector.deleteContact(updated)
    expect(fetchMock.mock.calls.map(([url, init]) => [String(url).split('?')[0], init.method])).toEqual([
      ['https://people.googleapis.com/v1/people:createContact', 'POST'],
      ['https://people.googleapis.com/v1/people/ada:updateContact', 'PATCH'],
      ['https://people.googleapis.com/v1/people/ada:deleteContact', 'DELETE']
    ])
  })

  it('creates, updates, and deletes Microsoft contacts with change-key conflict checks', async () => {
    const input = { id: 'local', name: 'Grace Hopper', email: 'grace@example.test', phone: '+1', company: 'Navy', title: 'Rear admiral', group: 'Friends', notes: 'COBOL', favorite: false, color: '#3b6fd8' }
    expect(microsoftContactBody(input)).toMatchObject({ givenName: 'Grace', surname: 'Hopper', categories: ['Friends'], businessPhones: ['+1'] })
    const remote = { id: 'grace', displayName: input.name, changeKey: 'revision-1', emailAddresses: [{ address: input.email }] }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => remote })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => remote })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ...remote, changeKey: 'revision-2' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ...remote, changeKey: 'revision-2' }) })
      .mockResolvedValueOnce({ ok: true, status: 204 })
    vi.stubGlobal('fetch', fetchMock)
    const connector = new MicrosoftProductivityConnector('b', async () => 'token', true, true)
    const created = await connector.createContact(input)
    const updated = await connector.updateContact(created, { ...input, id: created.id, title: 'Admiral' })
    await connector.deleteContact(updated)
    expect(fetchMock.mock.calls.map(([url, init]) => [String(url).split('?')[0], init.method])).toEqual([
      ['https://graph.microsoft.com/v1.0/me/contacts', 'POST'],
      ['https://graph.microsoft.com/v1.0/me/contacts/grace', undefined],
      ['https://graph.microsoft.com/v1.0/me/contacts/grace', 'PATCH'],
      ['https://graph.microsoft.com/v1.0/me/contacts/grace', undefined],
      ['https://graph.microsoft.com/v1.0/me/contacts/grace', 'DELETE']
    ])
  })

  it('rejects unauthorized or foreign provider contact writes', async () => {
    const contact = { id: 'a:google-contact:people/1', remoteId: 'people/1', accountId: 'other', provider: 'gmail', readOnly: false, name: 'Ada', email: '', group: 'Google', favorite: false, color: '#4d8f78' } satisfies SyncedContact
    const google = new GoogleProductivityConnector('a', async () => 'token', true, true)
    await expect(google.updateContact(contact, contact)).rejects.toThrow('Reconnect this Google account')
    await expect(new MicrosoftProductivityConnector('b', async () => 'token').createContact(contact)).rejects.toThrow('Reconnect this Microsoft account')
  })
})

describe('productivity synchronization', () => {
  it('paginates Google calendars and contacts while mapping event access', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      const url = new URL(input)
      let body: unknown
      if (url.pathname.endsWith('/calendarList')) body = url.searchParams.get('pageToken')
        ? { items: [{ id: 'second', summary: '', accessRole: 'reader' }] }
        : { items: [{ id: 'primary', summary: 'Main', backgroundColor: '#123', primary: true, accessRole: 'owner' }], nextPageToken: 'next calendar' }
      else if (url.pathname.includes('/calendars/primary/events')) body = { items: [{ id: 'event-1', start: { dateTime: '2026-08-01T10:00:00Z' }, end: { dateTime: '2026-08-01T11:00:00Z' } }], nextSyncToken: 'event-primary' }
      else if (url.pathname.includes('/calendars/second/events')) body = { items: [{ id: 'cancelled', status: 'cancelled' }], nextSyncToken: 'event-second' }
      else body = url.searchParams.get('pageToken')
        ? { connections: [{ resourceName: 'people/2', names: [{ displayName: 'Grace' }] }], nextSyncToken: 'contact-token' }
        : { connections: [{ resourceName: 'people/1' }], nextPageToken: 'next people' }
      return { ok: true, status: 200, json: async () => body }
    })
    vi.stubGlobal('fetch', fetchMock)
    const data = await new GoogleProductivityConnector('a', async () => 'token', true).sync()
    expect(data.calendars).toHaveLength(2)
    expect(data.calendars[0]).toMatchObject({ name: 'Main', color: '#123', primary: true, canWrite: true })
    expect(data.calendars[1]).toMatchObject({ name: 'Calendar', color: '#6558e8', canWrite: false })
    expect(data.events).toHaveLength(1)
    expect(data.contacts).toHaveLength(1)
    expect(data.checkpoints).toEqual({ 'events:primary': 'event-primary', 'events:second': 'event-second', contacts: 'contact-token' })
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('pageToken=next+calendar'))).toBe(true)
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('personFields='))).toBe(true)
  })

  it('paginates Microsoft calendars, events, and contacts and maps Graph colors', async () => {
    const fetchMock = vi.fn(async (input: string, init: RequestInit) => {
      const url = String(input)
      let body: unknown
      if (url.includes('/me/calendars?')) body = { value: [
        { id: 'one', name: 'Main', color: 'lightBlue', isDefaultCalendar: true, canEdit: true },
        { id: 'two', name: '', color: 'unknown' }
      ] }
      else if (url.includes('/calendars/one/calendarView')) body = { value: [{ id: 'e1', start: { dateTime: '2026-08-01T10:00:00' }, end: { dateTime: '2026-08-01T11:00:00' } }], '@odata.nextLink': 'https://graph.microsoft.com/next-events' }
      else if (url.includes('next-events')) body = { value: [{ id: 'cancel', isCancelled: true }], '@odata.deltaLink': 'https://graph.microsoft.com/events-delta-one' }
      else if (url.includes('/calendars/two/calendarView')) body = { value: [], '@odata.deltaLink': 'https://graph.microsoft.com/events-delta-two' }
      else if (url.includes('/me/contacts?')) body = { value: [{ id: 'probe', parentFolderId: 'default' }] }
      else if (url.includes('/contactFolders/default/contacts/delta')) body = { value: [{ id: 'c1', parentFolderId: 'default', displayName: 'Ada' }], '@odata.nextLink': 'https://graph.microsoft.com/next-contacts' }
      else body = { value: [{ id: 'c2' }], '@odata.deltaLink': 'https://graph.microsoft.com/contacts-delta' }
      const prefer = new Headers(init.headers).get('Prefer')
      if (prefer) expect(prefer).toContain('outlook.timezone="UTC"')
      return { ok: true, status: 200, json: async () => body }
    })
    vi.stubGlobal('fetch', fetchMock)
    const data = await new MicrosoftProductivityConnector('b', async () => 'token').sync()
    expect(data.calendars).toEqual([
      expect.objectContaining({ name: 'Main', color: '#3b82c4', primary: true, canWrite: false }),
      expect.objectContaining({ name: 'Calendar', color: '#6558e8', primary: false, canWrite: false })
    ])
    expect(data.events).toHaveLength(1)
    expect(data.contacts).toHaveLength(1)
    expect(data.checkpoints).toEqual({ 'events:one': 'https://graph.microsoft.com/events-delta-one', 'events:two': 'https://graph.microsoft.com/events-delta-two', contacts: 'https://graph.microsoft.com/contacts-delta' })
  })

  it('applies Google event and contact deltas to the cached snapshot', async () => {
    const calendar = googleCalendar
    const oldEvent = mapGoogleEvent('a', calendar, { id: 'old', summary: 'Old', start: { dateTime: '2026-08-01T09:00:00Z' }, end: { dateTime: '2026-08-01T10:00:00Z' } })!
    const deletedEvent = mapGoogleEvent('a', calendar, { id: 'deleted', summary: 'Delete me', start: { dateTime: '2026-08-01T11:00:00Z' }, end: { dateTime: '2026-08-01T12:00:00Z' } })!
    const oldContact = mapGoogleContact('a', { resourceName: 'people/1', metadata: { sources: [{ type: 'CONTACT', id: '1', etag: 'old' }] }, names: [{ displayName: 'Old Person' }] })!
    const deletedContact = mapGoogleContact('a', { resourceName: 'people/2', metadata: { sources: [{ type: 'CONTACT', id: '2', etag: 'old' }] }, names: [{ displayName: 'Delete Person' }] })!
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = String(input); urls.push(url)
      if (url.includes('calendarList')) return { ok: true, status: 200, json: async () => ({ items: [{ id: 'primary', summary: 'Main', accessRole: 'owner' }] }) }
      if (url.includes('/events?')) return { ok: true, status: 200, json: async () => ({ items: [
        { id: 'old', summary: 'Updated', start: { dateTime: '2026-08-01T09:00:00Z' }, end: { dateTime: '2026-08-01T10:00:00Z' } },
        { id: 'deleted', status: 'cancelled' }
      ], nextSyncToken: 'event-new' }) }
      return { ok: true, status: 200, json: async () => ({ connections: [
        { resourceName: 'people/1', metadata: { sources: [{ type: 'CONTACT', id: '1', etag: 'new' }] }, names: [{ displayName: 'Updated Person' }] },
        { resourceName: 'people/2', metadata: { deleted: true, sources: [{ type: 'CONTACT', id: '2', etag: 'old' }] } }
      ], nextSyncToken: 'contact-new' }) }
    }))
    const result = await new GoogleProductivityConnector('a', async () => 'token', true, true).sync(
      { calendars: [calendar], events: [oldEvent, deletedEvent], contacts: [oldContact, deletedContact] },
      { 'events:primary': 'event-old', contacts: 'contact-old' }
    )
    expect(result.events).toEqual([expect.objectContaining({ remoteId: 'old', title: 'Updated' })])
    expect(result.contacts).toEqual([expect.objectContaining({ remoteId: 'people/1', name: 'Updated Person', revision: 'new' })])
    expect(result.checkpoints).toEqual({ 'events:primary': 'event-new', contacts: 'contact-new' })
    expect(urls.find((url) => url.includes('/events?'))).toContain('syncToken=event-old')
    expect(urls.find((url) => url.includes('/connections?'))).toContain('syncToken=contact-old')
  })

  it('applies Microsoft delta links without repeating full event or contact reads', async () => {
    const calendar = microsoftCalendar
    const oldEvent = mapMicrosoftEvent('b', calendar, { id: 'old', subject: 'Old', start: { dateTime: '2026-08-01T09:00:00Z' }, end: { dateTime: '2026-08-01T10:00:00Z' } })!
    const deletedEvent = mapMicrosoftEvent('b', calendar, { id: 'deleted', subject: 'Delete', start: { dateTime: '2026-08-01T11:00:00Z' }, end: { dateTime: '2026-08-01T12:00:00Z' } })!
    const oldContact = mapMicrosoftContact('b', { id: 'old', displayName: 'Old Person', changeKey: 'one', parentFolderId: 'default' })!
    const deletedContact = mapMicrosoftContact('b', { id: 'deleted', displayName: 'Delete Person', changeKey: 'one', parentFolderId: 'default' })!
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = String(input); urls.push(url)
      if (url.includes('/me/calendars?')) return { ok: true, status: 200, json: async () => ({ value: [{ id: 'main', name: 'Main', canEdit: true }] }) }
      if (url === 'https://graph.microsoft.com/event-checkpoint') return { ok: true, status: 200, json: async () => ({ value: [
        { id: 'old', subject: 'Updated', start: { dateTime: '2026-08-01T09:00:00Z' }, end: { dateTime: '2026-08-01T10:00:00Z' } },
        { id: 'deleted', '@removed': { reason: 'deleted' } }
      ], '@odata.deltaLink': 'https://graph.microsoft.com/event-next' }) }
      return { ok: true, status: 200, json: async () => ({ value: [
        { id: 'old', displayName: 'Updated Person', changeKey: 'two', parentFolderId: 'default' },
        { id: 'deleted', '@removed': { reason: 'deleted' } }
      ], '@odata.deltaLink': 'https://graph.microsoft.com/contact-next' }) }
    }))
    const result = await new MicrosoftProductivityConnector('b', async () => 'token', true, true).sync(
      { calendars: [calendar], events: [oldEvent, deletedEvent], contacts: [oldContact, deletedContact] },
      { 'events:main': 'https://graph.microsoft.com/event-checkpoint', contacts: 'https://graph.microsoft.com/contact-checkpoint' }
    )
    expect(result.events).toEqual([expect.objectContaining({ remoteId: 'old', title: 'Updated' })])
    expect(result.contacts).toEqual([expect.objectContaining({ remoteId: 'old', name: 'Updated Person', revision: 'two' })])
    expect(result.checkpoints).toEqual({ 'events:main': 'https://graph.microsoft.com/event-next', contacts: 'https://graph.microsoft.com/contact-next' })
    expect(urls).not.toEqual(expect.arrayContaining([expect.stringContaining('/calendarView/delta?'), expect.stringContaining('/me/contacts?')]))
  })

  it('falls back to full synchronization when provider checkpoints expire', async () => {
    const googleUrls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = String(input); googleUrls.push(url)
      if (url.includes('calendarList')) return { ok: true, status: 200, json: async () => ({ items: [{ id: 'primary', accessRole: 'reader' }] }) }
      if (url.includes('/events?') && url.includes('syncToken=')) return { ok: false, status: 410, headers: new Headers(), json: async () => ({ error: { message: 'Sync token expired' } }) }
      if (url.includes('/events?')) return { ok: true, status: 200, json: async () => ({ items: [], nextSyncToken: 'fresh-event' }) }
      return { ok: true, status: 200, json: async () => ({ connections: [], nextSyncToken: 'fresh-contact' }) }
    }))
    const google = await new GoogleProductivityConnector('a', async () => 'token').sync(undefined, { 'events:primary': 'expired' })
    expect(google.checkpoints).toEqual({ 'events:primary': 'fresh-event', contacts: 'fresh-contact' })
    expect(googleUrls.filter((url) => url.includes('/events?'))).toHaveLength(2)
    expect(googleUrls.filter((url) => url.includes('/events?')).at(-1)).toContain('timeMin=')

    const microsoftUrls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = String(input); microsoftUrls.push(url)
      if (url.includes('/me/calendars?')) return { ok: true, status: 200, json: async () => ({ value: [{ id: 'main' }] }) }
      if (url === 'https://graph.microsoft.com/expired-event') return { ok: false, status: 410, headers: new Headers(), json: async () => ({ error: { message: 'Gone' } }) }
      if (url.includes('/calendarView/delta?')) return { ok: true, status: 200, json: async () => ({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/fresh-event' }) }
      return { ok: true, status: 200, json: async () => ({ value: [] }) }
    }))
    const microsoft = await new MicrosoftProductivityConnector('b', async () => 'token').sync(undefined, { 'events:main': 'https://graph.microsoft.com/expired-event' })
    expect(microsoft.checkpoints).toEqual({ 'events:main': 'https://graph.microsoft.com/fresh-event' })
    expect(microsoftUrls).toEqual(expect.arrayContaining(['https://graph.microsoft.com/expired-event', expect.stringContaining('/calendarView/delta?')]))
  })
})

describe('retryingJson', () => {
  it('merges authentication headers and supports JSON and 204 responses', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ value: true }) })
      .mockResolvedValueOnce({ ok: true, status: 204 })
    vi.stubGlobal('fetch', fetchMock)
    await expect(retryingJson('gmail', 'https://example.test/json', async () => 'token', { headers: { 'X-Test': 'yes' } })).resolves.toEqual({ value: true })
    await expect(retryingJson('gmail', 'https://example.test/empty', async () => 'token')).resolves.toBeUndefined()
    const headers = new Headers(fetchMock.mock.calls[0][1].headers)
    expect(headers.get('Authorization')).toBe('Bearer token')
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.get('X-Test')).toBe('yes')
  })

  it('retries throttling and server errors with explicit and exponential delays', async () => {
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => { callback(); return 1 as any }) as typeof setTimeout)
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, headers: new Headers({ 'retry-after': '2' }) })
      .mockResolvedValueOnce({ ok: false, status: 500, headers: new Headers() })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)
    await expect(retryingJson('microsoft', 'https://example.test', async () => 'token')).resolves.toEqual({ ok: true })
    expect(setTimeout).toHaveBeenNthCalledWith(1, expect.any(Function), 2_000)
    expect(setTimeout).toHaveBeenNthCalledWith(2, expect.any(Function), 1_500)
  })

  it('throws structured and fallback provider errors without retrying client failures', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, headers: new Headers(), json: async () => ({ error: { message: 'Bad request' } }) })
      .mockResolvedValueOnce({ ok: false, status: 403, headers: new Headers(), json: async () => { throw new Error('html') } }))
    const first = await retryingJson('gmail', 'https://example.test', async () => 'token').catch((error) => error)
    expect(first).toBeInstanceOf(ProductivityApiError)
    expect(first).toMatchObject({ message: 'Bad request', provider: 'gmail', status: 400, name: 'ProductivityApiError' })
    await expect(retryingJson('microsoft', 'https://example.test', async () => 'token')).rejects.toThrow('Microsoft synchronization failed (403)')
  })

  it('stops retrying after the sixth transient failure', async () => {
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => { callback(); return 1 as any }) as typeof setTimeout)
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, headers: new Headers(), json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)
    await expect(retryingJson('gmail', 'https://example.test', async () => 'token')).rejects.toThrow('Google synchronization failed (503)')
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })
})
