import { describe, expect, it, vi } from 'vitest'
import { InterchangeStore } from './interchange-store'
import {
  createSubscription, dueSubscriptions, fetchCalendarFeed, normalizeSubscriptionUrl, refreshSubscription, type FeedFetch
} from './calendar-subscriptions'

const feed = (summary: string, extra = '') => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Holidays\r\nBEGIN:VEVENT\r\nUID:holiday-1\r\nDTSTART;VALUE=DATE:20261225\r\nSUMMARY:${summary}\r\nEND:VEVENT\r\n${extra}END:VCALENDAR\r\n`
const response = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, ...init })

describe('subscription URLs', () => {
  it('maps webcal to https and refuses insecure or credentialed addresses', () => {
    expect(normalizeSubscriptionUrl('webcal://example.test/cal.ics#x')).toBe('https://example.test/cal.ics')
    expect(normalizeSubscriptionUrl('webcals://example.test/a.ics')).toBe('https://example.test/a.ics')
    expect(normalizeSubscriptionUrl(' https://example.test/a.ics?token=1 ')).toBe('https://example.test/a.ics?token=1')
    expect(() => normalizeSubscriptionUrl('http://example.test/a.ics')).toThrow(/https/)
    expect(() => normalizeSubscriptionUrl('file:///etc/passwd')).toThrow(/https/)
    expect(() => normalizeSubscriptionUrl('https://user:pass@example.test/a.ics')).toThrow(/password/)
    expect(() => normalizeSubscriptionUrl('not a url')).toThrow(/valid/)
    expect(() => normalizeSubscriptionUrl('')).toThrow(/Enter/)
  })
})

describe('fetchCalendarFeed', () => {
  it('sends conditional headers, follows validated redirects, and reports not-modified', async () => {
    const fetch = vi.fn<FeedFetch>()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: '/moved.ics' } }))
      .mockResolvedValueOnce(response(feed('Christmas'), { headers: { etag: '"v2"', 'last-modified': 'Tue, 01 Sep 2026 00:00:00 GMT' } }))
    const result = await fetchCalendarFeed('https://example.test/cal.ics', { fetch, etag: '"v1"' })
    expect(result).toMatchObject({ status: 'ok', etag: '"v2"', lastModified: 'Tue, 01 Sep 2026 00:00:00 GMT', finalUrl: 'https://example.test/moved.ics' })
    expect(fetch.mock.calls[0][1].headers).toMatchObject({ 'If-None-Match': '"v1"' })
    expect(fetch.mock.calls[0][1].redirect).toBe('manual')
    const notModified = vi.fn<FeedFetch>().mockResolvedValue(new Response(null, { status: 304 }))
    await expect(fetchCalendarFeed('https://example.test/cal.ics', { fetch: notModified })).resolves.toEqual({ status: 'not-modified' })
  })

  it('rejects redirects to http, redirect loops, server errors, oversized bodies, and slow servers', async () => {
    const toHttp = vi.fn<FeedFetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://example.test/a.ics' } }))
    await expect(fetchCalendarFeed('https://example.test/cal.ics', { fetch: toHttp })).rejects.toThrow(/https/)
    const loop = vi.fn<FeedFetch>().mockImplementation(async () => new Response(null, { status: 302, headers: { location: '/again' } }))
    await expect(fetchCalendarFeed('https://example.test/cal.ics', { fetch: loop })).rejects.toThrow(/redirected too many times/)
    const failing = vi.fn<FeedFetch>().mockResolvedValue(new Response('nope', { status: 503 }))
    await expect(fetchCalendarFeed('https://example.test/cal.ics', { fetch: failing })).rejects.toThrow(/503/)
    const declared = vi.fn<FeedFetch>().mockResolvedValue(response('x', { headers: { 'content-length': '999999' } }))
    await expect(fetchCalendarFeed('https://example.test/cal.ics', { fetch: declared, maxBytes: 100 })).rejects.toThrow(/larger than/)
    const streamed = vi.fn<FeedFetch>().mockResolvedValue(response('x'.repeat(500)))
    await expect(fetchCalendarFeed('https://example.test/cal.ics', { fetch: streamed, maxBytes: 100 })).rejects.toThrow(/larger than/)
    const slow: FeedFetch = (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    await expect(fetchCalendarFeed('https://example.test/cal.ics', { fetch: slow, timeoutMs: 20 })).rejects.toThrow(/did not respond in time/)
  })
})

describe('calendar subscriptions', () => {
  const fetcher = (fetch: FeedFetch): typeof fetchCalendarFeed => (url, options) => fetchCalendarFeed(url, { ...options, fetch })

  it('creates a read-only calendar from the first successful fetch with stable event ids', async () => {
    const store = new InterchangeStore(':memory:')
    const calendar = await createSubscription(store, { url: 'webcal://example.test/holidays.ics', refreshMinutes: 60 }, fetcher(async () => response(feed('Christmas'))))
    expect(calendar).toMatchObject({ kind: 'subscription', name: 'Holidays', url: 'https://example.test/holidays.ics', refreshMinutes: 60 })
    const [event] = store.events(calendar.id)
    expect(event).toMatchObject({ title: 'Christmas', start: '2026-12-25', allDay: true, readOnly: true, sourceUid: 'holiday-1', calendarId: calendar.id })
    await expect(createSubscription(store, { url: 'https://example.test/holidays.ics' }, fetcher(async () => response(feed('x'))))).rejects.toThrow(/already subscribed/)
    await expect(createSubscription(store, { url: 'https://example.test/other.ics', refreshMinutes: 7 }, fetcher(async () => response(feed('x'))))).rejects.toThrow(/refresh interval/)
    await expect(createSubscription(store, { url: 'https://example.test/broken.ics' }, fetcher(async () => response('<html>')))).rejects.toThrow(/not an iCalendar/)
    expect(store.calendars()).toHaveLength(1)

    const refreshed = await refreshSubscription(store, calendar.id, fetcher(async () => response(feed('Christmas Day', 'BEGIN:VEVENT\r\nUID:new\r\nDTSTART:20261231T230000Z\r\nSUMMARY:New Year\r\nEND:VEVENT\r\n'))))
    expect(refreshed?.error).toBeUndefined()
    const events = store.events(calendar.id)
    expect(events).toHaveLength(2)
    expect(events.find((item) => item.sourceUid === 'holiday-1')).toMatchObject({ id: event.id, title: 'Christmas Day' })
  })

  it('keeps the last good copy when a refresh fails or returns a malformed calendar', async () => {
    const store = new InterchangeStore(':memory:')
    const calendar = await createSubscription(store, { url: 'https://example.test/cal.ics', name: 'Team' }, fetcher(async () => response(feed('Kept'))))
    const before = store.events(calendar.id)
    const failed = await refreshSubscription(store, calendar.id, fetcher(async () => new Response('down', { status: 500 })), new Date('2026-10-01T00:00:00Z'))
    expect(failed).toMatchObject({ name: 'Team', error: 'The calendar server responded with 500', lastAttemptAt: '2026-10-01T00:00:00.000Z', lastRefreshedAt: calendar.lastRefreshedAt })
    expect(store.events(calendar.id)).toEqual(before)
    const malformed = await refreshSubscription(store, calendar.id, fetcher(async () => response('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VCALENDAR\r\n')))
    expect(malformed?.error).toMatch(/unexpected END/)
    expect(store.events(calendar.id)).toEqual(before)
    const recovered = await refreshSubscription(store, calendar.id, fetcher(async () => new Response(null, { status: 304 })))
    expect(recovered?.error).toBeUndefined()
    expect(store.events(calendar.id)).toEqual(before)
    await expect(refreshSubscription(store, 'missing')).rejects.toThrow(/no longer available/)
  })

  it('selects subscriptions whose refresh interval has elapsed', () => {
    const now = Date.parse('2026-10-01T12:00:00Z')
    expect(dueSubscriptions([
      { id: 'local', kind: 'local', name: 'Local', color: '#000' },
      { id: 'never', kind: 'subscription', name: 'Never', color: '#000', url: 'https://a.test' },
      { id: 'due', kind: 'subscription', name: 'Due', color: '#000', refreshMinutes: 60, lastAttemptAt: '2026-10-01T10:59:00Z' },
      { id: 'fresh', kind: 'subscription', name: 'Fresh', color: '#000', refreshMinutes: 60, lastAttemptAt: '2026-10-01T11:30:00Z' }
    ], now).map((calendar) => calendar.id)).toEqual(['never', 'due'])
  })
})

describe('InterchangeStore', () => {
  it('stores local calendars and events, stamps calendar color, and removes calendars with their events', () => {
    const store = new InterchangeStore(':memory:')
    store.saveCalendar({ id: 'local-1', kind: 'local', name: 'Imported', color: '#123456' })
    store.saveEvents('local-1', [{ id: 'e1', calendarId: '', title: 'A', start: '2026-01-01', end: '2026-01-02', allDay: true, color: '', attendees: [], reminderMinutes: 0 }])
    expect(store.snapshot().events).toEqual([expect.objectContaining({ id: 'e1', calendarId: 'local-1', color: '#123456', readOnly: false, allDay: true })])
    expect(() => store.saveEvents('missing', [])).toThrow(/no longer available/)
    store.deleteEvent('e1')
    expect(store.events()).toEqual([])
    store.saveEvents('local-1', [{ id: 'e2', calendarId: '', title: 'B', start: '2026-01-01', end: '2026-01-02', color: '', attendees: [], reminderMinutes: 0 }])
    store.removeCalendar('local-1')
    expect(store.snapshot()).toEqual({ calendars: [], events: [] })
  })
})
