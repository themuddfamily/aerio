import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SyncedCalendar, SyncedCalendarEvent } from '../../src/productivity-types'
import type { CalendarEvent } from '../../src/types'
import { GoogleProductivityConnector, googleEventBody, mapGoogleEvent } from './google-connector'
import { MicrosoftProductivityConnector, mapMicrosoftEvent, microsoftEventBody } from './microsoft-connector'

const googleCalendar: SyncedCalendar = { id: 'a:google-calendar:primary', remoteId: 'primary', accountId: 'a', provider: 'gmail', name: 'Main', color: '#6558e8', primary: true, canWrite: true }
const microsoftCalendar: SyncedCalendar = { id: 'b:microsoft-calendar:main', remoteId: 'main', accountId: 'b', provider: 'microsoft', name: 'Main', color: '#3b6fd8', primary: true, canWrite: true }
const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'event', calendarId: googleCalendar.id, title: 'Standup', start: '2026-03-02T14:00:00.000Z', end: '2026-03-02T14:30:00.000Z',
  color: '#000', attendees: [], reminderMinutes: 10, recurrence: 'none', ...overrides
})
const ok = (body: unknown) => ({ ok: true, status: body === undefined ? 204 : 200, json: async () => body })
const calls = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map(([url, init]) => [String(url), init?.method ?? 'GET', init?.body ? JSON.parse(init.body) : undefined])

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Google recurrence round trips', () => {
  it('maps instances with series identity, original start, named zones, and all-day dates', () => {
    expect(mapGoogleEvent('a', googleCalendar, {
      id: 'series_20260309T140000Z', recurringEventId: 'series', summary: 'Standup',
      start: { dateTime: '2026-03-09T10:00:00-04:00', timeZone: 'America/New_York' }, end: { dateTime: '2026-03-09T10:30:00-04:00', timeZone: 'America/New_York' },
      originalStartTime: { dateTime: '2026-03-09T09:00:00-04:00', timeZone: 'America/New_York' }
    })).toMatchObject({ seriesId: 'series', originalStart: '2026-03-09T09:00:00-04:00', timeZone: 'America/New_York', recurrence: 'none' })
    const master = mapGoogleEvent('a', googleCalendar, {
      id: 'holiday', start: { date: '2026-12-24' }, end: { date: '2026-12-26' }, recurrence: ['RRULE:FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=24', 'EXDATE;VALUE=DATE:20271224']
    })!
    expect(master).toMatchObject({ allDay: true, start: '2026-12-24', end: '2026-12-26', recurrenceRule: 'FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=24', recurrence: 'none' })
    expect(master.seriesId).toBeUndefined()
  })

  it('writes full rules, exceptions, zones, and all-day dates, but never a rule on an instance', () => {
    const body = googleEventBody(event({
      timeZone: 'America/New_York', recurrenceRule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=6', recurrenceExceptions: ['2026-03-05T14:00:00.000Z']
    }))
    expect(body.start).toEqual({ dateTime: '2026-03-02T14:00:00.000Z', timeZone: 'America/New_York' })
    expect(body.recurrence).toEqual(['RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=6;BYDAY=MO,TH', 'EXDATE;TZID=America/New_York:20260305T090000'])
    expect(googleEventBody(event({ allDay: true, start: '2026-12-24', end: '2026-12-25', recurrenceRule: 'FREQ=YEARLY', recurrenceExceptions: ['2027-12-24'] }))).toMatchObject({
      start: { date: '2026-12-24' }, end: { date: '2026-12-25' }, recurrence: ['RRULE:FREQ=YEARLY', 'EXDATE;VALUE=DATE:20271224']
    })
    expect(googleEventBody(event({ seriesId: 'series', recurrence: 'weekly' })).recurrence).toBeUndefined()
    expect(googleEventBody(event({ recurrenceRule: 'FREQ=DAILY' }), { instance: true }).recurrence).toBeUndefined()
  })

  it('edits one instance, the whole series, and this-and-following through the series master', async () => {
    const instance = { ...mapGoogleEvent('a', googleCalendar, {
      id: 'series_20260304T140000Z', recurringEventId: 'series', summary: 'Standup',
      start: { dateTime: '2026-03-04T14:00:00Z', timeZone: 'America/New_York' }, end: { dateTime: '2026-03-04T14:30:00Z', timeZone: 'America/New_York' },
      originalStartTime: { dateTime: '2026-03-04T14:00:00Z' }
    })! } as SyncedCalendarEvent
    const master = {
      id: 'series', summary: 'Standup', start: { dateTime: '2026-03-02T09:00:00-05:00', timeZone: 'America/New_York' }, end: { dateTime: '2026-03-02T09:30:00-05:00', timeZone: 'America/New_York' },
      recurrence: ['RRULE:FREQ=DAILY;COUNT=10', 'EXDATE;TZID=America/New_York:20260303T090000']
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({ ...master, id: 'series_20260304T140000Z' }))
      .mockResolvedValueOnce(ok(master)).mockResolvedValueOnce(ok(master))
      .mockResolvedValueOnce(ok(master)).mockResolvedValueOnce(ok(master)).mockResolvedValueOnce(ok({ ...master, id: 'successor' }))
      .mockResolvedValueOnce(ok(master)).mockResolvedValueOnce(ok(undefined))
    vi.stubGlobal('fetch', fetchMock)
    const connector = new GoogleProductivityConnector('a', async () => 'token', true)
    const edited = { ...instance, title: 'Late standup', start: '2026-03-04T15:00:00.000Z', end: '2026-03-04T15:30:00.000Z', timeZone: 'America/New_York' }
    await connector.updateEvent(googleCalendar, instance, edited)
    await connector.updateEventSeries(googleCalendar, instance, edited, 'series')
    await connector.updateEventSeries(googleCalendar, instance, edited, 'following')
    await connector.deleteEventSeries(googleCalendar, instance, 'series')
    const [one, getSeries, patchSeries, getFollowing, patchFollowing, createFollowing, getDelete, deleteSeries] = calls(fetchMock)
    expect(one).toEqual(['https://www.googleapis.com/calendar/v3/calendars/primary/events/series_20260304T140000Z', 'PATCH', expect.not.objectContaining({ recurrence: expect.anything() })])
    expect(getSeries.slice(0, 2)).toEqual(['https://www.googleapis.com/calendar/v3/calendars/primary/events/series', 'GET'])
    // 10:00 New York on the master's first day (before DST) is 15:00 UTC; the rule is untouched.
    expect(patchSeries[2]).toMatchObject({ summary: 'Late standup', start: { dateTime: '2026-03-02T15:00:00.000Z', timeZone: 'America/New_York' } })
    expect(patchSeries[2].recurrence).toBeUndefined()
    expect(getFollowing[1]).toBe('GET')
    expect(patchFollowing[2]).toEqual({ recurrence: ['RRULE:FREQ=DAILY;UNTIL=20260304T135959Z', 'EXDATE;TZID=America/New_York:20260303T090000'] })
    expect(createFollowing.slice(0, 2)).toEqual(['https://www.googleapis.com/calendar/v3/calendars/primary/events', 'POST'])
    expect(createFollowing[2]).toMatchObject({ summary: 'Late standup', recurrence: ['RRULE:FREQ=DAILY;COUNT=8'] })
    expect(getDelete[1]).toBe('GET')
    expect(deleteSeries.slice(0, 2)).toEqual(['https://www.googleapis.com/calendar/v3/calendars/primary/events/series', 'DELETE'])
  })

  it('deletes this and following by ending the master rule, and needs a series identity', async () => {
    const master = { id: 'series', start: { date: '2026-03-02' }, end: { date: '2026-03-03' }, recurrence: ['RRULE:FREQ=WEEKLY'] }
    const fetchMock = vi.fn().mockResolvedValueOnce(ok(master)).mockResolvedValueOnce(ok(master))
    vi.stubGlobal('fetch', fetchMock)
    const connector = new GoogleProductivityConnector('a', async () => 'token', true)
    const instance = { ...event({ allDay: true, start: '2026-03-16', end: '2026-03-17', seriesId: 'series', originalStart: '2026-03-16' }), remoteId: 'series_20260316', accountId: 'a', provider: 'gmail', readOnly: false } as SyncedCalendarEvent
    await connector.deleteEventSeries(googleCalendar, instance, 'following')
    expect(calls(fetchMock)[1][2]).toEqual({ recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=20260315'] })
    await expect(connector.deleteEventSeries(googleCalendar, { ...instance, seriesId: undefined }, 'series')).rejects.toThrow(/not part of a repeating series/)
  })
})

describe('Microsoft recurrence round trips', () => {
  it('maps occurrences with seriesMasterId, original start, Windows zones, and all-day dates', () => {
    expect(mapMicrosoftEvent('b', microsoftCalendar, {
      id: 'occurrence-1', type: 'occurrence', seriesMasterId: 'master', subject: 'Standup', originalStartTimeZone: 'Eastern Standard Time',
      start: { dateTime: '2026-03-09T13:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-03-09T13:30:00.0000000', timeZone: 'UTC' },
      originalStart: '2026-03-09T13:00:00Z', recurrence: null
    })).toMatchObject({ seriesId: 'master', originalStart: '2026-03-09T13:00:00.000Z', timeZone: 'America/New_York', recurrence: 'none' })
    const allDay = mapMicrosoftEvent('b', microsoftCalendar, {
      id: 'holiday', type: 'seriesMaster', isAllDay: true, subject: 'Holiday', originalStartTimeZone: 'GMT Standard Time',
      start: { dateTime: '2026-12-24T00:00:00.0000000' }, end: { dateTime: '2026-12-25T00:00:00.0000000' },
      recurrence: { pattern: { type: 'absoluteYearly', interval: 1, month: 12, dayOfMonth: 24 }, range: { type: 'numbered', numberOfOccurrences: 5 } }
    })
    expect(allDay).toMatchObject({ allDay: true, start: '2026-12-24', end: '2026-12-25', recurrenceRule: 'FREQ=YEARLY;COUNT=5;BYMONTH=12;BYMONTHDAY=24' })
    // An all-day value returned as the UTC instant of local midnight keeps its local date.
    expect(mapMicrosoftEvent('b', microsoftCalendar, {
      id: 'summer', isAllDay: true, originalStartTimeZone: 'GMT Standard Time', start: { dateTime: '2026-07-01T23:00:00.0000000' }, end: { dateTime: '2026-07-02T23:00:00.0000000' }
    })).toMatchObject({ start: '2026-07-02', end: '2026-07-03' })
  })

  it('writes wall times in Windows zones, patterned recurrence, and refuses unsupported rules', () => {
    const body = microsoftEventBody(event({ timeZone: 'America/New_York', recurrenceRule: 'FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20261231' }))
    expect(body).toMatchObject({
      start: { dateTime: '2026-03-02T09:00:00', timeZone: 'Eastern Standard Time' }, end: { dateTime: '2026-03-02T09:30:00', timeZone: 'Eastern Standard Time' },
      recurrence: { pattern: { type: 'relativeMonthly', daysOfWeek: ['friday'], index: 'last' }, range: { type: 'endDate', startDate: '2026-03-02', endDate: '2026-12-31', recurrenceTimeZone: 'Eastern Standard Time' } }
    })
    expect(microsoftEventBody(event({ allDay: true, start: '2026-12-24', end: '2026-12-25', timeZone: 'Europe/London', recurrenceRule: 'FREQ=YEARLY' }))).toMatchObject({
      isAllDay: true, start: { dateTime: '2026-12-24T00:00:00', timeZone: 'GMT Standard Time' }, recurrence: { pattern: { type: 'absoluteYearly', month: 12, dayOfMonth: 24 } }
    })
    expect(() => microsoftEventBody(event({ recurrenceRule: 'FREQ=DAILY;BYHOUR=9,17' }))).toThrow(/cannot store this repeat rule/)
    expect('recurrence' in microsoftEventBody(event({ seriesId: 'master', recurrence: 'weekly' }))).toBe(false)
  })

  it('edits the series master and splits this-and-following with an end date', async () => {
    const master = {
      id: 'master', type: 'seriesMaster', subject: 'Standup', originalStartTimeZone: 'Eastern Standard Time',
      start: { dateTime: '2026-03-02T14:00:00.0000000' }, end: { dateTime: '2026-03-02T14:30:00.0000000' },
      recurrence: { pattern: { type: 'daily', interval: 1 }, range: { type: 'numbered', startDate: '2026-03-02', numberOfOccurrences: 10, recurrenceTimeZone: 'Eastern Standard Time' } }
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok(master)).mockResolvedValueOnce(ok(master))
      .mockResolvedValueOnce(ok(master)).mockResolvedValueOnce(ok(master)).mockResolvedValueOnce(ok({ ...master, id: 'successor' }))
      .mockResolvedValueOnce(ok(master)).mockResolvedValueOnce(ok(master))
    vi.stubGlobal('fetch', fetchMock)
    const connector = new MicrosoftProductivityConnector('b', async () => 'token', true)
    const occurrence = { ...mapMicrosoftEvent('b', microsoftCalendar, {
      id: 'occurrence-9', type: 'occurrence', seriesMasterId: 'master', subject: 'Standup', originalStartTimeZone: 'Eastern Standard Time',
      start: { dateTime: '2026-03-09T13:00:00.0000000' }, end: { dateTime: '2026-03-09T13:30:00.0000000' }, originalStart: '2026-03-09T13:00:00Z'
    })! }
    const edited = { ...occurrence, start: '2026-03-09T14:00:00.000Z', end: '2026-03-09T14:30:00.000Z' }
    await connector.updateEventSeries(microsoftCalendar, occurrence, edited, 'series')
    await connector.updateEventSeries(microsoftCalendar, occurrence, edited, 'following')
    await connector.deleteEventSeries(microsoftCalendar, occurrence, 'following')
    const [get, patch, , patchRange, create, , patchDelete] = calls(fetchMock)
    expect(get.slice(0, 2)).toEqual(['https://graph.microsoft.com/v1.0/me/events/master', 'GET'])
    // 10:00 local after DST moves the master's first (pre-DST) start to 10:00 EST.
    expect(patch[2]).toMatchObject({ start: { dateTime: '2026-03-02T10:00:00', timeZone: 'Eastern Standard Time' } })
    expect('recurrence' in patch[2]).toBe(false)
    expect(patchRange[2]).toEqual({ recurrence: { pattern: { type: 'daily', interval: 1 }, range: { type: 'endDate', startDate: '2026-03-02', endDate: '2026-03-08', recurrenceTimeZone: 'Eastern Standard Time' } } })
    expect(create.slice(0, 2)).toEqual(['https://graph.microsoft.com/v1.0/me/calendars/main/events', 'POST'])
    expect(create[2].recurrence).toMatchObject({ pattern: { type: 'daily' }, range: { type: 'numbered', numberOfOccurrences: 3, startDate: '2026-03-09' } })
    expect(patchDelete[2].recurrence.range).toMatchObject({ type: 'endDate', endDate: '2026-03-08' })
  })
})
