import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IceWarpMeetingConnector, IceWarpMeetingStore, rescheduleIceWarpVcalendar } from './icewarp-meetings'
import type { OnlineMeetingRequest } from './online-meetings'
import type { SyncedCalendar } from '../../src/productivity-types'
const server = 'https://icewarp.example.test'
const storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret', encryptString: (value: string) => Buffer.from([...value].reverse().join('')), decryptString: (value: Buffer) => [...value.toString()].reverse().join('') }
const request: OnlineMeetingRequest = { requestId: '0123456789abcdef', title: 'Planning', start: '2026-12-01T10:00:00Z', end: '2026-12-01T11:00:00Z' }
const conference = { evnid: 'evn-123', meeting_id: '123456789', meeting_url: server + '/conference/123456789', title: 'Planning [aerio-0123456789abcdef]', organizer_parsed: [{ email: 'me@example.test' }] }
const vcalendar = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:evn-123', 'X-SERVER-UID:evn-123', 'X-ICEWARP-MEETING:123456789@icewarp.example.test', 'SUMMARY:Provisioned', 'DTSTART:20261020T120000Z', 'DTEND:20261020T123000Z', 'DESCRIPTION:Public conference link', 'SEQUENCE:0', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'aerio-icewarp-meetings-')) })
afterEach(() => rmSync(directory, { recursive: true, force: true }))
function fixture() {
  let locked = false; let failCreate = false; let failUpdate = false; let listed: unknown[] = []
  const calls: { method: string; body: any; url: string }[] = []
  const fetcher = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    const method = new URL(String(url)).pathname.split('/').at(-1)!, body = JSON.parse(init?.body as string); calls.push({ method, body, url: String(url) })
    if (method === 'auth.test') return Response.json({ ok: true, user: 'me@example.test', user_id: 'user-1' })
    if (method === 'conferences.meetNow') { if (failCreate) throw Error('token-secret'); return Response.json({ ok: true, conference }) }
    if (method === 'events.get') return Response.json({ ok: true, vcalendar })
    if (method === 'events.add') { if (failUpdate) throw Error('token-secret'); return Response.json({ ok: true }) }
    if (method === 'events.delete') return Response.json({ ok: true })
    if (method === 'conferences.list') return Response.json({ ok: true, conferences: listed })
    throw Error('Unexpected API method')
  })
  const path = join(directory, 'meetings.dat')
  const store = new IceWarpMeetingStore(path, storage, () => locked, fetcher as typeof fetch)
  return { store, connector: new IceWarpMeetingConnector(store), calls, fetcher, path, connect: () => store.connect({ server, token: 'token-secret' }), lock: () => { locked = true }, failCreate: (value: boolean) => { failCreate = value }, failUpdate: (value: boolean) => { failUpdate = value }, list: (items: unknown[]) => { listed = items } }
}
describe('IceWarp conference provisioning', () => {
  it('does not let an older pending connection replace the newer completed connection', async () => {
    const h = fixture()
    const original = h.fetcher.getMockImplementation()!
    let release!: (value: Response) => void
    h.fetcher.mockImplementation(async (url, init) => {
      if (new URL(String(url)).host === 'first.example.test') return new Promise<Response>((resolve) => { release = resolve })
      return original(url, init)
    })
    const first = h.store.connect({ server: 'https://first.example.test', token: 'first-token' })
    const rejected = expect(first).rejects.toThrow(/superseded or disconnected/)
    await h.store.connect({ server: 'https://second.example.test', token: 'second-token' })
    release(Response.json({ ok: true, user: 'first@example.test', user_id: 'first-user' }))
    await rejected
    expect(h.store.status()).toMatchObject({ connected: true, server: 'https://second.example.test' })
    expect(new IceWarpMeetingStore(h.path, storage).identity().token).toBe('second-token')
  })
  it('disconnect invalidates pending authentication even before any identity was connected', async () => {
    const h = fixture()
    let release!: (value: Response) => void
    h.fetcher.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve }))
    const pending = h.connect()
    const rejected = expect(pending).rejects.toThrow(/superseded or disconnected/)
    h.store.disconnect()
    release(Response.json({ ok: true, user: 'me@example.test', user_id: 'user-1' }))
    await rejected
    expect(h.store.status().connected).toBe(false)
    expect(new IceWarpMeetingStore(h.path, storage).status().connected).toBe(false)
  })
  it.each(['server', 'token', 'user'] as const)('stops a deferred schedule read when the connected %s changes, without posting to the new account', async (change) => {
    const h = fixture(); await h.connect()
    const meeting = await h.connector.createMeeting(request)
    const original = h.fetcher.getMockImplementation()!
    let release!: (value: Response) => void; let waiting = false
    h.fetcher.mockImplementation(async (url, init) => {
      if (change === 'user' && String(url).endsWith('/auth.test')) return Response.json({ ok: true, user: 'other@example.test', user_id: 'other-user' })
      if (String(url).endsWith('/events.get') && !waiting) {
        waiting = true; h.calls.push({ method: 'events.get', body: JSON.parse(init?.body as string), url: String(url) })
        return new Promise<Response>((resolve) => { release = resolve })
      }
      return original(url, init)
    })
    const before = h.calls.filter((call) => call.method === 'events.add').length
    const operation = h.connector.updateMeeting(meeting, { ...request, title: 'Changed schedule' })
    const rejected = expect(operation).rejects.toThrow(/account changed/)
    await vi.waitFor(() => expect(waiting).toBe(true))
    await h.store.connect({ server: change === 'server' ? 'https://second.example.test' : server, token: 'explicit-new-token' })
    release(Response.json({ ok: true, vcalendar })); await rejected
    expect(h.calls.filter((call) => call.method === 'events.add')).toHaveLength(before)
    expect(h.calls.filter((call) => call.method !== 'auth.test').every((call) => call.url.startsWith(server) && call.body.token === 'token-secret')).toBe(true)
    expect(h.store.attempt(request.requestId)?.meeting?.meetingId).toBe(meeting.meetingId)
  })
  it('keeps an in-flight provisioning response bound to its original pending journal when credentials change', async () => {
    const h = fixture(); await h.connect()
    const original = h.fetcher.getMockImplementation()!
    let release!: (value: Response) => void; let waiting = false
    h.fetcher.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/conferences.meetNow')) {
        waiting = true; h.calls.push({ method: 'conferences.meetNow', body: JSON.parse(init?.body as string), url: String(url) })
        return new Promise<Response>((resolve) => { release = resolve })
      }
      return original(url, init)
    })
    const operation = h.connector.createMeeting(request)
    const rejected = expect(operation).rejects.toMatchObject({ uncertain: true })
    await vi.waitFor(() => expect(waiting).toBe(true))
    await h.store.connect({ server: 'https://second.example.test', token: 'explicit-new-token' })
    release(Response.json({ ok: true, conference })); await rejected
    expect(h.store.attempt(request.requestId)).toEqual({ server, userId: 'user-1', scheduled: false })
    expect(h.calls.some((call) => ['events.get', 'events.add'].includes(call.method))).toBe(false)
    await expect(h.connector.findMeeting(request)).rejects.toThrow(/another server or user/)
  })
  it('does not bind an old lookup response to a newly connected account or continue its lookup there', async () => {
    const h = fixture(); await h.connect(); h.failCreate(true)
    await expect(h.connector.createMeeting(request)).rejects.toThrow()
    const original = h.fetcher.getMockImplementation()!
    let release!: (value: Response) => void; let waiting = false
    h.fetcher.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/conferences.list')) { waiting = true; return new Promise<Response>((resolve) => { release = resolve }) }
      return original(url, init)
    })
    const operation = h.connector.findMeeting(request)
    const rejected = expect(operation).rejects.toThrow(/account changed/)
    await vi.waitFor(() => expect(waiting).toBe(true))
    await h.store.connect({ server: 'https://second.example.test', token: 'explicit-new-token' })
    release(Response.json({ ok: true, conferences: [conference] })); await rejected
    expect(h.store.attempt(request.requestId)).toEqual({ server, userId: 'user-1', scheduled: false })
    expect(h.calls.some((call) => call.method === 'events.add')).toBe(false)
  })
  it('uses OS-encrypted credentials and recovery journal without exposing tokens in status', async () => {
    const h = fixture(); await h.connect(); await h.connector.createMeeting(request)
    expect(JSON.stringify(h.store.status())).not.toContain('token-secret')
    expect(readFileSync(h.path, 'utf8')).not.toContain('token-secret')
    const restored = new IceWarpMeetingStore(h.path, storage)
    expect(restored.status()).toMatchObject({ connected: true, email: 'me@example.test' })
    expect(restored.attempt(request.requestId)).toMatchObject({ scheduled: true, meeting: { provider: 'icewarp' } })
    h.store.disconnect()
    expect(h.store.status().connected).toBe(false)
    expect(h.store.attempt(request.requestId)).toBeDefined()
  })
  it('provisions a private non-recording conference then reschedules it before reporting success', async () => {
    const h = fixture(); await h.connect()
    const meeting = await h.connector.createMeeting(request)
    expect(h.calls.map((call) => call.method)).toEqual(['auth.test', 'conferences.meetNow', 'events.get', 'events.add'])
    expect(h.calls[1].body).toEqual({ name: 'Planning [aerio-0123456789abcdef]', autorecording: false, autolobby: true, token: 'token-secret' })
    expect(h.calls[3].body).toMatchObject({ evnid: conference.evnid, token: 'token-secret' })
    expect(h.calls[3].body.item).toContain('DTSTART:20261201T100000Z')
    expect(h.calls[3].body.item).toContain('DTEND:20261201T110000Z')
    expect(h.calls[3].body.item).toContain('X-ICEWARP-MEETING:123456789@icewarp.example.test')
    expect(h.calls[3].body.item).not.toContain('ATTENDEE')
    expect(h.calls.every((call) => !call.method.includes('joined') && !call.method.includes('jwt'))).toBe(true)
    expect(meeting).toMatchObject({ provider: 'icewarp', joinUrl: conference.meeting_url, meetingNumber: conference.meeting_id })
    expect(meeting.meetingId.length).toBeLessThan(500)
  })
  it('preserves provisioned IDs and repairs a failed schedule on restart without creating another conference', async () => {
    const h = fixture(); await h.connect(); h.failUpdate(true)
    await expect(h.connector.createMeeting(request)).rejects.toMatchObject({ uncertain: true })
    expect(h.store.attempt(request.requestId)).toMatchObject({ scheduled: false, meeting: { joinUrl: conference.meeting_url } })
    h.failUpdate(false)
    const restored = new IceWarpMeetingStore(h.path, storage, () => false, h.fetcher as typeof fetch)
    const recovered = await new IceWarpMeetingConnector(restored).findMeeting(request)
    expect(recovered?.joinUrl).toBe(conference.meeting_url)
    expect(h.calls.filter((call) => call.method === 'conferences.meetNow')).toHaveLength(1)
    expect(restored.attempt(request.requestId)?.scheduled).toBe(true)
  })
  it('never blindly recreates a lost initial outcome when bounded lookup finds no conference', async () => {
    const h = fixture(); await h.connect(); h.failCreate(true)
    await expect(h.connector.createMeeting(request)).rejects.toMatchObject({ uncertain: true })
    h.failCreate(false)
    const restored = new IceWarpMeetingStore(h.path, storage, () => false, h.fetcher as typeof fetch)
    await expect(new IceWarpMeetingConnector(restored).findMeeting(request)).rejects.toThrow(/will not create a duplicate/)
    expect(h.calls.filter((call) => call.method === 'conferences.meetNow')).toHaveLength(1)
  })
  it('recovers an unknown creation only by exact request marker and matching organizer, then schedules it', async () => {
    const h = fixture(); await h.connect(); h.failCreate(true)
    await expect(h.connector.createMeeting(request)).rejects.toThrow()
    h.list([{ ...conference, organizer_parsed: [{ email: 'other@example.test' }] }])
    await expect(h.connector.findMeeting(request)).rejects.toThrow(/unconfirmed/)
    h.list([conference])
    expect((await h.connector.findMeeting(request))?.joinUrl).toBe(conference.meeting_url)
    expect(h.store.attempt(request.requestId)?.scheduled).toBe(true)
  })
  it('updates/cancels only IDs bound to the original server and account', async () => {
    const h = fixture(); await h.connect()
    const meeting = await h.connector.createMeeting(request)
    await h.connector.updateMeeting(meeting, { ...request, title: 'Revised', start: '2026-12-02T10:00:00Z', end: '2026-12-02T11:00:00Z' })
    expect(h.calls.at(-1)!.body.item).toContain('SUMMARY:Revised')
    await h.connector.deleteMeeting(meeting)
    expect(h.calls.at(-1)).toMatchObject({ method: 'events.delete', body: { evnid: conference.evnid } })
    await h.store.connect({ server: 'https://other.example.test', token: 'explicit-new-token' })
    const before = h.calls.length
    await expect(h.connector.deleteMeeting(meeting)).rejects.toThrow(/another server or user/)
    expect(h.calls).toHaveLength(before)
    expect(h.calls.at(-1)!.body.token).toBe('explicit-new-token')
  })
  it('blocks operations while locked or without secure storage and reports corrupt journal without crashing startup', async () => {
    const h = fixture(); await h.connect(); h.lock()
    await expect(h.connector.createMeeting(request)).rejects.toThrow(/Unlock/)
    const insecure = new IceWarpMeetingStore(join(directory, 'insecure.dat'), { ...storage, isEncryptionAvailable: () => false })
    await expect(insecure.connect({ server, token: 'secret' })).rejects.toThrow()
    writeFileSync(join(directory, 'corrupt.dat'), 'bad cipher')
    const corrupt = new IceWarpMeetingStore(join(directory, 'corrupt.dat'), storage)
    expect(corrupt.status()).toMatchObject({ connected: false, error: expect.stringContaining('journal cannot be decrypted') })
    await expect(corrupt.connect({ server, token: 'token' })).rejects.toThrow(/original profile/)
  })
  it('reports calendar capabilities and refuses unsupported join URLs before scheduling', async () => {
    const h = fixture()
    const calendar = { provider: 'gmail', canWrite: true } as SyncedCalendar
    expect(h.connector.capability(calendar).available).toBe(false)
    await h.connect()
    expect(h.connector.capability(calendar).available).toBe(true)
    expect(h.connector.capability({ ...calendar, canWrite: false }).available).toBe(false)
    expect(h.connector.capability({ ...calendar, provider: 'caldav' } as unknown as SyncedCalendar).available).toBe(false)
    h.fetcher.mockResolvedValueOnce(Response.json({ ok: true, conference: { ...conference, meeting_url: 'https://host.example.test/meeting?token=host-secret' } }))
    await expect(h.connector.createMeeting(request)).rejects.toMatchObject({ uncertain: true })
    expect(h.calls.some((call) => call.method === 'events.add')).toBe(false)
  })
})
describe('IceWarp vCalendar schedule edits', () => {
  it('escapes user text, preserves server linkage and removes old schedule fields', () => {
    const result = rescheduleIceWarpVcalendar(vcalendar, { ...request, title: 'Topic\r\nATTENDEE:attacker@example.test, semicolon;' })
    expect(result).toContain('SUMMARY:Topic\\nATTENDEE:attacker@example.test\\, semicolon\\;')
    expect(result.split('\r\n').filter((line) => line.startsWith('DTSTART'))).toEqual(['DTSTART:20261201T100000Z'])
    expect(result).toContain('UID:evn-123')
    expect(result).toContain('SEQUENCE:1')
  })
  it('rejects attendee/recurrence manipulation, missing linkage and invalid ranges', () => {
    for (const line of ['ATTENDEE:mailto:other@example.test', 'RRULE:FREQ=DAILY', 'BEGIN:VEVENT']) expect(() => rescheduleIceWarpVcalendar(vcalendar.replace('END:VEVENT', line + '\r\nEND:VEVENT'), request)).toThrow()
    expect(() => rescheduleIceWarpVcalendar(vcalendar.replace('X-ICEWARP-MEETING:', 'UNRELATED:'), request)).toThrow()
    expect(() => rescheduleIceWarpVcalendar(vcalendar, { ...request, end: request.start })).toThrow()
  })
})
