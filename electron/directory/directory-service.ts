import type { MailProviderId } from '../../src/mail-types'
import type {
  DirectoryAccessLevel, DirectoryAccountSearchStatus, DirectoryAccountState, DirectoryEntry, DirectoryEntryKind, DirectoryGroupMembers,
  DirectorySearchRequest, DirectorySearchResult, DirectorySnapshot
} from '../../src/directory-types'
import type { EwsClient } from '../exchange/ews-client'
import {
  DirectoryPermissionError, DirectoryUnavailableError, EwsDirectoryBackend, EwsRoomCache, GOOGLE_DIRECTORY_SCOPE, GOOGLE_NO_DIRECTORY_MESSAGE,
  GRAPH_DENIED_MESSAGE, GRAPH_DIRECTORY_SCOPES, GRAPH_RESOURCE_SCOPES, GoogleDirectoryBackend, GraphDirectoryBackend, isConsumerGoogleAccount, isConsumerMicrosoftAccount, MICROSOFT_NO_DIRECTORY_MESSAGE,
  type DirectoryBackend, type FetchLike, type GraphDirectoryAccess
} from './directory-backends'
import type { DirectoryStore } from './directory-store'

// The organization directory service (E41): online lookup per account with a fallback to the
// offline address book, group expansion, scheduled and on-demand atomic cache refreshes, and
// directory consent through an explicit reconnect. Directory entries are never written back.

export const DIRECTORY_REFRESH_INTERVAL_MS = 24 * 60 * 60_000
/** A failed scheduled refresh is retried after this long. */
export const DIRECTORY_RETRY_INTERVAL_MS = 60 * 60_000
const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100
const KINDS: DirectoryEntryKind[] = ['person', 'group', 'room', 'equipment']

export interface DirectoryAccountInfo {
  id: string
  provider: MailProviderId
  email: string
}

export interface DirectoryServiceDependencies {
  store: DirectoryStore
  accounts(): Promise<DirectoryAccountInfo[]>
  googleToken(accountId: string): Promise<string>
  microsoftToken(accountId: string): Promise<string>
  /** Undefined when the stored grant predates scope tracking. */
  grantedScopes(accountId: string, provider: 'gmail' | 'microsoft'): string[] | undefined
  ewsClient(accountId: string): EwsClient
  /** Interactive reconnect that adds scopes to the account's grant. */
  authorize(account: DirectoryAccountInfo, scopes: string[]): Promise<void>
  online(): boolean
  fetch?: FetchLike
  now?(): number
  changed?(snapshot: DirectorySnapshot): void
  diagnostic?(record: { level: 'info' | 'warn' | 'error'; event: string; accountId?: string; message?: string; details?: Record<string, unknown> }): void
}

const lowerSet = (values: string[] | undefined) => new Set((values ?? []).map((value) => value.replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase()))
const hasAny = (granted: Set<string>, scopes: string[]) => scopes.some((scope) => granted.has(scope.toLowerCase()))

/** Graph permissions that grant each directory capability. */
export function graphDirectoryAccess(granted: string[] | undefined): GraphDirectoryAccess & { known: boolean } {
  if (!granted) return { users: true, people: true, groups: false, rooms: false, known: false }
  const scopes = lowerSet(granted)
  return {
    users: hasAny(scopes, ['User.ReadBasic.All', 'User.Read.All', 'User.ReadWrite.All', 'Directory.Read.All', 'Directory.ReadWrite.All']),
    people: hasAny(scopes, ['People.Read', 'People.Read.All']),
    groups: hasAny(scopes, ['GroupMember.Read.All', 'Group.Read.All', 'Group.ReadWrite.All', 'Directory.Read.All', 'Directory.ReadWrite.All']),
    rooms: hasAny(scopes, ['Place.Read.All', 'Place.ReadWrite.All']),
    known: true
  }
}

/** Admin-consent and access-denied answers from an interactive grant. */
export function isConsentDenied(message: string) {
  return /AADSTS65001|AADSTS90094|AADSTS90008|admin(istrator)? (approval|consent)|need(s)? admin|consent_required|access_denied|interaction_required|admin_policy_enforced/i.test(message)
}

const errorMessage = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback

export class DirectoryService {
  private readonly refreshing = new Set<string>()
  private readonly rooms: EwsRoomCache
  private readonly fetchImpl: FetchLike | undefined

  constructor(private readonly deps: DirectoryServiceDependencies) {
    this.rooms = new EwsRoomCache(() => this.now())
    this.fetchImpl = deps.fetch
  }

  private now() { return this.deps.now?.() ?? Date.now() }
  private iso() { return new Date(this.now()).toISOString() }

  private state(account: DirectoryAccountInfo): DirectoryAccountState {
    const cache = this.deps.store.state(account.id)
    const cacheState = {
      ...(cache.mode ? { mode: cache.mode } : {}), entries: cache.entries,
      ...(cache.lastSuccessAt ? { lastSuccessAt: cache.lastSuccessAt, nextRefreshAt: new Date(Date.parse(cache.lastSuccessAt) + DIRECTORY_REFRESH_INTERVAL_MS).toISOString() } : {}),
      ...(cache.lastAttemptAt ? { lastAttemptAt: cache.lastAttemptAt } : {}), ...(cache.error ? { error: cache.error } : {}),
      refreshing: this.refreshing.has(account.id)
    }
    const base = { accountId: account.id, email: account.email, provider: account.provider, cache: cacheState }
    const none = { people: false, groups: false, rooms: false, expandGroups: false, offline: false }
    if (account.provider === 'microsoft' && isConsumerMicrosoftAccount(account.email)) {
      return { ...base, backend: 'microsoft-graph', supported: false, message: MICROSOFT_NO_DIRECTORY_MESSAGE, consent: 'not-required', missingScopes: [], missingResourceScopes: [], capabilities: none }
    }
    if (account.provider === 'microsoft') {
      const access = graphDirectoryAccess(this.deps.grantedScopes(account.id, 'microsoft'))
      const granted = lowerSet(this.deps.grantedScopes(account.id, 'microsoft'))
      const consent = cache.consentError ? 'denied' : !access.known ? 'unknown' : access.users || access.people ? 'granted' : 'missing'
      return {
        ...base, backend: 'microsoft-graph', supported: true, consent,
        ...(cache.consentError ? { message: cache.consentError } : consent === 'missing' ? { message: 'Allow directory access to look up people, groups, and rooms in your organization.' } : {}),
        missingScopes: access.known ? GRAPH_DIRECTORY_SCOPES.filter((scope) => !granted.has(scope.toLowerCase())) : [...GRAPH_DIRECTORY_SCOPES],
        missingResourceScopes: GRAPH_RESOURCE_SCOPES.filter((scope) => !granted.has(scope.toLowerCase())),
        capabilities: { people: access.users || access.people, groups: access.people || access.groups, rooms: access.rooms, expandGroups: access.groups, offline: access.users }
      }
    }
    if (account.provider === 'gmail') {
      if (isConsumerGoogleAccount(account.email)) {
        return { ...base, backend: 'google-workspace', supported: false, message: GOOGLE_NO_DIRECTORY_MESSAGE, consent: 'not-required', missingScopes: [], missingResourceScopes: [], capabilities: none }
      }
      const scopes = this.deps.grantedScopes(account.id, 'gmail')
      const granted = scopes?.includes(GOOGLE_DIRECTORY_SCOPE)
      const consent = cache.consentError ? 'denied' : scopes === undefined ? 'unknown' : granted ? 'granted' : 'missing'
      return {
        ...base, backend: 'google-workspace', supported: true, consent,
        ...(cache.consentError ? { message: cache.consentError } : consent === 'missing' ? { message: 'Allow directory access to look up people in your Google Workspace directory.' } : {}),
        missingScopes: granted ? [] : [GOOGLE_DIRECTORY_SCOPE], missingResourceScopes: [],
        capabilities: { people: true, groups: false, rooms: false, expandGroups: false, offline: true }
      }
    }
    if (account.provider === 'exchange') {
      return {
        ...base, backend: 'exchange-ews', supported: true, consent: cache.consentError ? 'denied' : 'not-required', ...(cache.consentError ? { message: cache.consentError } : {}),
        missingScopes: [], missingResourceScopes: [],
        capabilities: { people: true, groups: true, rooms: true, expandGroups: true, offline: true }
      }
    }
    return { ...base, supported: false, message: 'This account’s server does not publish an organization directory that Aerio can read.', consent: 'not-required', missingScopes: [], missingResourceScopes: [], capabilities: none }
  }

  private backend(account: DirectoryAccountInfo): DirectoryBackend {
    if (account.provider === 'microsoft') {
      if (isConsumerMicrosoftAccount(account.email)) throw new DirectoryUnavailableError(MICROSOFT_NO_DIRECTORY_MESSAGE)
      const access = graphDirectoryAccess(this.deps.grantedScopes(account.id, 'microsoft'))
      return new GraphDirectoryBackend(account.id, () => this.deps.microsoftToken(account.id), access, this.fetchImpl)
    }
    if (account.provider === 'gmail') {
      if (isConsumerGoogleAccount(account.email)) throw new DirectoryUnavailableError(GOOGLE_NO_DIRECTORY_MESSAGE)
      return new GoogleDirectoryBackend(account.id, () => this.deps.googleToken(account.id), this.fetchImpl)
    }
    if (account.provider === 'exchange') return new EwsDirectoryBackend(account.id, this.deps.ewsClient(account.id), this.rooms)
    throw new DirectoryUnavailableError('This account’s server does not publish an organization directory that Aerio can read.')
  }

  private async account(accountId: string) {
    const account = (await this.deps.accounts()).find((item) => item.id === accountId)
    if (!account) throw new Error('That account is no longer connected')
    return account
  }

  async snapshot(): Promise<DirectorySnapshot> {
    return { accounts: (await this.deps.accounts()).map((account) => this.state(account)), online: this.deps.online() }
  }

  private async emit() {
    if (!this.deps.changed) return
    try { this.deps.changed(await this.snapshot()) } catch { /* Accounts can be unavailable during shutdown. */ }
  }

  private recordDenied(accountId: string, error: unknown) {
    if (error instanceof DirectoryPermissionError && error.denied) this.deps.store.updateState(accountId, { consentError: error.message })
  }

  async search(request: DirectorySearchRequest): Promise<DirectorySearchResult> {
    const query = typeof request?.query === 'string' ? request.query.trim().slice(0, 200) : ''
    const limit = Math.min(Math.max(Math.floor(Number(request?.limit) || DEFAULT_LIMIT), 1), MAX_LIMIT)
    const kinds = Array.isArray(request?.kinds) && request.kinds.length ? KINDS.filter((kind) => request.kinds!.includes(kind)) : KINDS
    const mode = request?.mode === 'online' || request?.mode === 'offline' ? request.mode : 'auto'
    const wanted = Array.isArray(request?.accountIds) ? new Set(request.accountIds.filter((id) => typeof id === 'string')) : undefined
    if (!query) return { entries: [], source: 'none', accounts: [] }
    const accounts = (await this.deps.accounts()).filter((account) => !wanted || wanted.has(account.id))
    const online = this.deps.online()
    const statuses: DirectoryAccountSearchStatus[] = []
    const results: DirectoryEntry[][] = []
    await Promise.all(accounts.map(async (account) => {
      const state = this.state(account)
      if (!state.supported) return
      const offline = (error?: string, needsConsent?: boolean) => {
        const cached = this.deps.store.search([account.id], query, kinds, limit)
        results.push(cached)
        statuses.push({ accountId: account.id, source: cached.length || state.cache.entries ? 'offline' : 'none', ...(error ? { error } : {}), ...(needsConsent ? { needsConsent } : {}) })
      }
      if (mode === 'offline' || (!online && mode === 'auto')) return offline(online ? undefined : 'Offline: showing the saved address book')
      if (state.consent === 'missing' || state.consent === 'denied') return offline(state.message, true)
      try {
        const entries = await this.backend(account).search(query, kinds, limit)
        if (account.provider === 'exchange') this.deps.store.remember(account.id, entries)
        results.push(entries)
        statuses.push({ accountId: account.id, source: 'online' })
      } catch (error) {
        this.recordDenied(account.id, error)
        if (error instanceof DirectoryUnavailableError) { statuses.push({ accountId: account.id, source: 'none', error: error.message }); return }
        if (mode === 'online') { statuses.push({ accountId: account.id, source: 'none', error: errorMessage(error, 'The directory lookup failed'), ...(error instanceof DirectoryPermissionError ? { needsConsent: true } : {}) }); return }
        this.deps.diagnostic?.({ level: 'warn', event: 'directory-lookup-failed', accountId: account.id, message: errorMessage(error, 'lookup failed') })
        offline(error instanceof DirectoryPermissionError ? error.message : `${errorMessage(error, 'The directory could not be reached')} Showing the saved address book.`, error instanceof DirectoryPermissionError)
      }
    }))
    const entries = rank(results.flat(), query).slice(0, limit)
    const sources = new Set(statuses.map((status) => status.source).filter((source) => source !== 'none'))
    return {
      entries: markAmbiguous(entries),
      source: sources.size === 0 ? 'none' : sources.size > 1 ? 'mixed' : sources.has('online') ? 'online' : 'offline',
      accounts: statuses.sort((a, b) => a.accountId.localeCompare(b.accountId))
    }
  }

  async expandGroup(accountId: string, groupEmail: string): Promise<DirectoryGroupMembers> {
    if (typeof groupEmail !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(groupEmail) || groupEmail.length > 320) throw new Error('Choose a group address')
    const account = await this.account(accountId)
    if (!this.deps.online()) throw new Error('Group members can be listed only while online. The group address can still be used.')
    try {
      const expansion = await this.backend(account).expandGroup(groupEmail)
      return { accountId, groupEmail, ...expansion }
    } catch (error) {
      this.recordDenied(accountId, error)
      throw new Error(errorMessage(error, 'The group members could not be listed'))
    }
  }

  /** Rebuilds the offline address book into staging and swaps it in only when the listing completes. */
  async refresh(accountId: string): Promise<DirectorySnapshot> {
    const account = await this.account(accountId)
    const state = this.state(account)
    if (!state.supported) throw new Error(state.message ?? 'This account has no directory')
    if (!state.capabilities.offline) throw new Error(state.consent === 'denied' ? state.message! : 'Allow directory access for this account to save an offline address book.')
    if (!this.deps.online()) throw new Error('The offline address book can be refreshed only while online')
    if (this.refreshing.has(accountId)) return this.snapshot()
    this.refreshing.add(accountId)
    void this.emit()
    const store = this.deps.store
    store.beginRefresh(accountId, this.iso())
    let staged = 0
    try {
      const mode = await this.backend(account).list((entries) => { staged += entries.length; store.stage(accountId, entries) })
      store.commitRefresh(accountId, mode, this.iso())
      if (state.consent === 'denied' || store.state(accountId).consentError) store.updateState(accountId, { consentError: undefined })
      this.deps.diagnostic?.({ level: 'info', event: 'directory-cache-refreshed', accountId, details: { entries: staged, mode } })
    } catch (error) {
      this.recordDenied(accountId, error)
      const message = errorMessage(error, 'The directory could not be listed')
      store.abortRefresh(accountId, message, this.iso())
      this.deps.diagnostic?.({ level: 'warn', event: 'directory-cache-refresh-failed', accountId, message })
      throw new Error(`${message} The previous offline address book is still used.`)
    } finally {
      this.refreshing.delete(accountId)
      void this.emit()
    }
    return this.snapshot()
  }

  /** Daily refresh of caches that are due; failures are retried hourly and never clear the cache. */
  async refreshDue() {
    if (!this.deps.online()) return
    for (const account of await this.deps.accounts()) {
      const state = this.state(account)
      if (!state.supported || !state.capabilities.offline || (state.consent !== 'granted' && state.consent !== 'not-required')) continue
      const success = state.cache.lastSuccessAt ? Date.parse(state.cache.lastSuccessAt) : 0
      const attempt = state.cache.lastAttemptAt ? Date.parse(state.cache.lastAttemptAt) : 0
      if (this.now() - success < DIRECTORY_REFRESH_INTERVAL_MS || this.now() - attempt < DIRECTORY_RETRY_INTERVAL_MS) continue
      await this.refresh(account.id).catch(() => undefined)
    }
  }

  /** Explicit reconnect that adds directory permissions (incremental consent). */
  async grantAccess(accountId: string, level: DirectoryAccessLevel = 'directory'): Promise<DirectorySnapshot> {
    const account = await this.account(accountId)
    let scopes: string[]
    if (account.provider === 'microsoft' && isConsumerMicrosoftAccount(account.email)) throw new Error(MICROSOFT_NO_DIRECTORY_MESSAGE)
    if (account.provider === 'microsoft') scopes = level === 'resources' ? [...GRAPH_DIRECTORY_SCOPES, ...GRAPH_RESOURCE_SCOPES] : GRAPH_DIRECTORY_SCOPES
    else if (account.provider === 'gmail') {
      if (isConsumerGoogleAccount(account.email)) throw new Error(GOOGLE_NO_DIRECTORY_MESSAGE)
      scopes = [GOOGLE_DIRECTORY_SCOPE]
    } else throw new Error('This account does not need a directory permission')
    try {
      await this.deps.authorize(account, scopes)
    } catch (error) {
      const message = errorMessage(error, 'The permission was not granted')
      if (isConsentDenied(message)) {
        const explanation = account.provider === 'microsoft'
          ? `${level === 'resources' ? 'Rooms and group membership need administrator approval (Place.Read.All, GroupMember.Read.All).' : GRAPH_DENIED_MESSAGE} Microsoft said: ${message}`
          : `Google did not grant directory access. ${message}`
        // A denied optional rooms/groups grant must not hide the people directory that still works.
        if (level === 'directory') this.deps.store.updateState(accountId, { consentError: explanation })
        void this.emit()
        throw new Error(explanation)
      }
      throw new Error(message)
    }
    this.deps.store.updateState(accountId, { consentError: undefined })
    this.rooms.clear(accountId)
    const next = this.state(account)
    if (next.capabilities.offline && !next.cache.lastSuccessAt) void this.refresh(accountId).catch(() => undefined)
    void this.emit()
    return this.snapshot()
  }

  removeAccount(accountId: string) {
    this.rooms.clear(accountId)
    this.deps.store.removeAccount(accountId)
  }
}

/** People first, then names that start with the query, then alphabetical. */
function rank(entries: DirectoryEntry[], query: string) {
  const lower = query.toLowerCase()
  const order: Record<DirectoryEntryKind, number> = { person: 0, group: 1, room: 2, equipment: 3 }
  const seen = new Set<string>()
  return entries.filter((entry) => {
    const key = `${entry.accountId}\n${entry.email.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).sort((a, b) => {
    const prefix = (entry: DirectoryEntry) => entry.name.toLowerCase().startsWith(lower) || entry.email.toLowerCase().startsWith(lower) ? 0 : 1
    return prefix(a) - prefix(b) || order[a.kind] - order[b.kind] || a.name.localeCompare(b.name) || a.email.localeCompare(b.email)
  })
}

/** Entries sharing a display name are flagged so the UI shows title, department, and address. */
export function markAmbiguous(entries: DirectoryEntry[]) {
  const counts = new Map<string, number>()
  for (const entry of entries) counts.set(entry.name.trim().toLowerCase(), (counts.get(entry.name.trim().toLowerCase()) ?? 0) + 1)
  return entries.map((entry) => (counts.get(entry.name.trim().toLowerCase()) ?? 0) > 1 ? { ...entry, ambiguous: true } : entry)
}

