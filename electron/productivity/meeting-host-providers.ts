import type { MeetingHostProvider } from '../../src/meeting-host-types'

// OAuth and API endpoints for the meeting hosts (E47). Both are authorization-code grants with PKCE over a
// fixed loopback redirect: Zoom and Webex compare the redirect URL with the app registration exactly, so the
// port cannot be chosen at random the way the Google and Microsoft sign-ins do.

export interface MeetingHostDefinition {
  provider: MeetingHostProvider
  label: string
  authorizeUrl: string
  tokenUrl: string
  revokeUrl?: string
  profileUrl: string
  apiBase: string
  // Scopes the registration must grant.
  scopes: readonly string[]
  // Webex takes the scope list on the authorize URL; Zoom grants whatever the app registration lists.
  sendScopes: boolean
  // Zoom authenticates the client with HTTP Basic; Webex takes client_id/client_secret in the form body.
  clientAuth: 'basic' | 'body'
  redirectPort: number
  redirectPath: string
  /** Omit PKCE parameters only when the provider documents a confidential code grant without PKCE. */
  pkce?: boolean
}

export const ZOOM_SCOPES = ['meeting:write:meeting', 'meeting:read:meeting', 'meeting:update:meeting', 'meeting:delete:meeting', 'user:read:user'] as const
// spark:people_read identifies the connected account (GET /people/me) for Settings; it grants no meeting access.
export const WEBEX_SCOPES = ['meeting:schedules_write', 'meeting:schedules_read', 'spark:people_read'] as const

export const MEETING_HOSTS: Record<MeetingHostProvider, MeetingHostDefinition> = {
  goto: {
    provider: 'goto', label: 'GoToMeeting',
    authorizeUrl: 'https://authentication.logmeininc.com/oauth/authorize',
    tokenUrl: 'https://authentication.logmeininc.com/oauth/token',
    profileUrl: 'https://api.getgo.com/identity/v1/Users/me',
    apiBase: 'https://api.getgo.com/G2M/rest',
    scopes: [], sendScopes: false, clientAuth: 'basic', pkce: false,
    redirectPort: 47819, redirectPath: '/oauth/goto'
  },
  zoom: {
    provider: 'zoom',
    label: 'Zoom',
    authorizeUrl: 'https://zoom.us/oauth/authorize',
    tokenUrl: 'https://zoom.us/oauth/token',
    revokeUrl: 'https://zoom.us/oauth/revoke',
    profileUrl: 'https://api.zoom.us/v2/users/me',
    apiBase: 'https://api.zoom.us/v2',
    scopes: ZOOM_SCOPES,
    sendScopes: false,
    clientAuth: 'basic',
    redirectPort: 47817,
    redirectPath: '/oauth/zoom'
  },
  webex: {
    provider: 'webex',
    label: 'Webex',
    authorizeUrl: 'https://webexapis.com/v1/authorize',
    tokenUrl: 'https://webexapis.com/v1/access_token',
    profileUrl: 'https://webexapis.com/v1/people/me',
    apiBase: 'https://webexapis.com/v1',
    scopes: WEBEX_SCOPES,
    sendScopes: true,
    clientAuth: 'body',
    redirectPort: 47818,
    redirectPath: '/oauth/webex'
  }
}

export const meetingHostRedirectUri = (definition: MeetingHostDefinition, port = definition.redirectPort) => `http://localhost:${port}${definition.redirectPath}`

export interface MeetingHostClientConfig {
  clientId: string
  clientSecret: string
}

export type BuiltInMeetingHostClients = Partial<Record<MeetingHostProvider, MeetingHostClientConfig>>

export function parseMeetingHostClient(provider: MeetingHostProvider, clientId: unknown, clientSecret: unknown): MeetingHostClientConfig {
  const id = String(clientId ?? '').trim()
  const secret = String(clientSecret ?? '').trim()
  const label = MEETING_HOSTS[provider].label
  if (!/^[A-Za-z0-9_.-]{8,200}$/.test(id)) throw new Error(`Enter the ${label} app’s client ID`)
  if (!/^[\x21-\x7e]{8,300}$/.test(secret)) throw new Error(`Enter the ${label} app’s client secret`)
  return { clientId: id, clientSecret: secret }
}

// Build-time registrations: MAIN_VITE_ZOOM_CLIENT_ID/SECRET and MAIN_VITE_WEBEX_CLIENT_ID/SECRET. Both values
// of a pair are required, as with the Google desktop client.
export function parseMeetingHostEnvironment(environment: { zoomClientId?: string; zoomClientSecret?: string; webexClientId?: string; webexClientSecret?: string }): BuiltInMeetingHostClients {
  const result: BuiltInMeetingHostClients = {}
  const pairs: [MeetingHostProvider, string | undefined, string | undefined, string][] = [
    ['zoom', environment.zoomClientId, environment.zoomClientSecret, 'MAIN_VITE_ZOOM_CLIENT_ID and MAIN_VITE_ZOOM_CLIENT_SECRET'],
    ['webex', environment.webexClientId, environment.webexClientSecret, 'MAIN_VITE_WEBEX_CLIENT_ID and MAIN_VITE_WEBEX_CLIENT_SECRET']
  ]
  for (const [provider, id, secret, names] of pairs) {
    if (!id?.trim() && !secret?.trim()) continue
    if (!id?.trim() || !secret?.trim()) throw new Error(`Set both ${names}`)
    result[provider] = parseMeetingHostClient(provider, id, secret)
  }
  return result
}
