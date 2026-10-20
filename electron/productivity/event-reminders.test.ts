import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CalendarEvent } from '../../src/types'
import { eventReminders, validEventReminders } from '../../src/lib/event-reminders'
import { icsEventToCalendarEvent, parseIcs, serializeIcs } from '../../src/lib/ics'
import { googleEventBody, mapGoogleEvent } from './google-connector'
import { microsoftEventBody, mapMicrosoftEvent } from './microsoft-connector'
import { calendarItemXml, calendarItemUpdates } from '../exchange/ews-items'
import { eventReminderCandidates, startEventReminders } from './event-reminders'
import { TaskReminderService } from './task-reminders'
import { mergeEventResource, eventsFromResource } from './dav-payload'
import { InterchangeStore } from './interchange-store'

const now = Date.parse('2026-10-20T08:00:00Z')
const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'e', calendarId: 'c', title: 'Planning', start: '2026-10-20T09:00:00Z', end: '2026-10-20T10:00:00Z',
  color: '#000', attendees: [], reminderMinutes: 60, reminders: [60, 15, 0], ...overrides
})
const calendar = { id: 'c', accountId: 'a', provider: 'gmail' as const, remoteId: 'c', name: 'Calendar', color: '#000', canWrite: true, primary: false }

describe('multiple event reminders', () => {
  it('distinguishes disabled reminders, at-start, and legacy values and validates untrusted input', () => {
    expect(eventReminders(event({ reminders: [] }))).toEqual([])
    expect(eventReminders(event({ reminders: undefined, reminderMinutes: 0 }))).toEqual([0])
    for (const value of [[-1], [1.5], [40321], [10, 10], [0, 1, 2, 3, 4, 5], '15']) expect(validEventReminders(value)).toBe(false)
    expect(validEventReminders([0, 15, 40320])).toBe(true)
  })

  it('round trips multiple display alarms including zero, and a disabled list, through ICS and CalDAV edits', () => {
    const original = serializeIcs([event()])
    const parsed = icsEventToCalendarEvent(parseIcs(original).events[0], 'c', '#000', 'e')
    expect(parsed.reminders).toEqual([60, 15, 0])
    const collection = { id: 'c', accountId: 'a', name: 'Calendar', color: '#000', readOnly: false }
    const edited = mergeEventResource(original, parsed, { ...parsed, reminders: [120, 30] })
    expect(eventsFromResource(collection, '/e.ics', edited)[0].reminders).toEqual([120, 30])
    expect(serializeIcs([event({ reminders: [] })])).not.toContain('VALARM')
    expect(parseIcs(serializeIcs([event({ reminders: [] })])).events[0].reminders).toEqual([])
  })

  it('maps every Google override and represents provider disabled reminders', () => {
    expect(googleEventBody(event()).reminders).toEqual({ useDefault: false, overrides: [60, 15, 0].map((minutes) => ({ method: 'popup', minutes })) })
    const times = { start: { dateTime: event().start }, end: { dateTime: event().end } }
    expect(mapGoogleEvent('a', calendar, { id: 'remote', ...times, reminders: { useDefault: false, overrides: [{ minutes: 60 }, { minutes: 15 }, { minutes: 0 }] } })?.reminders).toEqual([60, 15, 0])
    expect(mapGoogleEvent('a', calendar, { id: 'remote', ...times, reminders: { useDefault: false } })?.reminders).toEqual([])
    expect(mapGoogleEvent('a', { ...calendar, defaultEventReminders: [60, 5] }, { id: 'remote', ...times, reminders: { useDefault: true } })?.reminders).toEqual([60, 5])
    expect(mapMicrosoftEvent('a', { ...calendar, provider: 'microsoft' }, { id: 'remote', ...times, isReminderOn: false })?.reminders).toEqual([])
  })

  it('rejects unsupported multiple reminders on Microsoft and Exchange and writes off/at-start correctly', () => {
    expect(() => microsoftEventBody(event())).toThrow(/one reminder/)
    expect(() => calendarItemXml(event())).toThrow(/one reminder/)
    expect(() => calendarItemUpdates(event({ reminders: [15] }), event())).toThrow(/one reminder/)
    expect(microsoftEventBody(event({ reminders: [] }))).toMatchObject({ isReminderOn: false })
    expect(microsoftEventBody(event({ reminders: [0] }))).toMatchObject({ isReminderOn: true, reminderMinutesBeforeStart: 0 })
    expect(calendarItemXml(event({ reminders: [0] })).xml).toContain('<t:ReminderIsSet>true</t:ReminderIsSet>')
    expect(calendarItemUpdates(event({ reminders: [15] }), event({ reminders: [] })).updates.join('')).toContain('<t:ReminderIsSet>false</t:ReminderIsSet>')
  })

  it('persists the complete list in local calendar storage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aerio-event-reminders-'))
    let store: InterchangeStore | undefined
    try {
      store = new InterchangeStore(join(dir, 'events.sqlite'))
      const created = { id: 'local', name: 'Local', color: '#000', kind: 'local' as const, readOnly: false }
      store.saveCalendar(created)
      store.saveEvents(created.id, [event({ calendarId: created.id })])
      store.close()
      store = new InterchangeStore(join(dir, 'events.sqlite'))
      expect(store.snapshot().events[0].reminders).toEqual([60, 15, 0])
    } finally { store?.close(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('delivers each offset once across restart and creates fresh keys for recurring occurrences', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aerio-calendar-delivery-'))
    let service: TaskReminderService | undefined
    let clock = now
    const fired: string[] = []
    const candidates = () => eventReminderCandidates([event({ recurrence: 'daily', recurrenceRule: 'FREQ=DAILY;COUNT=2' })], clock)
    const open = () => new TaskReminderService({ path: join(dir, 'calendar.sqlite'), candidates, now: () => clock, notify: (items) => fired.push(...items.map((item) => item.key)), changed: () => {}, schedule: () => () => {} })
    try {
      service = open(); service.tick()
      expect(fired).toHaveLength(1)
      service.close(); service = open(); service.tick()
      expect(fired).toHaveLength(1)
      clock += 60 * 60_000; service.tick()
      expect(fired).toHaveLength(3)
      clock += 23 * 60 * 60_000; service.tick()
      expect(fired).toHaveLength(4)
      expect(new Set(fired).size).toBe(4)
    } finally { service?.close(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('respects notification preferences and lock privacy and bounds historical catch-up', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aerio-calendar-privacy-'))
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now)
    let service: ReturnType<typeof startEventReminders> | undefined
    let enabled = false
    const notify = vi.fn()
    try {
      service = startEventReminders({ userData: dir, events: () => [event()], enabled: () => enabled, locked: () => true, notify })
      expect(notify).not.toHaveBeenCalled()
      enabled = true; service.tick()
      expect(notify).toHaveBeenCalledExactlyOnceWith('Calendar reminder', 'Unlock Aerio to see this reminder')
      expect(eventReminderCandidates([event({ reminders: [40320] })], now)).toEqual([])
    } finally { service?.close(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) }
  })
})
