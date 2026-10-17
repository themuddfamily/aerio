import { describe, expect, it } from 'vitest'
import type { Task } from '../types'
import { connectedImportInput, importLocalTasks, localTaskUid, parseTaskIcsSource, serializeLocalTasks, taskIcsItems } from './task-ics'
import { parseVTodos } from './vtodo'

// A round-trip fixture in the style of Thunderbird/Apple Reminders exports: zones, alarms, a series
// with an overridden occurrence, a subtask, vendor properties, and an embedded attachment.
const FIXTURE = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mozilla.org/NONSGML Mozilla Calendar V1.1//EN', 'X-WR-CALNAME:Home',
  'BEGIN:VTODO', 'UID:series-1', 'DTSTAMP:20261001T000000Z', 'SUMMARY:Take out recycling', 'DUE;TZID=Europe/London:20261020T190000',
  'RRULE:FREQ=WEEKLY;BYDAY=TU', 'X-MOZ-GENERATION:3', 'X-MOZ-LASTACK:20261001T000000Z', 'CATEGORIES:Home',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER;RELATED=END:-PT30M', 'X-MOZ-ACKNOWLEDGED:20261001T000000Z', 'END:VALARM', 'END:VTODO',
  'BEGIN:VTODO', 'UID:series-1', 'RECURRENCE-ID;TZID=Europe/London:20261027T190000', 'SUMMARY:Take out recycling (bank holiday)', 'END:VTODO',
  'BEGIN:VTODO', 'UID:parent-1', 'DTSTAMP:20261001T000000Z', 'SUMMARY:Plan trip', 'DTSTART;VALUE=DATE:20261101', 'PERCENT-COMPLETE:25', 'PRIORITY:1',
  'ATTACH;ENCODING=BASE64;VALUE=BINARY;FILENAME=map.png:iVBORw0KGgo=', 'X-APPLE-SORT-ORDER:4', 'END:VTODO',
  'BEGIN:VTODO', 'UID:child-1', 'DTSTAMP:20261001T000000Z', 'SUMMARY:Book train', 'RELATED-TO:parent-1', 'STATUS:COMPLETED', 'COMPLETED:20261005T080000Z', 'END:VTODO',
  'END:VCALENDAR', ''
].join('\r\n')

let counter = 0
const newId = () => `id-${++counter}`

describe('.ics task interchange', () => {
  it('groups occurrences with their series and keeps a standalone source per task', () => {
    const items = taskIcsItems(parseVTodos(FIXTURE))
    expect(items.map((item) => [item.uid, item.occurrences, item.parentUid])).toEqual([['series-1', 1, undefined], ['parent-1', 0, undefined], ['child-1', 0, 'parent-1']])
    expect(items[0]).toMatchObject({ title: 'Take out recycling', due: '2026-10-20T19:00:00', dueTimeZone: 'Europe/London', recurrence: 'FREQ=WEEKLY;BYDAY=TU', categories: ['Home'], reminder: '2026-10-20T17:30:00.000Z' })
    expect(items[0].preserved).toEqual(expect.arrayContaining(['X-MOZ-GENERATION', 'X-MOZ-LASTACK']))
    expect(items[1]).toMatchObject({ priority: 'high', percentComplete: 25, start: '2026-11-01', inlineAttachments: 1 })
    expect(parseTaskIcsSource(items[0].source)).toMatchObject({ uid: 'series-1', occurrences: 1 })
    expect(() => parseTaskIcsSource(FIXTURE)).toThrow(/exactly one/)
  })

  it('round-trips through local tasks without losing properties Aerio does not edit', () => {
    const items = taskIcsItems(parseVTodos(FIXTURE))
    const { tasks } = importLocalTasks([], items, 'Home', 'skip', newId)
    const series = tasks.find((task) => task.title === 'Take out recycling')!
    expect(series).toMatchObject({ listId: 'Home', due: '2026-10-20T18:00:00.000Z', recurrence: 'none', categories: ['Home'], icalendar: { uid: 'series-1' } })
    expect(tasks.find((task) => task.title === 'Plan trip')).toMatchObject({ priority: 'high', percentComplete: 25, start: '2026-11-01' })
    const exported = serializeLocalTasks(tasks.map((task) => task.title === 'Plan trip' ? { ...task, title: 'Plan the trip', percentComplete: 50 } : task), 'Home', new Date('2026-10-17T00:00:00Z'))
    for (const kept of ['X-MOZ-GENERATION:3', 'X-MOZ-ACKNOWLEDGED:20261001T000000Z', 'RRULE:FREQ=WEEKLY;BYDAY=TU', 'RECURRENCE-ID;TZID=Europe/London:20261027T190000', 'DUE;TZID=Europe/London:20261020T190000', 'TRIGGER;RELATED=END:-PT30M', 'X-APPLE-SORT-ORDER:4', 'ATTACH;ENCODING=BASE64;VALUE=BINARY;FILENAME=map.png:iVBORw0KGgo=', 'RELATED-TO:parent-1']) expect(exported).toContain(kept)
    const again = taskIcsItems(parseVTodos(exported))
    expect(again.map((item) => item.uid)).toEqual(['series-1', 'parent-1', 'child-1'])
    expect(again[1]).toMatchObject({ title: 'Plan the trip', percentComplete: 50, priority: 'high' })
    expect(again[2]).toMatchObject({ completed: true, parentUid: 'parent-1' })
  })

  it('exports plain local tasks with subtasks and simple repeats', () => {
    const task: Task = { id: 'task-1', listId: 'Today', title: 'Laundry', priority: 'low', completed: false, due: '2026-10-18T09:00:00.000Z', recurrence: 'weekly', subtasks: [{ id: 'sub-1', title: 'Fold', completed: true }], categories: ['Chores'], reminder: '2026-10-18T08:00:00.000Z' }
    const items = taskIcsItems(parseVTodos(serializeLocalTasks([task])))
    expect(items).toMatchObject([
      { uid: 'task-1@aerio.local', title: 'Laundry', priority: 'low', due: '2026-10-18T09:00:00Z', recurrence: 'FREQ=WEEKLY', categories: ['Chores'], reminder: '2026-10-18T08:00:00.000Z' },
      { uid: 'sub-1@aerio.local', title: 'Fold', completed: true, parentUid: 'task-1@aerio.local' }
    ])
    expect(localTaskUid(task)).toBe('task-1@aerio.local')
  })

  it('handles duplicates by UID: skip, replace in place, or import as a copy', () => {
    const items = taskIcsItems(parseVTodos(FIXTURE)).slice(1, 2)
    const first = importLocalTasks([], items, 'Trips', 'skip', newId)
    const existing = first.tasks[0]
    const edited = [{ ...existing, title: 'Edited locally', subtasks: [{ id: 's', title: 'Keep me', completed: false }] }]
    expect(importLocalTasks(edited, items, 'Trips', 'skip', newId)).toMatchObject({ created: 0, skipped: 1, tasks: [{ title: 'Edited locally' }] })
    const replaced = importLocalTasks(edited, items, 'Later', 'replace', newId)
    expect(replaced).toMatchObject({ created: 0, replaced: 1, tasks: [{ id: existing.id, title: 'Plan trip', listId: 'Later', subtasks: [{ title: 'Keep me' }] }] })
    const copied = importLocalTasks(edited, items, 'Trips', 'copy', newId)
    expect(copied.created).toBe(1)
    expect(copied.tasks).toHaveLength(2)
    const copy = copied.tasks[0]
    expect(copy.icalendar!.uid).not.toBe('parent-1')
    expect(copy.icalendar!.source).toContain(`UID:${copy.icalendar!.uid}`)
    expect(copy.icalendar!.source).not.toContain('UID:parent-1')
  })

  it('maps imported tasks to each provider and explains what cannot be kept', () => {
    const [series, parent] = taskIcsItems(parseVTodos(FIXTURE))
    const dav = connectedImportInput('dav', series)
    expect(dav.warnings).toEqual([])
    expect(dav.input.native).toMatchObject({ dueTimeZone: 'Europe/London', categories: ['Home'], caldav: { uid: 'series-1', source: series.source } })
    const google = connectedImportInput('gmail', series)
    expect(google.input).toEqual({ title: 'Take out recycling', completed: false, due: '2026-10-20' })
    expect(google.local).toMatchObject({ priority: 'normal', recurrence: 'none', extended: { categories: ['Home'], reminder: '2026-10-20T17:30:00.000Z' } })
    expect(google.warnings.join('\n')).toMatch(/repeat rule was not imported[\s\S]*changed occurrence[\s\S]*X-MOZ-GENERATION[\s\S]*without its time/)
    const microsoft = connectedImportInput('microsoft', parent)
    expect(microsoft.input.native).toMatchObject({ priority: 'high', status: 'notStarted', start: '2026-11-01' })
    expect(microsoft.local).toEqual({ priority: 'normal', recurrence: 'none', extended: { percentComplete: 25 } })
    expect(microsoft.warnings.join('\n')).toMatch(/embedded files/)
  })
})
