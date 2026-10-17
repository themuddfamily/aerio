import PostalMime from 'postal-mime'
import { describe, expect, it } from 'vitest'
import { buildItipReply, parseItip } from '../../src/lib/itip'
import { calendarPartsFromRaw } from './invitation-parts'
import { createCalendarMimeBuffer } from './mime-builder'

const ics = (method: string, summary = 'Review') => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:${method}\r\nBEGIN:VEVENT\r\nUID:u1\r\nSEQUENCE:1\r\nDTSTAMP:20260901T120000Z\r\n` +
  `DTSTART:20261005T080000Z\r\nDTEND:20261005T090000Z\r\nSUMMARY:${summary}\r\nORGANIZER:mailto:ada@example.test\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.test\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`

// Outlook-style invitation: an inline text/calendar alternative plus the same data as invite.ics.
const outlookInvitation = (body: string) => Buffer.from([
  'From: Ada <ada@example.test>', 'To: me@example.test', 'Subject: Invitation: Review', 'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="mixed"', '',
  '--mixed', 'Content-Type: multipart/alternative; boundary="alt"', '',
  '--alt', 'Content-Type: text/plain; charset=utf-8', '', 'You are invited.',
  '--alt', 'Content-Type: text/calendar; charset=utf-8; method=REQUEST', 'Content-Transfer-Encoding: 7bit', '', body,
  '--alt--',
  '--mixed', 'Content-Type: application/ics; name="invite.ics"', 'Content-Disposition: attachment; filename="invite.ics"', 'Content-Transfer-Encoding: base64', '',
  Buffer.from(body).toString('base64'),
  '--mixed', 'Content-Type: application/pdf; name="agenda.pdf"', 'Content-Disposition: attachment; filename="agenda.pdf"', 'Content-Transfer-Encoding: base64', '',
  Buffer.from('%PDF-1.4').toString('base64'),
  '--mixed--', ''
].join('\r\n'))

describe('calendar parts in received mail', () => {
  it('finds inline and attached text/calendar parts and returns identical copies once', async () => {
    const parts = await calendarPartsFromRaw(outlookInvitation(ics('REQUEST')))
    expect(parts).toHaveLength(1)
    expect(parseItip(parts[0])).toMatchObject({ method: 'REQUEST', event: { uid: 'u1', sequence: 1 } })
  })

  it('ignores messages without calendar parts', async () => {
    expect(await calendarPartsFromRaw(Buffer.from('From: a@example.test\r\nSubject: Hi\r\nContent-Type: text/plain\r\n\r\nHello\r\n'))).toEqual([])
  })
})

describe('outgoing iTIP mail', () => {
  it('builds multipart/alternative with a text/calendar; method=REPLY part that mail parsers expose', async () => {
    const message = parseItip(ics('REQUEST', 'Café review'))!
    const reply = buildItipReply({ message, attendee: { email: 'me@example.test', name: 'Me' }, response: 'declined', now: new Date('2026-09-02T00:00:00Z') })
    const raw = createCalendarMimeBuffer({
      from: 'Me <me@example.test>', to: ['ada@example.test'], subject: 'Declined: Café review\r\nBcc: injected@example.test', text: 'Me declined.',
      ics: reply.ics, method: reply.method, inReplyTo: '<invite@example.test>'
    })
    const source = raw.toString('utf8')
    expect(source).toMatch(/Content-Type: multipart\/alternative; boundary="aerio-cal-/)
    expect(source).toContain('Content-Type: text/calendar; charset=utf-8; method=REPLY')
    expect(source).toContain('In-Reply-To: <invite@example.test>')
    expect(source).not.toMatch(/^Bcc:/m)
    const parsed = await PostalMime.parse(raw)
    expect(parsed.text).toContain('Me declined.')
    const parts = await calendarPartsFromRaw(raw)
    expect(parts).toHaveLength(1)
    const roundTrip = parseItip(parts[0])!
    expect(roundTrip).toMatchObject({ method: 'REPLY', event: { uid: 'u1', title: 'Café review', sequence: 1 } })
    expect(roundTrip.event.attendeeDetails?.[0]).toMatchObject({ email: 'me@example.test', response: 'declined' })
  })
})
