import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, Notification, protocol, safeStorage, shell, Tray } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { arch, homedir, platform, release, tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createDefaultPreferences, defaultSettings } from '../src/preferences'
import { setLinuxLoginItem } from './linux-login'
import { linuxTrayHostAvailable } from './tray-availability'
import { applicationMenuTemplate, registerMacLoginItem } from './mac-integration'
import type { AppPreferences, Attachment, CalendarEvent, Contact, MessageWindowRequest, ModuleId, RecurrenceEditScope, Settings } from '../src/types'
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
  MailSavedSearch,
  MailSavedSearchInput,
  MailQuickAction,
  MailQuickActionRunResult,
  MailSnooze,
  MailReplyWatch,
  MailReplyWatchInput,
  MailMessageSource,
  MailReceiptInfo,
  MailThreadDetail,
  ImapAccountInput,
  ImapServerSettings,
  ImapServerSettingsUpdate,
  MailPage,
  MailAttachmentPage,
  MailFolderUnreadCounts,
  MailAccountUnreadCounts,
  MailAccountSettingsInput,
  MailDiagnosticHealth,
  MailQuery,
  MailRecipientSuggestion,
  MailStorageStats,
  PendingOperation,
  SyncProgress
} from '../src/mail-types'
import type { CreateMailFolderInput, DeleteMailFolderInput, MailFolderDeletePreview, MailFolderMutationResult, UpdateMailFolderInput } from '../src/mail-types'
import { OAuthVault } from './mail/oauth-vault'
import { normalizeReadReceiptPolicy, normalizeSendOptions } from '../src/lib/mail-send-options'
import { DEFAULT_GOOGLE_CLIENT_ID, DEFAULT_MICROSOFT_CLIENT_ID, parseOAuthEnvironment } from './mail/oauth-config'
import { ImapSmtpClient } from './mail/imap-client'
import { PROVIDER_PRESETS, validateImapAccount } from './mail/provider-presets'
import { MailWorkerClient } from './mail/worker-client'
import { validateCreateFolder, validateDeleteFolder, validateFolderReference, validateUpdateFolder } from './mail/folder-validation'
import { registerMailRuleHandlers } from './mail/server-rule-ipc'
import { normalizeAttachmentQuery } from './mail/attachment-index'
import { DiagnosticLogger, type DiagnosticRecord } from './diagnostics'
import { UpdateManager } from './update-manager'
import { ProductivityStore } from './productivity/store'
import { TaskStore } from './productivity/task-store'
import { TaskService } from './productivity/task-service'
import { GoogleTasksConnector } from './productivity/google-tasks-connector'
import { MicrosoftTasksConnector } from './productivity/microsoft-tasks-connector'
import type { ProviderTaskInput, TaskFieldPatch, TaskLocalMetadata, TaskResolution } from '../src/task-provider-types'
import { parseTaskBackup } from './productivity/task-backup'
import { MessageLocalStore } from './mail/message-local-store'
import { registerMessageTools } from './mail/message-tools'
import { AiAssistantStore, registerAiAssistant } from './mail/ai-assistant'
import { MailTemplateStore, parseMailTemplateBackup, type MailTemplateBackup } from './mail/template-store'
import { registerMailTemplates } from './mail/template-tools'
import { registerMailIdentities, validateDraftSender } from './mail/identity-ipc'
import { AutomaticRepliesService, registerAutomaticReplies } from './mail/automatic-replies'
import { CloudAttachmentService, CloudAttachmentStateStore, registerCloudAttachments } from './mail/cloud-attachments'
import { assertSecureCredentialStorage } from './mail/secure-storage'
import { GoogleProductivityConnector } from './productivity/google-connector'
import { MicrosoftProductivityConnector } from './productivity/microsoft-connector'
import { InterchangeStore } from './productivity/interchange-store'
import { registerCalendarContactInterchange } from './productivity/interchange-ipc'
import { carryPendingConferences } from './productivity/online-meetings'
import { validEventConference } from '../src/lib/online-meetings'
import { validContactInterchangeFields, validContactLists, validEventInterchangeFields } from '../src/lib/interchange-validation'
import { contactEditConflict } from '../src/lib/contact-fields'
import type { LocalModuleSnapshot, ProductivitySnapshot } from '../src/productivity-types'
import { senderDomainFromEmail } from '../src/lib/sender-avatar'
import { isCompleteMailAddress } from '../src/lib/mail-address'
import { validateMailSavedSearch } from '../src/lib/mail-saved-search'
import { validateMailQuickAction, validateMailQuickActionTargets } from '../src/lib/mail-quick-actions'
import { inlineImageBytes } from '../src/lib/mail-rich-text'
import { mailPollingIntervalForWindow } from './mail/polling-policy'
import { faviconDomainCandidates } from './mail/favicon-domains'
import { fetchRemoteImage } from './mail/remote-image-fetch'
import { applyPendingProfileRestore, finalizeProfileRestore } from './profile-backup'
import { PROFILE_BACKUP_LAYOUT } from './profile-backup-layout'
import { registerProfileBackup } from './profile-backup-tools'

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
let initialWindow = true
const messageWindows = new Map<string, BrowserWindow>()
let tray: Tray | null = null
let trayMonitor: NodeJS.Timeout | undefined
let closeGeneration = 0
let database: DatabaseSync | null = null
let applicationLocked = false
let failedUnlockAttempts = 0
let unlockBlockedUntil = 0
let oauthVault: OAuthVault | null = null
let mailWorker: MailWorkerClient | null = null
const accountProviders = new Map<string, MailAccountSummary['provider']>()
const approvedAttachmentPaths = new Set<string>()
let quitting = false
let lastBoundsWrite: NodeJS.Timeout | undefined
let diagnostics: DiagnosticLogger | null = null
let updates: UpdateManager | null = null
let productivityStore: ProductivityStore | null = null
let interchangeStore: InterchangeStore | null = null
let interchangeService: ReturnType<typeof registerCalendarContactInterchange> | null = null
let taskService: TaskService | null = null
let taskPolling: NodeJS.Timeout | undefined
let taskNetworkOnline = true
let messageLocalStore: MessageLocalStore | null = null
let mailTemplateStore: MailTemplateStore | null = null
let profileBackups: ReturnType<typeof registerProfileBackup> | null = null
let readyToOpenWindows = false
const senderFaviconCache = new Map<string, { image: Buffer | null; expiresAt: number }>()
const senderFaviconCandidateRequests = new Map<string, Promise<Buffer | null>>()
const senderFaviconResolutionRequests = new Map<string, Promise<Buffer | null>>()

function diagnostic(record: Omit<DiagnosticRecord, 'timestamp'>) {
  diagnostics?.log(record)
}

const themeValues = new Set<Settings['theme']>(['system', 'light', 'dark'])
const densityValues = new Set<Settings['density']>(['comfortable', 'compact'])
const moduleValues = new Set<ModuleId>(['mail', 'calendar', 'contacts', 'tasks', 'notes', 'chat'])

function preferencesFromUnknown(value: unknown): AppPreferences | undefined {
  if (!value || typeof value !== 'object') return
  const settings = (value as { settings?: unknown }).settings
  if (!settings || typeof settings !== 'object') return
  const candidate = settings as Partial<Settings>
  if (!themeValues.has(candidate.theme as Settings['theme']) ||
      !densityValues.has(candidate.density as Settings['density']) ||
      typeof candidate.closeToTray !== 'boolean' ||
      typeof candidate.notifications !== 'boolean' ||
      !moduleValues.has(candidate.startModule as ModuleId)) return
  const profile = candidate.profile
  if (profile !== undefined && (!profile || typeof profile !== 'object' || typeof profile.displayName !== 'string')) return
  const isUntouchedSampleProfile = profile?.displayName === 'Alex Avery' && profile.email === 'alex@aerio.app' && !profile.avatarDataUrl
  return {
    schemaVersion: 1,
    settings: {
      ...defaultSettings,
      theme: candidate.theme as Settings['theme'],
      density: candidate.density as Settings['density'],
      closeToTray: candidate.closeToTray,
      launchAtLogin: typeof candidate.launchAtLogin === 'boolean' ? candidate.launchAtLogin : defaultSettings.launchAtLogin,
      notifications: candidate.notifications,
      startModule: candidate.startModule as ModuleId,
      readReceiptPolicy: normalizeReadReceiptPolicy(candidate.readReceiptPolicy),
      ...(profile && !isUntouchedSampleProfile ? { profile: {
        displayName: profile.displayName,
        ...(typeof profile.email === 'string' ? { email: profile.email } : {}),
        ...(typeof profile.avatarDataUrl === 'string' ? { avatarDataUrl: profile.avatarDataUrl } : {})
      } } : {})
    }
  }
}

function readLegacyPreferences(userData: string) {
  const legacyPath = join(userData, 'aerio-demo.sqlite')
  if (!existsSync(legacyPath)) return
  let legacy: DatabaseSync | undefined
  try {
    legacy = new DatabaseSync(legacyPath, { readOnly: true })
    const result = legacy.prepare('SELECT payload FROM app_state WHERE id = 1').get() as { payload?: unknown } | undefined
    return result?.payload === undefined ? undefined : preferencesFromUnknown(JSON.parse(String(result.payload)))
  } catch {
    return undefined
  } finally {
    legacy?.close()
  }
}

async function initializePreferencesDatabase() {
  const userData = app.getPath('userData')
  const databasePath = join(userData, 'aerio-state.sqlite')
  database = new DatabaseSync(databasePath)
  database.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS app_preferences (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      salt TEXT NOT NULL,
      verifier TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  const result = database.prepare('SELECT payload FROM app_preferences WHERE id = 1').get()
  if (!result) savePreferences(readLegacyPreferences(userData) ?? createDefaultPreferences())
  applicationLocked = Boolean(loadAppLockRecord())
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
  if (input.expectedUpdatedAt !== undefined && (typeof input.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(input.expectedUpdatedAt)))) throw new Error('The draft revision is invalid')
  if (input.expectedRemoteRevision !== undefined && (typeof input.expectedRemoteRevision !== 'string' || !input.expectedRemoteRevision || input.expectedRemoteRevision.length > 1_000)) throw new Error('The provider draft revision is invalid')
  const addresses = [...input.to, ...input.cc, ...input.bcc]
  if (addresses.length > 500) throw new Error('A message cannot contain more than 500 recipients')
  if (forSend && !addresses.length) throw new Error('Add at least one recipient')
  if (addresses.some((address) => typeof address !== 'string' || address.length > 500)) throw new Error('A recipient entry is too long')
  if (forSend && addresses.some((address) => !isCompleteMailAddress(address))) throw new Error('Finish or correct the recipient email addresses')
  if (typeof input.subject !== 'string' || input.subject.length > 998) throw new Error('The subject is too long')
  if (typeof input.text !== 'string' || (input.html !== undefined && typeof input.html !== 'string') || input.text.length > 20_000_000 || (input.html?.length ?? 0) > 20_000_000) throw new Error('The message body is too large')
  if (input.attachmentPaths.length > 50) throw new Error('A message cannot contain more than 50 attachments')
  validateDraftSender(input, forSend)
  input.sendOptions = normalizeSendOptions(input.sendOptions)
  if (input.attachmentPaths.some((path) => typeof path !== 'string' || !approvedAttachmentPaths.has(path))) {
    throw new Error('A draft referenced a file that was not selected through Aerio')
  }
  // Embedded images become MIME parts too, so they share the attachment budget.
  let attachmentBytes = inlineImageBytes(input.html)
  for (const path of input.attachmentPaths) {
    try {
      const details = statSync(path)
      if (!details.isFile()) throw new Error('not a file')
      attachmentBytes += details.size
    } catch {
      throw new Error(`An attachment is no longer available: ${basename(path)}`)
    }
  }
  if (attachmentBytes > 20 * 1024 * 1024) throw new Error('Attachments and inline images exceed Aerio’s 20 MB sending limit')
  return input
}

function validateFutureDate(value: unknown, label: string) {
  if (typeof value !== 'string' || !value || value.length > 100) throw new Error(`Choose a valid ${label.toLowerCase()}`)
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) throw new Error(`${label} must be in the future`)
  if (timestamp > Date.now() + 366 * 24 * 60 * 60 * 1_000) throw new Error(`${label} cannot be more than one year away`)
  return new Date(timestamp).toISOString()
}

function requireProductivityStore() {
  if (!productivityStore) throw new Error('Calendar and contacts storage is not ready')
  return productivityStore
}

const NOTE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024
const NOTE_BACKUP_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024

function noteAttachmentsDirectory() {
  return join(app.getPath('userData'), 'note-attachments')
}

function isManagedNoteAttachmentPath(path: string) {
  const root = resolve(noteAttachmentsDirectory())
  const candidate = resolve(path)
  const nested = relative(root, candidate)
  return Boolean(nested) && !nested.startsWith('..') && !isAbsolute(nested)
}

function referencedNoteAttachmentPaths(snapshot: LocalModuleSnapshot) {
  return new Set(snapshot.notes.flatMap((note) => note.attachments ?? []).flatMap((attachment) => attachment.path ? [resolve(attachment.path)] : []))
}

function cleanupRemovedNoteAttachments(previous: LocalModuleSnapshot, next: LocalModuleSnapshot) {
  const retained = referencedNoteAttachmentPaths(next)
  for (const path of referencedNoteAttachmentPaths(previous)) {
    if (!retained.has(path) && isManagedNoteAttachmentPath(path) && existsSync(path)) {
      try { unlinkSync(path) } catch { /* The next cleanup pass can retry an in-use file. */ }
    }
  }
}

function validLocalModules(value: unknown): value is LocalModuleSnapshot {
  if (!value || typeof value !== 'object') return false
  const input = value as Partial<LocalModuleSnapshot>
  if (!Array.isArray(input.tasks) || !Array.isArray(input.notes) || input.tasks.length > 100_000 || input.notes.length > 100_000) return false
  if (input.contacts !== undefined && (!Array.isArray(input.contacts) || input.contacts.length > 100_000)) return false
  const uniqueIds = (records: { id: string }[]) => new Set(records.map((record) => record?.id)).size === records.length
  if (!uniqueIds(input.tasks) || !uniqueIds(input.notes) || !uniqueIds(input.contacts ?? [])) return false
  const text = (candidate: unknown, max: number, required = false) => typeof candidate === 'string' && candidate.length <= max && (!required || Boolean(candidate.trim()))
  return input.tasks.every((task) => task && text(task.id, 300, true) && text(task.listId, 300, true) && text(task.title, 10_000, true) &&
      (task.notes === undefined || text(task.notes, 1_000_000)) && (task.due === undefined || (text(task.due, 100) && Number.isFinite(Date.parse(task.due)))) &&
      ['low', 'normal', 'high'].includes(task.priority) && typeof task.completed === 'boolean' && Array.isArray(task.subtasks) && task.subtasks.length <= 10_000 &&
      uniqueIds(task.subtasks) && task.subtasks.every((subtask) => subtask && text(subtask.id, 300, true) && text(subtask.title, 10_000, true) && typeof subtask.completed === 'boolean') &&
      (task.recurrence === undefined || ['none', 'daily', 'weekly', 'monthly'].includes(task.recurrence))) &&
    input.notes.every((note) => note && text(note.id, 300, true) && text(note.folder, 300, true) && text(note.title, 10_000, true) && text(note.content, 10_000_000) &&
      Array.isArray(note.tags) && note.tags.length <= 1_000 && note.tags.every((tag) => text(tag, 300, true)) && typeof note.pinned === 'boolean' && typeof note.archived === 'boolean' &&
      text(note.updatedAt, 100) && Number.isFinite(Date.parse(note.updatedAt)) && (note.color === undefined || text(note.color, 100)) &&
      (note.attachments === undefined || (Array.isArray(note.attachments) && note.attachments.length <= 50 && uniqueIds(note.attachments) && note.attachments.every((attachment) =>
        attachment && text(attachment.id, 300, true) && text(attachment.name, 1_000, true) && Number.isSafeInteger(attachment.size) && attachment.size >= 0 && attachment.size <= NOTE_ATTACHMENT_MAX_BYTES &&
        text(attachment.path, 32_767, true) && (attachment.mime === undefined || text(attachment.mime, 300)))))) &&
    (input.contacts ?? []).every((contact) => contact && text(contact.id, 300, true) && text(contact.name, 10_000, true) && text(contact.email, 10_000) &&
      text(contact.group, 300, true) && text(contact.color, 100, true) && typeof contact.favorite === 'boolean' && contact.source === 'local' &&
      [contact.phone, contact.company, contact.title, contact.notes].every((field) => field === undefined || text(field, 1_000_000)) &&
      validContactInterchangeFields(contact)) &&
    (input.contactLists === undefined || validContactLists(input.contactLists))
}

interface ArchivedNoteAttachment {
  id: string
  name: string
  size: number
  mime?: string
  dataBase64: string
}

interface LocalDataBackup {
  format: 'aerio-local-data'
  schemaVersion: 1 | 2
  exportedAt: string
  data: LocalModuleSnapshot
  attachments?: ArchivedNoteAttachment[]
  /** Optional so older backups still restore; when present it replaces local mail templates. */
  mailTemplates?: MailTemplateBackup
}

function localDataBackupFromUnknown(value: unknown): LocalDataBackup | undefined {
  if (!value || typeof value !== 'object') return
  const backup = value as Partial<LocalDataBackup>
  if (backup.format !== 'aerio-local-data' || (backup.schemaVersion !== 1 && backup.schemaVersion !== 2) || typeof backup.exportedAt !== 'string' || !Number.isFinite(Date.parse(backup.exportedAt)) || !validLocalModules(backup.data)) return
  if (backup.schemaVersion === 1 && backup.data.notes.some((note) => (note.attachments?.length ?? 0) > 0)) return
  if (backup.mailTemplates !== undefined && !parseMailTemplateBackup(backup.mailTemplates)) return
  if (backup.schemaVersion === 2 && (!Array.isArray(backup.attachments) || backup.attachments.length > 5_000 || !backup.attachments.every((attachment) =>
    attachment && typeof attachment.id === 'string' && Boolean(attachment.id.trim()) && attachment.id.length <= 300 &&
    typeof attachment.name === 'string' && Boolean(attachment.name.trim()) && attachment.name.length <= 1_000 &&
    Number.isSafeInteger(attachment.size) && attachment.size >= 0 && attachment.size <= NOTE_ATTACHMENT_MAX_BYTES &&
    (attachment.mime === undefined || (typeof attachment.mime === 'string' && attachment.mime.length <= 300)) &&
    typeof attachment.dataBase64 === 'string' && attachment.dataBase64.length <= Math.ceil(NOTE_ATTACHMENT_MAX_BYTES / 3) * 4 + 4 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(attachment.dataBase64)))) return
  if (backup.schemaVersion === 2 && new Set(backup.attachments!.map((attachment) => attachment.id)).size !== backup.attachments!.length) return
  if (backup.schemaVersion === 2) {
    const archived = new Map(backup.attachments!.map((attachment) => [attachment.id, attachment]))
    const referenced = new Set<string>()
    for (const attachment of backup.data.notes.flatMap((note) => note.attachments ?? [])) {
      const stored = archived.get(attachment.id)
      if (!stored || stored.name !== attachment.name || stored.size !== attachment.size || stored.mime !== attachment.mime) return
      referenced.add(attachment.id)
    }
    if (referenced.size !== archived.size) return
  }
  return backup as LocalDataBackup
}

function createLocalDataBackup(snapshot: LocalModuleSnapshot): LocalDataBackup {
  const archived = new Map<string, ArchivedNoteAttachment>()
  const sources = new Map<string, string>()
  let total = 0
  for (const attachment of snapshot.notes.flatMap((note) => note.attachments ?? [])) {
    const previous = archived.get(attachment.id)
    if (previous) {
      if (previous.name !== attachment.name || previous.size !== attachment.size || previous.mime !== attachment.mime || !attachment.path || sources.get(attachment.id) !== resolve(attachment.path)) throw new Error('Notes contain conflicting attachment references; fix them before exporting')
      continue
    }
    if (!attachment.path || !isManagedNoteAttachmentPath(attachment.path) || !existsSync(attachment.path)) throw new Error(`The note attachment “${attachment.name}” is unavailable`)
    const bytes = Buffer.from(readFileSync(attachment.path))
    if (bytes.byteLength !== attachment.size || bytes.byteLength > NOTE_ATTACHMENT_MAX_BYTES) throw new Error(`The note attachment “${attachment.name}” changed or is too large`)
    total += bytes.byteLength
    if (total > NOTE_BACKUP_ATTACHMENT_MAX_BYTES) throw new Error('Note attachments exceed the 100 MB backup limit')
    archived.set(attachment.id, { id: attachment.id, name: attachment.name, size: bytes.byteLength, mime: attachment.mime, dataBase64: bytes.toString('base64') })
    sources.set(attachment.id, resolve(attachment.path))
  }
  return {
    format: 'aerio-local-data', schemaVersion: 2, exportedAt: new Date().toISOString(), data: snapshot, attachments: [...archived.values()],
    ...(mailTemplateStore ? { mailTemplates: mailTemplateStore.exportBackup() } : {})
  }
}

function materializeLocalDataBackup(backup: LocalDataBackup): { snapshot: LocalModuleSnapshot; createdPaths: string[] } {
  if (backup.schemaVersion === 1) return { snapshot: backup.data, createdPaths: [] }
  const archived = new Map((backup.attachments ?? []).map((attachment) => [attachment.id, attachment]))
  const paths = new Map<string, string>()
  const createdPaths: string[] = []
  let total = 0
  try {
    const notes = backup.data.notes.map((note) => ({
      ...note,
      attachments: note.attachments?.map((attachment) => {
        const stored = archived.get(attachment.id)
        if (!stored) throw new Error(`The backup is missing the attachment “${attachment.name}”`)
        const bytes = Buffer.from(stored.dataBase64, 'base64')
        if (bytes.byteLength !== stored.size || bytes.toString('base64') !== stored.dataBase64 || bytes.byteLength > NOTE_ATTACHMENT_MAX_BYTES) {
          throw new Error(`The backup attachment “${attachment.name}” is invalid`)
        }
        total += paths.has(attachment.id) ? 0 : bytes.byteLength
        if (total > NOTE_BACKUP_ATTACHMENT_MAX_BYTES) throw new Error('Note attachments exceed the 100 MB restore limit')
        let path = paths.get(attachment.id)
        if (!path) {
          const extension = extname(stored.name)
          path = join(noteAttachmentsDirectory(), `${crypto.randomUUID()}${extension.length <= 12 ? extension : ''}`)
          mkdirSync(noteAttachmentsDirectory(), { recursive: true })
          createdPaths.push(path)
          writeFileSync(path, bytes, { mode: 0o600 })
          paths.set(attachment.id, path)
        }
        return { id: stored.id, name: stored.name, size: stored.size, mime: stored.mime, path }
      })
    }))
    return { snapshot: { ...backup.data, notes }, createdPaths }
  } catch (error) {
    for (const path of createdPaths) {
      try { if (existsSync(path)) unlinkSync(path) } catch { /* Do not mask the restore validation error. */ }
    }
    throw error
  }
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
      requireVault().hasGoogleCalendarWriteAccess(accountId),
      requireVault().hasGoogleContactsWriteAccess(accountId)
    )
    : new MicrosoftProductivityConnector(
      accountId,
      () => requireVault().microsoftAccessToken(accountId),
      requireVault().hasMicrosoftCalendarWriteAccess(accountId),
      requireVault().hasMicrosoftContactsWriteAccess(accountId)
    )
  try {
    const previous = store.accountData(accountId)
    const data = await connector.sync(previous, store.checkpoints(accountId))
    data.events = carryPendingConferences(previous.events, data.events)
    store.replaceAccount(accountId, provider, data, data.checkpoints)
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
  if (!(event.recurrence === undefined || event.recurrence === 'none' || event.recurrence === 'daily' || event.recurrence === 'weekly' || event.recurrence === 'monthly')) return false
  return validEventInterchangeFields(event) && validEventConference(event.conference)
}

function validContact(value: unknown): value is Contact {
  if (!value || typeof value !== 'object') return false
  const contact = value as Partial<Contact>
  const validText = (input: unknown, max: number, required = false) => typeof input === 'string' && input.length <= max && (!required || Boolean(input.trim()))
  return validText(contact.id, 500, true) && validText(contact.name, 10_000, true) && validText(contact.email, 10_000) &&
    validText(contact.group, 300, true) && validText(contact.color, 100, true) && typeof contact.favorite === 'boolean' &&
    [contact.phone, contact.company, contact.title, contact.notes].every((field) => field === undefined || validText(field, 100_000)) &&
    validContactInterchangeFields(contact)
}

function googleCalendarConnector(accountId: string) {
  return new GoogleProductivityConnector(
    accountId,
    () => requireVault().accessToken(accountId),
    requireVault().hasGoogleCalendarWriteAccess(accountId)
  )
}

function microsoftCalendarConnector(accountId: string) {
  return new MicrosoftProductivityConnector(
    accountId,
    () => requireVault().microsoftAccessToken(accountId),
    requireVault().hasMicrosoftCalendarWriteAccess(accountId)
  )
}

function googleContactsConnector(accountId: string) {
  return new GoogleProductivityConnector(
    accountId,
    () => requireVault().accessToken(accountId),
    requireVault().hasGoogleCalendarWriteAccess(accountId),
    requireVault().hasGoogleContactsWriteAccess(accountId)
  )
}

function microsoftContactsConnector(accountId: string) {
  return new MicrosoftProductivityConnector(
    accountId,
    () => requireVault().microsoftAccessToken(accountId),
    requireVault().hasMicrosoftCalendarWriteAccess(accountId),
    requireVault().hasMicrosoftContactsWriteAccess(accountId)
  )
}

function writableCalendarConnector(calendar: import('../src/productivity-types').SyncedCalendar) {
  return calendar.provider === 'gmail' ? googleCalendarConnector(calendar.accountId) : microsoftCalendarConnector(calendar.accountId)
}

const validEventScope = (value: unknown): value is RecurrenceEditScope => value === undefined || value === 'occurrence' || value === 'following' || value === 'series'

async function createProductivityEvent(input: CalendarEvent) {
  const store = requireProductivityStore()
  const calendar = store.snapshot().calendars.find((item) => item.id === input.calendarId)
  if (!calendar) throw new Error('That calendar is no longer available')
  if (!calendar.canWrite) throw new Error('This calendar cannot be edited until its account is reconnected')
  const saved = await writableCalendarConnector(calendar).createEvent(calendar, input)
  store.upsertEvent(saved)
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('productivity:changed', { snapshot: store.snapshot() })
  diagnostic({ level: 'info', component: 'provider', event: 'calendar-event-created', accountId: calendar.accountId, details: { provider: calendar.provider, calendarId: calendar.id } })
  // A new series is stored as its master; synchronizing replaces it with the provider's occurrences.
  if (saved.recurrenceRule && !saved.seriesId) return syncProductivity(calendar.accountId).catch(() => store.snapshot())
  return store.snapshot()
}

// Series-wide and "this and following" writes go to the provider's series master, then the calendar is
// synchronized so every affected occurrence is refreshed.
async function writeProductivitySeries(eventId: string, scope: 'following' | 'series', input?: CalendarEvent) {
  const store = requireProductivityStore()
  const snapshot = store.snapshot()
  const current = snapshot.events.find((item) => item.id === eventId)
  if (!current) throw new Error('That event is no longer available')
  if (current.readOnly) throw new Error(input ? 'This event cannot be edited' : 'This event cannot be deleted')
  if (!current.seriesId) throw new Error('This event is not part of a repeating series')
  const calendar = snapshot.calendars.find((item) => item.id === current.calendarId)
  if (!calendar) throw new Error('That calendar is no longer available')
  if (!calendar.canWrite) throw new Error('This calendar cannot be edited until its account is reconnected')
  if (current.provider !== calendar.provider || current.accountId !== calendar.accountId) throw new Error('The event’s calendar connection changed; synchronize before editing')
  const connector = writableCalendarConnector(calendar)
  if (input) await connector.updateEventSeries(calendar, current, input, scope)
  else await connector.deleteEventSeries(calendar, current, scope)
  diagnostic({ level: 'info', component: 'provider', event: input ? 'calendar-series-updated' : 'calendar-series-deleted', accountId: calendar.accountId, details: { provider: calendar.provider, calendarId: calendar.id, scope } })
  // A failed refresh is recorded on the account's sync state; the write itself already succeeded.
  return syncProductivity(calendar.accountId).catch(() => store.snapshot())
}

async function updateProductivityEvent(input: CalendarEvent, scope?: RecurrenceEditScope) {
  if (scope === 'following' || scope === 'series') {
    if (requireProductivityStore().snapshot().events.find((item) => item.id === input.id)?.seriesId) return writeProductivitySeries(input.id, scope, input)
  }
  const store = requireProductivityStore()
  const snapshot = store.snapshot()
  const current = snapshot.events.find((item) => item.id === input.id)
  if (!current) throw new Error('That event is no longer available')
  if (current.readOnly) throw new Error('This event cannot be edited')
  if (input.calendarId !== current.calendarId) throw new Error('Moving an existing event to another calendar is not supported yet')
  const calendar = snapshot.calendars.find((item) => item.id === current.calendarId)
  if (!calendar) throw new Error('That calendar is no longer available')
  if (!calendar.canWrite) throw new Error('This calendar cannot be edited until its account is reconnected')
  if (current.provider !== calendar.provider || current.accountId !== calendar.accountId) throw new Error('The event’s calendar connection changed; synchronize before editing')
  // A requested meeting is stored with its request id before the write, so a failed or interrupted save is
  // retried under the same id (and the editor reopens with it) instead of requesting a second meeting.
  if (input.conference?.status === 'pending' && input.conference.requestId && !current.conference) store.upsertEvent({ ...current, conference: input.conference })
  const saved = await writableCalendarConnector(calendar).updateEvent(calendar, current, input)
  store.upsertEvent(saved)
  diagnostic({ level: 'info', component: 'provider', event: 'calendar-event-updated', accountId: calendar.accountId, details: { provider: calendar.provider, calendarId: calendar.id } })
  return store.snapshot()
}

async function deleteProductivityEvent(eventId: string, scope?: RecurrenceEditScope) {
  if (scope === 'following' || scope === 'series') {
    if (requireProductivityStore().snapshot().events.find((item) => item.id === eventId)?.seriesId) return writeProductivitySeries(eventId, scope)
  }
  const store = requireProductivityStore()
  const snapshot = store.snapshot()
  const current = snapshot.events.find((item) => item.id === eventId)
  if (!current) throw new Error('That event is no longer available')
  if (current.readOnly) throw new Error('This event cannot be deleted')
  const calendar = snapshot.calendars.find((item) => item.id === current.calendarId)
  if (!calendar) throw new Error('That calendar is no longer available')
  if (!calendar.canWrite) throw new Error('This calendar cannot be edited until its account is reconnected')
  if (current.provider !== calendar.provider || current.accountId !== calendar.accountId) throw new Error('The event’s calendar connection changed; synchronize before deleting')
  await writableCalendarConnector(calendar).deleteEvent(calendar, current)
  store.deleteEvent(current.id)
  diagnostic({ level: 'info', component: 'provider', event: 'calendar-event-deleted', accountId: calendar.accountId, details: { provider: calendar.provider, calendarId: calendar.id } })
  return store.snapshot()
}

function writableContactsConnector(accountId: string, provider: 'gmail' | 'microsoft') {
  if (provider !== 'gmail') return microsoftContactsConnector(accountId)
  const connector = googleContactsConnector(accountId)
  connector.useContactGroups(requireProductivityStore().accountData(accountId).contactGroups ?? [])
  return connector
}

// Google contactGroups management. Microsoft Graph has no contact-group API for personal contacts;
// Outlook categories are edited through ordinary contact updates instead.
function writableContactGroup(groupId: string) {
  const store = requireProductivityStore()
  const group = (store.snapshot().contactGroups ?? []).find((item) => item.id === groupId)
  if (!group) throw new Error('That contact group is no longer available')
  if (group.provider !== 'gmail') throw new Error('This provider does not support contact group management')
  return { store, group, connector: writableContactsConnector(group.accountId, 'gmail') as GoogleProductivityConnector }
}

const validGroupName = (name: unknown): name is string => typeof name === 'string' && Boolean(name.trim()) && name.trim().length <= 300

async function createProductivityContactGroup(accountId: string, name: string) {
  if (accountProviders.get(accountId) !== 'gmail') throw new Error('Contact groups can be created for connected Google accounts')
  const store = requireProductivityStore()
  const group = await (writableContactsConnector(accountId, 'gmail') as GoogleProductivityConnector).createContactGroup(name)
  store.upsertContactGroup(group)
  diagnostic({ level: 'info', component: 'provider', event: 'contact-group-created', accountId, details: { provider: 'gmail' } })
  return store.snapshot()
}

async function renameProductivityContactGroup(groupId: string, name: string) {
  const { store, group, connector } = writableContactGroup(groupId)
  const renamed = await connector.renameContactGroup(group, name)
  store.upsertContactGroup(renamed)
  // Member contacts carry the group's display name.
  const data = store.accountData(group.accountId)
  const names = new Map((data.contactGroups ?? []).map((item) => [item.remoteId, item.name]))
  for (const contact of data.contacts.filter((item) => item.groupIds?.includes(group.remoteId))) {
    const groups = (contact.groupIds ?? []).flatMap((id) => names.get(id) ?? [])
    store.upsertContact({ ...contact, groups, group: groups[0] ?? 'Google' })
  }
  return store.snapshot()
}

async function deleteProductivityContactGroup(groupId: string) {
  const { store, group, connector } = writableContactGroup(groupId)
  await connector.deleteContactGroup(group)
  store.deleteContactGroup(group.id)
  for (const contact of store.accountData(group.accountId).contacts.filter((item) => item.groupIds?.includes(group.remoteId))) {
    const groupIds = (contact.groupIds ?? []).filter((id) => id !== group.remoteId)
    const groups = (contact.groups ?? []).filter((name) => name !== group.name)
    store.upsertContact({ ...contact, groupIds, groups, group: groups[0] ?? 'Google' })
  }
  diagnostic({ level: 'info', component: 'provider', event: 'contact-group-deleted', accountId: group.accountId, details: { provider: 'gmail' } })
  return store.snapshot()
}

async function updateProductivityContactGroupMembers(groupId: string, addIds: string[], removeIds: string[]) {
  const { store, group, connector } = writableContactGroup(groupId)
  const contacts = store.accountData(group.accountId).contacts
  const pick = (ids: string[]) => ids.map((id) => {
    const contact = contacts.find((item) => item.id === id)
    if (!contact) throw new Error('A selected contact is no longer available; synchronize Contacts and try again')
    return contact
  })
  const result = await connector.modifyContactGroupMembers(group, pick(addIds), pick(removeIds))
  for (const contact of result.contacts) store.upsertContact(contact)
  diagnostic({ level: 'info', component: 'provider', event: 'contact-group-members-updated', accountId: group.accountId, details: { provider: 'gmail', added: addIds.length, removed: removeIds.length, skipped: result.skipped } })
  return store.snapshot()
}

async function createProductivityContact(accountId: string, input: Contact) {
  const provider = accountProviders.get(accountId)
  if (provider !== 'gmail' && provider !== 'microsoft') throw new Error('Choose a connected Google or Microsoft account')
  const store = requireProductivityStore()
  const saved = await writableContactsConnector(accountId, provider).createContact(input)
  store.upsertContact(saved)
  diagnostic({ level: 'info', component: 'provider', event: 'contact-created', accountId, details: { provider } })
  return { contact: saved, snapshot: store.snapshot() }
}

async function updateProductivityContact(input: Contact) {
  const store = requireProductivityStore()
  const current = store.snapshot().contacts.find((contact) => contact.id === input.id)
  if (!current) throw new Error('That contact is no longer available')
  if (current.readOnly) throw new Error('Reconnect this account once to enable Contacts editing')
  const conflict = contactEditConflict(current, input as Contact & { revision?: unknown })
  if (conflict) throw new Error(conflict)
  const saved = await writableContactsConnector(current.accountId, current.provider).updateContact(current, input)
  store.upsertContact(saved)
  diagnostic({ level: 'info', component: 'provider', event: 'contact-updated', accountId: current.accountId, details: { provider: current.provider } })
  return { contact: saved, snapshot: store.snapshot() }
}

async function deleteProductivityContact(contactId: string) {
  const store = requireProductivityStore()
  const current = store.snapshot().contacts.find((contact) => contact.id === contactId)
  if (!current) throw new Error('That contact is no longer available')
  if (current.readOnly) throw new Error('Reconnect this account once to enable Contacts editing')
  await writableContactsConnector(current.accountId, current.provider).deleteContact(current)
  store.deleteContact(current.id)
  diagnostic({ level: 'info', component: 'provider', event: 'contact-deleted', accountId: current.accountId, details: { provider: current.provider } })
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
  if (hideTestWindows || !Notification.isSupported() || !loadPreferences().settings.notifications) return
  const title = payload.count === 1 ? payload.sender || 'New message' : `${payload.count.toLocaleString()} new messages`
  const notification = new Notification({ title, body: payload.count === 1 ? payload.subject || 'Open Aerio to read it' : 'Open Aerio to view your inbox', icon: iconPath() })
  notification.on('click', () => {
    openMainWindow()
    if (payload.threadId && !appLockStatus().locked) createMessageWindow({ source: 'connected', accountId: payload.accountId, threadId: payload.threadId, title: payload.subject || 'New message' })
  })
  notification.show()
}

function showReplyWatchNotification(payload: Extract<import('../src/mail-types').MailWorkerEvent, { type: 'reply-watch' }>['payload']) {
  if (hideTestWindows || !Notification.isSupported() || !loadPreferences().settings.notifications) return
  const { watch, reason } = payload
  const subject = watch.subject || '(No subject)'
  const notification = new Notification({
    title: reason === 'replied' ? `Reply from ${watch.replyFrom || 'a recipient'}` : 'No reply yet',
    body: reason === 'replied' ? subject : `${subject} — the reply deadline has passed`,
    icon: iconPath()
  })
  notification.on('click', () => {
    openMainWindow()
    const threadId = watch.replyThreadId ?? watch.threadId
    if (threadId && !appLockStatus().locked) createMessageWindow({ source: 'connected', accountId: watch.accountId, threadId, title: subject })
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
      if (event.type === 'reply-watch') showReplyWatchNotification(event.payload)
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
      return await fetchRemoteImage(remote, {
        lookup: (hostname) => lookup(hostname, { all: true }),
        isPrivateAddress,
        fetch: (target, init) => net.fetch(target, init)
      })
    } catch {
      return new Response('Invalid image URL', { status: 400 })
    }
  })
}

function loadPreferences(): AppPreferences {
  if (!database) throw new Error('Aerio database is not ready')
  const result = database.prepare('SELECT payload FROM app_preferences WHERE id = 1').get() as { payload?: unknown } | undefined
  if (!result) return createDefaultPreferences()
  const parsed: unknown = JSON.parse(String(result.payload))
  const preferences = preferencesFromUnknown(parsed)
  if (!preferences) throw new Error('Stored Aerio preferences are invalid')
  return preferences
}

function savePreferences(preferences: AppPreferences) {
  if (!database) throw new Error('Aerio database is not ready')
  const normalized = preferencesFromUnknown(preferences)
  if (!normalized) throw new Error('Refusing to save invalid Aerio preferences')
  // Register before acknowledging a preference save, so an unavailable or
  // unowned startup entry cannot leave a falsely successful checkbox behind.
  if (app.isPackaged) {
    if (process.platform === 'win32') app.setLoginItemSettings({ openAtLogin: Boolean(normalized.settings.launchAtLogin), args: ['--aerio-login'] })
    else if (process.platform === 'darwin' && (normalized.settings.launchAtLogin ||
      Boolean(normalized.settings.launchAtLogin) !== Boolean(loadPreferences().settings.launchAtLogin))) registerMacLoginItem(app, Boolean(normalized.settings.launchAtLogin))
    else if (process.platform === 'linux' && (normalized.settings.launchAtLogin ||
      Boolean(normalized.settings.launchAtLogin) !== Boolean(loadPreferences().settings.launchAtLogin))) setLinuxLoginItem(Boolean(normalized.settings.launchAtLogin), {
      home: homedir(), configHome: process.env.XDG_CONFIG_HOME, executable: process.execPath, appImage: process.env.APPIMAGE
    })
  }
  const updatedAt = new Date().toISOString()
  database.prepare(
    `INSERT INTO app_preferences (id, schema_version, payload, updated_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       schema_version = excluded.schema_version,
       payload = excluded.payload,
        updated_at = excluded.updated_at`
  ).run(normalized.schemaVersion, JSON.stringify(normalized), updatedAt)
  return { savedAt: updatedAt }
}

interface AppLockRecord {
  salt: string
  verifier: string
}

function loadAppLockRecord(): AppLockRecord | undefined {
  if (!database) throw new Error('Aerio database is not ready')
  const result = database.prepare('SELECT salt, verifier FROM app_lock WHERE id = 1').get() as Partial<AppLockRecord> | undefined
  if (!result) return
  if (typeof result.salt !== 'string' || typeof result.verifier !== 'string' ||
      !/^[A-Za-z0-9+/]{22}==$/.test(result.salt) || !/^[A-Za-z0-9+/]{43}=$/.test(result.verifier)) {
    throw new Error('Stored Aerio app-lock data is invalid')
  }
  return { salt: result.salt, verifier: result.verifier }
}

function appLockStatus() {
  const enabled = Boolean(loadAppLockRecord())
  return { enabled, locked: enabled && applicationLocked }
}

function validAppLockPassphrase(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 256 && value.trim().length >= 8
}

function appLockVerifier(passphrase: string, salt: Buffer) {
  return scryptSync(passphrase, salt, 32)
}

function verifyAppLockPassphrase(passphrase: unknown, record = loadAppLockRecord()) {
  if (!record) throw new Error('Aerio app lock is not enabled')
  if (typeof passphrase !== 'string' || passphrase.length > 256) throw new Error('Enter the app-lock passphrase')
  const wait = unlockBlockedUntil - Date.now()
  if (wait > 0) throw new Error(`Too many attempts. Try again in ${Math.ceil(wait / 1_000)} seconds`)
  const actual = appLockVerifier(passphrase, Buffer.from(record.salt, 'base64'))
  const expected = Buffer.from(record.verifier, 'base64')
  if (!timingSafeEqual(actual, expected)) {
    failedUnlockAttempts += 1
    if (failedUnlockAttempts >= 5) {
      unlockBlockedUntil = Date.now() + 30_000
      failedUnlockAttempts = 0
    }
    throw new Error('The app-lock passphrase is incorrect')
  }
  failedUnlockAttempts = 0
  unlockBlockedUntil = 0
}

function publishAppLockStatus() {
  const status = appLockStatus()
  BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('app-lock:status-changed', status))
  return status
}

function enableAppLock(passphrase: unknown) {
  if (loadAppLockRecord()) throw new Error('Aerio app lock is already enabled')
  if (!validAppLockPassphrase(passphrase)) throw new Error('Use a passphrase of 8 to 256 characters')
  const salt = randomBytes(16)
  const verifier = appLockVerifier(passphrase, salt)
  const updatedAt = new Date().toISOString()
  database!.prepare(
    `INSERT INTO app_lock (id, salt, verifier, updated_at) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET salt = excluded.salt, verifier = excluded.verifier, updated_at = excluded.updated_at`
  ).run(salt.toString('base64'), verifier.toString('base64'), updatedAt)
  applicationLocked = false
  return publishAppLockStatus()
}

function disableAppLock(passphrase: unknown) {
  verifyAppLockPassphrase(passphrase)
  database!.prepare('DELETE FROM app_lock WHERE id = 1').run()
  applicationLocked = false
  return publishAppLockStatus()
}

function lockApplication() {
  if (!loadAppLockRecord()) return appLockStatus()
  applicationLocked = true
  for (const window of messageWindows.values()) window.close()
  return publishAppLockStatus()
}

function unlockApplication(passphrase: unknown) {
  const record = loadAppLockRecord()
  if (!record) {
    applicationLocked = false
    return appLockStatus()
  }
  verifyAppLockPassphrase(passphrase, record)
  applicationLocked = false
  return publishAppLockStatus()
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
  return input.source === 'connected' && validText(input.accountId) && validText(input.threadId) && (input.messageId === undefined || validText(input.messageId))
}

function createMessageWindow(input: MessageWindowRequest) {
  if (appLockStatus().locked) throw new Error('Unlock Aerio before opening a message window')
  const key = `mail:${input.accountId}:${input.threadId}:${input.messageId ?? 'thread'}`
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
  loadRenderer(messageWindow, { view: 'message', source: 'connected', accountId: input.accountId, threadId: input.threadId, ...(input.messageId ? { messageId: input.messageId } : {}) })
}

function createWindow() {
  const startMinimized = initialWindow && (process.argv.includes('--aerio-login') ||
    (process.platform === 'darwin' && app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin))
  initialWindow = false
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
    if (!hideTestWindows) {
      mainWindow?.show()
      if (startMinimized) mainWindow?.minimize()
    }
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
  mainWindow.on('show', () => { stopTrayMonitor(); closeGeneration++; updateMailPolling(true) })
  mainWindow.on('focus', () => updateMailPolling(true))
  mainWindow.on('restore', () => { stopTrayMonitor(); closeGeneration++; updateMailPolling(true) })
  mainWindow.on('hide', () => { updateMailPolling(); lockApplication() })
  mainWindow.on('blur', () => updateMailPolling())
  mainWindow.on('minimize', () => updateMailPolling())
  mainWindow.on('close', (event) => {
    const closeToTray = loadPreferences().settings.closeToTray
    if (!quitting && closeToTray) {
      event.preventDefault()
      void closeToBackground()
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
    if (compose && !appLockStatus().locked) window.webContents.once('did-finish-load', () => window.webContents.send('command:compose'))
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
    if (!hideTestWindows) {
      mainWindow.show()
      mainWindow.focus()
    }
  if (compose && !appLockStatus().locked) mainWindow.webContents.send('command:compose')
}

function stopTrayMonitor() {
  if (trayMonitor) clearInterval(trayMonitor)
  trayMonitor = undefined
}

function minimizeForBackground(window: BrowserWindow) {
  // Retain a taskbar entry so a desktop without a tray can reopen Aerio.
  if (!hideTestWindows) window.show()
  window.minimize()
}

async function closeToBackground() {
  const window = mainWindow
  const generation = ++closeGeneration
  if (!window) return
  lockApplication()
  const available = tray && !tray.isDestroyed() &&
    (process.platform !== 'linux' || await linuxTrayHostAvailable())
  if (quitting || window.isDestroyed() || mainWindow !== window || generation !== closeGeneration) return
  if (!available) { minimizeForBackground(window); return }
  window.hide()
  if (process.platform === 'linux') {
    stopTrayMonitor()
    let probing = false
    trayMonitor = setInterval(() => {
      if (probing) return
      probing = true
      void linuxTrayHostAvailable().then((reachable) => {
        if (!reachable && !quitting && mainWindow === window && !window.isDestroyed() && !window.isVisible()) {
          minimizeForBackground(window)
        }
      }).finally(() => { probing = false })
    }, 3_000)
    trayMonitor.unref()
  }
}

function createTray() {
  try {
    const path = process.platform === 'darwin'
      ? join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'build', 'trayTemplate.png')
      : iconPath()
    let image = path ? nativeImage.createFromPath(path) : nativeImage.createEmpty()
    if (image.isEmpty()) return
    if (process.platform === 'darwin') image.setTemplateImage(true)
    else image = image.resize({ width: 20, height: 20 })
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
    if (process.platform === 'linux') tray.on('click', () => openMainWindow())
  } catch {
    try { tray?.destroy() } catch { /* Preserve the usable window even if native cleanup fails. */ }
    tray = null
    diagnostic({ level: 'warn', component: 'app', event: 'tray-unavailable', message: 'Background close will retain a taskbar window.' })
  }
}

function registerIpc() {
  const tasks = () => {
    if (!taskService) throw new Error('Task storage is not ready')
    return taskService
  }
  const taskId = (value: unknown) => {
    if (typeof value !== 'string' || !value || value.length > 2048) throw new Error('Invalid task identity')
    return value
  }
  ipcMain.handle('tasks:snapshot', () => tasks().snapshot())
  ipcMain.handle('tasks:list:create', (_event, accountId: unknown, title: string) => tasks().createList(taskId(accountId), title))
  ipcMain.handle('tasks:list:rename', (_event, listId: unknown, title: string) => tasks().renameList(taskId(listId), title))
  ipcMain.handle('tasks:list:delete', (_event, listId: unknown) => tasks().deleteList(taskId(listId)))
  ipcMain.handle('tasks:list:resolve', (_event, id: unknown, resolution: TaskResolution) => tasks().resolveList(taskId(id), resolution))
  ipcMain.handle('tasks:export', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.SaveDialogOptions = { title: 'Back up connected tasks', defaultPath: `Aerio-connected-tasks-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'Aerio connected tasks', extensions: ['json'] }] }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return {}
    const backup = await tasks().exportBackup()
    const contents = `${JSON.stringify(backup, null, 2)}\n`
    if (Buffer.byteLength(contents, 'utf8') > 150 * 1024 * 1024) throw new Error('Connected-task backups must be smaller than 150 MB')
    writeFileSync(result.filePath, contents, { encoding: 'utf8', mode: 0o600 })
    return { savedPath: result.filePath }
  })
  ipcMain.handle('tasks:import', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = { title: 'Restore connected tasks', filters: [{ name: 'Aerio connected tasks', extensions: ['json'] }], properties: ['openFile'] }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    const path = result.filePaths[0]
    if (result.canceled || !path) return
    const file = statSync(path)
    if (!file.isFile() || file.size > 150 * 1024 * 1024) throw new Error('Choose a connected-task backup smaller than 150 MB')
    let parsed: unknown
    try { parsed = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new Error('That file is not a readable connected-task backup') }
    return tasks().restoreBackup(parseTaskBackup(parsed))
  })
  ipcMain.handle('tasks:sync', (_event, id: unknown) => tasks().sync(taskId(id)))
  ipcMain.handle('tasks:create', (_event, accountId: unknown, listId: unknown, input: ProviderTaskInput, parentId: unknown, local?: TaskLocalMetadata) => tasks().create(taskId(accountId), taskId(listId), input, parentId === undefined ? undefined : taskId(parentId), local))
  ipcMain.handle('tasks:update', (_event, id: unknown, patch: TaskFieldPatch, local?: TaskLocalMetadata) => tasks().update(taskId(id), patch, local))
  ipcMain.handle('tasks:delete', (_event, id: unknown) => tasks().delete(taskId(id)))
  ipcMain.handle('tasks:move', (_event, id: unknown, parentId: unknown) => tasks().move(taskId(id), parentId === undefined ? undefined : taskId(parentId)))
  ipcMain.handle('tasks:local', (_event, id: unknown, local: TaskLocalMetadata) => tasks().setLocal(taskId(id), local))
  ipcMain.handle('tasks:undo', (_event, id: unknown) => tasks().undo(taskId(id)))
  ipcMain.handle('tasks:resolve', (_event, id: unknown, resolution: TaskResolution) => tasks().resolve(taskId(id), resolution))
  messageLocalStore = new MessageLocalStore(join(app.getPath('userData'), 'message-local.sqlite'))
  mailTemplateStore = new MailTemplateStore(join(app.getPath('userData'), 'mail-templates.sqlite'), join(app.getPath('userData'), 'template-attachments'), (path) => approvedAttachmentPaths.has(path))
  try { mailTemplateStore.cleanupOrphanedFiles() } catch { /* Orphaned template files are retried on the next launch. */ }
  registerMailTemplates({ store: () => {
    if (!mailTemplateStore) throw new Error('Template storage is not ready')
    return mailTemplateStore
  }, approveAttachment: (path) => approvedAttachmentPaths.add(path) })
  registerMailIdentities({ worker: requireMailWorker })
  registerMessageTools({ worker: requireMailWorker, productivity: requireProductivityStore, local: messageLocalStore, changed: (local) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('productivity:changed', { local })
  } })
  registerAiAssistant({ worker: requireMailWorker, store: new AiAssistantStore(join(app.getPath('userData'), 'ai-assistant.json'), join(app.getPath('userData'), 'ai-assistant-key.dat')) })
  const automaticReplies = new AutomaticRepliesService({
    account: async (accountId) => (await requireMailWorker().request<MailAccountSummary[]>({ type: 'accounts:list' })).find((item) => item.id === accountId),
    googleToken: (accountId) => requireVault().accessToken(accountId),
    microsoftToken: (accountId) => requireVault().microsoftAccessToken(accountId),
    grantedScopes: (accountId, provider) => requireVault().grantedScopes(accountId, provider)
  })
  registerAutomaticReplies(ipcMain, () => automaticReplies)
  const cloudAttachments = new CloudAttachmentService({
    account: async (accountId) => (await requireMailWorker().request<MailAccountSummary[]>({ type: 'accounts:list' })).find((item) => item.id === accountId),
    googleToken: (accountId) => requireVault().accessToken(accountId),
    microsoftToken: (accountId) => requireVault().microsoftAccessToken(accountId),
    grantedScopes: (accountId, provider) => requireVault().grantedScopes(accountId, provider),
    authorize: async (account, scopes) => {
      const expected = { accountId: account.id, email: account.email }
      if (account.provider === 'gmail') await requireVault().authorize(expected, { additionalScopes: scopes })
      else await requireVault().authorizeMicrosoft(expected, { additionalScopes: scopes })
    },
    isApprovedPath: (path) => approvedAttachmentPaths.has(path),
    // Upload session URLs are short-lived capabilities; keep them encrypted at rest.
    state: new CloudAttachmentStateStore(join(app.getPath('userData'), 'cloud-uploads.dat'), {
      encode: (value) => { assertSecureCredentialStorage(safeStorage); return safeStorage.encryptString(value).toString('base64') },
      decode: (value) => { assertSecureCredentialStorage(safeStorage); return safeStorage.decryptString(Buffer.from(value, 'base64')) }
    })
  })
  registerCloudAttachments(ipcMain, () => cloudAttachments)
  ipcMain.handle('preferences:load', () => loadPreferences())
  ipcMain.handle('preferences:save', (_event, preferences: AppPreferences) => savePreferences(preferences))
  ipcMain.handle('app-lock:status', () => appLockStatus())
  ipcMain.handle('app-lock:enable', (_event, passphrase: unknown) => enableAppLock(passphrase))
  ipcMain.handle('app-lock:disable', (_event, passphrase: unknown) => disableAppLock(passphrase))
  ipcMain.handle('app-lock:lock', () => lockApplication())
  ipcMain.handle('app-lock:unlock', (_event, passphrase: unknown) => unlockApplication(passphrase))
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
    const store = requireProductivityStore()
    const previous = store.localSnapshot()
    store.saveLocal(snapshot)
    cleanupRemovedNoteAttachments(previous, snapshot)
  })
  ipcMain.handle('productivity:note-attachments-choose', async (event): Promise<Attachment[]> => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = { title: 'Attach files to note', properties: ['openFile', 'multiSelections'] }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled) return []
    if (result.filePaths.length > 50) throw new Error('Attach no more than 50 files to a note')
    const files = result.filePaths.map((source) => ({ source, file: statSync(source) }))
    for (const { source, file } of files) {
      if (!file.isFile() || file.size > NOTE_ATTACHMENT_MAX_BYTES) throw new Error(`“${basename(source)}” must be a file no larger than 25 MB`)
    }
    mkdirSync(noteAttachmentsDirectory(), { recursive: true })
    const copiedPaths: string[] = []
    try {
      return files.map(({ source, file }) => {
        const extension = extname(source)
        const path = join(noteAttachmentsDirectory(), `${crypto.randomUUID()}${extension.length <= 12 ? extension : ''}`)
        copyFileSync(source, path)
        copiedPaths.push(path)
        return { id: crypto.randomUUID(), name: basename(source), size: file.size, path, mime: extension.slice(1) || undefined }
      })
    } catch (error) {
      for (const path of copiedPaths) {
        try { if (existsSync(path)) unlinkSync(path) } catch { /* Do not mask the copy error. */ }
      }
      throw error
    }
  })
  ipcMain.handle('productivity:note-attachment-open', async (_event, path: unknown) => {
    if (typeof path !== 'string' || !path || path.length > 32_767 || !isManagedNoteAttachmentPath(path) || !existsSync(path)) throw new Error('That note attachment is no longer available')
    const error = await shell.openPath(path)
    return error ? { error } : {}
  })
  ipcMain.handle('productivity:local-export', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const filename = `Aerio-local-data-${new Date().toISOString().slice(0, 10)}.json`
    const options: Electron.SaveDialogOptions = {
      title: 'Export Aerio local data',
      defaultPath: filename,
      filters: [{ name: 'Aerio local data', extensions: ['json'] }]
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return {}
    const backup = createLocalDataBackup(requireProductivityStore().localSnapshot())
    writeFileSync(result.filePath, `${JSON.stringify(backup, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    return { savedPath: result.filePath }
  })
  ipcMain.handle('productivity:local-import', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Restore Aerio local data',
      filters: [{ name: 'Aerio local data', extensions: ['json'] }],
      properties: ['openFile']
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    const path = result.filePaths[0]
    if (result.canceled || !path) return
    const file = statSync(path)
    if (!file.isFile() || file.size > 150 * 1024 * 1024) throw new Error('Choose an Aerio local-data backup smaller than 150 MB')
    let parsed: unknown
    try { parsed = JSON.parse(readFileSync(path, 'utf8')) }
    catch { throw new Error('That file is not a readable Aerio local-data backup') }
    const backup = localDataBackupFromUnknown(parsed)
    if (!backup) throw new Error('That backup is invalid or was created by an unsupported Aerio version')
    const templates = backup.mailTemplates && mailTemplateStore ? mailTemplateStore.prepareRestore(backup.mailTemplates, 'replace') : undefined
    let materialized: ReturnType<typeof materializeLocalDataBackup>
    try { materialized = materializeLocalDataBackup(backup) }
    catch (error) {
      templates?.rollback()
      throw error
    }
    const { snapshot: restored, createdPaths } = materialized
    const store = requireProductivityStore()
    const previous = store.localSnapshot()
    try { store.saveLocal(restored) }
    catch (error) {
      templates?.rollback()
      for (const path of createdPaths) {
        try { if (existsSync(path)) unlinkSync(path) } catch { /* Do not mask the storage error. */ }
      }
      throw error
    }
    cleanupRemovedNoteAttachments(previous, restored)
    templates?.commit()
    return restored
  })
  ipcMain.handle('productivity:sync', (_event, accountId: string) => {
    if (typeof accountId !== 'string' || !accountId || accountId.length > 200) throw new Error('Choose a valid account to synchronize')
    return syncProductivity(accountId)
  })
  ipcMain.handle('productivity:event-create', (_event, input: unknown) => {
    if (!validCalendarEvent(input)) throw new Error('Enter valid event details')
    return createProductivityEvent(input)
  })
  ipcMain.handle('productivity:event-update', (_event, input: unknown, scope?: unknown) => {
    if (!validCalendarEvent(input)) throw new Error('Enter valid event details')
    if (!validEventScope(scope)) throw new Error('Choose which events to change')
    return updateProductivityEvent(input, scope)
  })
  ipcMain.handle('productivity:event-delete', (_event, eventId: unknown, scope?: unknown) => {
    if (typeof eventId !== 'string' || !eventId || eventId.length > 500) throw new Error('Choose a valid event')
    if (!validEventScope(scope)) throw new Error('Choose which events to delete')
    return deleteProductivityEvent(eventId, scope)
  })
  ipcMain.handle('productivity:contact-create', (_event, accountId: unknown, input: unknown) => {
    if (typeof accountId !== 'string' || !accountId || accountId.length > 200) throw new Error('Choose a valid provider account')
    if (!validContact(input)) throw new Error('Enter valid contact details')
    return createProductivityContact(accountId, input)
  })
  ipcMain.handle('productivity:contact-update', (_event, input: unknown) => {
    if (!validContact(input)) throw new Error('Enter valid contact details')
    return updateProductivityContact(input)
  })
  ipcMain.handle('productivity:contact-delete', (_event, contactId: unknown) => {
    if (typeof contactId !== 'string' || !contactId || contactId.length > 500) throw new Error('Choose a valid contact')
    return deleteProductivityContact(contactId)
  })
  const validId = (value: unknown): value is string => typeof value === 'string' && Boolean(value) && value.length <= 500
  ipcMain.handle('productivity:contact-group-create', (_event, accountId: unknown, name: unknown) => {
    if (!validId(accountId) || !validGroupName(name)) throw new Error('Enter a group name of up to 300 characters')
    return createProductivityContactGroup(accountId, name)
  })
  ipcMain.handle('productivity:contact-group-rename', (_event, groupId: unknown, name: unknown) => {
    if (!validId(groupId) || !validGroupName(name)) throw new Error('Enter a group name of up to 300 characters')
    return renameProductivityContactGroup(groupId, name)
  })
  ipcMain.handle('productivity:contact-group-delete', (_event, groupId: unknown) => {
    if (!validId(groupId)) throw new Error('Choose a valid contact group')
    return deleteProductivityContactGroup(groupId)
  })
  ipcMain.handle('productivity:contact-group-members', (_event, groupId: unknown, add: unknown, remove: unknown) => {
    const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 1_000 && value.every(validId)
    if (!validId(groupId) || !ids(add) || !ids(remove) || add.length + remove.length === 0) throw new Error('Choose contacts to add or remove')
    return updateProductivityContactGroupMembers(groupId, add, remove)
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
    if (typeof input.syncEnabled !== 'boolean') throw new Error('Invalid account synchronization setting')
    return (async () => {
      if (!input.syncEnabled) await taskService?.stopAccount(input.accountId)
      try {
        const account = await requireMailWorker().request<MailAccountSummary>({ type: 'accounts:update', payload: { ...input, displayName: input.displayName.trim() } })
        if (input.syncEnabled) taskService?.resumeAccount(input.accountId)
        return account
      } catch (error) {
        if (!input.syncEnabled) taskService?.resumeAccount(input.accountId)
        throw error
      }
    })()
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
    taskService?.resumeAccount(accountId)
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
    if (typeof accountId !== 'string' || !accountId || !['archive', 'delete'].includes(mode)) throw new Error('Invalid account disconnect request')
    await taskService?.stopAccount(accountId)
    await requireVault().remove(accountId)
    await requireMailWorker().request({ type: 'accounts:disconnect', payload: { accountId, mode } })
    requireProductivityStore().removeAccount(accountId)
    accountProviders.delete(accountId)
    if (mode === 'delete') await taskService?.removeAccount(accountId)
    else await taskService?.accountChanged()
  })
  ipcMain.handle('mail:labels:list', (_event, accountIds?: string[]) =>
    requireMailWorker().request<MailLabel[]>({ type: 'labels:list', payload: { accountIds } }))
  ipcMain.handle('mail:recipients:suggest', (_event, query: string, accountIds?: string[]) =>
    requireMailWorker().request<MailRecipientSuggestion[]>({ type: 'recipients:suggest', payload: { query: typeof query === 'string' ? query.slice(0, 200) : '', accountIds } }))
  ipcMain.handle('mail:threads:list', (_event, query: MailQuery) =>
    requireMailWorker().request<MailPage>({ type: 'mail:list', payload: query }))
  ipcMain.handle('mail:folders:unread-counts', (_event, accountIds?: string[]) =>
    requireMailWorker().request<MailFolderUnreadCounts>({ type: 'mail:unread-counts', payload: { accountIds } }))
  ipcMain.handle('mail:accounts:unread-counts', () =>
    requireMailWorker().request<MailAccountUnreadCounts>({ type: 'mail:account-unread-counts' }))
  ipcMain.handle('mail:threads:get', async (_event, accountId: string, threadId: string, allowRemoteImages?: boolean) => {
    const thread = await requireMailWorker().request<MailThreadDetail>({ type: 'mail:thread', payload: { accountId, threadId, allowRemoteImages } })
    return { ...thread, messages: thread.messages.map((message) => ({ ...message, local: messageLocalStore?.get({ accountId, messageId: message.id }) })) }
  })
  ipcMain.handle('mail:message:source', (_event, accountId: string, messageId: string) =>
    requireMailWorker().request<MailMessageSource>({ type: 'mail:source', payload: { accountId, messageId } }))
  // The receipt policy is read here, never trusted from the renderer.
  ipcMain.handle('mail:receipts:inspect', (_event, accountId: string, messageId: string) => {
    if (typeof accountId !== 'string' || !accountId || accountId.length > 200 || typeof messageId !== 'string' || !messageId || messageId.length > 500) throw new Error('Choose a valid message')
    return requireMailWorker().request<MailReceiptInfo>({ type: 'receipts:inspect', payload: { accountId, messageId, policy: normalizeReadReceiptPolicy(loadPreferences().settings.readReceiptPolicy) } })
  })
  ipcMain.handle('mail:receipts:respond', (_event, accountId: string, messageId: string, decision: 'send' | 'decline') => {
    if (typeof accountId !== 'string' || !accountId || accountId.length > 200 || typeof messageId !== 'string' || !messageId || messageId.length > 500 || (decision !== 'send' && decision !== 'decline')) throw new Error('Choose a valid read receipt response')
    return requireMailWorker().request<MailReceiptInfo>({ type: 'receipts:respond', payload: { accountId, messageId, decision, policy: normalizeReadReceiptPolicy(loadPreferences().settings.readReceiptPolicy) } })
  })
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
  ipcMain.handle('mail:reply-watches:list', (_event, accountIds?: string[]) =>
    requireMailWorker().request<MailReplyWatch[]>({ type: 'reply-watches:list', payload: { accountIds: Array.isArray(accountIds) ? accountIds.filter((id) => typeof id === 'string').slice(0, 100) : undefined } }))
  ipcMain.handle('mail:reply-watches:create', (_event, input: MailReplyWatchInput) => {
    const valid = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 500
    if (!input || !valid(input.accountId) || (valid(input.draftId) === valid(input.messageId))) throw new Error('Choose a sent or outgoing message to watch')
    return requireMailWorker().request<MailReplyWatch>({ type: 'reply-watches:create', payload: {
      accountId: input.accountId,
      ...(input.draftId ? { draftId: input.draftId } : { messageId: input.messageId }),
      deadlineAt: input.deadlineAt ? validateFutureDate(input.deadlineAt, 'Reply deadline') : undefined
    } })
  })
  ipcMain.handle('mail:reply-watches:cancel', (_event, id: string) => {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('Invalid reply watch')
    return requireMailWorker().request<boolean>({ type: 'reply-watches:cancel', payload: { id } })
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
  ipcMain.handle('mail:folders:create', (_event, input: CreateMailFolderInput) =>
    requireMailWorker().request<MailFolderMutationResult>({ type: 'folders:create', payload: validateCreateFolder(input) }))
  ipcMain.handle('mail:folders:update', (_event, input: UpdateMailFolderInput) =>
    requireMailWorker().request<MailFolderMutationResult>({ type: 'folders:update', payload: validateUpdateFolder(input) }))
  ipcMain.handle('mail:folders:delete', (_event, input: DeleteMailFolderInput) =>
    requireMailWorker().request<MailFolderMutationResult>({ type: 'folders:delete', payload: validateDeleteFolder(input) }))
  ipcMain.handle('mail:folders:delete-preview', (_event, accountId: string, labelId: string) =>
    requireMailWorker().request<MailFolderDeletePreview>({ type: 'folders:delete-preview', payload: validateFolderReference(accountId, labelId) }))
  ipcMain.handle('mail:rules:list', (_event, accountIds?: string[]) =>
    requireMailWorker().request<MailRule[]>({ type: 'rules:list', payload: { accountIds } }))
  registerMailRuleHandlers(ipcMain, {
    request: (command) => requireMailWorker().request(command),
    provider: (accountId) => accountProviders.get(accountId),
    accessToken: async (accountId, provider) => {
      const credential = await requireVault().credential(accountId, provider)
      if (credential.type !== 'oauth') throw new Error('This account has no server rules')
      return credential.accessToken
    },
    access: (accountId, provider) => requireVault().mailSettingsAccess(accountId, provider, 'server-rules'),
    diagnostic: (event, accountId, details) => diagnostic({ level: 'info', component: 'provider', event, accountId, details })
  })
  ipcMain.handle('mail:rules:delete', (_event, id: string) => {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('Invalid rule id')
    return requireMailWorker().request({ type: 'rules:delete', payload: { id } })
  })
  ipcMain.handle('mail:rules:run', (_event, id: string) => {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('Invalid rule id')
    return requireMailWorker().request<MailRuleRunResult>({ type: 'rules:run', payload: { id } })
  })
  ipcMain.handle('mail:saved-searches:list', () =>
    requireMailWorker().request<MailSavedSearch[]>({ type: 'saved-searches:list' }))
  ipcMain.handle('mail:saved-searches:save', (_event, input: MailSavedSearchInput) =>
    requireMailWorker().request<MailSavedSearch>({ type: 'saved-searches:save', payload: validateMailSavedSearch(input) }))
  ipcMain.handle('mail:saved-searches:delete', (_event, id: string) => {
    if (typeof id !== 'string' || !id || id.length > 500) throw new Error('Invalid saved search id')
    return requireMailWorker().request({ type: 'saved-searches:delete', payload: { id } })
  })
  const quickActionId = (id: unknown) => {
    if (typeof id !== 'string' || !id || id.length > 500) throw new Error('Invalid quick action id')
    return id
  }
  ipcMain.handle('mail:quick-actions:list', () =>
    requireMailWorker().request<MailQuickAction[]>({ type: 'quick-actions:list' }))
  ipcMain.handle('mail:quick-actions:save', (_event, input: unknown) =>
    requireMailWorker().request<MailQuickAction>({ type: 'quick-actions:save', payload: validateMailQuickAction(input) }))
  ipcMain.handle('mail:quick-actions:delete', (_event, id: unknown) =>
    requireMailWorker().request({ type: 'quick-actions:delete', payload: { id: quickActionId(id) } }))
  ipcMain.handle('mail:quick-actions:run', (_event, id: unknown, targets: unknown) =>
    requireMailWorker().request<MailQuickActionRunResult>({ type: 'quick-actions:run', payload: { id: quickActionId(id), targets: validateMailQuickActionTargets(targets) } }))
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
  ipcMain.handle('mail:network', (_event, online: boolean) => {
    if (typeof online !== 'boolean') throw new Error('Invalid network state')
    taskNetworkOnline = online
    if (online) void taskService?.flush().catch(() => {})
    return requireMailWorker().request({ type: 'network', payload: { online } })
  })
  ipcMain.handle('mail:attachments:list', (_event, query: unknown) =>
    requireMailWorker().request<MailAttachmentPage>({ type: 'attachments:list', payload: normalizeAttachmentQuery(query) }))
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
  const menu = applicationMenuTemplate(process.platform, () => openMainWindow())
  Menu.setApplicationMenu(menu ? Menu.buildFromTemplate(menu) : null)
  // A staged full-profile restore is swapped in before any profile database opens.
  try {
    const restored = applyPendingProfileRestore(app.getPath('userData'))
    if (restored) diagnostic({ level: restored.status === 'applied' ? 'info' : 'error', component: 'app', event: `profile-restore-${restored.status}`, message: restored.error, details: { ...restored.report } })
  } catch (error) {
    diagnostic({ level: 'error', component: 'app', event: 'profile-restore-failed', message: error instanceof Error ? error.message : String(error) })
  }
  await initializePreferencesDatabase()
  await initializeMail()
  productivityStore = new ProductivityStore(join(app.getPath('userData'), 'productivity.sqlite'))
  interchangeStore = new InterchangeStore(join(app.getPath('userData'), 'productivity.sqlite'))
  taskService = new TaskService(new TaskStore(join(app.getPath('userData'), 'provider-tasks.sqlite')), {
    accounts: () => requireMailWorker().request<MailAccountSummary[]>({ type: 'accounts:list' }),
    access: (id, provider) => provider === 'gmail'
      ? { read: requireVault().hasGoogleTasksAccess(id), write: requireVault().hasGoogleTasksAccess(id, true) }
      : { read: requireVault().hasMicrosoftTasksAccess(id), write: requireVault().hasMicrosoftTasksAccess(id, true) },
    connector: (id, provider) => provider === 'gmail'
      ? new GoogleTasksConnector(id, () => requireVault().accessToken(id), requireVault().hasGoogleTasksAccess(id, true))
      : new MicrosoftTasksConnector(id, () => requireVault().microsoftAccessToken(id), requireVault().hasMicrosoftTasksAccess(id, true)),
    online: () => taskNetworkOnline && net.isOnline(),
    changed: (snapshot) => BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('tasks:changed', snapshot))
  })
  taskPolling = setInterval(() => { void taskService?.poll().catch(() => {}) }, 60_000)
  taskPolling.unref()
  registerIpc()
  profileBackups = registerProfileBackup({
    userData: app.getPath('userData'),
    appVersion: app.getVersion(),
    defaultDirectory: join(app.getPath('documents'), 'Aerio Backups'),
    layout: PROFILE_BACKUP_LAYOUT,
    isLocked: () => applicationLocked,
    relaunch: () => { app.relaunch(); app.quit() },
    log: (event, details, error) => diagnostic({ level: error ? 'error' : 'info', component: 'app', event, details, message: error === undefined ? undefined : error instanceof Error ? error.message : String(error) })
  })
  // Every store opened on the restored data, so the rollback copy is no longer needed.
  try { finalizeProfileRestore(app.getPath('userData')) } catch { /* Retried on the next launch. */ }
  interchangeService = registerCalendarContactInterchange({
    productivity: requireProductivityStore,
    interchange: () => {
      if (!interchangeStore) throw new Error('Calendar import and subscription storage is not ready')
      return interchangeStore
    },
    diagnostic: (record) => diagnostic({ ...record, component: 'provider' })
  })
  registerRemoteImageProtocol()
  readyToOpenWindows = true
  createWindow()
  void taskService.poll().catch(() => {})
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
  stopTrayMonitor()
  if (taskPolling) clearInterval(taskPolling)
  profileBackups?.stop()
  void taskService?.close().catch(() => {})
  updates?.stop()
  interchangeService?.dispose()
  interchangeStore?.close()
  interchangeStore = null
  productivityStore?.close()
  messageLocalStore?.close()
  mailTemplateStore?.close()
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
  // A tray preference cannot keep a windowless, unreachable process alive.
  if (process.platform !== 'darwin') app.quit()
})
