import type { MailThreadDetail } from '../../src/mail-types'
import type {
  MailOfflineAvailability,
  MailOfflineExtendInput,
  MailOfflinePolicy,
  MailOfflineReclaimResult,
  MailOfflineSettings,
  MailSearchCoverage,
  MailServerSearchInput,
  MailServerSearchResult
} from '../../src/offline-sync-types'
import { NOT_DOWNLOADED_NOTICE, folderViewLocation } from '../../src/lib/offline-sync'
import { OFFLINE_EXEMPT_PROVIDERS } from './offline-store'
import { fetchFullMessage, searchServer, type OfflineDownloadDeps, type OfflineProviderClients } from './offline-download'

export interface OfflineCommandDeps extends OfflineDownloadDeps {
  clients: OfflineProviderClients
  online(): boolean
  /** Starts a sync for the account when it is enabled and not paused. */
  resync(accountId: string): void
  changed(accountId: string): void
}

const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60_000
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

/**
 * Worker-side operations for offline scope (E36): policy changes (which
 * queue missing content and reclaim unwanted content), availability and
 * search-coverage reports, server search, and on-demand downloads.
 */
export function createOfflineCommands(deps: OfflineCommandDeps) {
  const { database } = deps
  const store = () => database.offline

  const account = (accountId: string) => {
    const value = database.getAccount(accountId)
    if (!value) throw new Error('Account not found')
    return value
  }

  /** Re-plans an account after its scope changed: queue what is now wanted, reclaim what is not, then sync. */
  function applyPolicy(accountId: string): MailOfflineReclaimResult {
    if (OFFLINE_EXEMPT_PROVIDERS.has(account(accountId).provider)) return { messages: 0, bytes: 0 }
    const context = store().context(accountId)
    const plan = store().planContent(accountId, context)
    store().queueDownloads(accountId, plan.upgrades)
    const reclaimed = store().evict(accountId, context)
    if (reclaimed.messages || plan.upgrades.length) deps.changed(accountId)
    deps.resync(accountId)
    return reclaimed
  }

  /** Ends expired "Load all" periods and reclaims what they had added. */
  function expire(now = new Date()) {
    for (const accountId of store().expireExtensions(now)) {
      if (!database.getAccount(accountId)) continue
      const reclaimed = store().evict(accountId, store().context(accountId, now))
      if (reclaimed.messages) deps.changed(accountId)
    }
  }

  /**
   * A "last N days" window moves forward every day. After a sync (at most
   * once a day per account) mail that has aged out of the window gives back
   * its local body and original, like any other narrowing.
   */
  const lastMaintenance = new Map<string, number>()
  function maintain(accountId: string, now = new Date()) {
    const value = database.getAccount(accountId)
    if (!value || OFFLINE_EXEMPT_PROVIDERS.has(value.provider)) return { messages: 0, bytes: 0 }
    if (now.getTime() - (lastMaintenance.get(accountId) ?? 0) < MAINTENANCE_INTERVAL_MS) return { messages: 0, bytes: 0 }
    lastMaintenance.set(accountId, now.getTime())
    const result = store().evict(accountId, store().context(accountId, now))
    if (result.messages) deps.changed(accountId)
    return result
  }

  function settings(accountId: string): MailOfflineSettings {
    account(accountId)
    return store().settings(accountId)
  }

  function setAccountPolicy(accountId: string, policy: MailOfflinePolicy) {
    store().setAccountPolicy(accountId, policy)
    applyPolicy(accountId)
    return store().settings(accountId)
  }

  function setFolderOverride(accountId: string, labelId: string, override: Parameters<MailOfflineStoreLike['setFolderOverride']>[2]) {
    store().setFolderOverride(accountId, labelId, override)
    applyPolicy(accountId)
    return store().settings(accountId)
  }

  function extend(input: MailOfflineExtendInput) {
    const location = folderViewLocation(input.folder, input.labelId)
    return input.accountIds.map((accountId) => {
      const value = account(accountId)
      if (OFFLINE_EXEMPT_PROVIDERS.has(value.provider)) return store().settings(accountId)
      store().extend(accountId, location, input.mode)
      applyPolicy(accountId)
      return store().settings(accountId)
    })
  }

  function availability(accountId: string, labelId?: string): MailOfflineAvailability {
    account(accountId)
    return store().availability(accountId, labelId)
  }

  function searchCoverage(accountIds?: string[]): MailSearchCoverage[] {
    const accounts = database.listAccounts().filter((item) => !accountIds?.length || accountIds.includes(item.id))
    return accounts.map((item) => store().searchCoverage(
      item.id,
      Boolean(item.lastSyncAt),
      // Server search needs a connected provider; Local Folders and POP3 have nothing more on a server.
      !OFFLINE_EXEMPT_PROVIDERS.has(item.provider) && !item.archived
    ))
  }

  async function serverSearch(input: MailServerSearchInput): Promise<MailServerSearchResult> {
    if (!deps.online()) throw new Error('Connect to the internet to search the server')
    const searchId = crypto.randomUUID()
    const hits: { accountId: string; threadId: string }[] = []
    const errors: MailServerSearchResult['errors'] = []
    let added = 0
    for (const accountId of input.accountIds) {
      const value = database.getAccount(accountId)
      if (!value || value.archived || OFFLINE_EXEMPT_PROVIDERS.has(value.provider)) continue
      try {
        const result = await searchServer(deps, deps.clients, accountId, input.query)
        added += result.added
        for (const threadId of result.threadIds) hits.push({ accountId, threadId })
        if (result.added) deps.changed(accountId)
      } catch (error) {
        errors.push({ accountId, message: errorMessage(error) })
      }
    }
    store().saveSearchHits(searchId, hits)
    return { searchId, matched: hits.length, added, errors }
  }

  function reclaim(accountId: string) {
    account(accountId)
    const result = store().evict(accountId, store().context(accountId))
    if (result.messages) deps.changed(accountId)
    return result
  }

  /**
   * Opening a header-only message downloads it when online; offline (or when
   * the download fails) the message carries a notice instead of a body.
   */
  async function annotateThread(accountId: string, thread: MailThreadDetail): Promise<MailThreadDetail> {
    if (!store()) return thread
    let fetched = false
    const failures = new Map<string, string>()
    if (deps.online()) {
      for (const message of thread.messages) {
        if (store().contentState(accountId, message.id) !== 'headers') continue
        try {
          await fetchFullMessage(deps, deps.clients, accountId, message.id)
          fetched = true
        } catch (error) {
          failures.set(message.id, `Couldn’t download this message: ${errorMessage(error)}`)
        }
      }
    }
    const current = fetched ? database.getThread(accountId, thread.id) : thread
    return {
      ...current,
      messages: current.messages.map((message) => {
        const state = store().contentState(accountId, message.id)
        if (!state || state === 'full') return message
        return { ...message, offline: state === 'headers' ? { state, notice: failures.get(message.id) ?? NOT_DOWNLOADED_NOTICE } : { state } }
      })
    }
  }

  /** The original's path, downloading it first when only headers or a body are stored. */
  async function ensureRaw(accountId: string, messageId: string) {
    const path = database.getMessageRaw(accountId, messageId)
    if (path && database.rawExists(path)) return path
    if (!path) throw new Error('The original message is not available offline')
    if (!deps.online()) throw new Error(`${NOT_DOWNLOADED_NOTICE}.`)
    const stored = await fetchFullMessage(deps, deps.clients, accountId, messageId)
    deps.changed(accountId)
    return stored.record.rawPath
  }

  return { applyPolicy, expire, maintain, settings, setAccountPolicy, setFolderOverride, extend, availability, searchCoverage, serverSearch, reclaim, annotateThread, ensureRaw }
}

type MailOfflineStoreLike = import('./offline-store').MailOfflineStore
export type OfflineCommands = ReturnType<typeof createOfflineCommands>
