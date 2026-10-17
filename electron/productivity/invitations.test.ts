import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InvitationMailInput, InvitationMessageSource } from '../../src/invitation-types'
import type { SyncedCalendar, SyncedCalendarEvent } from '../../src/productivity-types'
import { parseItip } from '../../src/lib/itip'
import { InterchangeStore } from './interchange-store'
import { InvitationStore } from './invitation-store'
import { createInvitationService, INVITATIONS_CALENDAR_ID, validRespondInput } from './invitations'
import { ProductivityStore } from './store'

const vcalendar = (method: string, lines: string[], extra = '') =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:${method}\r\nBEGIN:VEVENT\r\n${lines.join('\r\n')}\r\nEND:VEVENT\r\n${extra}END:VCALENDAR\r\n`
const request = (sequence: number, stamp = '20260901T120000Z', extra: string[] = []) => vcalendar('REQUEST', [
  'UID:meet-1@example.test', `SEQUENCE:${sequence}`, `DTSTAMP:${stamp}`, 'DTSTART:20261005T080000Z', 'DTEND:20261005T090000Z',
  'SUMMARY:Design review', 'LOCATION:Room 4', 'ORGANIZER;CN=Ada:mailto:ada@example.test',
  'ATTENDEE;ROLE=CHAIR;PARTSTAT=ACCEPTED:mailto:ada@example.test',
  'ATTENDEE;RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:me@example.test',
  'ATTENDEE;CUTYPE=ROOM;ROLE=NON-PARTICIPANT:mailto:room4@example.test',
  ...extra
])
const cancel = (sequence: number) => vcalendar('CANCEL', ['UID:meet-1@example.test', `SEQUENCE:${sequence}`, 'DTSTAMP:20260903T120000Z', 'STATUS:CANCELLED', 'DTSTART:20261005T080000Z', 'ORGANIZER:mailto:ada@example.test'])

const googleCalendar: SyncedCalendar = { id: 'g:cal', remoteId: 'primary', accountId: 'g', provider: 'gmail', name: 'Calendar', color: '#000', primary: true, canWrite: true }
const googleEvent: SyncedCalendarEvent = {
  id: 'g:google-event:primary:abc', remoteId: 'abc', accountId: 'g', provider: 'gmail', calendarId: 'g:cal', title: 'Design review',
  start: '2026-10-05T08:00:00.000Z', end: '2026-10-05T09:00:00.000Z', color: '#000', reminderMinutes: 10, readOnly: false,
  attendees: ['ada@example.test', 'me@example.test'], attendeeDetails: [{ email: 'me@example.test', self: true, response: 'tentative' }],
  organizer: { email: 'ada@example.test' }, icalUid: 'meet-1@example.test', sequence: 1
}

let directory: string
let productivity: ProductivityStore
let interchange: InterchangeStore
let invitations: InvitationStore
let messages: Map<string, { parts: string[]; provider?: InvitationMessageSource['account']['provider'] }>
let sent: InvitationMailInput[]

const service = (overrides: Partial<Parameters<typeof createInvitationService>[0]> = {}) => createInvitationService({
  source: async (accountId, messageId) => {
    const message = messages.get(messageId)
    if (!message) throw new Error('Message not found')
    return {
      parts: message.parts,
      account: { id: accountId, email: 'me@example.test', displayName: 'Me', provider: message.provider ?? 'imap', archived: false },
      addresses: ['me@example.test', 'alias@example.test'], fromEmail: 'ada@example.test', subject: 'Invitation', messageIdHeader: `<${messageId}@example.test>`
    }
  },
  sendMail: async (input) => { sent.push(input) },
  respondProvider: vi.fn(async () => undefined),
  addresses: async () => ['me@example.test'],
  sync: vi.fn(async () => undefined),
  productivity: () => productivity,
  interchange: () => interchange,
  invitations: () => invitations,
  now: () => new Date('2026-09-04T10:00:00Z'),
  ...overrides
})

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aerio-invitations-'))
  const path = join(directory, 'productivity.sqlite')
  productivity = new ProductivityStore(path)
  interchange = new InterchangeStore(path)
  invitations = new InvitationStore(path)
  messages = new Map()
  sent = []
})

afterEach(() => {
  productivity.close()
  interchange.close()
  invitations.close()
  rmSync(directory, { recursive: true, force: true })
})

describe('incoming invitations', () => {
  it('shows a new invitation with organizer, roles, rooms, and this mailbox as the replying attendee', async () => {
    messages.set('m1', { parts: ['not a calendar', request(1)] })
    const invitation = await service().inspect('imap', 'm1')
    expect(invitation).toMatchObject({
      method: 'REQUEST', status: 'new', uid: 'meet-1@example.test', sequence: 1, title: 'Design review', location: 'Room 4',
      organizer: { email: 'ada@example.test', name: 'Ada' }, self: { email: 'me@example.test', rsvp: true }, organizerIsSelf: false,
      channel: 'mail', canRespond: true, canProposeTime: true
    })
    expect(invitation!.attendees.find((attendee) => attendee.email === 'room4@example.test')).toMatchObject({ kind: 'room', role: 'non-participant' })
    expect(await service().inspect('imap', 'm1')).toMatchObject({ status: 'current' })
    messages.set('plain', { parts: [] })
    expect(await service().inspect('imap', 'plain')).toBeUndefined()
  })

  it('detects duplicates and explains stale updates and stale requests after a cancellation', async () => {
    messages.set('m1', { parts: [request(1)] })
    messages.set('copy', { parts: [request(1)] })
    messages.set('m2', { parts: [request(2, '20260902T120000Z')] })
    messages.set('c2', { parts: [cancel(2)] })
    await service().inspect('imap', 'm1')
    expect(await service().inspect('imap', 'copy')).toMatchObject({ status: 'duplicate', canRespond: true, explanation: expect.stringMatching(/already received/) })
    expect(await service().inspect('imap', 'm2')).toMatchObject({ status: 'update' })
    const stale = await service().inspect('imap', 'm1')
    expect(stale).toMatchObject({ status: 'stale', canRespond: false, respondBlockedReason: expect.stringMatching(/update 2.*update 1/) })
    await expect(service().respond({ accountId: 'imap', messageId: 'm1', response: 'accepted' })).rejects.toThrow(/out of date/)
    expect(await service().inspect('imap', 'c2')).toMatchObject({ method: 'CANCEL', status: 'cancelled', canRespond: false })
    expect(await service().inspect('imap', 'm2')).toMatchObject({ status: 'stale', explanation: expect.stringMatching(/cancelled/) })
  })

  it('refuses to answer meetings this mailbox organized and explains missing guest entries', async () => {
    messages.set('own', { parts: [request(0).replace('ORGANIZER;CN=Ada:mailto:ada@example.test', 'ORGANIZER:mailto:alias@example.test')] })
    expect(await service().inspect('imap', 'own')).toMatchObject({ organizerIsSelf: true, canRespond: false, respondBlockedReason: expect.stringMatching(/organized/) })
    messages.set('list', { parts: [request(0).replace('mailto:me@example.test', 'mailto:team@example.test')] })
    const viaList = await service().inspect('imap', 'list')
    expect(viaList).toMatchObject({ canRespond: true })
    expect(viaList!.self).toBeUndefined()
    expect(viaList!.warnings.join(' ')).toMatch(/not on the guest list/)
  })
})

describe('responding by mail (iTIP REPLY)', () => {
  it('mails a REPLY to the organizer, copies the meeting to the Invitations calendar, and records the response', async () => {
    messages.set('m1', { parts: [request(1)] })
    const answered = await service().respond({ accountId: 'imap', messageId: 'm1', response: 'accepted', comment: 'Looking forward' })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ accountId: 'imap', to: ['ada@example.test'], method: 'REPLY', subject: 'Accepted: Design review', inReplyTo: '<m1@example.test>' })
    const reply = parseItip(sent[0].ics)!
    expect(reply).toMatchObject({ method: 'REPLY', event: { uid: 'meet-1@example.test', sequence: 1, comment: 'Looking forward', attendees: ['me@example.test'] } })
    expect(reply.event.attendeeDetails?.[0].response).toBe('accepted')
    expect(answered).toMatchObject({ response: 'accepted', respondedAt: '2026-09-04T10:00:00.000Z', localCopyId: expect.stringMatching(/^invitation-/) })
    const copies = interchange.events(INVITATIONS_CALENDAR_ID)
    expect(interchange.calendar(INVITATIONS_CALENDAR_ID)).toMatchObject({ kind: 'local', name: 'Invitations' })
    expect(copies).toHaveLength(1)
    expect(copies[0]).toMatchObject({ sourceUid: 'meet-1@example.test', title: 'Design review', sequence: 1, organizer: { email: 'ada@example.test' } })
    expect(copies[0].attendeeDetails?.find((attendee) => attendee.email === 'me@example.test')).toMatchObject({ response: 'accepted', self: true })
    // A later update clears the old answer; declining removes the copy.
    messages.set('m2', { parts: [request(2, '20260905T120000Z')] })
    expect((await service().inspect('imap', 'm2'))!.response).toBeUndefined()
    await service().respond({ accountId: 'imap', messageId: 'm2', response: 'declined' })
    expect(interchange.events(INVITATIONS_CALENDAR_ID)).toHaveLength(0)
    expect(sent[1].subject).toBe('Declined: Design review')
  })

  it('sends a COUNTER for a proposed time and validates proposals', async () => {
    messages.set('m1', { parts: [request(1)] })
    await service().respond({ accountId: 'imap', messageId: 'm1', response: 'tentative', proposed: { start: '2026-10-06T08:00:00.000Z', end: '2026-10-06T09:00:00.000Z' } })
    expect(sent[0]).toMatchObject({ method: 'COUNTER', subject: 'New time proposed: Design review' })
    expect(parseItip(sent[0].ics)!.event).toMatchObject({ start: '2026-10-06T08:00:00.000Z', end: '2026-10-06T09:00:00.000Z' })
    expect(validRespondInput({ response: 'accepted' })).toBe(true)
    expect(validRespondInput({ response: 'maybe' })).toBe(false)
    expect(validRespondInput({ response: 'tentative', proposed: { start: '2026-10-06T09:00:00Z', end: '2026-10-06T08:00:00Z' } })).toBe(false)
    expect(validRespondInput({ response: 'declined', comment: 'x'.repeat(2_001) })).toBe(false)
  })

  it('applies a cancellation to the local copy, as an exception for one occurrence', async () => {
    const weekly = request(1, '20260901T120000Z', ['RRULE:FREQ=WEEKLY;COUNT=4'])
    messages.set('m1', { parts: [weekly] })
    await service().respond({ accountId: 'imap', messageId: 'm1', response: 'accepted' })
    messages.set('c-one', { parts: [vcalendar('CANCEL', ['UID:meet-1@example.test', 'SEQUENCE:2', 'DTSTAMP:20260903T120000Z', 'RECURRENCE-ID:20261012T080000Z', 'STATUS:CANCELLED', 'DTSTART:20261012T080000Z'])] })
    const one = await service().applyCancellation('imap', 'c-one')
    expect(one.status).toBe('cancelled')
    expect(interchange.events(INVITATIONS_CALENDAR_ID)[0].recurrenceExceptions).toEqual(['2026-10-12T08:00:00.000Z'])
    messages.set('c-all', { parts: [cancel(3)] })
    expect(await service().inspect('imap', 'c-all')).toMatchObject({ status: 'cancelled', localCopyId: expect.any(String) })
    await service().applyCancellation('imap', 'c-all')
    expect(interchange.events(INVITATIONS_CALENDAR_ID)).toHaveLength(0)
    await expect(service().applyCancellation('imap', 'm1')).rejects.toThrow()
  })
})

describe('responding through provider calendars', () => {
  beforeEach(() => {
    productivity.replaceAccount('g', 'gmail', { calendars: [googleCalendar], events: [googleEvent, { ...googleEvent, id: 'g:google-event:primary:abc_2', remoteId: 'abc_2', seriesId: 'abc', originalStart: '2026-10-12T08:00:00.000Z', start: '2026-10-12T08:00:00.000Z', end: '2026-10-12T09:00:00.000Z' }], contacts: [] })
  })

  it('uses Google events.patch for invitations already in the synced calendar and reports the provider response', async () => {
    messages.set('g1', { parts: [request(1)], provider: 'gmail' })
    const respondProvider = vi.fn(async () => undefined)
    const sync = vi.fn(async () => undefined)
    const changed = vi.fn()
    const invitation = await service({ respondProvider, sync, changed }).inspect('g', 'g1')
    expect(invitation).toMatchObject({ channel: 'google', response: 'tentative', calendarEventId: googleEvent.id, canProposeTime: false, proposeTimeNote: expect.stringMatching(/Google/) })
    await service({ respondProvider, sync, changed }).respond({ accountId: 'g', messageId: 'g1', response: 'accepted', comment: 'Yes' })
    expect(respondProvider).toHaveBeenCalledWith(googleCalendar, 'abc', ['me@example.test', 'alias@example.test'], { response: 'accepted', comment: 'Yes' })
    expect(sync).toHaveBeenCalledWith('g')
    expect(changed).toHaveBeenCalled()
    expect(sent).toHaveLength(0)
    await expect(service().respond({ accountId: 'g', messageId: 'g1', response: 'tentative', proposed: { start: '2026-10-06T08:00:00Z', end: '2026-10-06T09:00:00Z' } })).rejects.toThrow(/Google/)
  })

  it('answers one occurrence for an instance invitation and treats a lower provider SEQUENCE as stale', async () => {
    messages.set('g2', { parts: [request(1, '20260901T120000Z', ['RECURRENCE-ID:20261012T080000Z'])], provider: 'gmail' })
    const respondProvider = vi.fn(async () => undefined)
    await service({ respondProvider }).respond({ accountId: 'g', messageId: 'g2', response: 'declined' })
    expect(respondProvider).toHaveBeenCalledWith(googleCalendar, 'abc_2', expect.any(Array), { response: 'declined' })
    messages.set('old', { parts: [request(0)], provider: 'gmail' })
    expect(await service().inspect('g', 'old')).toMatchObject({ status: 'stale', explanation: expect.stringMatching(/already has update 1/) })
  })

  it('falls back to mail when the meeting is not in the provider calendar', async () => {
    messages.set('other', { parts: [request(0).replace('meet-1@example.test', 'other@example.test')], provider: 'gmail' })
    expect(await service().inspect('g', 'other')).toMatchObject({ channel: 'mail', canProposeTime: true })
  })

  it('answers synced events from the calendar and refuses organizers and non-guests', async () => {
    const respondProvider = vi.fn(async () => undefined)
    const snapshot = await service({ respondProvider }).respondToEvent(googleEvent.id, { response: 'accepted' })
    expect(respondProvider).toHaveBeenCalledWith(googleCalendar, 'abc', ['me@example.test'], { response: 'accepted' })
    expect(snapshot.events.length).toBeGreaterThan(0)
    await expect(service({ addresses: async () => ['ada@example.test'] }).respondToEvent(googleEvent.id, { response: 'accepted' })).rejects.toThrow(/organized/)
    await expect(service({ addresses: async () => ['stranger@example.test'] }).respondToEvent(googleEvent.id, { response: 'accepted' })).resolves.toBeDefined()
    productivity.upsertEvent({ ...googleEvent, id: 'g:x', attendees: ['ada@example.test'], attendeeDetails: undefined })
    await expect(service().respondToEvent('g:x', { response: 'accepted' })).rejects.toThrow(/not a guest/)
    await expect(service().respondToEvent(googleEvent.id, { response: 'tentative', proposed: { start: '2026-10-06T08:00:00Z', end: '2026-10-06T09:00:00Z' } })).rejects.toThrow(/Google/)
  })
})
