// On-premises Microsoft Exchange accounts reached over Exchange Web Services (EWS). Microsoft 365
// keeps using Microsoft Graph (provider 'microsoft'); this is the separate 'exchange' provider for
// Exchange Server 2013 SP1, 2016, 2019, and Subscription Edition. See docs/exchange-ews.md.

import type { MailAccountSummary } from './mail-types'

/** How Aerio authenticates to EWS. Kerberos-only (Negotiate without NTLM) servers are not supported. */
export type ExchangeAuthMethod = 'basic' | 'ntlm' | 'bearer'
/** 'auto' lets Aerio pick from the server's WWW-Authenticate challenge (NTLM first, then Basic). */
export type ExchangeAuthPreference = 'auto' | ExchangeAuthMethod

export interface ExchangeDiscoverInput {
  email: string
  username?: string
  password?: string
  /** Hosts outside the email domain that the user agreed to send credentials to. */
  trustedHosts?: string[]
}

export interface ExchangeDiscoveryAttempt {
  url: string
  error: string
}

export type ExchangeDiscoverResult =
  | {
    status: 'found'
    email: string
    ewsUrl: string
    autodiscoverUrl: string
    /** How the Autodiscover endpoint was reached. */
    source: 'domain' | 'autodiscover-host' | 'http-redirect' | 'srv'
    serverVersion?: string
    displayName?: string
    attempts: ExchangeDiscoveryAttempt[]
  }
  | {
    /** A redirect would send the password to another site; ask before following it. */
    status: 'confirm-redirect'
    email: string
    fromUrl: string
    toUrl: string
    host: string
    reason: 'http-redirect' | 'srv' | 'redirect-url' | 'redirect-address'
    attempts: ExchangeDiscoveryAttempt[]
  }
  | { status: 'not-found'; email: string; attempts: ExchangeDiscoveryAttempt[] }

export interface ExchangeAccountInput {
  email: string
  displayName?: string
  /** user@domain, DOMAIN\user, or a bare user name; defaults to the email address. */
  username?: string
  password?: string
  /** Full EWS endpoint, normally https://mail.example.com/EWS/Exchange.asmx. */
  ewsUrl: string
  auth: ExchangeAuthPreference
  /** Hybrid deployments with modern authentication: an OAuth access token for the EWS resource. */
  bearerToken?: string
}

export interface ExchangeCredentialsUpdate {
  password?: string
  bearerToken?: string
  auth?: ExchangeAuthPreference
}

export interface ExchangeModuleCapability {
  read: boolean
  write: boolean
  detail: string
}

export interface ExchangeCapabilities {
  mail: ExchangeModuleCapability
  calendar: ExchangeModuleCapability
  contacts: ExchangeModuleCapability
  folderManagement: boolean
  /** Server limitations Aerio detected, shown in Settings. */
  notes: string[]
}

export type ExchangeAccountStatus = 'ready' | 'syncing' | 'needs-auth' | 'error'

export interface ExchangeAccountState {
  accountId: string
  email: string
  username: string
  ewsUrl: string
  auth: ExchangeAuthMethod
  /** For example "15.2.1544.4 (Exchange 2019)". */
  serverVersion?: string
  status: ExchangeAccountStatus
  error?: string
  lastSyncedAt?: string
  pendingWrites: number
  capabilities: ExchangeCapabilities
}

export type ExchangeReviewStatus = 'conflict' | 'failed' | 'held'

/** A calendar or contact change that Exchange did not accept; nothing is overwritten until the user chooses. */
export interface ExchangeReviewItem {
  id: string
  accountId: string
  kind: 'event' | 'contact'
  action: 'create' | 'update' | 'delete'
  status: ExchangeReviewStatus
  title: string
  serverTitle?: string
  error: string
  serverDeleted: boolean
  updatedAt: string
}

export type ExchangeResolution = 'keep-server' | 'keep-local'

export interface ExchangeSnapshot {
  accounts: ExchangeAccountState[]
  review: ExchangeReviewItem[]
}

export interface ExchangeDesktopApi {
  discover(input: ExchangeDiscoverInput): Promise<ExchangeDiscoverResult>
  connect(input: ExchangeAccountInput): Promise<MailAccountSummary>
  snapshot(): Promise<ExchangeSnapshot>
  updateCredentials(accountId: string, input: ExchangeCredentialsUpdate): Promise<ExchangeSnapshot>
  sync(accountId: string): Promise<ExchangeSnapshot>
  resolve(reviewId: string, resolution: ExchangeResolution): Promise<ExchangeSnapshot>
  onChanged(callback: (snapshot: ExchangeSnapshot) => void): () => void
}
