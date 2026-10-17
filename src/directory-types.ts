// Organization directory (global address list) and offline address book (E41). The directory is
// a read-only source: people, groups, and rooms published by the organization's server, looked up
// online and cached per account for offline use. Personal contacts and cached-mail recipient
// suggestions are separate and unchanged. See docs/organization-directory.md.

/** What a directory entry addresses. Equipment is shown only where a server labels it. */
export type DirectoryEntryKind = 'person' | 'group' | 'room' | 'equipment'

/** The server API behind an account's directory. */
export type DirectoryBackendId = 'microsoft-graph' | 'google-workspace' | 'exchange-ews'

export interface DirectoryEntry {
  /** Stable within an account: `${accountId}:${server id or address}`. */
  id: string
  accountId: string
  backend: DirectoryBackendId
  kind: DirectoryEntryKind
  name: string
  /** The SMTP address a message is sent to; groups insert the group address. */
  email: string
  title?: string
  department?: string
  company?: string
  office?: string
  phone?: string
  mobile?: string
  /** Rooms: seats and building when the server publishes them. */
  capacity?: number
  building?: string
  /** Groups whose members this server can list (Exchange ExpandDL, Graph group members). */
  expandable?: boolean
  /** Set in search results when another entry has the same display name. */
  ambiguous?: boolean
}

export interface DirectorySearchRequest {
  query: string
  /** Accounts to search; all directory-capable accounts when omitted. */
  accountIds?: string[]
  kinds?: DirectoryEntryKind[]
  /** Default 25, at most 100. */
  limit?: number
  /** 'auto' (default) looks up online and falls back to the offline cache. */
  mode?: 'auto' | 'online' | 'offline'
}

export interface DirectoryAccountSearchStatus {
  accountId: string
  source: 'online' | 'offline' | 'none'
  error?: string
  /** Directory permission is missing or was refused; see the account state for the explanation. */
  needsConsent?: boolean
}

export interface DirectorySearchResult {
  entries: DirectoryEntry[]
  /** 'offline' when every result came from the cache. */
  source: 'online' | 'offline' | 'mixed' | 'none'
  accounts: DirectoryAccountSearchStatus[]
}

export interface DirectoryGroupMembers {
  accountId: string
  groupEmail: string
  members: DirectoryEntry[]
  /** More members exist than Aerio expands at once (500). */
  truncated: boolean
}

export type DirectoryConsentState = 'granted' | 'missing' | 'denied' | 'not-required' | 'unknown'

export interface DirectoryCacheState {
  /** 'full' lists the whole directory; 'incremental' keeps entries learned from lookups plus rooms. */
  mode?: 'full' | 'incremental'
  entries: number
  lastSuccessAt?: string
  lastAttemptAt?: string
  /** The last refresh failure; the previous cache stays in use. */
  error?: string
  refreshing: boolean
  nextRefreshAt?: string
}

export interface DirectoryAccountState {
  accountId: string
  email: string
  provider: string
  backend?: DirectoryBackendId
  /** False when the account's server has no directory Aerio can read (IMAP, POP3, consumer Gmail). */
  supported: boolean
  message?: string
  consent: DirectoryConsentState
  /** Permissions that can still be requested through an explicit reconnect. */
  missingScopes: string[]
  /** Optional permissions for rooms and groups (Microsoft 365 only; often need an administrator). */
  missingResourceScopes: string[]
  capabilities: { people: boolean; groups: boolean; rooms: boolean; expandGroups: boolean; offline: boolean }
  cache: DirectoryCacheState
}

export interface DirectorySnapshot {
  accounts: DirectoryAccountState[]
  online: boolean
}

/** 'directory' asks for people lookup; 'resources' also asks for rooms and groups. */
export type DirectoryAccessLevel = 'directory' | 'resources'

export interface DirectoryDesktopApi {
  snapshot(): Promise<DirectorySnapshot>
  search(request: DirectorySearchRequest): Promise<DirectorySearchResult>
  expandGroup(accountId: string, groupEmail: string): Promise<DirectoryGroupMembers>
  /** Rebuilds the offline address book now; the old cache is kept if it fails. */
  refresh(accountId: string): Promise<DirectorySnapshot>
  /** Explicit reconnect that adds the directory permissions to the account's grant. */
  grantAccess(accountId: string, level?: DirectoryAccessLevel): Promise<DirectorySnapshot>
  onChanged(callback: (snapshot: DirectorySnapshot) => void): () => void
}
