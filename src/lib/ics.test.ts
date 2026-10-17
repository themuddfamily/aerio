import { describe, expect, it } from 'vitest'
import type { CalendarEvent } from '../types'
import { foldLine, parseContentLine, unfoldLines } from './content-lines'
import { buildVTimeZone, icsEventToCalendarEvent, InterchangeFormatError, normalizeRecurrenceRule, parseIcs, serializeIcs, simpleRecurrence, ICS_LIMITS } from './ics'
import { resolveTimeZoneName, wallTimeToUtc } from './time-zones'

const calendar = (body: string, header = '') => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\n${header}${body}END:VCALENDAR\r\n`
const vevent = (lines: string) => `BEGIN:VEVENT\r\n${lines}END:VEVENT\r\n`

const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'event-1', calendarId: 'local', title: 'Planning', start: '2026-03-10T14:00:00.000Z', end: '2026-03-10T15:00:00.000Z',
  color: '#000', attendees: [], reminderMinutes: 0, recurrence: 'none', ...overrides
})

describe('content lines', () => {
  it('unfolds continuation lines and parses quoted, caret-encoded, and multi-valued parameters', () => {
    const lines = unfoldLines('DESCRIPTION:one\r\n  two\r\n\tthree\nSUMMARY:x', ICS_LIMITS)
    expect(lines).toEqual(['DESCRIPTION:one twothree', 'SUMMARY:x'])
    expect(parseContentLine('ATTENDEE;CN="Doe; Jane: PhD";ROLE=REQ-PARTICIPANT;X-NOTE=a^nb:mailto:jane@example.test')).toEqual({
      name: 'ATTENDEE', params: { CN: ['Doe; Jane: PhD'], ROLE: ['REQ-PARTICIPANT'], 'X-NOTE': ['a\nb'] }, value: 'mailto:jane@example.test'
    })
    expect(parseContentLine('item1.EMAIL;TYPE=work,pref:a@example.test')).toMatchObject({ group: 'item1', name: 'EMAIL', params: { TYPE: ['work', 'pref'] } })
    expect(parseContentLine('no separator')).toBeUndefined()
    expect(parseContentLine('X;CN="unterminated:value')).toBeUndefined()
  })

  it('folds at 75 octets without splitting multi-byte characters', () => {
    const line = `SUMMARY:${'é'.repeat(60)}${'🙂'.repeat(10)}`
    const folded = foldLine(line)
    for (const part of folded.split('\r\n')) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75)
    expect(unfoldLines(folded, ICS_LIMITS)[0]).toBe(line)
  })
})

describe('time zones', () => {
  it('resolves IANA, Windows, and vendor-prefixed TZIDs', () => {
    expect(resolveTimeZoneName('America/New_York')).toBe('America/New_York')
    expect(resolveTimeZoneName('Pacific Standard Time')).toBe('America/Los_Angeles')
    expect(resolveTimeZoneName('/mozilla.org/20050126_1/Europe/Paris')).toBe('Europe/Paris')
    expect(resolveTimeZoneName('Nowhere Standard Time')).toBeUndefined()
  })

  it('moves wall times in a DST gap forward and picks the first occurrence of repeated times', () => {
    expect(new Date(wallTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 }, 'America/New_York')).toISOString()).toBe('2026-03-08T07:30:00.000Z')
    expect(new Date(wallTimeToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 }, 'America/New_York')).toISOString()).toBe('2026-11-01T05:30:00.000Z')
    expect(new Date(wallTimeToUtc({ year: 2026, month: 10, day: 25, hour: 2, minute: 30, second: 0 }, 'Europe/Berlin')).toISOString()).toBe('2026-10-25T00:30:00.000Z')
  })
})

describe('parseIcs', () => {
  it('reads TZID, UTC, all-day, duration, escaping, alarms, attendees, recurrence, and exceptions', () => {
    const parsed = parseIcs(calendar(
      vevent([
        'UID:abc@example.test',
        'DTSTART;TZID=America/New_York:20260310T090000',
        'DTEND;TZID=America/New_York:20260310T103000',
        'SUMMARY:Board\\, quarterly\\; review',
        'DESCRIPTION:Line one\\nLine two\\\\done',
        'LOCATION:Room 4',
        'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=10',
        'EXDATE;TZID=America/New_York:20260317T090000,20260324T090000',
        'ATTENDEE;CN=Ada:mailto:ada@example.test',
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT30M', 'END:VALARM', ''
      ].join('\r\n')) +
      vevent('UID:holiday\r\nDTSTART;VALUE=DATE:20260704\r\nSUMMARY:Holiday\r\n') +
      vevent('UID:utc\r\nDTSTART:20260401T120000Z\r\nDURATION:PT45M\r\nSUMMARY:UTC call\r\n') +
      vevent('UID:override\r\nRECURRENCE-ID;TZID=America/New_York:20260331T090000\r\nDTSTART;TZID=America/New_York:20260331T110000\r\nDTEND;TZID=America/New_York:20260331T120000\r\nSUMMARY:Moved\r\n') +
      vevent('UID:cancelled\r\nSTATUS:CANCELLED\r\nDTSTART:20260401T120000Z\r\nSUMMARY:Gone\r\n'),
      'X-WR-CALNAME:Team\\, shared\r\n'
    ))
    expect(parsed.calendarName).toBe('Team, shared')
    expect(parsed.events).toHaveLength(4)
    const [board, holiday, utc, override] = parsed.events
    expect(board).toMatchObject({
      uid: 'abc@example.test', title: 'Board, quarterly; review', description: 'Line one\nLine two\\done', location: 'Room 4',
      start: '2026-03-10T13:00:00.000Z', end: '2026-03-10T14:30:00.000Z', allDay: false, timeZone: 'America/New_York',
      recurrenceRule: 'FREQ=WEEKLY;BYDAY=TU;COUNT=10', recurrenceExceptions: ['2026-03-17T13:00:00.000Z', '2026-03-24T13:00:00.000Z'],
      attendees: ['ada@example.test'], reminderMinutes: 30
    })
    expect(holiday).toMatchObject({ start: '2026-07-04', end: '2026-07-05', allDay: true })
    expect(utc).toMatchObject({ start: '2026-04-01T12:00:00.000Z', end: '2026-04-01T12:45:00.000Z' })
    expect(override).toMatchObject({ uid: 'override', recurrenceId: '2026-03-31T13:00:00.000Z', start: '2026-03-31T15:00:00.000Z' })
    expect(icsEventToCalendarEvent(board, 'cal', '#123', 'id-1')).toMatchObject({ id: 'id-1', calendarId: 'cal', recurrence: 'weekly', sourceUid: 'abc@example.test' })
  })

  it('uses VTIMEZONE rules for TZIDs outside the Intl database', () => {
    const zone = [
      'BEGIN:VTIMEZONE', 'TZID:Custom Eastern',
      'BEGIN:STANDARD', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'END:STANDARD',
      'BEGIN:DAYLIGHT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'END:DAYLIGHT',
      'END:VTIMEZONE', ''
    ].join('\r\n')
    const parsed = parseIcs(calendar(
      vevent('UID:winter\r\nDTSTART;TZID=Custom Eastern:20260115T090000\r\nSUMMARY:Winter\r\n') +
      vevent('UID:summer\r\nDTSTART;TZID="Custom Eastern":20260715T090000\r\nSUMMARY:Summer\r\n'),
      zone
    ))
    expect(parsed.events.map((item) => item.start)).toEqual(['2026-01-15T14:00:00.000Z', '2026-07-15T13:00:00.000Z'])
    expect(parsed.events[0].timeZone).toBe('Custom Eastern')
  })

  it('reports malformed content without losing valid events', () => {
    const parsed = parseIcs(calendar(
      vevent('UID:ok\r\nDTSTART:20260101T100000Z\r\nSUMMARY:Valid\r\nthis line is broken\r\nRRULE:FREQ=SOMETIMES\r\n') +
      vevent('UID:bad\r\nDTSTART:2026-13-45\r\nSUMMARY:No start\r\n')
    ))
    expect(parsed.events.map((item) => item.title)).toEqual(['Valid'])
    expect(parsed.events[0].recurrenceRule).toBeUndefined()
    expect(parsed.warnings.join(' ')).toMatch(/malformed line/)
    expect(parsed.warnings.join(' ')).toMatch(/repeat rule/)
    expect(parsed.warnings.join(' ')).toMatch(/without a valid start/)
  })

  it('keeps complete events from a truncated file and rejects structurally invalid files', () => {
    const truncated = parseIcs('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20260101T100000Z\r\nSUMMARY:Kept\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:b\r\nDTSTART:2026')
    expect(truncated.events.map((item) => item.title)).toEqual(['Kept'])
    expect(truncated.warnings.join(' ')).toMatch(/ended before VEVENT/)
    expect(() => parseIcs('BEGIN:VCARD\r\nFN:x\r\nEND:VCARD\r\n')).toThrow(InterchangeFormatError)
    expect(() => parseIcs('<html>Not found</html>')).toThrow(/not an iCalendar/)
    expect(() => parseIcs('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VTODO\r\nEND:VCALENDAR')).toThrow(/unexpected END:VTODO/)
  })

  it('enforces size, line, nesting, and event-count limits', () => {
    expect(() => parseIcs(calendar(''), { ...ICS_LIMITS, maxChars: 10 })).toThrow(/import limit/)
    expect(() => parseIcs(calendar(`X-LONG:${'a'.repeat(200)}\r\n`), { ...ICS_LIMITS, maxLineLength: 100 })).toThrow(/too long/)
    expect(() => parseIcs(`${'BEGIN:X\r\n'.repeat(10)}`, { ...ICS_LIMITS, maxDepth: 4 })).toThrow(/too deeply/)
    const many = calendar(Array.from({ length: 4 }, (_, index) => vevent(`UID:${index}\r\nDTSTART:20260101T100000Z\r\n`)).join(''))
    expect(() => parseIcs(many, ICS_LIMITS, 3)).toThrow(/more than 3 events/)
  })

  it('normalizes and simplifies recurrence rules', () => {
    expect(normalizeRecurrenceRule('freq=monthly;bymonthday=15')).toBe('FREQ=MONTHLY;BYMONTHDAY=15')
    expect(normalizeRecurrenceRule('FREQ=DAILY;COUNT=2;UNTIL=20260101T000000Z')).toBeUndefined()
    expect(normalizeRecurrenceRule('FREQ=DAILY;X-EVIL=1')).toBeUndefined()
    expect(simpleRecurrence('FREQ=DAILY')).toBe('daily')
    expect(simpleRecurrence('FREQ=WEEKLY;INTERVAL=2')).toBe('none')
    expect(simpleRecurrence('FREQ=YEARLY')).toBe('none')
  })
})

describe('serializeIcs round trips', () => {
  const now = new Date('2026-01-01T00:00:00Z')

  it('preserves time zones, all-day dates, recurrence, exceptions, reminders, and source identity', () => {
    const events: CalendarEvent[] = [
      event({
        id: 'a', title: 'Standup, daily; team', description: 'Notes\nwith lines', location: 'Room\\1', timeZone: 'America/New_York',
        start: '2026-03-10T13:00:00.000Z', end: '2026-03-10T13:15:00.000Z', recurrence: 'weekly', recurrenceRule: 'FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261231T235959Z',
        recurrenceExceptions: ['2026-03-17T13:00:00.000Z'], sourceUid: 'uid-a@example.test', reminderMinutes: 10, attendees: ['ada@example.test']
      }),
      event({ id: 'b', title: 'Holiday', start: '2026-12-25', end: '2026-12-26', allDay: true, recurrenceRule: 'FREQ=YEARLY', recurrenceExceptions: ['2027-12-25'] }),
      event({ id: 'c', title: 'Override', sourceUid: 'uid-a@example.test', recurrenceId: '2026-03-12T13:00:00.000Z', timeZone: 'America/New_York', start: '2026-03-12T15:00:00.000Z', end: '2026-03-12T15:15:00.000Z' }),
      event({ id: 'd', title: 'Simple monthly', recurrence: 'monthly' })
    ]
    const text = serializeIcs(events, { calendarName: 'Work', now })
    expect(text).toContain('BEGIN:VTIMEZONE\r\nTZID:America/New_York')
    expect(text).toContain('DTSTART;TZID=America/New_York:20260310T090000')
    expect(text).toContain('DTSTART;VALUE=DATE:20261225')
    expect(text).toContain('UID:d@aerio.local')
    expect(text.split('\r\n').every((line) => new TextEncoder().encode(line).length <= 75)).toBe(true)
    const parsed = parseIcs(text)
    expect(parsed.calendarName).toBe('Work')
    const restored = parsed.events.map((item, index) => icsEventToCalendarEvent(item, 'local', '#000', events[index].id))
    expect(restored[0]).toMatchObject({
      title: events[0].title, description: events[0].description, location: events[0].location, timeZone: 'America/New_York',
      start: events[0].start, end: events[0].end, recurrenceRule: events[0].recurrenceRule, recurrenceExceptions: events[0].recurrenceExceptions,
      sourceUid: 'uid-a@example.test', reminderMinutes: 10, attendees: ['ada@example.test'], recurrence: 'weekly'
    })
    expect(restored[1]).toMatchObject({ start: '2026-12-25', end: '2026-12-26', allDay: true, recurrenceRule: 'FREQ=YEARLY', recurrenceExceptions: ['2027-12-25'] })
    expect(restored[2]).toMatchObject({ sourceUid: 'uid-a@example.test', recurrenceId: '2026-03-12T13:00:00.000Z', start: events[2].start })
    expect(restored[3]).toMatchObject({ recurrence: 'monthly', recurrenceRule: 'FREQ=MONTHLY', sourceUid: 'd@aerio.local' })
  })

  it('generates VTIMEZONE rules that reproduce Intl offsets for other parsers', () => {
    for (const [zone, wall, expected] of [
      ['America/New_York', '20260715T090000', '2026-07-15T13:00:00.000Z'],
      ['Australia/Sydney', '20260115T090000', '2026-01-14T22:00:00.000Z'],
      ['Australia/Sydney', '20260715T090000', '2026-07-14T23:00:00.000Z'],
      ['Asia/Tokyo', '20260715T090000', '2026-07-15T00:00:00.000Z']
    ] as const) {
      // Rename the zone so the parser must use the generated rules rather than Intl.
      const vtimezone = buildVTimeZone(zone, 2026).join('\r\n').replace(`TZID:${zone}`, 'TZID:Exported Zone')
      const parsed = parseIcs(calendar(vevent(`UID:x\r\nDTSTART;TZID=Exported Zone:${wall}\r\nSUMMARY:x\r\n`), `${vtimezone}\r\n`))
      expect(parsed.events[0].start).toBe(expected)
    }
  })
})
