import { describe, expect, it } from 'vitest'
import { buildItipReply, evaluateInvitation, invitationAttendee, isCalendarAttachment, parseItip, replyingAttendee, replyMailText, type InvitationRecord } from './itip'

const itip = (method: string, lines: string[], extra = '') => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', `METHOD:${method}`, 'BEGIN:VEVENT', ...lines, 'END:VEVENT', extra, 'END:VCALENDAR', ''
].filter((line, index, all) => line || index === all.length - 1).join('\r\n')

const request = (sequence = 0, stamp = '20260901T120000Z', extra: string[] = []) => itip('REQUEST', [
  'UID:meeting-1@example.test', `SEQUENCE:${sequence}`, `DTSTAMP:${stamp}`,
  'DTSTART;TZID=Europe/Berlin:20261005T100000', 'DTEND;TZID=Europe/Berlin:20261005T110000', 'SUMMARY:Design review',
  'ORGANIZER;CN="Ada Lovelace":mailto:ada@example.test',
  'ATTENDEE;CN=Ada Lovelace;ROLE=CHAIR;PARTSTAT=ACCEPTED:mailto:ada@example.test',
  'ATTENDEE;CN=Grace;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:Grace@Example.test',
  'ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=TENTATIVE:mailto:linus@example.test',
  'ATTENDEE;CUTYPE=ROOM;ROLE=NON-PARTICIPANT;CN=Room 4:mailto:room4@example.test',
  ...extra
])

describe('parseItip', () => {
  it('reads method, organizer, roles, resources, responses, SEQUENCE, and DTSTAMP', () => {
    const message = parseItip(request(2))!
    expect(message.method).toBe('REQUEST')
    expect(message.event).toMatchObject({
      uid: 'meeting-1@example.test', sequence: 2, dtstamp: '2026-09-01T12:00:00.000Z', title: 'Design review',
      start: '2026-10-05T08:00:00.000Z', timeZone: 'Europe/Berlin',
      organizer: { email: 'ada@example.test', name: 'Ada Lovelace' },
      attendees: ['ada@example.test', 'Grace@Example.test', 'linus@example.test', 'room4@example.test']
    })
    expect(message.event.attendeeDetails).toEqual([
      { email: 'ada@example.test', name: 'Ada Lovelace', role: 'chair', response: 'accepted' },
      { email: 'Grace@Example.test', name: 'Grace', role: 'required', response: 'needs-action', rsvp: true },
      { email: 'linus@example.test', role: 'optional', response: 'tentative' },
      { email: 'room4@example.test', name: 'Room 4', role: 'non-participant', kind: 'room' }
    ])
    expect(invitationAttendee(message.event, ['grace@example.test'])).toMatchObject({ email: 'Grace@Example.test', rsvp: true })
    expect(invitationAttendee(message.event, ['nobody@example.test'])).toBeUndefined()
  })

  it('keeps cancelled events, orders the master before overrides, and rejects non-iTIP calendars', () => {
    const cancel = parseItip(itip('CANCEL', ['UID:x', 'SEQUENCE:3', 'STATUS:CANCELLED', 'DTSTART:20261005T080000Z', 'SUMMARY:Gone']))!
    expect(cancel).toMatchObject({ method: 'CANCEL', event: { uid: 'x', status: 'CANCELLED', sequence: 3 } })
    const series = parseItip(itip('REQUEST', ['UID:s', 'RECURRENCE-ID:20261012T080000Z', 'DTSTART:20261012T090000Z', 'SUMMARY:Moved'],
      'BEGIN:VEVENT\r\nUID:s\r\nDTSTART:20261005T080000Z\r\nRRULE:FREQ=WEEKLY\r\nSUMMARY:Weekly\r\nEND:VEVENT'))!
    expect(series.event.title).toBe('Weekly')
    expect(series.instances.map((item) => item.recurrenceId)).toEqual([undefined, '2026-10-12T08:00:00.000Z'])
    expect(parseItip('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20260101T000000Z\r\nEND:VEVENT\r\nEND:VCALENDAR')).toBeUndefined()
    expect(parseItip(itip('REQUEST', ['DTSTART:20260101T000000Z']))).toBeUndefined()
    expect(parseItip(itip('X-UNKNOWN', ['UID:a', 'DTSTART:20260101T000000Z']))).toBeUndefined()
    expect(parseItip('not a calendar')).toBeUndefined()
    expect(parseItip('x'.repeat(2 * 1024 * 1024))).toBeUndefined()
  })

  it('recognizes calendar parts by type or file name', () => {
    expect(isCalendarAttachment({ mimeType: 'text/calendar' })).toBe(true)
    expect(isCalendarAttachment({ mimeType: 'application/octet-stream', filename: 'invite.ICS' })).toBe(true)
    expect(isCalendarAttachment({ mimeType: 'application/pdf', filename: 'agenda.pdf' })).toBe(false)
  })
})

describe('evaluateInvitation', () => {
  const record = (overrides: Partial<InvitationRecord> = {}): InvitationRecord => ({
    uid: 'meeting-1@example.test', method: 'REQUEST', sequence: 1, dtstamp: '2026-09-01T12:00:00.000Z', messageId: 'm1', ...overrides
  })

  it('treats the first copy as new, the recorded message as current, and higher SEQUENCE as an update', () => {
    expect(evaluateInvitation(parseItip(request(1))!, 'm1')).toEqual({ status: 'new', record: true })
    expect(evaluateInvitation(parseItip(request(1))!, 'm1', record())).toEqual({ status: 'current', record: false })
    expect(evaluateInvitation(parseItip(request(2))!, 'm2', record())).toEqual({ status: 'update', record: true })
    // Same SEQUENCE with a later DTSTAMP is a minor update.
    expect(evaluateInvitation(parseItip(request(1, '20260902T120000Z'))!, 'm2', record())).toEqual({ status: 'update', record: true })
  })

  it('flags duplicates (same UID, SEQUENCE, and DTSTAMP) and explains stale updates', () => {
    const duplicate = evaluateInvitation(parseItip(request(1))!, 'm2', record())
    expect(duplicate).toMatchObject({ status: 'duplicate', record: false })
    expect(duplicate.explanation).toMatch(/already received this invitation/)
    const lower = evaluateInvitation(parseItip(request(0))!, 'm0', record())
    expect(lower).toMatchObject({ status: 'stale', record: false })
    expect(lower.explanation).toMatch(/update 1.*update 0/)
    const older = evaluateInvitation(parseItip(request(1, '20260801T120000Z'))!, 'm0', record())
    expect(older).toMatchObject({ status: 'stale' })
    expect(older.explanation).toMatch(/later timestamp/)
    const provider = evaluateInvitation(parseItip(request(1))!, 'm9', undefined, 4)
    expect(provider).toMatchObject({ status: 'stale', record: false })
    expect(provider.explanation).toMatch(/your calendar already has update 4/)
  })

  it('lets a cancellation outrank a request at the same SEQUENCE and ignores older cancellations', () => {
    const cancel = parseItip(itip('CANCEL', ['UID:meeting-1@example.test', 'SEQUENCE:1', 'DTSTAMP:20260901T130000Z', 'STATUS:CANCELLED', 'DTSTART:20261005T080000Z']))!
    expect(evaluateInvitation(cancel, 'c1', record())).toEqual({ status: 'cancelled', record: true })
    const afterCancel = evaluateInvitation(parseItip(request(1, '20260901T140000Z'))!, 'm3', record({ method: 'CANCEL', messageId: 'c1' }))
    expect(afterCancel).toMatchObject({ status: 'stale' })
    expect(afterCancel.explanation).toMatch(/cancelled/)
    expect(evaluateInvitation(cancel, 'c0', record({ sequence: 2 }))).toMatchObject({ status: 'stale' })
    expect(evaluateInvitation(parseItip(request(2))!, 'm4', record({ method: 'CANCEL', messageId: 'c1' }))).toMatchObject({ status: 'update', record: true })
  })

  it('reports replies, counters, and unsupported methods without recording them', () => {
    const reply = parseItip(itip('REPLY', ['UID:meeting-1@example.test', 'DTSTART:20261005T080000Z', 'ATTENDEE;PARTSTAT=DECLINED;CN=Grace:mailto:grace@example.test', 'COMMENT:Sorry']))!
    expect(evaluateInvitation(reply, 'r1', record())).toEqual({ status: 'reply', record: false })
    expect(replyingAttendee(reply.event)).toMatchObject({ email: 'grace@example.test', response: 'declined', name: 'Grace' })
    expect(reply.event.comment).toBe('Sorry')
    expect(evaluateInvitation(parseItip(itip('COUNTER', ['UID:a', 'DTSTART:20261005T080000Z']))!, 'x')).toMatchObject({ status: 'counter' })
    expect(evaluateInvitation(parseItip(itip('PUBLISH', ['UID:a', 'DTSTART:20261005T080000Z']))!, 'x')).toMatchObject({ status: 'unsupported', record: false })
  })
})

describe('buildItipReply', () => {
  const now = new Date('2026-09-02T08:00:00Z')

  it('writes an RFC 5546 REPLY with only the replying attendee and the original identity', () => {
    const message = parseItip(request(2, '20260901T120000Z', ['RECURRENCE-ID:20261005T080000Z']))!
    const { method, ics } = buildItipReply({ message, attendee: { email: 'Grace@Example.test', name: 'Grace' }, response: 'accepted', comment: 'See you, all', now })
    expect(method).toBe('REPLY')
    expect(ics).toContain('METHOD:REPLY\r\n')
    expect(ics).toContain('UID:meeting-1@example.test\r\n')
    expect(ics).toContain('SEQUENCE:2\r\n')
    expect(ics).toContain('DTSTAMP:20260902T080000Z\r\n')
    expect(ics).toContain('RECURRENCE-ID:20261005T080000Z\r\n')
    expect(ics).toContain('ORGANIZER;CN=Ada Lovelace:mailto:ada@example.test\r\n')
    expect(ics).toContain('ATTENDEE;CN=Grace;PARTSTAT=ACCEPTED:mailto:Grace@Example.test\r\n')
    expect(ics).toContain('COMMENT:See you\\, all\r\n')
    expect(ics.match(/^ATTENDEE/gm)).toHaveLength(1)
    // The reply is itself a valid iTIP message that round-trips.
    const parsed = parseItip(ics)!
    expect(parsed).toMatchObject({ method: 'REPLY', event: { uid: 'meeting-1@example.test', sequence: 2, start: '2026-10-05T08:00:00.000Z' } })
    expect(replyingAttendee(parsed.event)).toMatchObject({ response: 'accepted' })
  })

  it('writes a COUNTER with the proposed times and a readable mail summary', () => {
    const message = parseItip(request(1))!
    const proposed = { start: '2026-10-06T09:00:00.000Z', end: '2026-10-06T10:00:00.000Z' }
    const { method, ics } = buildItipReply({ message, attendee: { email: 'grace@example.test' }, response: 'tentative', proposed, now })
    expect(method).toBe('COUNTER')
    expect(ics).toContain('METHOD:COUNTER')
    expect(ics).toContain('DTSTART:20261006T090000Z')
    expect(ics).toContain('PARTSTAT=TENTATIVE')
    expect(replyMailText({ message, attendee: { email: 'grace@example.test' }, response: 'tentative', proposed }).subject).toBe('New time proposed: Design review')
    expect(replyMailText({ message, attendee: { email: 'g@example.test', name: 'Grace' }, response: 'declined', comment: 'Away' })).toEqual({
      subject: 'Declined: Design review', text: 'Grace declined “Design review”.\n\nAway'
    })
  })
})
