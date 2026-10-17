import { describe, expect, it } from 'vitest'
import type { CalendarEvent, Contact } from '../types'
import { mergeContacts, planContactImport, planEventImport, preserveEventInterchangeFields } from './interchange-plan'
import { validContactInterchangeFields, validInterchangeEvent } from './interchange-validation'

const contact = (overrides: Partial<Contact>): Contact => ({ id: 'id', name: 'Name', email: '', group: 'Personal', favorite: false, color: '#000', ...overrides })
const event = (overrides: Partial<CalendarEvent>): CalendarEvent => ({
  id: 'e', calendarId: 'cal', title: 'Event', start: '2026-01-01T10:00:00.000Z', end: '2026-01-01T11:00:00.000Z', color: '#000', attendees: [], reminderMinutes: 0, ...overrides
})

describe('planContactImport', () => {
  const existing = [
    contact({ id: 'ada', name: 'Ada Lovelace', email: 'ada@test', phone: '555 0100', favorite: true, source: 'local' }),
    contact({ id: 'uid', name: 'Old Name', email: '', sourceUid: 'urn:1' }),
    contact({ id: 'grace', name: 'Grace Hopper', email: '', phone: '+1 (555) 0199' })
  ]
  const incoming = [
    contact({ id: 'n1', name: 'A. Lovelace', email: 'ADA@test', emails: [{ value: 'ADA@test' }, { value: 'ada@work.test' }], company: 'Engines' }),
    contact({ id: 'n2', name: 'Renamed', sourceUid: 'urn:1', title: 'Admiral' }),
    contact({ id: 'n3', name: 'Grace Hopper', phone: '+15550199' }),
    contact({ id: 'n4', name: 'New Person', email: 'new@test' }),
    contact({ id: 'n5', name: 'New Person', email: 'new@test', phone: '777 8888' })
  ]

  it('merges duplicates by UID, email, or name and phone, folding repeated rows into one new contact', () => {
    const plan = planContactImport(incoming, existing, 'merge')
    expect(plan.map((item) => item.action)).toEqual(['merge', 'merge', 'merge', 'create', 'skip'])
    expect(plan[0].contact).toMatchObject({ id: 'ada', name: 'Ada Lovelace', favorite: true, source: 'local', company: 'Engines', email: 'ada@test' })
    expect(plan[0].contact.emails?.map((field) => field.value)).toEqual(['ada@test', 'ada@work.test'])
    expect(plan[1].contact).toMatchObject({ id: 'uid', name: 'Old Name', title: 'Admiral' })
    expect(plan[2].match?.id).toBe('grace')
    expect(plan[3].contact).toMatchObject({ id: 'n4', phone: '777 8888' })
  })

  it('skips duplicates or creates copies when asked', () => {
    expect(planContactImport(incoming, existing, 'skip').map((item) => item.action)).toEqual(['skip', 'skip', 'skip', 'create', 'skip'])
    expect(planContactImport(incoming, existing, 'create').every((item) => item.action === 'create')).toBe(true)
  })

  it('keeps existing values when merging', () => {
    const merged = mergeContacts(contact({ id: 'a', name: 'Keep', email: 'keep@test', notes: 'old' }), contact({ id: 'b', name: 'Other', email: 'other@test', notes: 'new', company: 'Co' }))
    expect(merged).toMatchObject({ id: 'a', name: 'Keep', email: 'keep@test', notes: 'old', company: 'Co' })
    expect(merged.emails?.map((field) => field.value)).toEqual(['keep@test', 'other@test'])
  })
})

describe('planEventImport', () => {
  it('updates matching UIDs, matches by title and time, and skips repeats within a file', () => {
    const existing = [event({ id: 'old', sourceUid: 'uid-1', calendarId: 'dest', color: '#abc' }), event({ id: 'same', title: 'Lunch', start: '2026-02-01T12:00:00.000Z', end: '2026-02-01T13:00:00.000Z' })]
    const incoming = [
      event({ id: 'n1', sourceUid: 'uid-1', title: 'Changed' }),
      event({ id: 'n2', sourceUid: 'uid-1', recurrenceId: '2026-01-08T10:00:00.000Z' }),
      event({ id: 'n3', title: 'lunch', start: '2026-02-01T12:00:00.000Z', end: '2026-02-01T13:00:00.000Z' }),
      event({ id: 'n4', sourceUid: 'uid-1', title: 'Repeat in file' })
    ]
    const plan = planEventImport(incoming, existing, 'update')
    expect(plan.map((item) => item.action)).toEqual(['update', 'create', 'update', 'skip'])
    expect(plan[0].event).toMatchObject({ id: 'old', calendarId: 'dest', color: '#abc', title: 'Changed' })
    expect(planEventImport(incoming, existing, 'skip').map((item) => item.action)).toEqual(['skip', 'create', 'skip', 'skip'])
    expect(planEventImport(incoming, existing, 'create').map((item) => item.action)).toEqual(['create', 'create', 'create', 'skip'])
  })
})

describe('preserveEventInterchangeFields', () => {
  it('keeps source data unless the user changed recurrence or all-day times', () => {
    const original = event({ allDay: true, start: '2026-03-01', end: '2026-03-02', timeZone: 'Europe/Paris', sourceUid: 'u', recurrence: 'weekly', recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO,WE', recurrenceExceptions: ['2026-03-08'] })
    const unchanged = preserveEventInterchangeFields(original, event({ start: new Date(2026, 2, 1).toISOString(), end: new Date(2026, 2, 2).toISOString(), recurrence: 'weekly', title: 'Renamed' }))
    expect(unchanged).toMatchObject({ title: 'Renamed', allDay: true, start: '2026-03-01', end: '2026-03-02', recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO,WE', sourceUid: 'u', timeZone: 'Europe/Paris' })
    const changed = preserveEventInterchangeFields(original, event({ start: '2026-03-01T09:00:00.000Z', end: '2026-03-01T10:00:00.000Z', recurrence: 'daily' }))
    expect(changed.allDay).toBeUndefined()
    expect(changed.recurrenceRule).toBeUndefined()
    expect(changed.recurrenceExceptions).toBeUndefined()
    expect(changed.sourceUid).toBe('u')
  })
})

describe('interchange validation', () => {
  it('accepts all-day and time-zoned events and rejects mismatched or oversized values', () => {
    expect(validInterchangeEvent(event({ allDay: true, start: '2026-03-01', end: '2026-03-02' }))).toBe(true)
    expect(validInterchangeEvent(event({ timeZone: 'America/New_York', recurrenceRule: 'FREQ=DAILY', recurrenceExceptions: ['2026-01-02T10:00:00.000Z'] }))).toBe(true)
    expect(validInterchangeEvent(event({ start: '2026-03-01', end: '2026-03-02T00:00:00.000Z' }))).toBe(false)
    expect(validInterchangeEvent(event({ recurrenceExceptions: ['not a date'] }))).toBe(false)
    expect(validInterchangeEvent(event({ end: '2025-01-01T00:00:00.000Z' }))).toBe(false)
    expect(validContactInterchangeFields(contact({ emails: [{ value: 'a@test', type: 'work' }], nameParts: ['A', 'B'] }))).toBe(true)
    expect(validContactInterchangeFields(contact({ emails: Array.from({ length: 51 }, () => ({ value: 'a@test' })) }))).toBe(false)
    expect(validContactInterchangeFields(contact({ phones: [{ value: '' }] }))).toBe(false)
  })
})
