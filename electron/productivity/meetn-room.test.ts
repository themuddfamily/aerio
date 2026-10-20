import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { MeetnRoomConnector, MeetnRoomStore, meetnRoom } from './meetn-room'
import { MeetingLinkStore } from './meeting-link-store'
import { HostedMeetingCoordinator } from './meeting-coordinator'
import type { SyncedCalendar } from '../../src/productivity-types'
const directories: string[] = []
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'aerio-meetn-')); directories.push(path); return path }
afterEach(() => { for (const path of directories) rmSync(path, { recursive: true, force: true }); directories.length = 0 })
const calendar: SyncedCalendar = { id: 'calendar', remoteId: 'calendar', accountId: 'account', provider: 'gmail', name: 'Calendar', color: '#fff', primary: true, canWrite: true }
const request = { requestId: '0123456789abcdef', title: 'Discussion', start: '2030-01-01T10:00:00Z', end: '2030-01-01T11:00:00Z' }
describe('Meetn permanent room integration', () => {
  it('normalizes room names and exact public HTTPS links without accepting arbitrary URLs', () => {
    expect(meetnRoom(' https://meetn.com/team-room/ ')).toEqual({ room: 'team-room', joinUrl: 'https://meetn.com/team-room' })
    expect(meetnRoom('Team.Room')).toEqual({ room: 'Team.Room', joinUrl: 'https://meetn.com/Team.Room' })
    for (const value of ['', 'https://meetn.com.evil.test/room', 'https://user:secret@meetn.com/room', 'http://meetn.com/room', 'https://meetn.com:444/room', 'https://meetn.com/room?token=secret', 'https://meetn.com/room#host', 'a/b', '..', 'https://meetn.com/a%2fb', 'support', 'a'.repeat(101)]) expect(() => meetnRoom(value)).toThrow()
  })
  it('remembers the room across restart and fails closed on malformed persisted links', () => {
    const path = join(directory(), 'room.json'), store = new MeetnRoomStore(path)
    expect(store.status().connected).toBe(false)
    store.set('team-room'); expect(new MeetnRoomStore(path).status().joinUrl).toBe('https://meetn.com/team-room')
    store.set(''); expect(new MeetnRoomStore(path).status().connected).toBe(false)
    writeFileSync(path, JSON.stringify({ version: 1, room: 'https://hostile.test/room' })); expect(store.status().connected).toBe(false)
  })
  it('preserves old event links after the configured room changes and never deletes a shared room', async () => {
    const store = new MeetnRoomStore(join(directory(), 'room.json')), connector = new MeetnRoomConnector(store)
    expect(connector.capability(calendar).available).toBe(false)
    await expect(connector.createMeeting(request)).rejects.toThrow(/Configure/)
    store.set('original'); const meeting = await connector.createMeeting(request)
    store.set('new-room')
    expect(await connector.updateMeeting(meeting, { ...request, title: 'New title' })).toEqual(meeting)
    await connector.deleteMeeting(meeting)
    expect(store.status().room).toBe('new-room')
    expect(connector.capability(calendar).available).toBe(true)
  })
  it('creates durable calendar invitation links, recovers them after restart and detaches on removal', async () => {
    const path = directory(), room = new MeetnRoomStore(join(path, 'room.json')); room.set('team')
    const connector = new MeetnRoomConnector(room); let store = new MeetingLinkStore(join(path, 'links.sqlite'))
    let coordinator = new HostedMeetingCoordinator({ store, connector: () => connector })
    const event = { id: 'event', calendarId: calendar.id, color: '#fff', attendees: [], reminderMinutes: 10, title: request.title, start: request.start, end: request.end, conference: { provider: 'meetn' as const, status: 'pending' as const, requestId: request.requestId } }
    const prepared = await coordinator.prepare(calendar, event)
    expect(prepared.event.conference).toMatchObject({ provider: 'meetn', status: 'ready', joinUrl: 'https://meetn.com/team' })
    expect(prepared.event.description).toContain('Join Meetn meeting')
    store.close(); store = new MeetingLinkStore(join(path, 'links.sqlite')); coordinator = new HostedMeetingCoordinator({ store, connector: () => connector })
    try {
      room.set('new-room')
      expect((await coordinator.prepare(calendar, event)).event.conference?.joinUrl).toBe('https://meetn.com/team')
      const removed = await coordinator.prepare(calendar, { ...prepared.event, conference: { provider: 'meetn', status: 'removed' } }, prepared.event)
      expect(removed.event.description).not.toContain('meetn.com')
      await coordinator.settle(removed)
      expect(room.status().room).toBe('new-room')
    } finally { store.close() }
  })
})
