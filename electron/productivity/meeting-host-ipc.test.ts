import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncedCalendar } from '../../src/productivity-types'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  sent: [] as unknown[][]
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => electron.handlers.set(channel, handler) },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: (...args: unknown[]) => electron.sent.push(args) } }] }
}))

import { initializeMeetingHosts, type MeetingHosts } from './meeting-host-ipc'
import { assertConferenceCreatable, externalMeetingConnectors } from './online-meetings'

const storage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (value: Buffer) => value.toString()
}
const calendar: SyncedCalendar = { id: 'a:google-calendar:primary', remoteId: 'primary', accountId: 'a', provider: 'gmail', name: 'Main', color: '#000', primary: true, canWrite: true }
const invoke = (channel: string, ...args: unknown[]) => Promise.resolve().then(() => electron.handlers.get(channel)!({}, ...args))

let directory: string
let hosts: MeetingHosts
let locked: boolean

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aerio-meeting-ipc-'))
  electron.handlers.clear()
  electron.sent.length = 0
  locked = false
  hosts = initializeMeetingHosts({
    userData: directory, databasePath: join(directory, 'productivity.sqlite'), storage,
    builtIn: { zoom: { clientId: 'zoomClientId123', clientSecret: 'zoomClientSecret456' } },
    openExternal: async () => undefined, isLocked: () => locked
  })
})
afterEach(() => {
  hosts.close()
  rmSync(directory, { recursive: true, force: true })
})

describe('meeting-host IPC', () => {
  it('connects IceWarp through real IPC and coordinator provisioning without leaking credentials or inviting participants', async () => {
    hosts.close()
    const calls: { method: string; body: any }[] = []
    hosts = initializeMeetingHosts({ userData: directory, databasePath: join(directory, 'productivity.sqlite'), storage, builtIn: {}, openExternal: async () => {}, isLocked: () => locked,
      fetch: async (url, init) => {
        const method = new URL(String(url)).pathname.split('/').at(-1)!, body = JSON.parse(init?.body as string); calls.push({ method, body })
        if (method === 'auth.test') return Response.json({ ok: true, user_id: 'user-1', user: 'me@example.test' })
        if (method === 'conferences.meetNow') return Response.json({ ok: true, conference: { evnid: 'evn-1', meeting_id: '12345', meeting_url: 'https://icewarp.test/conference/12345' } })
        if (method === 'events.get') return Response.json({ ok: true, vcalendar: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:evn-1\r\nX-ICEWARP-MEETING:12345@icewarp.test\r\nSUMMARY:Provisioned\r\nDTSTART:20261020T120000Z\r\nDTEND:20261020T130000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n' })
        if (method === 'events.add') return Response.json({ ok: true })
        throw Error('Unexpected API')
      }
    })
    const snapshot = await invoke('meeting-hosts:icewarp-connect', { server: 'https://icewarp.test', token: 'secret-token' }) as { accounts: unknown[] }
    expect(JSON.stringify(snapshot)).not.toContain('secret-token')
    expect(snapshot.accounts).toContainEqual(expect.objectContaining({ provider: 'icewarp', connected: true, email: 'me@example.test' }))
    const event = { id: 'new', calendarId: calendar.id, title: 'Scheduled', start: '2026-12-01T10:00:00Z', end: '2026-12-01T11:00:00Z', location: '', description: '', color: '#123', attendees: ['calendar-guest@example.test'], reminderMinutes: 10, recurrence: 'none', conference: { provider: 'icewarp', status: 'pending', requestId: '0123456789abcdef' } } as import('../../src/types').CalendarEvent
    const prepared = await hosts.coordinator.prepare(calendar, event)
    expect(prepared.event.conference).toMatchObject({ provider: 'icewarp', status: 'ready', joinUrl: 'https://icewarp.test/conference/12345' })
    expect(prepared.event.description).toContain('Join IceWarp meeting')
    expect(JSON.stringify(calls)).not.toContain('calendar-guest@example.test')
    expect(calls.map((call) => call.method)).toEqual(['auth.test', 'conferences.meetNow', 'events.get', 'events.add'])
    await invoke('meeting-hosts:icewarp-disconnect')
    expect(externalMeetingConnectors.icewarp?.capability(calendar).available).toBe(false)
  })
  it('reports hosts and registers the real connectors behind the boundary', async () => {
    const status = await invoke('meeting-hosts:status') as { accounts: { provider: string; configured: boolean; connected: boolean }[] }
    expect(status.accounts.map(({ provider, configured, connected }) => ({ provider, configured, connected }))).toEqual([
      { provider: 'zoom', configured: true, connected: false }, { provider: 'webex', configured: false, connected: false }, { provider: 'goto', configured: false, connected: false }, { provider: 'meetn', configured: true, connected: false }, { provider: 'icewarp', configured: true, connected: false }
    ])
    expect(externalMeetingConnectors.zoom?.requiredScopes).toContain('meeting:write:meeting')
    expect(externalMeetingConnectors.webex?.requiredScopes).toContain('meeting:schedules_write')
    expect(externalMeetingConnectors.goto?.provider).toBe('goto')
    expect(() => assertConferenceCreatable(calendar, 'zoom')).toThrow('Connect Zoom in Settings › Online meetings')
    expect(() => assertConferenceCreatable(calendar, 'webex')).toThrow(/no Webex app registration/)
  })

  it('validates input, broadcasts changes, and refuses account changes while Aerio is locked', async () => {
    await expect(invoke('meeting-hosts:connect', 'skype')).rejects.toThrow('Choose Zoom, Webex or GoToMeeting')
    await expect(invoke('meeting-hosts:configure', 'zoom', 'otherClient123', 'otherSecret456')).rejects.toThrow(/already includes its Zoom app registration/)
    await invoke('meeting-hosts:configure', 'webex', 'webexClientId123', 'webexClientSecret456')
    expect(electron.sent.at(-1)?.[0]).toBe('meeting-hosts:changed')
    locked = true
    await expect(invoke('meeting-hosts:configure', 'webex', 'webexClientId123', 'webexClientSecret456')).rejects.toThrow(/Unlock Aerio/)
    await expect(invoke('meeting-hosts:meetn-room', 'my-room')).rejects.toThrow(/Unlock Aerio/)
    await expect(invoke('meeting-hosts:icewarp-connect', { server: 'https://icewarp.test', token: 'secret' })).rejects.toThrow(/Unlock Aerio/)
    await expect(invoke('meeting-hosts:icewarp-disconnect')).rejects.toThrow(/Unlock Aerio/)
    await expect(invoke('meeting-hosts:connect', 'zoom')).rejects.toThrow(/Unlock Aerio/)
    await expect(invoke('meeting-hosts:disconnect', 'zoom')).rejects.toThrow(/Unlock Aerio/)
    await expect(invoke('meeting-hosts:meeting-options', 'bad id!')).rejects.toThrow(/Invalid meeting request/)
    await expect(invoke('meeting-hosts:meeting-options', '0123456789abcdef')).resolves.toBeNull()
    await expect(invoke('meeting-hosts:set-cancel-on-delete', '0123456789abcdef', 'no')).rejects.toThrow(/Invalid meeting option/)
    await expect(invoke('meeting-hosts:set-cancel-on-delete', '0123456789abcdef', false)).rejects.toThrow(/no longer linked/)
  })
  it('persists an existing Meetn room and broadcasts connection changes without OAuth', async () => {
    const connected = await invoke('meeting-hosts:meetn-room', 'https://meetn.com/my-room') as { accounts: unknown[] }
    expect(connected.accounts).toContainEqual({ provider: 'meetn', configured: true, connected: true, room: 'my-room', joinUrl: 'https://meetn.com/my-room' })
    expect(externalMeetingConnectors.meetn?.capability(calendar).available).toBe(true)
    expect(electron.sent.at(-1)?.[0]).toBe('meeting-hosts:changed')
    const disconnected = await invoke('meeting-hosts:meetn-room', '') as { accounts: unknown[] }
    expect(disconnected.accounts).toContainEqual({ provider: 'meetn', configured: true, connected: false })
    await expect(invoke('meeting-hosts:meetn-room', 'https://hostile.test/room')).rejects.toThrow(/public https/)
  })
})
