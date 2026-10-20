// Zoom and Webex meeting-host accounts (E47). These providers create meetings through their own APIs and
// their own OAuth consent, separate from the mail/calendar account the event belongs to. Tokens stay in the
// main process (meeting-host-vault.dat, OS secure storage); the renderer sees only this status.

export type MeetingHostProvider = 'zoom' | 'webex' | 'goto'

export const MEETING_HOST_PROVIDERS: readonly MeetingHostProvider[] = ['zoom', 'webex', 'goto']

export interface MeetingHostAccount {
  provider: MeetingHostProvider
  // An OAuth app registration is available (built into this build, or entered in Settings).
  configured: boolean
  configSource?: 'built-in' | 'user'
  clientIdHint?: string
  // The exact redirect URL the OAuth app registration must allow.
  redirectUri: string
  // Scopes the registration must grant.
  scopes: string[]
  connected: boolean
  email?: string
  displayName?: string
  connectedAt?: string
  // The provider rejected the stored grant (app removed, consent revoked, refresh token expired).
  needsReconnect?: boolean
  error?: string
}

export interface MeetingHostSnapshot {
  accounts: MeetingHostAccount[]
}

// Per-meeting choice, keyed by the conference request id.
export interface HostedMeetingOptions {
  provider: MeetingHostProvider
  // Cancel the provider meeting when its calendar event is deleted in Aerio (default true).
  cancelOnDelete: boolean
  meetingId?: string
}

export interface MeetingHostApi {
  status(): Promise<MeetingHostSnapshot>
  configure(provider: MeetingHostProvider, clientId: string, clientSecret: string): Promise<MeetingHostSnapshot>
  connect(provider: MeetingHostProvider): Promise<MeetingHostSnapshot>
  disconnect(provider: MeetingHostProvider): Promise<MeetingHostSnapshot>
  meetingOptions(requestId: string): Promise<HostedMeetingOptions | null>
  setCancelOnDelete(requestId: string, cancel: boolean): Promise<HostedMeetingOptions | null>
  onChanged(callback: (snapshot: MeetingHostSnapshot) => void): () => void
}
