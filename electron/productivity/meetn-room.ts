import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { MeetnRoomAccount } from '../../src/meeting-host-types'
import type { SyncedCalendar } from '../../src/productivity-types'
import { hostedConferenceCapability } from '../../src/lib/online-meetings'
import type { HostedMeeting, OnlineMeetingConnector, OnlineMeetingRequest } from './online-meetings'

export function meetnRoom(value: unknown): { room: string; joinUrl: string } {
  if (typeof value !== 'string' || value.length > 2000) throw new Error('Enter your existing Meetn room name or its public HTTPS link')
  let room = value.trim()
  if (room.includes('://')) {
    let url: URL
    try { url = new URL(room) } catch { throw new Error('Enter a valid Meetn room link') }
    if (url.protocol !== 'https:' || url.hostname !== 'meetn.com' || url.port || url.username || url.password || url.search || url.hash) throw new Error('Use the public https://meetn.com/room link without credentials or extra parameters')
    room = url.pathname.replace(/^\//, '').replace(/\/$/, '')
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(room) || room.includes('..') || ['support', 'pricing', 'signin', 'login', 'signup', 'terms', 'privacy', 'account'].includes(room.toLowerCase())) throw new Error('Enter the name of your existing Meetn room, using letters, numbers, dots, hyphens or underscores')
  return { room, joinUrl: `https://meetn.com/${room}` }
}
export class MeetnRoomStore {
  constructor(private readonly path: string) {}
  status(): MeetnRoomAccount {
    try {
      if (existsSync(this.path)) { const saved = JSON.parse(readFileSync(this.path, 'utf8')); if (saved.version === 1 && saved.room) return { provider: 'meetn', configured: true, connected: true, ...meetnRoom(saved.room) } }
    } catch { /* Invalid room configuration never becomes an arbitrary join link. */ }
    return { provider: 'meetn', configured: true, connected: false }
  }
  set(value: unknown): MeetnRoomAccount {
    const selected = value === '' ? undefined : meetnRoom(value)
    writeFileSync(this.path + '.tmp', JSON.stringify({ version: 1, room: selected?.room ?? '' }), { mode: 0o600 })
    renameSync(this.path + '.tmp', this.path)
    return this.status()
  }
}
/** Meetn schedules reuse the owner's permanent room; there is no disposable server meeting to delete. */
export class MeetnRoomConnector implements OnlineMeetingConnector {
  readonly provider = 'meetn' as const
  readonly requiredScopes: readonly string[] = []
  constructor(private readonly store: MeetnRoomStore) {}
  capability(calendar: SyncedCalendar) { return hostedConferenceCapability('meetn', calendar, this.store.status()) }
  async createMeeting(_request: OnlineMeetingRequest): Promise<HostedMeeting> {
    const room = this.store.status()
    if (!room.connected || !room.room || !room.joinUrl) throw new Error('Configure your existing Meetn room in Settings › Online meetings')
    return { provider: 'meetn', meetingId: room.room, joinUrl: room.joinUrl }
  }
  async findMeeting(request: OnlineMeetingRequest) { return this.createMeeting(request) }
  async updateMeeting(meeting: HostedMeeting, _request: OnlineMeetingRequest) { return meeting }
  async deleteMeeting(_meeting: HostedMeeting): Promise<void> { /* A shared permanent room must never be deleted for one calendar event. */ }
}
