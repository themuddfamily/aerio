import type { DavPresetId } from '../dav-types'

export interface DavPreset {
  id: DavPresetId
  label: string
  // Fixed service roots; discovery starts here (RFC 6764 .well-known, then current-user-principal).
  calendarUrl?: string
  contactsUrl?: string
  needsServerUrl: boolean
  serverPlaceholder?: string
  usernameLabel: string
  passwordHelp: string
}

export const DAV_PRESETS: DavPreset[] = [
  {
    id: 'icloud', label: 'iCloud', calendarUrl: 'https://caldav.icloud.com/', contactsUrl: 'https://contacts.icloud.com/',
    needsServerUrl: false, usernameLabel: 'Apple Account email',
    passwordHelp: 'Create an app-specific password at account.apple.com → Sign-In and Security. Your Apple Account password will not work.'
  },
  {
    id: 'fastmail', label: 'Fastmail', calendarUrl: 'https://caldav.fastmail.com/', contactsUrl: 'https://carddav.fastmail.com/',
    needsServerUrl: false, usernameLabel: 'Fastmail email address',
    passwordHelp: 'Create an app password in Fastmail Settings → Privacy & Security with CalDAV and CardDAV access.'
  },
  {
    id: 'nextcloud', label: 'Nextcloud', needsServerUrl: true, serverPlaceholder: 'https://cloud.example.com',
    usernameLabel: 'Nextcloud user name',
    passwordHelp: 'Create an app password in Nextcloud Personal settings → Security → Devices & sessions.'
  },
  {
    id: 'generic', label: 'Other CalDAV / CardDAV server', needsServerUrl: true, serverPlaceholder: 'https://dav.example.com',
    usernameLabel: 'User name',
    passwordHelp: 'Use an app-specific password if your provider offers one. Aerio stores it with OS secure storage.'
  }
]

export const davPreset = (id: DavPresetId) => DAV_PRESETS.find((preset) => preset.id === id) ?? DAV_PRESETS[DAV_PRESETS.length - 1]

const isLoopbackHost = (host: string) => {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase()
  return name === 'localhost' || name === '::1' || /^127(?:\.\d{1,3}){3}$/.test(name)
}

/**
 * Validates a DAV server address: HTTPS is required, except plain HTTP on a loopback address
 * (a local test server or a tunnel on this computer). Credentials embedded in the URL are refused.
 */
export function normalizeDavUrl(input: unknown): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 2_048) throw new Error('Enter a server address')
  const trimmed = input.trim()
  let url: URL
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`) }
  catch { throw new Error('Enter a valid https:// server address') }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) throw new Error('CalDAV and CardDAV servers must use https:// (plain http is allowed only on this computer)')
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Enter a valid https:// server address')
  if (url.username || url.password) throw new Error('Remove the user name and password from the server address')
  url.hash = ''
  url.search = ''
  return url.toString()
}

export { isLoopbackHost }

/** Discovery starting points for each service, most specific first. */
export function davServiceRoots(preset: DavPresetId, serverUrl?: string): { calendar: string[]; contacts: string[] } {
  const definition = davPreset(preset)
  if (!definition.needsServerUrl) return { calendar: [definition.calendarUrl!], contacts: [definition.contactsUrl!] }
  const base = normalizeDavUrl(serverUrl)
  const roots = [base]
  // Nextcloud serves both protocols from remote.php/dav when .well-known redirects are not configured.
  if (preset === 'nextcloud' && !/\/remote\.php\/dav\/?$/.test(new URL(base).pathname)) roots.push(new URL('remote.php/dav/', base.endsWith('/') ? base : `${base}/`).toString())
  return { calendar: roots, contacts: roots }
}
