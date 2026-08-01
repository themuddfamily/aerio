import type { MailProviderId } from '../gmail-types'
import type { ModuleId } from '../types'

export type ProviderId = MailProviderId | 'demo' | 'local'
export type CapabilityTransport = 'remote' | 'local' | 'demo' | 'none'
export type CapabilityStatus = 'ready' | 'planned' | 'unavailable'

export interface ModuleCapability {
  transport: CapabilityTransport
  status: CapabilityStatus
  read: boolean
  write: boolean
  details: string
}

export interface ProviderCapabilities {
  id: ProviderId
  name: string
  modules: Record<ModuleId, ModuleCapability>
}

const capability = (
  transport: CapabilityTransport,
  status: CapabilityStatus,
  read: boolean,
  write: boolean,
  details: string
): ModuleCapability => ({ transport, status, read, write, details })

const remoteReady = (details: string) => capability('remote', 'ready', true, true, details)
const remoteReadOnly = (details: string) => capability('remote', 'ready', true, false, details)
const remotePlanned = (details: string) => capability('remote', 'planned', false, false, details)
const localReady = (details: string) => capability('local', 'ready', true, true, details)
const unavailable = (details: string) => capability('none', 'unavailable', false, false, details)

const localProductivity = {
  calendar: localReady('Stored on this device; remote calendar sync is not provided by this mail connection.'),
  contacts: localReady('Stored on this device; remote contact sync is not provided by this mail connection.'),
  tasks: localReady('Stored privately on this device.'),
  notes: localReady('Stored privately on this device.'),
  chat: localReady('Local conversations only; no remote chat service is connected.')
} satisfies Omit<Record<ModuleId, ModuleCapability>, 'mail'>

const imapCapabilities = (id: MailProviderId, name: string): ProviderCapabilities => ({
  id,
  name,
  modules: {
    mail: remoteReady('Mail synchronizes over IMAP and sends over SMTP.'),
    ...localProductivity
  }
})

export const providerCatalog: Record<ProviderId, ProviderCapabilities> = {
  demo: {
    id: 'demo',
    name: 'Demo workspace',
    modules: Object.fromEntries((['mail', 'calendar', 'contacts', 'tasks', 'notes', 'chat'] satisfies ModuleId[]).map((module) => [
      module,
      capability('demo', 'ready', true, true, 'Sample data for exploring Aerio; it never leaves this device.')
    ])) as Record<ModuleId, ModuleCapability>
  },
  local: {
    id: 'local',
    name: 'Local workspace',
    modules: {
      mail: unavailable('Connect a mail provider to use mail.'),
      ...localProductivity
    }
  },
  gmail: {
    id: 'gmail',
    name: 'Google',
    modules: {
      mail: remoteReady('Gmail mail, labels, drafts, and sending are connected.'),
      calendar: remoteReady('Google Calendar synchronizes through the same Google account connection, including event creation and editing.'),
      contacts: remoteReadOnly('Google Contacts are synchronized read-only through the same Google account connection.'),
      tasks: remotePlanned('Google Tasks support is planned behind the same Google account connection.'),
      notes: localReady('Google does not expose a general Google Keep synchronization API; Aerio notes remain local.'),
      chat: unavailable('Google Chat is not part of Aerio’s consumer Google connector.')
    }
  },
  microsoft: {
    id: 'microsoft',
    name: 'Microsoft',
    modules: {
      mail: remoteReady('Outlook mail, folders, drafts, and sending are connected through Microsoft Graph.'),
      calendar: remoteReadOnly('Outlook Calendar is synchronized read-only through the same Microsoft account connection.'),
      contacts: remoteReadOnly('Outlook Contacts are synchronized read-only through the same Microsoft account connection.'),
      tasks: remotePlanned('Microsoft To Do support is planned through Microsoft Graph.'),
      notes: remotePlanned('OneNote support needs a dedicated data model and is planned separately.'),
      chat: unavailable('Teams chat requires organization-specific permissions and is not part of this connector.')
    }
  },
  icloud: imapCapabilities('icloud', 'Apple iCloud Mail'),
  yahoo: imapCapabilities('yahoo', 'Yahoo Mail'),
  fastmail: imapCapabilities('fastmail', 'Fastmail'),
  imap: imapCapabilities('imap', 'IMAP/SMTP'),
  'proton-bridge': imapCapabilities('proton-bridge', 'Proton Mail Bridge')
}

export function capabilitiesFor(provider: ProviderId) {
  return providerCatalog[provider]
}

export function capableProviders(module: ModuleId, providers: ProviderId[]) {
  return providers
    .map((provider) => capabilitiesFor(provider))
    .filter((entry) => entry.modules[module].status === 'ready')
}
