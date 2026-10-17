import { describe, expect, it } from 'vitest'
import type { CalendarEvent } from '../types'
import { expandCalendarEvents } from './recurrence'
import { planLocalRecurrenceDelete, planLocalRecurrenceSave, shiftSeriesTiming } from './recurrence-edit'

const master: CalendarEvent = {
  id: 'master', calendarId: 'local', title: 'Standup', start: '2026-03-02T14:00:00.000Z', end: '2026-03-02T14:30:00.000Z',
  color: '#000', attendees: [], reminderMinutes: 0, recurrence: 'none', recurrenceRule: 'FREQ=DAILY;COUNT=10', timeZone: 'America/New_York'
}
const window = (events: CalendarEvent[]) => expandCalendarEvents(events, '2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z', { timeZone: 'UTC' })
const occurrenceAt = (events: CalendarEvent[], start: string) => window(events).find((event) => event.start === start)!
let counter = 0
const newId = () => `new-${++counter}`
const apply = (events: CalendarEvent[], plan: { save: CalendarEvent[]; remove: string[] }) => {
  const byId = new Map(events.map((event) => [event.id, event]))
  for (const id of plan.remove) byId.delete(id)
  for (const event of plan.save) byId.set(event.id, event)
  return [...byId.values()]
}

describe('shiftSeriesTiming', () => {
  it('applies the edited wall time and day offset in the event zone across DST', () => {
    // The 9 March occurrence (after the US spring change) moves from 09:00 to 10:00 local.
    const shifted = shiftSeriesTiming(master, '2026-03-09T13:00:00.000Z', { start: '2026-03-09T14:00:00.000Z', end: '2026-03-09T15:00:00.000Z', timeZone: 'America/New_York' })
    expect(shifted).toEqual({ start: '2026-03-02T15:00:00.000Z', end: '2026-03-02T16:00:00.000Z', allDay: undefined })
    expect(shiftSeriesTiming({ start: '2026-03-02', end: '2026-03-03', allDay: true }, '2026-03-04', { start: '2026-03-05', end: '2026-03-07', allDay: true }))
      .toEqual({ start: '2026-03-03', end: '2026-03-05', allDay: true })
  })
})

describe('local recurrence plans', () => {
  it('edits one occurrence as an override linked to the series', () => {
    const events = [master]
    const occurrence = occurrenceAt(events, '2026-03-04T14:00:00.000Z')
    const plan = planLocalRecurrenceSave(events, occurrence, { ...occurrence, title: 'Moved', start: '2026-03-04T18:00:00.000Z', end: '2026-03-04T18:30:00.000Z' }, 'occurrence', newId)
    expect(plan.save).toHaveLength(1)
    expect(plan.save[0]).toMatchObject({ title: 'Moved', seriesId: 'master', recurrenceId: '2026-03-04T14:00:00.000Z', recurrence: 'none' })
    expect(plan.save[0].recurrenceRule).toBeUndefined()
    expect(plan.save[0].occurrenceOf).toBeUndefined()
    const next = apply(events, plan)
    const shown = window(next)
    expect(shown).toHaveLength(10)
    expect(shown.filter((event) => event.start.startsWith('2026-03-04'))).toEqual([expect.objectContaining({ title: 'Moved', start: '2026-03-04T18:00:00.000Z' })])
    // Editing the override again updates it in place.
    const override = shown.find((event) => event.title === 'Moved')!
    expect(planLocalRecurrenceSave(next, override, { ...override, title: 'Moved again' }, 'occurrence', newId).save[0].id).toBe(override.id)
  })

  it('splits a series for this-and-following edits and keeps the remaining COUNT', () => {
    const events = [master]
    const occurrence = occurrenceAt(events, '2026-03-06T14:00:00.000Z')
    const plan = planLocalRecurrenceSave(events, occurrence, { ...occurrence, title: 'Late standup', start: '2026-03-06T15:00:00.000Z', end: '2026-03-06T15:30:00.000Z' }, 'following', newId)
    const [truncated, successor] = plan.save
    expect(truncated).toMatchObject({ id: 'master', recurrenceRule: 'FREQ=DAILY;UNTIL=20260306T135959Z' })
    expect(successor).toMatchObject({ title: 'Late standup', recurrenceRule: 'FREQ=DAILY;COUNT=6', start: '2026-03-06T15:00:00.000Z' })
    expect(successor.seriesId).toBeUndefined()
    const shown = window(apply(events, plan))
    expect(shown).toHaveLength(10)
    expect(shown.filter((event) => event.title === 'Late standup')).toHaveLength(6)
    // Local 10:00 is kept after the 8 March DST change.
    expect(shown.find((event) => event.start.startsWith('2026-03-09') && event.title === 'Late standup')!.start).toBe('2026-03-09T14:00:00.000Z')
  })

  it('moves the whole series and carries exceptions and overrides with it', () => {
    const override: CalendarEvent = { ...master, id: 'override', title: 'Special', recurrenceRule: undefined, seriesId: 'master', recurrenceId: '2026-03-05T14:00:00.000Z', start: '2026-03-05T20:00:00.000Z', end: '2026-03-05T21:00:00.000Z' }
    const events = [{ ...master, recurrenceExceptions: ['2026-03-04T14:00:00.000Z'] }, override]
    const occurrence = occurrenceAt(events, '2026-03-03T14:00:00.000Z')
    const plan = planLocalRecurrenceSave(events, occurrence, { ...occurrence, title: 'Renamed', start: '2026-03-03T13:00:00.000Z', end: '2026-03-03T13:30:00.000Z' }, 'series', newId)
    expect(plan.save[0]).toMatchObject({ id: 'master', title: 'Renamed', start: '2026-03-02T13:00:00.000Z', recurrenceRule: 'FREQ=DAILY;COUNT=10', recurrenceExceptions: ['2026-03-04T13:00:00.000Z'] })
    expect(plan.save[1]).toMatchObject({ id: 'override', recurrenceId: '2026-03-05T13:00:00.000Z' })
    const shown = window(apply(events, plan))
    expect(shown).toHaveLength(9)
    expect(shown.filter((event) => event.start.startsWith('2026-03-05')).map((event) => event.title)).toEqual(['Special'])
  })

  it('deletes one occurrence, following occurrences, or the whole series', () => {
    const override: CalendarEvent = { ...master, id: 'override', recurrenceRule: undefined, seriesId: 'master', recurrenceId: '2026-03-08T13:00:00.000Z' }
    const events = [master, override]
    const one = planLocalRecurrenceDelete(events, occurrenceAt(events, '2026-03-03T14:00:00.000Z'), 'occurrence')
    expect(one.save[0].recurrenceExceptions).toEqual(['2026-03-03T14:00:00.000Z'])
    expect(window(apply(events, one))).toHaveLength(9)
    const overrideDelete = planLocalRecurrenceDelete(events, override, 'occurrence')
    expect(overrideDelete).toEqual({ save: [expect.objectContaining({ recurrenceExceptions: ['2026-03-08T13:00:00.000Z'] })], remove: ['override'] })
    const following = planLocalRecurrenceDelete(events, occurrenceAt(events, '2026-03-05T14:00:00.000Z'), 'following')
    expect(following.remove).toEqual(['override'])
    expect(window(apply(events, following))).toHaveLength(3)
    expect(planLocalRecurrenceDelete(events, occurrenceAt(events, '2026-03-02T14:00:00.000Z'), 'following').remove).toEqual(['master', 'override'])
    expect(planLocalRecurrenceDelete(events, occurrenceAt(events, '2026-03-04T14:00:00.000Z'), 'series').remove).toEqual(['master', 'override'])
  })
})
