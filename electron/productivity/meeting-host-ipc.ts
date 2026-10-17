import { join } from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import type { MeetingHostProvider, MeetingHostSnapshot } from '../../src/meeting-host-types'
import { MEETING_HOST_PROVIDERS } from '../../src/meeting-host-types'
import { ZoomMeetingConnector, WebexMeetingConnector } from './hosted-meeting-connectors'
import { HostedMeetingCoordinator } from './meeting-coordinator'
import { MeetingHostHttp } from './meeting-host-http'
import type { BuiltInMeetingHostClients } from './meeting-host-providers'
import { MeetingHostVault, type MeetingHostSecretStorage } from './meeting-host-vault'
import { MeetingLinkStore } from './meeting-link-store'
import { registerExternalMeetingConnector } from './online-meetings'

// Main-process wiring for Zoom and Webex (E47): the credential vault, the connectors registered behind the
// online-meeting boundary, the coordinator used by calendar writes, and the Settings IPC.

const validProvider = (value: unknown): value is MeetingHostProvider => MEETING_HOST_PROVIDERS.includes(value as MeetingHostProvider)
const validRequestId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{8,200}$/.test(value)

export interface MeetingHostsOptions {
  userData: string
  // productivity.sqlite, shared with the calendar cache.
  databasePath: string
  storage: MeetingHostSecretStorage
  builtIn: BuiltInMeetingHostClients
  openExternal(url: string): Promise<void>
  isLocked(): boolean
  log?(event: string, details: Record<string, unknown>): void
}

export interface MeetingHosts {
  vault: MeetingHostVault
  coordinator: HostedMeetingCoordinator
  close(): void
}

export function initializeMeetingHosts(options: MeetingHostsOptions): MeetingHosts {
  const broadcast = () => {
    const snapshot = vault.status()
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('meeting-hosts:changed', snapshot)
  }
  const vault: MeetingHostVault = new MeetingHostVault(join(options.userData, 'meeting-host-vault.dat'), {
    storage: options.storage,
    builtIn: options.builtIn,
    openExternal: options.openExternal,
    changed: broadcast
  })
  const store = new MeetingLinkStore(options.databasePath)
  const account = (provider: MeetingHostProvider) => () => vault.account(provider)
  const connectors = {
    zoom: new ZoomMeetingConnector(new MeetingHostHttp('zoom', vault), account('zoom')),
    webex: new WebexMeetingConnector(new MeetingHostHttp('webex', vault), account('webex'))
  }
  registerExternalMeetingConnector(connectors.zoom)
  registerExternalMeetingConnector(connectors.webex)
  const coordinator = new HostedMeetingCoordinator({ store, connector: (provider) => connectors[provider], log: options.log })

  const unlocked = () => {
    if (options.isLocked()) throw new Error('Unlock Aerio to change online meeting accounts')
  }
  const provider = (value: unknown) => {
    if (!validProvider(value)) throw new Error('Choose Zoom or Webex')
    return value
  }
  ipcMain.handle('meeting-hosts:status', (): MeetingHostSnapshot => vault.status())
  ipcMain.handle('meeting-hosts:configure', (_event, value: unknown, clientId: unknown, clientSecret: unknown) => {
    unlocked()
    return vault.configure(provider(value), clientId, clientSecret)
  })
  ipcMain.handle('meeting-hosts:connect', async (_event, value: unknown) => {
    unlocked()
    const host = provider(value)
    await vault.authorize(host)
    options.log?.('meeting-host-connected', { provider: host })
    return vault.status()
  })
  ipcMain.handle('meeting-hosts:disconnect', async (_event, value: unknown) => {
    unlocked()
    const host = provider(value)
    const snapshot = await vault.disconnect(host)
    options.log?.('meeting-host-disconnected', { provider: host })
    return snapshot
  })
  ipcMain.handle('meeting-hosts:meeting-options', (_event, requestId: unknown) => {
    if (!validRequestId(requestId)) throw new Error('Invalid meeting request')
    return coordinator.meetingOptions(requestId)
  })
  ipcMain.handle('meeting-hosts:set-cancel-on-delete', (_event, requestId: unknown, cancel: unknown) => {
    if (!validRequestId(requestId) || typeof cancel !== 'boolean') throw new Error('Invalid meeting option')
    return coordinator.setCancelOnDelete(requestId, cancel)
  })

  return { vault, coordinator, close: () => store.close() }
}
