import { describe, expect, it } from 'vitest'
import type { CalendarEvent } from '../../src/types'
import {
  contactFromResource, davContactId, davEventId, eventsFromResource, mergeContactResource, mergeEventResource, newContactResource,
  newEventResource, removeEventInstance, resourceTitle
} from './dav-payload'
import { ICS, VCF } from './dav-fixture-server'

const collection = { id: 'acct:work', accountId: 'acct', name: 'Contacts', color: '#123456', readOnly: false }
const href = 'https://dav.example.com/cal/a.ics'

describe('DAV payload mapping', () => {
  it('maps every instance of a calendar object with stable ids', () => {
    const data = ICS('a', 'Master', 'RRULE:FREQ=DAILY').replace('END:VCALENDAR', 'BEGIN:VEVENT\r\nUID:a\r\nRECURRENCE-ID:20261021T090000Z\r\nDTSTART:20261021T110000Z\r\nDTEND:20261021T120000Z\r\nSUMMARY:Moved\r\nEND:VEVENT\r\nEND:VCALENDAR')
    const events = eventsFromResource(collection, href, data)
    expect(events.map((event) => [event.title, event.id, event.remoteId, event.provider, event.color])).toEqual([
      ['Master', davEventId('acct:work', href), href, 'dav', '#123456'],
      ['Moved', davEventId('acct:work', href, '2026-10-21T09:00:00.000Z'), href, 'dav', '#123456']
    ])
    expect(events[0].recurrence).toBe('daily')
    expect(resourceTitle('event', data)).toBe('Master')
    expect(resourceTitle('event', 'garbage')).toBeUndefined()
  })

  it('creates resources with the given UID', () => {
    const event: CalendarEvent = { id: 'x', calendarId: 'c', title: 'New', start: '2026-10-21T09:00:00.000Z', end: '2026-10-21T10:00:00.000Z', color: '', attendees: ['a@example.com'], reminderMinutes: 10, timeZone: 'Europe/Berlin' }
    const data = newEventResource(event, 'uid-1')
    expect(data).toContain('UID:uid-1')
    expect(data).toContain('BEGIN:VTIMEZONE')
    expect(eventsFromResource(collection, href, data)[0]).toMatchObject({ title: 'New', sourceUid: 'uid-1', reminderMinutes: 10, attendees: ['a@example.com'] })
  })

  it('merges edits into a recurring resource without touching other instances', () => {
    const original = ICS('a', 'Master', 'RRULE:FREQ=WEEKLY\nX-KEEP:1').replace('END:VCALENDAR', 'BEGIN:VEVENT\r\nUID:a\r\nRECURRENCE-ID:20261027T090000Z\r\nDTSTART:20261027T110000Z\r\nDTEND:20261027T120000Z\r\nSUMMARY:Override\r\nX-OVERRIDE:yes\r\nEND:VEVENT\r\nEND:VCALENDAR')
    const [master, override] = eventsFromResource(collection, href, original)
    const editedOverride = mergeEventResource(original, override, { ...override, title: 'Override edited' })
    expect(editedOverride).toContain('X-OVERRIDE:yes')
    expect(editedOverride).toContain('SUMMARY:Master')
    expect(editedOverride).toContain('X-KEEP:1')
    const mapped = eventsFromResource(collection, href, editedOverride)
    expect(mapped.map((event) => event.title)).toEqual(['Master', 'Override edited'])

    const editedMaster = mergeEventResource(original, master, { ...master, title: 'Master edited', attendees: ['new@example.com'], reminderMinutes: 15 })
    const titles = eventsFromResource(collection, href, editedMaster)
    expect(titles.map((event) => event.title)).toEqual(['Master edited', 'Override'])
    expect(titles[0]).toMatchObject({ attendees: ['new@example.com'], reminderMinutes: 15, sourceUid: 'a' })
    // A resource that is not a calendar becomes a fresh one.
    expect(mergeEventResource('BEGIN:VCARD\r\nEND:VCARD\r\n', master, master)).toContain('BEGIN:VCALENDAR')
  })

  it('deletes a single occurrence with EXDATE, including one without an override', () => {
    const original = ICS('a', 'Daily', 'RRULE:FREQ=DAILY')
    const next = removeEventInstance(original, '2026-10-22T09:00:00.000Z')!
    expect(eventsFromResource(collection, href, next)[0].recurrenceExceptions).toEqual(['2026-10-22T09:00:00.000Z'])
    expect(removeEventInstance(ICS('b', 'Single'), '2026-10-22T09:00:00.000Z')).toBeUndefined()
  })

  it('maps vCards and skips groups', () => {
    const contact = contactFromResource(collection, href, '"e1"', VCF('u', 'Ada Lovelace', 'EMAIL:ada@example.com'))!
    expect(contact).toMatchObject({ id: davContactId('acct:work', href), name: 'Ada Lovelace', email: 'ada@example.com', group: 'Contacts', revision: '"e1"', folderId: 'acct:work' })
    expect(contactFromResource(collection, href, undefined, VCF('g', 'Team', 'KIND:group'))).toBeUndefined()
    expect(contactFromResource(collection, href, undefined, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')).toBeUndefined()
  })

  it('writes vCards without the default group and keeps unedited properties on update', () => {
    const contact = { id: 'c', name: 'Ada Lovelace', email: 'ada@example.com', group: 'Contacts', favorite: false, color: '' }
    expect(newContactResource(contact, 'uid-9', 'Contacts')).not.toContain('CATEGORIES')
    expect(newContactResource({ ...contact, group: 'Friends' }, 'uid-9', 'Contacts')).toContain('CATEGORIES:Friends')
    const original = VCF('orig', 'Ada Lovelace', 'PHOTO;VALUE=uri:https://example.com/a.jpg\nREV:20200101T000000Z\nCATEGORIES:Contacts\nX-CUSTOM:1').replace('VERSION:3.0', 'VERSION:4.0')
    const merged = mergeContactResource(original, { ...contact, name: 'Ada King' }, 'Contacts')
    expect(merged).toMatch(/^BEGIN:VCARD\r\nVERSION:4.0\r\n/)
    expect(merged).toContain('FN:Ada King')
    expect(merged).toContain('UID:orig')
    expect(merged).toContain('PHOTO;VALUE=uri:https://example.com/a.jpg')
    expect(merged).toContain('X-CUSTOM:1')
    expect(merged).toContain('CATEGORIES:Contacts')
    expect(merged).not.toContain('REV:20200101')
    expect(merged.match(/^UID:/gm)).toHaveLength(1)
  })
})
