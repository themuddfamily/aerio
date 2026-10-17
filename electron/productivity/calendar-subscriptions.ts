import { createHash, randomUUID } from 'node:crypto'
import type { CalendarEvent } from '../../src/types'
import type { CalendarSubscriptionInput, InterchangeCalendar } from '../../src/interchange-types'
import { icsEventToCalendarEvent, parseIcs, ICS_LIMITS } from '../../src/lib/ics'
import type { InterchangeStore } from './interchange-store'

export const SUBSCRIPTION_MAX_BYTES = 10 * 1024 * 1024
export const SUBSCRIPTION_TIMEOUT_MS = 30_000
export const SUBSCRIPTION_REFRESH_CHOICES = [15, 30, 60, 180, 360, 720, 1440]
export const DEFAULT_SUBSCRIPTION_REFRESH_MINUTES = 60
const MAX_REDIRECTS = 5

export type FeedFetch = (url: string, init: RequestInit) => Promise<Response>

export type FeedResult =
  | { status: 'not-modified' }
  | { status: 'ok'; text: string; etag?: string; lastModified?: string; finalUrl: string }

// webcal:// and webcals:// are aliases for HTTPS feeds; plain HTTP and embedded credentials are refused.
export function normalizeSubscriptionUrl(input: unknown) {
  if (typeof input !== 'string' || !input.trim() || input.length > 2_048) throw new Error('Enter a calendar address')
  let url: URL
  try { url = new URL(input.trim().replace(/^webcals?:\/\//i, 'https://')) }
  catch { throw new Error('Enter a valid https:// or webcal:// calendar address') }
  if (url.protocol !== 'https:') throw new Error('Internet calendars must use https:// or webcal://')
  if (url.username || url.password) throw new Error('Remove the user name and password from the calendar address')
  url.hash = ''
  return url.toString()
}

async function readLimited(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > maxBytes) throw new Error(`The calendar feed is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`)
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`The calendar feed is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8').decode(bytes)
}

// Fetches a feed with a total deadline, a byte ceiling, conditional request headers, and redirects
// that are re-validated so an https feed cannot be redirected to another scheme.
export async function fetchCalendarFeed(url: string, options: {
  fetch?: FeedFetch
  timeoutMs?: number
  maxBytes?: number
  etag?: string
  lastModified?: string
} = {}): Promise<FeedResult> {
  const request = options.fetch ?? ((target, init) => fetch(target, init))
  const signal = AbortSignal.timeout(options.timeoutMs ?? SUBSCRIPTION_TIMEOUT_MS)
  let current = normalizeSubscriptionUrl(url)
  try {
    for (let redirects = 0; ; redirects++) {
      const response = await request(current, {
        redirect: 'manual',
        signal,
        headers: {
          Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.1',
          'User-Agent': 'Aerio calendar subscription',
          ...(options.etag ? { 'If-None-Match': options.etag } : {}),
          ...(options.lastModified ? { 'If-Modified-Since': options.lastModified } : {})
        }
      })
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        const location = response.headers.get('location')
        if (!location || redirects >= MAX_REDIRECTS) throw new Error('The calendar feed redirected too many times')
        current = normalizeSubscriptionUrl(new URL(location, current).toString())
        continue
      }
      if (response.status === 304) return { status: 'not-modified' }
      if (!response.ok) throw new Error(`The calendar server responded with ${response.status}`)
      const text = await readLimited(response, options.maxBytes ?? SUBSCRIPTION_MAX_BYTES)
      return {
        status: 'ok', text, finalUrl: current,
        ...(response.headers.get('etag') ? { etag: response.headers.get('etag')!.slice(0, 500) } : {}),
        ...(response.headers.get('last-modified') ? { lastModified: response.headers.get('last-modified')!.slice(0, 100) } : {})
      }
    }
  } catch (error) {
    if (signal.aborted) throw new Error('The calendar feed did not respond in time')
    throw error
  }
}

// Subscription event ids derive from the feed's UID and RECURRENCE-ID so they stay stable across refreshes.
export function subscriptionEvents(calendar: InterchangeCalendar, text: string): { events: CalendarEvent[]; sourceName?: string } {
  const parsed = parseIcs(text, { ...ICS_LIMITS, maxChars: SUBSCRIPTION_MAX_BYTES })
  const used = new Set<string>()
  const events = parsed.events.map((event, index) => {
    const identity = event.uid ? `${event.uid}\u0000${event.recurrenceId ?? ''}` : `${index}\u0000${event.title}\u0000${event.start}`
    let id = `${calendar.id}:${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`
    if (used.has(id)) id = `${id}-${index}`
    used.add(id)
    return icsEventToCalendarEvent(event, calendar.id, calendar.color, id)
  })
  return { events, ...(parsed.calendarName ? { sourceName: parsed.calendarName } : {}) }
}

export function refreshMinutes(value: unknown) {
  const minutes = Number(value ?? DEFAULT_SUBSCRIPTION_REFRESH_MINUTES)
  if (!SUBSCRIPTION_REFRESH_CHOICES.includes(minutes)) throw new Error('Choose a supported refresh interval')
  return minutes
}

export async function createSubscription(store: InterchangeStore, input: CalendarSubscriptionInput, fetchFeed: typeof fetchCalendarFeed = fetchCalendarFeed) {
  const url = normalizeSubscriptionUrl(input?.url)
  if (store.calendars().some((calendar) => calendar.url === url)) throw new Error('You are already subscribed to that calendar')
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 200) : ''
  const draft: InterchangeCalendar = {
    id: `subscription-${randomUUID()}`, kind: 'subscription', name: name || 'Internet calendar', color: store.nextColor(),
    url, refreshMinutes: refreshMinutes(input.refreshMinutes)
  }
  // The first fetch must succeed: there is no last good copy to fall back on yet.
  const feed = await fetchFeed(url)
  if (feed.status !== 'ok') throw new Error('The calendar server did not return a calendar')
  const { events, sourceName } = subscriptionEvents(draft, feed.text)
  const timestamp = new Date().toISOString()
  const calendar: InterchangeCalendar = {
    ...draft, name: name || sourceName || new URL(url).hostname, lastRefreshedAt: timestamp, lastAttemptAt: timestamp,
    ...(sourceName ? { sourceName } : {}), ...(feed.etag ? { etag: feed.etag } : {}), ...(feed.lastModified ? { lastModified: feed.lastModified } : {})
  }
  store.replaceSubscription(calendar, events)
  return calendar
}

// Refresh failures record the error and keep the previously stored events untouched.
export async function refreshSubscription(store: InterchangeStore, calendarId: string, fetchFeed: typeof fetchCalendarFeed = fetchCalendarFeed, now = new Date()) {
  const calendar = store.calendar(calendarId)
  if (!calendar || calendar.kind !== 'subscription' || !calendar.url) throw new Error('That calendar subscription is no longer available')
  const timestamp = now.toISOString()
  try {
    const feed = await fetchFeed(calendar.url, { etag: calendar.etag, lastModified: calendar.lastModified })
    const latest = store.calendar(calendarId)
    if (!latest) return undefined
    if (feed.status === 'not-modified') {
      const next = { ...latest, lastRefreshedAt: timestamp, lastAttemptAt: timestamp, error: undefined }
      store.saveCalendar(next)
      return next
    }
    const { events, sourceName } = subscriptionEvents(latest, feed.text)
    const next: InterchangeCalendar = {
      ...latest, lastRefreshedAt: timestamp, lastAttemptAt: timestamp, error: undefined,
      etag: feed.etag, lastModified: feed.lastModified, ...(sourceName ? { sourceName } : {})
    }
    store.replaceSubscription(next, events)
    return next
  } catch (error) {
    const latest = store.calendar(calendarId)
    if (!latest) return undefined
    const next = { ...latest, lastAttemptAt: timestamp, error: (error instanceof Error ? error.message : 'The calendar could not be refreshed').slice(0, 500) }
    store.saveCalendar(next)
    return next
  }
}

export function dueSubscriptions(calendars: InterchangeCalendar[], now = Date.now()) {
  return calendars.filter((calendar) => {
    if (calendar.kind !== 'subscription') return false
    const last = Date.parse(calendar.lastAttemptAt ?? '')
    return !Number.isFinite(last) || now - last >= (calendar.refreshMinutes ?? DEFAULT_SUBSCRIPTION_REFRESH_MINUTES) * 60_000
  })
}
