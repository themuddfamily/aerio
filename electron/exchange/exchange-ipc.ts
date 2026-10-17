import { createHash } from 'node:crypto'
import type { IpcMain } from 'electron'
import type { MailAccountSummary } from '../../src/mail-types'
import type {
  ExchangeAccountInput, ExchangeAccountState, ExchangeCapabilities, ExchangeCredentialsUpdate, ExchangeDiscoverInput, ExchangeDiscoverResult, ExchangeResolution, ExchangeSnapshot
} from '../../src/exchange-types'
import { autodiscover } from './autodiscover'
import { EwsError, formatServerVersion, type EwsClient } from './ews-client'
import { EwsAuthError, EwsHttpError, EwsNetworkError, EwsUnsupportedError, resolvedAuth } from './ews-transport'
import { ewsClientFor, validateExchangeInput, type ExchangeAccountConfig, type ExchangeClientConfig } from './exchange-config'
import type { ExchangeProductivityService } from './exchange-productivity'

// IPC for on-premises Exchange accounts: discovery, connection, credential updates (the reauth
// path after a 401), manual sync, and conflict review. Mail for these accounts then flows through
// the ordinary mail:* IPC and the mail worker; Calendar and Contacts through productivity:*.

const SYNC_INTERVAL_MS = 15 * 60_000
const FLUSH_INTERVAL_MS = 60_000
const INITIAL_SYNC_DELAY_MS = 30_000

interface WorkerLike { request(command: import('../mail-protocol').MailWorkerCommand): Promise<unknown> }
interface VaultLike {
  storeExchange(accountId: string, config: ExchangeAccountConfig): void
  exchangeCredential(accountId: string): ExchangeAccountConfig
  remove(accountId: string): Promise<void>
}

export interface ExchangeIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  service(): ExchangeProductivityService
  vault(): VaultLike
  worker(): WorkerLike
  accountColor(accountId: string): string
  /** Keeps main's provider map in sync (accountProviders). */
  accountAdded(account: MailAccountSummary): void
  accountRemoved(accountId: string): void
  broadcast(snapshot: ExchangeSnapshot): void
  productivityChanged(): void
  discover?(input: ExchangeDiscoverInput): Promise<ExchangeDiscoverResult>
  createClient?(config: ExchangeClientConfig): EwsClient
  /** Interval timers are skipped in tests. */
  timers?: boolean
}

const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 500

/** Turns transport and EWS failures into messages for the setup and settings screens. */
export function exchangeErrorMessage(error: unknown) {
  if (error instanceof EwsAuthError) return error.message.includes('token') ? error.message : 'Exchange rejected the user name or password. Check them (DOMAIN\\user or user@domain) and try again.'
  if (error instanceof EwsUnsupportedError) return error.message
  if (error instanceof EwsHttpError || error instanceof EwsNetworkError) return error.message
  if (error instanceof EwsError) return error.code === 'ErrorUnsupportedServerVersion' || error.code === 'ErrorInvalidServerVersion' ? error.message : `Exchange refused the request: ${error.message}`
  return error instanceof Error ? error.message : 'The Exchange server could not be reached'
}

const accountIdFor = (config: Pick<ExchangeAccountConfig, 'email' | 'username' | 'ewsUrl'>) =>
  createHash('sha256').update(`exchange:${config.email}:${config.username.toLowerCase()}:${config.ewsUrl.toLowerCase()}`).digest('hex').slice(0, 24)

export function registerExchangeAccounts(options: ExchangeIpcOptions) {
  const createClient = options.createClient ?? ewsClientFor
  const discover = options.discover ?? ((input: ExchangeDiscoverInput) => autodiscover(input))

  const capabilities = (accountId: string, auth: ExchangeAccountConfig['auth']): ExchangeCapabilities => {
    const folders = options.service().writableFolders(accountId)
    const calendars = folders.filter((folder) => folder.kind === 'calendar').length
    const contacts = folders.filter((folder) => folder.kind === 'contacts').length
    return {
      mail: { read: true, write: true, detail: 'Folders, read/flag state, moves, drafts, and sending through EWS.' },
      calendar: { read: true, write: calendars > 0, detail: calendars ? `${calendars} writable calendar${calendars === 1 ? '' : 's'}; edits are checked against the item's ChangeKey.` : 'No writable calendar was found yet; synchronize to refresh.' },
      contacts: { read: true, write: contacts > 0, detail: contacts ? `${contacts} writable contacts folder${contacts === 1 ? '' : 's'}; edits are checked against the item's ChangeKey.` : 'No writable contacts folder was found yet; synchronize to refresh.' },
      folderManagement: true,
      notes: [
        'Free/busy lookup, tasks, notes, delegate mailboxes, public folders, and the global address list are not synchronized yet.',
        ...(auth === 'bearer' ? ['OAuth tokens are not refreshed by Aerio; paste a new token when this one expires.'] : []),
        ...(auth === 'basic' ? ['Basic authentication sends the password with every request over HTTPS.'] : [])
      ]
    }
  }

  const snapshot = (): ExchangeSnapshot => {
    const service = options.service()
    const accounts: ExchangeAccountState[] = []
    for (const account of service.accounts()) {
      let config: ExchangeAccountConfig | undefined
      try { config = options.vault().exchangeCredential(account.accountId) } catch { config = undefined }
      accounts.push({
        accountId: account.accountId,
        email: config?.email ?? '',
        username: config?.username ?? '',
        ewsUrl: config?.ewsUrl ?? '',
        auth: config?.auth ?? 'ntlm',
        ...(account.serverVersion ?? config?.serverVersion ? { serverVersion: account.serverVersion ?? config?.serverVersion } : {}),
        status: config ? account.status : 'needs-auth',
        ...(account.error || !config ? { error: account.error ?? 'Enter the password for this Exchange account again' } : {}),
        ...(account.lastSyncedAt ? { lastSyncedAt: account.lastSyncedAt } : {}),
        pendingWrites: service.pendingWrites(account.accountId),
        capabilities: capabilities(account.accountId, config?.auth ?? 'ntlm')
      })
    }
    return { accounts, review: service.review() }
  }

  const broadcast = () => {
    const value = snapshot()
    options.broadcast(value)
    options.productivityChanged()
    return value
  }

  /** Connects with the given settings and returns the verified client and the auth method it used. */
  const verify = async (config: ExchangeClientConfig) => {
    // With 'auto' the transport picks the method from the server's 401 challenge.
    const probeClient = createClient(config)
    try {
      await probeClient.probe()
      return { auth: resolvedAuth(probeClient.transport, config.auth), serverVersion: formatServerVersion(probeClient.serverVersion) }
    } catch (error) {
      throw new Error(exchangeErrorMessage(error))
    } finally {
      probeClient.close()
    }
  }

  options.ipcMain.handle('exchange:discover', async (_event, input: unknown) => {
    const value = input as ExchangeDiscoverInput
    if (!value || typeof value !== 'object' || typeof value.email !== 'string' || value.email.length > 320) throw new Error('Enter a valid email address')
    if (value.password !== undefined && (typeof value.password !== 'string' || value.password.length > 1_000)) throw new Error('Enter a valid password')
    if (value.username !== undefined && (typeof value.username !== 'string' || value.username.length > 320)) throw new Error('Enter a valid user name')
    const trustedHosts = Array.isArray(value.trustedHosts) ? value.trustedHosts.filter((host): host is string => typeof host === 'string' && host.length <= 255).slice(0, 10) : []
    try {
      return await discover({ email: value.email, ...(value.username ? { username: value.username } : {}), ...(value.password ? { password: value.password } : {}), trustedHosts })
    } catch (error) {
      throw new Error(exchangeErrorMessage(error))
    }
  })

  options.ipcMain.handle('exchange:connect', async (_event, input: unknown) => {
    const value = validateExchangeInput(input as ExchangeAccountInput)
    const verified = await verify(value)
    const config: ExchangeAccountConfig = {
      email: value.email, username: value.username, ewsUrl: value.ewsUrl, auth: verified.auth,
      ...(value.password ? { password: value.password } : {}), ...(value.bearerToken ? { bearerToken: value.bearerToken } : {}),
      ...(verified.serverVersion ? { serverVersion: verified.serverVersion } : {})
    }
    const accountId = accountIdFor(config)
    const account: MailAccountSummary = {
      id: accountId, provider: 'exchange', email: value.email, displayName: value.displayName || value.email.split('@')[0],
      color: options.accountColor(accountId), status: 'connecting', archived: false, signature: '', notifications: true, syncEnabled: true
    }
    // The verified password is stored first; an OS without secure storage leaves nothing behind.
    options.vault().storeExchange(accountId, config)
    options.accountAdded(account)
    try {
      await options.worker().request({ type: 'accounts:upsert', payload: account })
      await options.worker().request({ type: 'sync:start', payload: { accountId } })
      options.service().addAccount(accountId, verified.serverVersion)
    } catch (error) {
      options.accountRemoved(accountId)
      await options.vault().remove(accountId)
      await options.worker().request({ type: 'accounts:disconnect', payload: { accountId, mode: 'delete' } }).catch(() => undefined)
      options.service().removeAccount(accountId)
      throw error
    }
    // Calendar and Contacts load in the background; failures show on the account in Settings.
    void options.service().sync(accountId).catch(() => undefined).then(() => broadcast()).catch(() => undefined)
    broadcast()
    return account
  })

  options.ipcMain.handle('exchange:snapshot', () => snapshot())

  options.ipcMain.handle('exchange:update-credentials', async (_event, accountId: unknown, update: unknown) => {
    if (!validId(accountId)) throw new Error('Choose an Exchange account')
    const value = (update ?? {}) as ExchangeCredentialsUpdate
    if (typeof value !== 'object') throw new Error('Enter the new password or token')
    const current = options.vault().exchangeCredential(accountId)
    const password = typeof value.password === 'string' && value.password ? value.password : current.password
    const bearerToken = typeof value.bearerToken === 'string' && value.bearerToken.trim() ? value.bearerToken.trim() : current.bearerToken
    const auth = value.auth && ['auto', 'basic', 'ntlm', 'bearer'].includes(value.auth) ? value.auth : current.auth
    if ((password?.length ?? 0) > 1_000 || (bearerToken?.length ?? 0) > 20_000) throw new Error('The password or token is too long')
    const verified = await verify({ ...current, password, bearerToken, auth })
    options.vault().storeExchange(accountId, { ...current, auth: verified.auth, ...(password ? { password } : {}), ...(bearerToken ? { bearerToken } : {}), ...(verified.serverVersion ? { serverVersion: verified.serverVersion } : {}) })
    await options.worker().request({ type: 'accounts:verify', payload: { accountId } })
    await options.worker().request({ type: 'sync:start', payload: { accountId } })
    if (options.service().hasAccount(accountId)) await options.service().credentialsUpdated(accountId).catch(() => undefined)
    return broadcast()
  })

  options.ipcMain.handle('exchange:sync', async (_event, accountId: unknown) => {
    if (!validId(accountId) || !options.service().hasAccount(accountId)) throw new Error('That Exchange account is no longer connected')
    try { await options.service().sync(accountId) } catch (error) { throw new Error(exchangeErrorMessage(error)) } finally { broadcast() }
    return snapshot()
  })

  options.ipcMain.handle('exchange:resolve', async (_event, reviewId: unknown, resolution: unknown) => {
    if (!validId(reviewId)) throw new Error('Choose a change to review')
    if (resolution !== 'keep-server' && resolution !== 'keep-local') throw new Error('Choose how to resolve the change')
    await options.service().resolve(reviewId, resolution as ExchangeResolution)
    return broadcast()
  })

  let running = false
  const run = async (work: () => Promise<void>) => {
    if (running) return
    running = true
    try { await work(); broadcast() } catch { /* Storage can close during shutdown; the next interval retries. */ } finally { running = false }
  }
  const timers = options.timers === false ? [] : [
    setTimeout(() => void run(() => options.service().syncAll()), INITIAL_SYNC_DELAY_MS),
    setInterval(() => void run(() => options.service().syncAll()), SYNC_INTERVAL_MS),
    setInterval(() => void run(() => options.service().flushAll()), FLUSH_INTERVAL_MS)
  ]
  for (const timer of timers) timer.unref?.()
  return {
    snapshot,
    broadcast,
    flushNow: () => run(() => options.service().flushAll()),
    dispose() { for (const timer of timers) clearInterval(timer) }
  }
}
