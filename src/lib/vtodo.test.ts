import { describe, expect, it } from 'vitest'
import {
  describeRecurrenceRule, emitComponents, ensureTimeZones, newCalendar, newVTodo, normalizeVTodoStatus, parseVTodos, patchVTodo,
  removeOccurrence, simpleTaskRepeat
} from './vtodo'

const calendar = (...lines: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Other//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n')
const FULL = calendar(
  'BEGIN:VTODO', 'UID:full-1', 'DTSTAMP:20261001T000000Z', 'SUMMARY:Write report', 'DESCRIPTION:Draft\\, then review\\nwith team',
  'DTSTART;TZID=Europe/Berlin:20261019T090000', 'DUE;VALUE=DATE:20261021', 'STATUS:IN-PROCESS', 'PERCENT-COMPLETE:40', 'PRIORITY:2',
  'CATEGORIES:Work,Writing', 'CATEGORIES:work,Urgent', 'RELATED-TO;RELTYPE=PARENT:parent-uid', 'RELATED-TO;RELTYPE=SIBLING:sibling-uid',
  'ATTACH;FMTTYPE=application/pdf;FILENAME=brief.pdf:https://ex.com/b.pdf',
  'ATTACH;ENCODING=BASE64;VALUE=BINARY;X-FILENAME=note.txt:SGVsbG8gd29ybGQh',
  'X-APPLE-SORT-ORDER:12', 'X-CUSTOM;X-PARAM=kept:custom value', 'CLASS:PRIVATE',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER;RELATED=START:-PT15M', 'END:VALARM', 'END:VTODO'
)

describe('VTODO mapping', () => {
  it('maps every edited property and lists the ones it preserves', () => {
    const [item] = parseVTodos(FULL).items
    expect(item.uid).toBe('full-1')
    expect(item.fields).toEqual({
      title: 'Write report', notes: 'Draft, then review\nwith team', due: '2026-10-21', start: '2026-10-19T09:00:00', startTimeZone: 'Europe/Berlin',
      completed: false, status: 'inProgress', percentComplete: 40, priority: 'high', categories: ['Work', 'Writing', 'Urgent'],
      // 09:00 Berlin (UTC+2 in October) minus 15 minutes.
      reminder: '2026-10-19T06:45:00.000Z', parentUid: 'parent-uid'
    })
    expect(item.links).toEqual([{ uri: 'https://ex.com/b.pdf', name: 'brief.pdf', contentType: 'application/pdf' }])
    expect(item.inlineAttachments).toEqual([{ name: 'note.txt', size: 12 }])
    expect(item.preserved).toEqual(expect.arrayContaining(['RELATED-TO', 'X-APPLE-SORT-ORDER', 'X-CUSTOM', 'CLASS']))
  })

  it('maps status, priority, UTC and floating times, and absolute or due-relative alarms', () => {
    const parsed = parseVTodos(calendar(
      'BEGIN:VTODO', 'UID:a', 'SUMMARY:Done', 'STATUS:COMPLETED', 'COMPLETED:20261002T100000Z', 'PRIORITY:5', 'DUE:20261020T170000Z',
      'BEGIN:VALARM', 'TRIGGER;VALUE=DATE-TIME:20261020T080000Z', 'ACTION:DISPLAY', 'END:VALARM', 'END:VTODO',
      'BEGIN:VTODO', 'UID:b', 'SUMMARY:Later', 'PRIORITY:9', 'DUE:20261020T170000', 'BEGIN:VALARM', 'TRIGGER;RELATED=END:-PT1H', 'ACTION:DISPLAY', 'END:VALARM', 'END:VTODO',
      'BEGIN:VTODO', 'UID:c', 'SUMMARY:Dropped', 'STATUS:CANCELLED', 'END:VTODO',
      'BEGIN:VTODO', 'UID:d', 'END:VTODO'
    ))
    const [a, b, c, d] = parsed.items.map((item) => item.fields)
    expect(a).toMatchObject({ completed: true, status: 'completed', priority: 'normal', due: '2026-10-20T17:00:00Z', reminder: '2026-10-20T08:00:00.000Z' })
    expect(b).toMatchObject({ completed: false, status: 'notStarted', priority: 'low', due: '2026-10-20T17:00:00' })
    expect(b.dueTimeZone).toBeUndefined()
    expect(Date.parse(b.reminder!)).toBe(new Date(2026, 9, 20, 16, 0, 0).getTime())
    expect(c).toMatchObject({ status: 'cancelled', completed: false })
    expect(d).toMatchObject({ title: 'Untitled task', priority: 'normal', categories: [] })
  })

  it('counts events without reading them, and assigns UIDs only when asked', () => {
    const text = calendar('BEGIN:VEVENT', 'UID:e', 'DTSTART:20261020T090000Z', 'END:VEVENT', 'BEGIN:VTODO', 'SUMMARY:No uid', 'END:VTODO')
    expect(parseVTodos(text)).toMatchObject({ items: [], otherComponents: ['VEVENT'], warnings: ['1 task without a UID was skipped'] })
    const assigned = parseVTodos(text, { uid: () => 'new-uid' })
    expect(assigned.items[0].uid).toBe('new-uid')
    expect(emitComponents(assigned.calendars)).toContain('UID:new-uid')
  })

  it('round-trips an unchanged task byte for byte', () => {
    const parsed = parseVTodos(FULL)
    const [item] = parsed.items
    expect(patchVTodo(item.component, item.fields, item.fields)).toEqual([])
    expect(emitComponents(parsed.calendars)).toBe(FULL)
  })

  it('patches only edited properties and keeps everything else', () => {
    const parsed = parseVTodos(FULL)
    const [item] = parsed.items
    const now = new Date('2026-10-17T12:00:00Z')
    const changed = patchVTodo(item.component, item.fields, normalizeVTodoStatus({ ...item.fields, title: 'Final report', completed: true, priority: 'low', categories: ['Work'], reminder: undefined }, item.fields.status), now)
    expect(changed).toEqual(['SUMMARY', 'STATUS', 'PRIORITY', 'CATEGORIES', 'VALARM'])
    const text = emitComponents(parsed.calendars)
    expect(text).toContain('SUMMARY:Final report')
    expect(text).toContain('STATUS:COMPLETED')
    expect(text).toContain('COMPLETED:20261017T120000Z')
    expect(text).toContain('PRIORITY:9')
    expect(text).toContain('CATEGORIES:Work\r\n')
    expect(text).not.toContain('VALARM')
    for (const kept of ['DTSTART;TZID=Europe/Berlin:20261019T090000', 'DUE;VALUE=DATE:20261021', 'X-CUSTOM;X-PARAM=kept:custom value', 'RELATED-TO;RELTYPE=SIBLING:sibling-uid', 'ATTACH;ENCODING=BASE64;VALUE=BINARY;X-FILENAME=note.txt:SGVsbG8gd29ybGQh', 'CLASS:PRIVATE', 'PERCENT-COMPLETE:40']) expect(text).toContain(kept)
    const reread = parseVTodos(text).items[0].fields
    expect(reread).toMatchObject({ title: 'Final report', completed: true, priority: 'low', categories: ['Work'] })
    expect(reread.reminder).toBeUndefined()
  })

  it('writes dates, zones and reminders, and reopening clears COMPLETED', () => {
    const component = newVTodo('n-1', { title: 'Call', due: '2026-11-02T10:30:00', dueTimeZone: 'America/New_York', start: '2026-11-01', completed: true, status: 'completed', priority: 'high', categories: ['Calls'], reminder: '2026-11-02T14:00:00.000Z', parentUid: 'p-1', percentComplete: 100 }, new Date('2026-10-17T00:00:00Z'))
    const cal = newCalendar([component], 'Errands')
    ensureTimeZones(cal)
    const text = emitComponents([cal])
    expect(text).toContain('DUE;TZID=America/New_York:20261102T103000')
    expect(text).toContain('DTSTART;VALUE=DATE:20261101')
    expect(text).toContain('TRIGGER;VALUE=DATE-TIME:20261102T140000Z')
    expect(text).toContain('BEGIN:VTIMEZONE\r\nTZID:America/New_York')
    expect(text).toContain('X-WR-CALNAME:Errands')
    const parsed = parseVTodos(text)
    const [item] = parsed.items
    expect(item.fields).toMatchObject({ due: '2026-11-02T10:30:00', dueTimeZone: 'America/New_York', start: '2026-11-01', completed: true, parentUid: 'p-1', reminder: '2026-11-02T14:00:00.000Z' })
    patchVTodo(item.component, item.fields, normalizeVTodoStatus({ ...item.fields, completed: false }, item.fields.status))
    const reopened = emitComponents(parsed.calendars)
    expect(reopened).toContain('STATUS:NEEDS-ACTION')
    expect(reopened).not.toMatch(/^COMPLETED:/m)
  })

  it('removes one overridden occurrence and excludes it from the series', () => {
    const text = calendar(
      'BEGIN:VTODO', 'UID:s', 'SUMMARY:Water plants', 'DUE;VALUE=DATE:20261019', 'RRULE:FREQ=WEEKLY', 'END:VTODO',
      'BEGIN:VTODO', 'UID:s', 'RECURRENCE-ID;VALUE=DATE:20261026', 'SUMMARY:Water plants (balcony)', 'END:VTODO'
    )
    const parsed = parseVTodos(text)
    expect(parsed.items.map((item) => [item.recurrenceId, item.recurrence])).toEqual([[undefined, 'FREQ=WEEKLY'], ['20261026', undefined]])
    expect(removeOccurrence(parsed.calendars[0], 's', '20261026')).toBe(true)
    const result = emitComponents(parsed.calendars)
    expect(result).toContain('EXDATE;VALUE=DATE:20261026')
    expect(result).not.toContain('balcony')
  })

  it('recognizes simple repeat rules and describes others', () => {
    expect(simpleTaskRepeat('FREQ=WEEKLY')).toBe('weekly')
    expect(simpleTaskRepeat('FREQ=MONTHLY;INTERVAL=1')).toBe('monthly')
    expect(simpleTaskRepeat('FREQ=WEEKLY;BYDAY=MO')).toBeUndefined()
    expect(simpleTaskRepeat('FREQ=DAILY;INTERVAL=2')).toBeUndefined()
    expect(describeRecurrenceRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261231T000000Z')).toBe('Repeats every 2 weeks on Monday, Wednesday, until 2026-12-31')
  })
})
