import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, Notification, protocol, shell, Tray } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { arch, platform, release, tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createDemoState } from '../src/demo-data'
import type { AppState, Attachment, CalendarEvent, MessageWindowRequest } from '../src/types'
import type {
  ApplyMailActionInput,
  MailAccountSummary,
  MailDraftInput,
  MailDraftRecord,
  MailDraftAttachmentFile,
  MailDraftResult,
  MailLabel,
  MailRule,
  MailRuleInput,
  MailRuleRunResult,
  MailSnooze,
  MailMessageSource,
  MailThreadDetail,
  ImapAccountInput,
  ImapServerSettings,
  ImapServerSettingsUpdate,
  MailPage,
  MailAccountSettingsInput,
  MailDiagnosticHealth,
  MailQuery,
  MailRecipientSuggestion,
  MailStorageStats,
  PendingOperation,
  SyncProgress
} from '../src/mail-types'
import { OAuthVault } from './mail/oauth-vault'
import { DEFAULT_GOOGLE_CLIENT_ID, DEFAULT_MICROSOFT_CLIENT_ID, parseOAuthEnvironment } from './mail/oauth-config'
import { ImapSmtpClient } from './mail/imap-client'
import { PROVIDER_PRESETS, validateImapAccount } from './mail/provider-presets'
import { MailWorkerClient } from './mail/worker-client'
import { DiagnosticLogger, type DiagnosticRecord } from './diagnostics'
import { UpdateManager } from './update-manager'
import { ProductivityStore } from './productivity/store'
import { GoogleProductivityConnector } from './productivity/google-connector'
import { MicrosoftProductivityConnector } from './productivity/microsoft-connector'
import type { LocalModuleSnapshot, ProductivitySnapshot } from '../src/productivity-types'
import { senderDomainFromEmail } from '../src/lib/sender-avatar'
import { isCompleteMailAddress } from '../src/lib/mail-address'
import { mailPollingIntervalForWindow } from './mail/polling-policy'
import { faviconDomainCandidates } from './mail/favicon-domains'

const builtInGoogleClientSecret = import.meta.env.MAIN_VITE_GOOGLE_CLIENT_SECRET
const builtInOAuthClients = parseOAuthEnvironment({
  googleClientId: builtInGoogleClientSecret
    ? import.meta.env.MAIN_VITE_GOOGLE_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID
    : undefined,
  googleClientSecret: builtInGoogleClientSecret,
  microsoftClientId: import.meta.env.MAIN_VITE_MICROSOFT_CLIENT_ID || DEFAULT_MICROSOFT_CLIENT_ID
})

const hasSingleInstanceLock = app.requestSingleInstanceLock()
const hideTestWindows = process.env.AERIO_TEST_HIDDEN === '1'

if (!hasSingleInstanceLock) app.quit()
if (process.platform === 'win32') app.setAppUserModelId('com.aerio.desktop')

protocol.registerSchemesAsPrivileged([
  { scheme: 'aerio-image', privileges: { secure: true, standard: true, supportFetchAPI: true, bypassCSP: false } }
])

let mainWindow: BrowserWindow | null = null
const messageWindows = new Map<string, BrowserWindow>()
let tray: Tray | null = null
let database: DatabaseSync | null = null
let oauthVault: OAuthVault | null = null
let mailWorker: MailWorkerClient | null = null
const accountProviders = new Map<string, MailAccountSummary['provider']>()
const approvedAttachmentPaths = new Set<string>()
let quitting = false
let lastBoundsWrite: NodeJS.Timeout | undefined
let diagnostics: DiagnosticLogger | null = null
let updates: UpdateManager | null = null
let productivityStore: ProductivityStore | null = null
let readyToOpenWindows = false
const senderFaviconCache = new Map<string, { image: Buffer | null; expiresAt: number }>()
const senderFaviconCandidateRequests = new Map<string, Promise<Buffer | null>>()
const senderFaviconResolutionRequests = new Map<string, Promise<Buffer | null>>()

function diagnostic(record: Omit<DiagnosticRecord, 'timestamp'>) {
  diagnostics?.log(record)
}

const validState = (value: unknown): value is AppState => {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<AppState>
  return state.schemaVersion === 1 &&
    Array.isArray(state.accounts) &&
    Array.isArray(state.messages) &&
    Array.isArray(state.events) &&
    Array.isArray(state.contacts) &&
    Array.isArray(state.tasks) &&
    Array.isArray(state.notes) &&
    Array.isArray(state.conversations)
}

async function initializeDatabase() {
  const userData = app.getPath('userData')
  const legacyPath = join(userData, 'aerio.sqlite')
  const databasePath = join(userData, 'aerio-demo.sqlite')
  if (!existsSync(databasePath) && existsSync(legacyPath)) {
    const legacy = new DatabaseSync(legacyPath, { readOnly: true })
    const normalized = Boolean(legacy.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`).get())
    legacy.close()
    if (!normalized) {
      copyFileSync(legacyPath, databasePath)
      const backup = `${legacyPath}.v0.1.bak`
      if (!existsSync(backup)) copyFileSync(legacyPath, backup)
    }
  }
  database = new DatabaseSync(databasePath)
  database.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  const result = database.prepare('SELECT payload FROM app_state WHERE id = 1').get()
  if (!result) saveState(createDemoState())
}

function requireMailWorker() {
  if (!mailWorker) throw new Error('The mail engine is not ready')
  return mailWorker
}

function requireVault() {
  if (!oauthVault) throw new Error('Secure mail storage is not ready')
  return oauthVault
}

function safeFilename(value: string) {
  const cleaned = value.replaceAll(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 180)
  return cleaned || 'attachment'
}

function validateDraft(input: MailDraftInput, forSend = false) {
  if (!input || typeof input !== 'object' || typeof input.accountId !== 'string' || !input.accountId || input.accountId.length > 200) throw new Error('Choose a valid sending account')
  if (!Array.isArray(input.to) || !Array.isArray(input.cc) || !Array.isArray(input.bcc) || !Array.isArray(input.attachmentPaths)) throw new Error('The draft is invalid')
  if (input.id !== undefined && (typeof input.id !== 'string' || !input.id || input.id.length > 200)) throw new Error('The draft id is invalid')
  const addresses = [...input.to, ...input.cc, ...input.bcc]
  if (addresses.length > 500) throw new Error('A message cannot contain more than 500 recipients')
  if (forSend && !addresses.length) throw new Error('Add at least one recipient')
  if (addresses.some((address) => typeof address !== 'string' || address.length > 500)) throw new Error('A recipient entry is too long')
  if (forSend && addresses.some((address) => !isCompleteMailAddress(address))) throw new Error('Finish or correct the recipient email addresses')
  if (typeof input.subject !== 'string' || input.subject.length > 998) throw new Error('The subject is too long')
  if (typeof input.text !== 'string' || (input.html !== undefined && typeof input.html !== 'string') || input.text.length > 20_000_000 || (input.html?.length ?? 0) > 20_000_000) throw new Error('The message body is too large')
  if (input.attachmentPaths.length > 50) throw new Error('A message cannot contain more than 50 attachments')
  if (input.attachmentPaths.some((path) => typeof path !== 'string' || !approvedAttachmentPaths.has(path))) {
    throw new Error('A draft referenced a file that was not selected through Aerio')
  }
  let attachmentBytes = 0
  for (const path of input.attachmentPaths) {
    try {
      const details = statSync(path)
      if (!details.isFile()) throw new Error('not a file')
      attachmentBytes += details.size
    } catch {
      throw new Error(`An attachment is no longer available: ${basename(path)}`)
    }
  }
  if (attachmentBytes > 20 * 1024 * 1024) throw new Error('Attachments exceed Aerio’s 20 MB sending limit')
  return input
}

function validateFutureDate(value: unknown, label: string) {
  if (typeof value !== 'string' || !value || value.length > 100) throw new Error(`Choose a valid ${label.toLowerCase()}`)
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) throw new Error(`${label} must be in the future`)
  if (timestamp > Date.now() + 366 * 24 * 60 * 60 * 1_000) throw new Error(`${label} cannot be more than one year away`)
  return new Date(timestamp).toISOString()
}

function validateRule(input: MailRuleInput): MailRuleInput {
  if (!input || typeof input !== 'object') throw new Error('The rule is invalid')
  if (input.id !== undefined && (typeof input.id !== 'string' || !input.id || input.id.length > 200)) throw new Error('The rule id is invalid')
  if (typeof input.accountId !== 'string' || !input.accountId || input.accountId.length > 200) throw new Error('Choose an account for this rule')
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200) throw new Error('Give this rule a name')
  if (typeof input.enabled !== 'boolean' || !['all', 'any'].includes(input.match)) throw new Error('Choose how this rule should match')
  if (!Array.isArray(input.conditions) || input.conditions.length < 1 || input.conditions.length > 10) throw new Error('Add between one and ten conditions')
  if (!Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > 10) throw new Error('Add between one and ten actions')
  const fields = new Set(['from', 'to', 'subject', 'body'])
  const operators = new Set(['contains', 'equals', 'starts-with', 'ends-with'])
  const actions = new Set(['archive', 'read', 'star', 'important', 'trash', 'label', 'move'])
  for (const condition of input.conditions) {
    if (!condition || !fields.has(condition.field) || !operators.has(condition.operator) || typeof condition.value !== 'string' || !condition.value.trim() || condition.value.length > 500) throw new Error('Finish every rule condition')
  }
  for (const action of input.actions) {
    if (!action || !actions.has(action.action)) throw new Error('Choose a valid rule action')
    if ((action.action === 'label' || action.action === 'move') && (typeof action.labelId !== 'string' || !action.labelId || action.labelId.length > 500)) throw new Error('Choose a label or folder for the rule')
  }
  return {
    ...input,
    name: input.name.trim(),
    conditions: input.conditions.map((condition) => ({ ...condition, value: condition.value.trim() }))
  }
}

function requireProductivityStore() {
  if (!productivityStore) throw new Error('Calendar and contacts storage is not ready')
  return productivityStore
}

function validLocalModules(value: unknown): value is LocalModuleSnapshot {
  if (!value || typeof value !== 'object') return false
  const input = value as Partial<LocalModuleSnapshot>
  if (!Array.isArray(input.tasks) || !Array.isArray(input.notes) || input.tasks.length > 100_000 || input.notes.length > 100_000) return false
  return input.tasks.every((task) => task && typeof task.id === 'string' && typeof task.title === 'string' && task.id.length <= 300 && task.title.length <= 10_000) &&
    input.notes.every((note) => note && typeof note.id === 'string' && typeof note.title === 'string' && typeof note.content === 'string' && note.id.length <= 300 && note.title.length <= 10_000 && note.content.length <= 10_000_000)
}

async function syncProductivity(accountId: string): Promise<ProductivitySnapshot> {
  const provider = accountProviders.get(accountId)
  if (provider !== 'gmail' && provider !== 'microsoft') throw new Error('This mail connection does not provide Calendar or Contacts APIs')
  const store = requireProductivityStore()
  store.setSyncing(accountId)
  const connector = provider === 'gmail'
    ? new GoogleProductivityConnector(
      accountId,
      () => requireVault().accessToken(accountId),
      requireVault().hasGoogleCalendarWriteAccess(accountId)
    )
    : new MicrosoftProductivityConnector(accountId, () => requireVault().microsoftAccessToken(accountId))
  try {
    const data = await connector.sync()
    store.replaceAccount(accountId, provider, data)
    diagnostic({
      level: 'info', component: 'provider', event: 'productivity-sync-complete', accountId,
      details: { provider, calendars: data.calendars.length, events: data.events.length, contacts: data.contacts.length }
    })
    return store.snapshot()
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'Calendar and contacts synchronization failed'
    store.setError(accountId, message)
    diagnostic({ level: 'error', component: 'provider', event: 'productivity-sync-error', accountId, message, details: { provider } })
    throw new Error(message)
  }
}

function validCalendarEvent(value: unknown): value is CalendarEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<CalendarEvent>
  const validText = (text: unknown, max = 20_000) => typeof text === 'string' && text.length <= max
  if (!validText(event.id, 500) || !event.id || !validText(event.calendarId, 500) || !event.calendarId || !validText(event.title, 500) || !event.title?.trim()) return false
  if (!validText(event.start, 100) || !validText(event.end, 100)) return false
  const start = Date.parse(event.start ?? '')
  const end = Date.parse(event.end ?? '')
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false
  if (event.location !== undefined && !validText(event.location, 2_000)) return false
  if (event.description !== undefined && !validText(event.description, 100_000)) return false
  if (!validText(event.color, 100) || !Array.isArray(event.attendees) || event.attendees.length > 1_000 || !event.attendees.every((item) => validText(item, 500))) return false
  if (!Number.isInteger(event.reminderMinutes) || Number(event.reminderMinutes) < 0 || Number(event.reminderMinutes) > 40_320) return false
  return event.recurrence === undefined || event.recurrence === 'none' || event.recurrence === 'daily' || event.recurrence === 'weekly' || event.recurrence === 'monthly'
}

function googleCalendarConnector(accountId: string) {
  return new GoogleProductivityConnector(
    accountId,
    () => requireVault().accessToken(accountId),
    requireVault().hasGoogleCalendarWriteAccess(accountId)
  )
}

async function createProductivityEvent(input: CalendarEvent) {
  const store = requireProductivityStore()
  const calendar = store.snapshot().calendars.find((item) => item.id === input.calendarId)
  if (!calendar) throw new Error('That calendar is no longer available')
  if (calendar.provider !== 'gmail') throw new Error('Event editing is currently available for Google Calendar accounts')
  const saved = await googleCalendarConnector(calendar.accountId).createEvent(calendar, input)
  store.upsertEvent(saved)
  diagnostic({ level: 'info', component: 'provider', event: 'calendar-event-created', accountId: calendar.accountId, details: { provider: calendar.provider, calendarId: calendar.id } })
  return store.snapshot()
}

async function updateProductivityEvent(input: CalendarEvent) {
  const store = requireProductivityStore()
  const snapshot = store.snapshot()
  const current = snapshot.events.find((item) => item.id === input.id)
  if (!current) throw new Error('That event is no longer available')
  if (current.readOnly) throw new Error('This event cannot be edited')
  if (input.calendarId !== current.calendarId) throw new Error('Moving an existing event to another calendar is not supported yet')
  const calendar = snapshot.calendars.find((item) => item.id === current.calendarId)
  if (!calendar) throw new Error('That calendar is no longer available')
  if (calendar.provider !== 'gmail') throw new Error('Event editing is currently available for Google Calendar accounts')
  const saved = await googleCalendarConnector(calendar.accountId).updateEvent(calendar, current, input)
  store.upsertEvent(saved)
  diagnostic({ level: 'info', component: 'provider', event: 'calendar-event-updated', accountId: calendar.accountId, details: { provider: calendar.provider, calendarId: calendar.id } })
  return store.snapshot()
}

async function deleteProductivityEvent(eventId: string) {
  const store = requireProductivityStore()
  const snapshot = store.snapshot()
  const current = snapshot.events.find((item) => item.id === eventId)
  if (!current) throw new Error('That event is no longer available')
  if (current.readOnly) throw new Error('This event cannot be deleted')
  const calendar = snapshot.calendars.find((item) => item.id === current.calendarId)
  if (!calendar) throw new Error('That calendar is no longer available')
  if (calendar.provider !== 'gmail') throw new Error('Event editing is currently available for Google Calendar accounts')
  await googleCalendarConnector(calendar.accountId).deleteEvent(calendar, current)
  store.deleteEvent(current.id)
  diagnostic({ level: 'info', component: 'provider', event: 'calendar-event-deleted', accountId: calendar.accountId, details: { provider: calendar.provider, calendarId: calendar.id } })
  return store.snapshot()
}

function isPrivateAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase()
    return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') ||
      normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb')
  }
  return true
}

function showNewMailNotification(payload: Extract<import('../src/mail-types').MailWorkerEvent, { type: 'new-mail' }>['payload']) {
  if (hideTestWindows || !Notification.isSupported() || !loadState().settings.notifications) return
  const title = payload.count === 1 ? payload.sender || 'New message' : `${payload.count.toLocaleString()} new messages`
  const notification = new Notification({ title, body: payload.count === 1 ? payload.subject || 'Open Aerio to read it' : 'Open Aerio to view your inbox', icon: iconPath() })
  notification.on('click', () => {
    openMainWindow()
    if (payload.threadId) createMessageWindow({ source: 'connected', accountId: payload.accountId, threadId: payload.threadId, title: payload.subject || 'New message' })
  })
  notification.show()
}

function updateMailPolling(immediate = false) {
  if (!mailWorker || !mainWindow) return
  const intervalMs = mailPollingIntervalForWindow({
    visible: mainWindow.isVisible(),
    focused: mainWindow.isFocused(),
    minimized: mainWindow.isMinimized()
  })
  void mailWorker.request({ type: 'polling', payload: { intervalMs, immediate } }).catch((error) => {
    diagnostic({ level: 'error', component: 'mail-worker', event: 'polling-update-failed', message: error instanceof Error ? error.message : String(error) })
  })
}

async function initializeMail() {
  const userData = app.getPath('userData')
  oauthVault = new OAuthVault(join(userData, 'oauth-vault.dat'), builtInOAuthClients)
  mailWorker = new MailWorkerClient(
    join(import.meta.dirname, 'mail-worker.js'),
    (accountId) => requireVault().credential(accountId, accountProviders.get(accountId) ?? 'gmail'),
    (event) => {
      diagnostic({
        level: event.type === 'sync-progress' && event.payload.phase === 'error' ? 'error' : 'info',
        component: 'mail-worker',
        event: event.type,
        accountId: 'accountId' in event.payload ? event.payload.accountId : undefined,
        details: event.payload as unknown as Record<string, unknown>
      })
      if (event.type === 'new-mail') showNewMailNotification(event.payload)
      mainWindow?.webContents.send('mail:event', event)
      for (const window of messageWindows.values()) if (!window.isDestroyed()) window.webContents.send('mail:event', event)
    }
  )
  await mailWorker.request({
    type: 'initialize',
    payload: {
      databasePath: join(userData, 'aerio.sqlite'),
      contentPath: join(userData, 'mail')
    }
  })
  const accounts = await mailWorker.request<MailAccountSummary[]>({ type: 'accounts:list' })
  for (const account of accounts) {
    accountProviders.set(account.id, account.provider)
    if (account.status !== 'needs-auth' || account.archived || !account.syncEnabled) continue
    void (async () => {
      try {
        await requireMailWorker().request({ type: 'accounts:verify', payload: { accountId: account.id } })
        await requireMailWorker().request({ type: 'sync:start', payload: { accountId: account.id } })
        diagnostic({ level: 'info', component: 'mail-worker', event: 'authentication-recovered', accountId: account.id })
      } catch (error) {
        diagnostic({
          level: 'error',
          component: 'mail-worker',
          event: 'authentication-recovery-failed',
          accountId: account.id,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    })()
  }
}

const accountColors = ['#1d7a62', '#3b6fd8', '#8a5dc7', '#c2673d', '#b04d73', '#5d7589']
function accountColor(accountId: string) {
  return accountColors[Number.parseInt(accountId.slice(0, 2), 16) % accountColors.length]
}

function cacheSenderFavicon(domain: string, image: Buffer | null) {
  if (senderFaviconCache.size >= 512) senderFaviconCache.delete(senderFaviconCache.keys().next().value as string)
  senderFaviconCache.set(domain, {
    image,
    expiresAt: Date.now() + (image ? 7 * 24 * 60 * 60_000 : 10 * 60_000)
  })
  return image
}

async function loadSenderFaviconCandidate(domain: string) {
  const cached = senderFaviconCache.get(domain)
  if (cached && cached.expiresAt > Date.now()) return cached.image
  senderFaviconCache.delete(domain)
  const existing = senderFaviconCandidateRequests.get(domain)
  if (existing) return existing
  const request = (async () => {
    try {
      const target = new URL('https://www.google.com/s2/favicons')
      target.searchParams.set('domain_url', `https://${domain}`)
      target.searchParams.set('sz', '64')
      const response = await net.fetch(target.toString(), {
        credentials: 'omit',
        headers: { 'User-Agent': 'Aerio sender icon resolver', Accept: 'image/png,image/x-icon,image/*' }
      })
      const declaredSize = Number(response.headers.get('content-length') ?? 0)
      if (!response.ok || declaredSize > 512 * 1024) return cacheSenderFavicon(domain, null)
      const encoded = Buffer.from(await response.arrayBuffer())
      if (!encoded.length || encoded.length > 512 * 1024) return cacheSenderFavicon(domain, null)
      const image = nativeImage.createFromBuffer(encoded)
      if (image.isEmpty()) return cacheSenderFavicon(domain, null)
      const normalized = image.resize({ width: 64, height: 64, quality: 'best' }).toPNG()
      return cacheSenderFavicon(domain, normalized.length ? normalized : null)
    } catch {
      return cacheSenderFavicon(domain, null)
    }
  })()
  senderFaviconCandidateRequests.set(domain, request)
  try {
    return await request
  } finally {
    senderFaviconCandidateRequests.delete(domain)
  }
}

async function loadSenderFavicon(domain: string) {
  const cached = senderFaviconCache.get(domain)
  if (cached?.image && cached.expiresAt > Date.now()) return cached.image
  const existing = senderFaviconResolutionRequests.get(domain)
  if (existing) return existing
  const request = (async () => {
    for (const candidate of faviconDomainCandidates(domain)) {
      const image = await loadSenderFaviconCandidate(candidate)
      if (image) return cacheSenderFavicon(domain, image)
    }
    return cacheSenderFavicon(domain, null)
  })()
  senderFaviconResolutionRequests.set(domain, request)
  try {
    return await request
  } finally {
    senderFaviconResolutionRequests.delete(domain)
  }
}

function registerRemoteImageProtocol() {
  protocol.handle('aerio-image', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname === 'favicon') {
        const requestedDomain = decodeURIComponent(url.pathname.replace(/^\//, '')).toLowerCase()
        const domain = senderDomainFromEmail(`sender@${requestedDomain}`)
        if (!domain || domain !== requestedDomain) return new Response('Blocked', { status: 403 })
        const image = await loadSenderFavicon(domain)
        return image
          ? new Response(Uint8Array.from(image), { headers: { 'Cache-Control': 'public, max-age=604800, immutable', 'Content-Type': 'image/png' } })
          : new Response('No sender icon', { status: 404 })
      }
      if (url.hostname !== 'fetch') return new Response('Not found', { status: 404 })
      const encoded = url.pathname.replace(/^\//, '')
      const remote = Buffer.from(encoded, 'base64url').toString('utf8')
      const target = new URL(remote)
      if (target.protocol !== 'https:' && target.protocol !== 'http:') return new Response('Blocked', { status: 403 })
      if (target.hostname === 'localhost' || target.hostname.endsWith('.localhost') || target.hostname.endsWith('.local')) {
        return new Response('Blocked', { status: 403 })
      }
      const addresses = await lookup(target.hostname, { all: true })
      if (!addresses.length || addresses.some((address) => isPrivateAddress(address.address))) {
        return new Response('Blocked', { status: 403 })
      }
      return await net.fetch(target.toString(), {
        headers: {
          'User-Agent': 'Aerio mail image proxy',
          Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*'
        }
      })
    } catch {
      return new Response('Invalid image URL', { status: 400 })
    }
  })
}

function loadState(): AppState {
  if (!database) throw new Error('Aerio database is not ready')
  const result = database.prepare('SELECT payload FROM app_state WHERE id = 1').get() as { payload?: unknown } | undefined
  if (!result) return createDemoState()
  const parsed: unknown = JSON.parse(String(result.payload))
  if (!validState(parsed)) throw new Error('Stored Aerio data is invalid')
  return parsed
}

function saveState(state: AppState) {
  if (!database) throw new Error('Aerio database is not ready')
  if (!validState(state)) throw new Error('Refusing to save invalid Aerio data')
  const updatedAt = new Date().toISOString()
  database.prepare(
    `INSERT INTO app_state (id, schema_version, payload, updated_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       schema_version = excluded.schema_version,
       payload = excluded.payload,
        updated_at = excluded.updated_at`
  ).run(state.schemaVersion, JSON.stringify(state), updatedAt)
  return { savedAt: updatedAt }
}

function boundsPath() {
  return join(app.getPath('userData'), 'window-bounds.json')
}

function loadBounds() {
  try {
    const value = JSON.parse(readFileSync(boundsPath(), 'utf8')) as Electron.Rectangle
    if (value.width >= 980 && value.height >= 640) return value
  } catch {
    // Use the balanced default below.
  }
  return { width: 1480, height: 900 }
}

function saveBounds() {
  if (!mainWindow || mainWindow.isMaximized() || mainWindow.isMinimized()) return
  clearTimeout(lastBoundsWrite)
  lastBoundsWrite = setTimeout(() => {
    if (mainWindow) writeFileSync(boundsPath(), JSON.stringify(mainWindow.getBounds()))
  }, 250)
}

function iconPath() {
  const candidate = app.isPackaged
    ? join(process.resourcesPath, 'build', 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')
  return existsSync(candidate) ? candidate : undefined
}

function configureRendererWindow(window: BrowserWindow) {
  window.on('maximize', () => window.webContents.send('window:maximized-state', true))
  window.on('unmaximize', () => window.webContents.send('window:maximized-state', false))
  window.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (url === 'about:blank' && frameName.startsWith('aerio-modal-')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          minWidth: 420,
          minHeight: 420,
          frame: true,
          autoHideMenuBar: true,
          title: 'Aerio',
          backgroundColor: '#f4f5f7',
          show: !hideTestWindows,
          icon: iconPath(),
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false
          }
        }
      }
    }
    if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('did-create-window', (child, details) => {
    if (details.frameName.startsWith('aerio-modal-')) configureRendererWindow(child)
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url === window.webContents.getURL()) return
    event.preventDefault()
    if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url)
  })
}

function loadRenderer(window: BrowserWindow, query?: Record<string, string>) {
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value)
    void window.loadURL(url.toString())
  } else {
    void window.loadFile(join(import.meta.dirname, '../../dist/index.html'), query ? { query } : undefined)
  }
}

function validMessageWindowRequest(value: unknown): value is MessageWindowRequest {
  if (!value || typeof value !== 'object') return false
  const input = value as Partial<MessageWindowRequest> & { accountId?: unknown; threadId?: unknown; messageId?: unknown }
  const validText = (text: unknown) => typeof text === 'string' && text.length > 0 && text.length <= 1_000
  if (!validText(input.title)) return false
  if (input.source === 'demo') return validText(input.messageId)
  return input.source === 'connected' && validText(input.accountId) && validText(input.threadId) && (input.messageId === undefined || validText(input.messageId))
}

function createMessageWindow(input: MessageWindowRequest) {
  const key = input.source === 'demo' ? `demo:${input.messageId}` : `mail:${input.accountId}:${input.threadId}:${input.messageId ?? 'thread'}`
  const existing = messageWindows.get(key)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    if (!hideTestWindows) {
      existing.show()
      existing.focus()
    }
    return
  }

  const messageWindow = new BrowserWindow({
    width: 900,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    show: false,
    frame: false,
    title: input.title.slice(0, 180),
    backgroundColor: '#f4f5f7',
    icon: iconPath(),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  messageWindows.set(key, messageWindow)
  configureRendererWindow(messageWindow)
  messageWindow.once('ready-to-show', () => { if (!hideTestWindows) messageWindow.show() })
  messageWindow.once('closed', () => messageWindows.delete(key))
  loadRenderer(messageWindow, input.source === 'demo'
    ? { view: 'message', source: 'demo', messageId: input.messageId }
    : { view: 'message', source: 'connected', accountId: input.accountId, threadId: input.threadId, ...(input.messageId ? { messageId: input.messageId } : {}) })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    ...loadBounds(),
    minWidth: 1020,
    minHeight: 660,
    show: false,
    frame: false,
    title: 'Aerio',
    backgroundColor: '#f4f5f7',
    icon: iconPath(),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (!hideTestWindows) mainWindow?.show()
    const capturePath = process.env.AERIO_CAPTURE_PATH
    if (capturePath) {
      setTimeout(() => {
        void mainWindow?.webContents.capturePage().then((image) => {
          writeFileSync(capturePath, image.toPNG())
          quitting = true
          app.quit()
        })
      }, 1_500)
    }
  })
  mainWindow.on('resize', saveBounds)
  mainWindow.on('move', saveBounds)
  mainWindow.on('show', () => updateMailPolling(true))
  mainWindow.on('focus', () => updateMailPolling(true))
  mainWindow.on('restore', () => updateMailPolling(true))
  mainWindow.on('hide', () => updateMailPolling())
  mainWindow.on('blur', () => updateMailPolling())
  mainWindow.on('minimize', () => updateMailPolling())
  mainWindow.on('close', (event) => {
    const closeToTray = loadState().settings.closeToTray
    if (!quitting && closeToTray) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })
  configureRendererWindow(mainWindow)
  loadRenderer(mainWindow, process.env.AERIO_CAPTURE_PATH ? { workspace: 'connected' } : undefined)
  return mainWindow
}

function openMainWindow(compose = false) {
  if (!mainWindow) {
    const window = createWindow()
    if (compose) window.webContents.once('did-finish-load', () => window.webContents.send('command:compose'))
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
    if (!hideTestWindows) {
      mainWindow.show()
      mainWindow.focus()
    }
  if (compose) mainWindow.webContents.send('command:compose')
}

function createTray() {
  const path = iconPath()
  const image = path ? nativeImage.createFromPath(path).resize({ width: 20, height: 20 }) : nativeImage.createEmpty()
  tray = new Tray(image)
  tray.setToolTip('Aerio')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Aerio', click: () => openMainWindow() },
    { type: 'separator' },
    { label: 'Compose message', click: () => openMainWindow(true) },
    { type: 'separator' },
    { label: 'Quit Aerio', click: () => { quitting = true; app.quit() } }
  ]))
  tray.on('double-click', () => openMainWindow())
}

function registerIpc() {
  ipcMain.handle('state:load', () => loadState())
  ipcMain.handle('state:save', (_event, state: AppState) => saveState(state))
  ipcMain.handle('state:reset', () => {
    const state = createDemoState()
    saveState(state)
    return state
  })
  ipcMain.handle('files:choose', async (): Promise<Attachment[]> => {
    const options: Electron.OpenDialogOptions = { properties: ['openFile', 'multiSelections'] }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled) return []
    return result.filePaths.map((path) => {
      approvedAttachmentPaths.add(path)
      return {
        id: crypto.randomUUID(),
        name: basename(path),
        size: statSync(path).size,
        path,
        mime: extname(path).slice(1)
      }
    })
  })
  ipcMain.handle('profile:image:choose', async (event): Promise<string | undefined> => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a profile picture',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      properties: ['openFile']
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    const path = result.filePaths[0]
    if (result.canceled || !path) return
    const image = nativeImage.createFromPath(path)
    if (image.isEmpty()) throw new Error('That image could not be opened')
    const size = image.getSize()
    const scale = Math.min(1, 256 / Math.max(size.width, size.height))
    return image.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: 'best'
    }).toDataURL()
  })
  ipcMain.handle('notification:show', (_event, input: { title: string; body: string }) => {
    if (!hideTestWindows && Notification.isSupported()) new Notification({ title: input.title.slice(0, 80), body: input.body.slice(0, 240), icon: iconPath() }).show()
  })
  ipcMain.handle('productivity:snapshot', () => requireProductivityStore().snapshot())
  ipcMain.handle('productivity:local-snapshot', () => requireProductivityStore().localSnapshot())
  ipcMain.handle('productivity:local-save', (_event, snapshot: unknown) => {
    if (!validLocalModules(snapshot)) throw new Error('Local Tasks or Notes data is invalid')
    requireProductivityStore().saveLocal(snapshot)
  })
  ipcMain.handle('productivity:sync', (_event, accountId: string) => {
    if (typeof accountId !== 'string' || !accountId || accountId.length > 200) throw new Error('Choose a valid account to synchronize')
    return syncProductivity(accountId)
  })
  ipcMain.handle('productivity:event-create', (_event, input: unknown) => {
    if (!validCalendarEvent(input)) throw new Error('Enter valid event details')
    return createProductivityEvent(input)
  })
  ipcMain.handle('productivity:event-update', (_event, input: unknown) => {
    if (!validCalendarEvent(input)) throw new Error('Enter valid event details')
    return updateProductivityEvent(input)
  })
  ipcMain.handle('productivity:event-delete', (_event, eventId: unknown) => {
    if (typeof eventId !== 'string' || !eventId || eventId.length > 500) throw new Error('Choose a valid event')
    return deleteProductivityEvent(eventId)
  })
  ipcMain.handle('app:update:status', () => updates?.status() ?? ({
    phase: 'unsupported',
    currentVersion: app.getVersion(),
    message: 'The update service has not started.'
  }))
  ipcMain.handle('app:update:check', () => updates?.check() ?? Promise.reject(new Error('The update service has not started')))
  ipcMain.handle('app:update:download', () => updates?.download() ?? Promise.reject(new Error('The update service has not started')))
  ipcMain.handle('app:update:install', () => {
    if (!updates) throw new Error('The update service has not started')
    updates.install()
  })
  ipcMain.handle('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
  ipcMain.handle('window:maximize', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window?.isMaximized()) window.unmaximize()
    else window?.maximize()
  })
  ipcMain.handle('window:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close())
  ipcMain.handle('window:is-maximized', (event) => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false)
  ipcMain.handle('window:open-message', (_event, input: unknown) => {
    if (!validMessageWindowRequest(input)) throw new Error('Invalid message window request')
    createMessageWindow(input)
  })

  ipcMain.handle('gmail:credentials:status', () => requireVault().status())
  ipcMain.handle('mail:credentials:microsoft-status', () => requireVault().microsoftStatus())
  ipcMain.handle('mail:credentials:microsoft-configure', (_event, clientId: string) => requireVault().configureMicrosoft(clientId))
  ipcMain.handle('mail:providers:presets', () => PROVIDER_PRESETS)
  ipcMain.handle('gmail:credentials:import', async () => {
    const options: Electron.OpenDialogOptions = {
      title: 'Import Google Desktop OAuth credentials',
      filters: [{ name: 'Google OAuth JSON', extensions: ['json'] }],
      properties: ['openFile']
    }
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return requireVault().status()
    return requireVault().importConfig(result.filePaths[0])
  })
  ipcMain.handle('mail:accounts:list', () => requireMailWorker().request<MailAccountSummary[]>({ type: 'accounts:list' }))
  ipcMain.handle('mail:accounts:update', (_event, input: MailAccountSettingsInput) => {
    if (!input || typeof input.accountId !== 'string' || typeof input.displayName !== 'string' || !input.displayName.trim() || input.displayName.length > 200) throw new Error('Enter a valid sender name')
    if (!/^#[0-9a-f]{6}$/i.test(input.color)) throw new Error('Choose a valid account colour')
    if (typeof input.signature !== 'string' || input.signature.length > 20_000) throw new Error('The signature is too long')
    return requireMailWorker().request<MailAccountSummary>({ type: 'accounts:update', payload: { ...input, displayName: input.displayName.trim() } })
  })
  ipcMain.handle('mail:accounts:verify', (_event, accountId: string) => {
    if (typeof accountId !== 'string' || !accountId) throw new Error('Invalid account id')
    return requireMailWorker().request({ type: 'accounts:verify', payload: { accountId } })
  })
  ipcMain.handle('mail:accounts:reconnect', async (_event, accountId: string) => {
    const account = (await requireMailWorker().request<MailAccountSummary[]>({ type: 'accounts:list' })).find((item) => item.id === accountId)
    if (!account) throw new Error('Account not found')
    if (account.provider !== 'gmail' && account.provider !== 'microsoft') throw new Error('Update the app password or server credentials by reconnecting this IMAP account')
    if (account.provider === 'gmail') await requireVault().authorize({ accountId: account.id, email: account.email })
    else await requireVault().authorizeMicrosoft({ accountId: account.id, email: account.email })
    await requireMailWorker().request({ type: 'accounts:verify', payload: { accountId } })
    await requireMailWorker().request({ type: 'sync:start', payload: { accountId } })
  })
  ipcMain.handle('mail:accounts:imap-settings', (_event, accountId: string): ImapServerSettings => {
    if (accountProviders.get(accountId) === 'gmail' || accountProviders.get(accountId) === 'microsoft') throw new Error('This OAuth account does not use IMAP server settings')
    return requireVault().imapSettings(accountId)
  })
  ipcMain.handle('mail:accounts:imap-update', async (_event, accountId: string, input: ImapServerSettingsUpdate): Promise<ImapServerSettings> => {
    if (!input || typeof input !== 'object') throw new Error('Enter valid IMAP and SMTP server settings')
    const current = requireVault().imapCredential(accountId)
    if (input.password !== undefined && typeof input.password !== 'string') throw new Error('Enter a valid password')
    const candidate = validateImapAccount({ ...current, ...input, password: input.password?.trim() || current.password })
    await new ImapSmtpClient(candidate).verify()
    requireVault().storeImap(accountId, candidate)
    await requireMailWorker().request({ type: 'accounts:verify', payload: { accountId } })
    await requireMailWorker().request({ type: 'sync:start', payload: { accountId } })
    return requireVault().imapSettings(accountId)
  })
  ipcMain.handle('mail:accounts:connect', async () => {
    const authorized = await requireVault().authorize()
    const account: MailAccountSummary = {
      id: authorized.accountId,
      provider: 'gmail',
      email: authorized.email,
      displayName: authorized.email.split('@')[0],
      color: accountColor(authorized.accountId),
      status: 'connecting',
      archived: false,
      signature: '',
      notifications: true,
      syncEnabled: true
    }
    accountProviders.set(account.id, account.provider)
    try {
      await requireMailWorker().request({ type: 'accounts:upsert', payload: account })
      await requireMailWorker().request({ type: 'sync:start', payload: { accountId: account.id } })
      return account
    } catch (error) {
      accountProviders.delete(account.id)
      await requireVault().remove(account.id)
      throw error
    }
  })
  ipcMain.handle('mail:accounts:connect-microsoft', async () => {
    const authorized = await requireVault().authorizeMicrosoft()
    const account: MailAccountSummary = {
      id: authorized.accountId,
      provider: 'microsoft',
      email: authorized.email,
      displayName: authorized.displayName,
      color: accountColor(authorized.accountId),
      status: 'connecting',
      archived: false,
      signature: '',
      notifications: true,
      syncEnabled: true
    }
    accountProviders.set(account.id, account.provider)
    try {
      await requireMailWorker().request({ type: 'accounts:upsert', payload: account })
      await requireMailWorker().request({ type: 'accounts:verify', payload: { accountId: account.id } })
      await requireMailWorker().request({ type: 'sync:start', payload: { accountId: account.id } })
      return account
    } catch (error) {
      accountProviders.delete(account.id)
      await requireVault().remove(account.id)
      await requireMailWorker().request({ type: 'accounts:disconnect', payload: { accountId: account.id, mode: 'delete' } })
      throw error
    }
  })
  ipcMain.handle('mail:accounts:connect-imap', async (_event, rawInput: ImapAccountInput) => {
    const input = validateImapAccount(rawInput)
    await new ImapSmtpClient(input).verify()
    const accountId = createHash('sha256').update(`${input.provider}:${input.email}:${input.username}:${input.imapHost}`).digest('hex').slice(0, 24)
    const account: MailAccountSummary = {
      id: accountId,
      provider: input.provider,
      email: input.email,
      displayName: input.displayName?.trim() || input.email.split('@')[0],
      color: accountColor(accountId),
      status: 'connecting',
      archived: false,
      signature: '',
      notifications: true,
      syncEnabled: true
    }
    requireVault().storeImap(accountId, input)
    accountProviders.set(account.id, account.provider)
    try {
      await requireMailWorker().request({ type: 'accounts:upsert', payload: account })
      await requireMailWorker().request({ type: 'sync:start', payload: { accountId } })
      return account
    } catch (error) {
      accountProviders.delete(account.id)
      await requireVault().remove(account.id)
      await requireMailWorker().request({ type: 'accounts:disconnect', payload: { accountId, mode: 'delete' } })
      throw error
    }
  })
  ipcMain.handle('mail:accounts:disconnect', async (_event, accountId: string, mode: 'archive' | 'delete') => {
    await requireVault().remove(accountId)
    await requireMailWorker().request({ type: 'accounts:disconnect', payload: { accountId, mode } })
    requireProductivityStore().removeAccount(accountId)
    accountProviders.delete(accountId)
  })
  ipcMain.handle('mail:labels:list', (_event, accountIds?: string[]) =>
    requireMailWorker().request<MailLabel[]>({ type: 'labels:list', payload: { accountIds } }))
  ipcMain.handle('mail:recipients:suggest', (_event, query: string, accountIds?: string[]) =>
    requireMailWorker().request<MailRecipientSuggestion[]>({ type: 'recipients:suggest', payload: { query: typeof query === 'string' ? query.slice(0, 200) : '', accountIds } }))
  ipcMain.handle('mail:threads:list', (_event, query: MailQuery) =>
    requireMailWorker().request<MailPage>({ type: 'mail:list', payload: query }))
  ipcMain.handle('mail:threads:get', (_event, accountId: string, threadId: string, allowRemoteImages?: boolean) =>
    requireMailWorker().request<MailThreadDetail>({ type: 'mail:thread', payload: { accountId, threadId, allowRemoteImages } }))
  ipcMain.handle('mail:message:source', (_event, accountId: string, messageId: string) =>
    requireMailWorker().request<MailMessageSource>({ type: 'mail:source', payload: { accountId, messageId } }))
  ipcMain.handle('mail:actions:apply', (_event, input: ApplyMailActionInput) =>
    requireMailWorker().request<PendingOperation>({ type: 'mail:action', payload: input }))
  ipcMain.handle('mail:actions:undo', (_event, operationId: string) =>
    requireMailWorker().request<boolean>({ type: 'mail:undo', payload: { operationId } }))
  ipcMain.handle('mail:snooze', (_event, accountId: string, threadIds: string[], until: string) => {
    if (typeof accountId !== 'string' || !accountId || accountId.length > 200 || !Array.isArray(threadIds) || !threadIds.length || threadIds.length > 500 || threadIds.some((id) => typeof id !== 'string' || !id || id.length > 500)) throw new Error('Choose valid conversations to snooze')
    return requireMailWorker().request<MailSnooze[]>({ type: 'mail:snooze', payload: { accountId, threadIds, until: validateFutureDate(until, 'Reminder time') } })
  })
  ipcMain.handle('mail:unsnooze', (_event, accountId: string, threadIds: string[]) => {
    if (typeof accountId !== 'string' || !accountId || !Array.isArray(threadIds) || !threadIds.length || threadIds.some((id) => typeof id !== 'string' || !id)) throw new Error('Choose valid conversations to restore')
    return requireMailWorker().request<boolean>({ type: 'mail:unsnooze', payload: { accountId, threadIds } })
  })
  ipcMain.handle('mail:drafts:save', (_event, input: MailDraftInput) =>
    requireMailWorker().request({ type: 'drafts:save', payload: validateDraft(input) }))
  ipcMain.handle('mail:drafts:send', (_event, input: MailDraftInput) =>
    requireMailWorker().request({ type: 'drafts:send', payload: validateDraft(input, true) }))
  ipcMain.handle('mail:drafts:schedule', (_event, input: MailDraftInput, deliveryAt: string) =>
    requireMailWorker().request({ type: 'drafts:schedule', payload: { input: validateDraft(input, true), deliveryAt: validateFutureDate(deliveryAt, 'Scheduled send time') } }))
  ipcMain.handle('mail:drafts:cancel-send', (_event, id: string) => {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('Invalid queued message id')
    return requireMailWorker().request<MailDraftResult>({ type: 'drafts:cancel-send', payload: { id } })
  })
  ipcMain.handle('mail:drafts:list', async (_event, accountIds?: string[]) => {
    const drafts = await requireMailWorker().request<MailDraftRecord[]>({ type: 'drafts:list', payload: { accountIds } })
    for (const draft of drafts) for (const path of draft.attachmentPaths) approvedAttachmentPaths.add(path)
    return drafts
  })
  ipcMain.handle('mail:drafts:get', async (_event, id: string) => {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('Invalid draft id')
    const draft = await requireMailWorker().request<MailDraftRecord | undefined>({ type: 'drafts:get', payload: { id } })
    if (draft) for (const path of draft.attachmentPaths) approvedAttachmentPaths.add(path)
    return draft
  })
  ipcMain.handle('mail:drafts:delete', (_event, id: string) => {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('Invalid draft id')
    return requireMailWorker().request<MailDraftResult>({ type: 'drafts:delete', payload: { id } })
  })
  ipcMain.handle('mail:drafts:stage-message-attachments', async (_event, draftId: string, accountId: string, messageId: string) => {
    if (![draftId, accountId, messageId].every((value) => typeof value === 'string' && value.length > 0 && value.length <= 500)) throw new Error('Invalid attachment staging request')
    const files = await requireMailWorker().request<MailDraftAttachmentFile[]>({ type: 'drafts:stage-message-attachments', payload: { draftId, accountId, messageId } })
    for (const file of files) approvedAttachmentPaths.add(file.path)
    return files
  })
  ipcMain.handle('mail:rules:list', (_event, accountIds?: string[]) =>
    requireMailWorker().request<MailRule[]>({ type: 'rules:list', payload: { accountIds } }))
  ipcMain.handle('mail:rules:save', (_event, input: MailRuleInput) =>
    requireMailWorker().request<MailRule>({ type: 'rules:save', payload: validateRule(input) }))
  ipcMain.handle('mail:rules:delete', (_event, id: string) => {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('Invalid rule id')
    return requireMailWorker().request({ type: 'rules:delete', payload: { id } })
  })
  ipcMain.handle('mail:rules:run', (_event, id: string) => {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('Invalid rule id')
    return requireMailWorker().request<MailRuleRunResult>({ type: 'rules:run', payload: { id } })
  })
  ipcMain.handle('mail:sync:start', (_event, accountId?: string) =>
    requireMailWorker().request({ type: 'sync:start', payload: { accountId } }))
  ipcMain.handle('mail:sync:pause', (_event, accountId: string) =>
    requireMailWorker().request({ type: 'sync:pause', payload: { accountId } }))
  ipcMain.handle('mail:sync:resume', (_event, accountId: string) =>
    requireMailWorker().request({ type: 'sync:resume', payload: { accountId } }))
  ipcMain.handle('mail:sync:rebuild', (_event, accountId: string) =>
    requireMailWorker().request({ type: 'sync:rebuild', payload: { accountId } }))
  ipcMain.handle('mail:sync:progress', () =>
    requireMailWorker().request<SyncProgress[]>({ type: 'sync:progress' }))
  ipcMain.handle('mail:storage', () =>
    requireMailWorker().request<MailStorageStats>({ type: 'storage:stats' }))
  ipcMain.handle('mail:diagnostics:health', () =>
    requireMailWorker().request<MailDiagnosticHealth>({ type: 'diagnostics:health' }))
  ipcMain.handle('mail:diagnostics:export', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = owner
      ? await dialog.showSaveDialog(owner, { title: 'Export Aerio diagnostics', defaultPath: `aerio-diagnostics-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] })
      : await dialog.showSaveDialog({ title: 'Export Aerio diagnostics', defaultPath: `aerio-diagnostics-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (result.canceled || !result.filePath) return {}
    const health = await requireMailWorker().request<MailDiagnosticHealth>({ type: 'diagnostics:health' })
    diagnostics?.exportBundle(result.filePath, {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      operatingSystem: `${platform()} ${release()} ${arch()}`,
      packaged: app.isPackaged
    }, health)
    diagnostic({ level: 'info', component: 'app', event: 'diagnostics-exported' })
    return { savedPath: result.filePath }
  })
  ipcMain.handle('mail:network', (_event, online: boolean) =>
    requireMailWorker().request({ type: 'network', payload: { online } }))
  ipcMain.handle('mail:attachment:open', async (_event, accountId: string, messageId: string, attachmentId: string, filename: string) => {
    const directory = join(tmpdir(), 'aerio-attachments')
    mkdirSync(directory, { recursive: true })
    const targetPath = join(directory, `${crypto.randomUUID()}-${safeFilename(filename)}`)
    await requireMailWorker().request({ type: 'attachment:extract', payload: { accountId, messageId, attachmentId, targetPath } })
    const error = await shell.openPath(targetPath)
    return error ? { error } : {}
  })
  ipcMain.handle('mail:attachment:save', async (_event, accountId: string, messageId: string, attachmentId: string, filename: string) => {
    const options: Electron.SaveDialogOptions = { title: 'Save attachment', defaultPath: safeFilename(filename) }
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return {}
    await requireMailWorker().request({ type: 'attachment:extract', payload: { accountId, messageId, attachmentId, targetPath: result.filePath } })
    return { savedPath: result.filePath }
  })
}

if (hasSingleInstanceLock) app.on('second-instance', () => {
  if (readyToOpenWindows) openMainWindow()
})

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  diagnostics = new DiagnosticLogger(join(app.getPath('userData'), 'logs', 'aerio.jsonl'))
  diagnostic({ level: 'info', component: 'app', event: 'startup', details: { version: app.getVersion(), packaged: app.isPackaged } })
  Menu.setApplicationMenu(null)
  await initializeDatabase()
  await initializeMail()
  productivityStore = new ProductivityStore(join(app.getPath('userData'), 'productivity.sqlite'))
  registerIpc()
  registerRemoteImageProtocol()
  readyToOpenWindows = true
  createWindow()
  if (!hideTestWindows) createTray()
  updates = new UpdateManager(
    (status) => BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('app:update:status-changed', status)),
    (event, message, details) => diagnostic({
      level: event.endsWith('error') ? 'error' : 'info',
      component: 'app',
      event,
      message,
      details
    })
  )
  updates.start()

  app.on('activate', () => {
    if (!mainWindow) createWindow()
    else if (!hideTestWindows) mainWindow.show()
  })
})

app.on('before-quit', () => {
  quitting = true
  updates?.stop()
  productivityStore?.close()
  diagnostic({ level: 'info', component: 'app', event: 'shutdown' })
  void mailWorker?.close()
})

app.on('will-quit', () => {
  database?.close()
  database = null
})

process.on('unhandledRejection', (error) => diagnostic({ level: 'error', component: 'app', event: 'unhandled-rejection', message: error instanceof Error ? error.message : String(error) }))
process.on('uncaughtExceptionMonitor', (error) => diagnostic({ level: 'error', component: 'app', event: 'uncaught-exception', message: error.message, details: { stack: error.stack } }))

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !loadState().settings.closeToTray) app.quit()
})
