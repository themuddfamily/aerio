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
  it('reports both hosts and registers the real connectors behind the boundary', async () => {
    const status = await invoke('meeting-hosts:status') as { accounts: { provider: string; configured: boolean; connected: boolean }[] }
    expect(status.accounts.map(({ provider, configured, connected }) => ({ provider, configured, connected }))).toEqual([
      { provider: 'zoom', configured: true, connected: false }, { provider: 'webex', configured: false, connected: false }
    ])
    expect(externalMeetingConnectors.zoom?.requiredScopes).toContain('meeting:write:meeting')
    expect(externalMeetingConnectors.webex?.requiredScopes).toContain('meeting:schedules_write')
    expect(() => assertConferenceCreatable(calendar, 'zoom')).toThrow('Connect Zoom in Settings › Online meetings')
    expect(() => assertConferenceCreatable(calendar, 'webex')).toThrow(/no Webex app registration/)
  })

  it('validates input, broadcasts changes, and refuses account changes while Aerio is locked', async () => {
    await expect(invoke('meeting-hosts:connect', 'skype')).rejects.toThrow('Choose Zoom or Webex')
    await expect(invoke('meeting-hosts:configure', 'zoom', 'otherClient123', 'otherSecret456')).rejects.toThrow(/already includes its Zoom app registration/)
    await invoke('meeting-hosts:configure', 'webex', 'webexClientId123', 'webexClientSecret456')
    expect(electron.sent.at(-1)?.[0]).toBe('meeting-hosts:changed')
    locked = true
    await expect(invoke('meeting-hosts:configure', 'webex', 'webexClientId123', 'webexClientSecret456')).rejects.toThrow(/Unlock Aerio/)
    await expect(invoke('meeting-hosts:connect', 'zoom')).rejects.toThrow(/Unlock Aerio/)
    await expect(invoke('meeting-hosts:disconnect', 'zoom')).rejects.toThrow(/Unlock Aerio/)
    await expect(invoke('meeting-hosts:meeting-options', 'bad id!')).rejects.toThrow(/Invalid meeting request/)
    await expect(invoke('meeting-hosts:meeting-options', '0123456789abcdef')).resolves.toBeNull()
    await expect(invoke('meeting-hosts:set-cancel-on-delete', '0123456789abcdef', 'no')).rejects.toThrow(/Invalid meeting option/)
    await expect(invoke('meeting-hosts:set-cancel-on-delete', '0123456789abcdef', false)).rejects.toThrow(/no longer linked/)
  })
})
