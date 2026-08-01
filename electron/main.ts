import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, Notification, protocol, shell, Tray } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import initSqlJs, { type Database } from 'sql.js'
import { createDemoState } from '../src/demo-data'
import type { AppState, Attachment, MessageWindowRequest } from '../src/types'
import type {
  ApplyMailActionInput,
  GmailAccountSummary,
  GmailDraftInput,
  GmailLabel,
  GmailThreadDetail,
  ImapAccountInput,
  MailPage,
  MailQuery,
  MailStorageStats,
  PendingOperation,
  SyncProgress
} from '../src/gmail-types'
import { OAuthVault } from './mail/oauth-vault'
import { ImapSmtpClient } from './mail/imap-client'
import { PROVIDER_PRESETS, validateImapAccount } from './mail/provider-presets'
import { MailWorkerClient } from './mail/worker-client'

protocol.registerSchemesAsPrivileged([
  { scheme: 'aerio-image', privileges: { secure: true, standard: true, supportFetchAPI: true, bypassCSP: false } }
])

let mainWindow: BrowserWindow | null = null
const messageWindows = new Map<string, BrowserWindow>()
let tray: Tray | null = null
let database: Database | null = null
let databasePath = ''
let oauthVault: OAuthVault | null = null
let mailWorker: MailWorkerClient | null = null
const accountProviders = new Map<string, GmailAccountSummary['provider']>()
const approvedAttachmentPaths = new Set<string>()
let quitting = false
let lastBoundsWrite: NodeJS.Timeout | undefined

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

function persistDatabase() {
  if (!database) return
  const data = Buffer.from(database.export())
  const temporaryPath = `${databasePath}.tmp`
  writeFileSync(temporaryPath, data)
  renameSync(temporaryPath, databasePath)
}

async function initializeDatabase() {
  const userData = app.getPath('userData')
  const legacyPath = join(userData, 'aerio.sqlite')
  databasePath = join(userData, 'aerio-demo.sqlite')
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
  const wasmBase = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'sql.js', 'dist')
    : join(app.getAppPath(), 'node_modules', 'sql.js', 'dist')
  const SQL = await initSqlJs({ locateFile: (file) => join(wasmBase, file) })
  database = existsSync(databasePath)
    ? new SQL.Database(readFileSync(databasePath))
    : new SQL.Database()
  database.run(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  const result = database.exec('SELECT payload FROM app_state WHERE id = 1')
  if (!result.length) saveState(createDemoState())
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

function validateDraft(input: GmailDraftInput) {
  if (input.attachmentPaths.some((path) => !approvedAttachmentPaths.has(path))) {
    throw new Error('A draft referenced a file that was not selected through Aerio')
  }
  return input
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

async function initializeMail() {
  const userData = app.getPath('userData')
  oauthVault = new OAuthVault(join(userData, 'oauth-vault.dat'))
  mailWorker = new MailWorkerClient(
    join(__dirname, 'mail-worker.js'),
    (accountId) => requireVault().credential(accountId, accountProviders.get(accountId) ?? 'gmail'),
    (event) => mainWindow?.webContents.send('gmail:event', event)
  )
  await mailWorker.request({
    type: 'initialize',
    payload: {
      databasePath: join(userData, 'aerio.sqlite'),
      contentPath: join(userData, 'mail')
    }
  })
  const accounts = await mailWorker.request<GmailAccountSummary[]>({ type: 'accounts:list' })
  for (const account of accounts) accountProviders.set(account.id, account.provider)
}

const accountColors = ['#1d7a62', '#3b6fd8', '#8a5dc7', '#c2673d', '#b04d73', '#5d7589']
function accountColor(accountId: string) {
  return accountColors[Number.parseInt(accountId.slice(0, 2), 16) % accountColors.length]
}

function registerRemoteImageProtocol() {
  protocol.handle('aerio-image', async (request) => {
    try {
      const url = new URL(request.url)
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
  const result = database.exec('SELECT payload FROM app_state WHERE id = 1')
  if (!result.length) return createDemoState()
  const parsed: unknown = JSON.parse(String(result[0].values[0][0]))
  if (!validState(parsed)) throw new Error('Stored Aerio data is invalid')
  return parsed
}

function saveState(state: AppState) {
  if (!database) throw new Error('Aerio database is not ready')
  if (!validState(state)) throw new Error('Refusing to save invalid Aerio data')
  const updatedAt = new Date().toISOString()
  database.run(
    `INSERT INTO app_state (id, schema_version, payload, updated_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       schema_version = excluded.schema_version,
       payload = excluded.payload,
       updated_at = excluded.updated_at`,
    [state.schemaVersion, JSON.stringify(state), updatedAt]
  )
  persistDatabase()
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
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
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
    void window.loadFile(join(__dirname, '../../dist/index.html'), query ? { query } : undefined)
  }
}

function validMessageWindowRequest(value: unknown): value is MessageWindowRequest {
  if (!value || typeof value !== 'object') return false
  const input = value as Partial<MessageWindowRequest> & { accountId?: unknown; threadId?: unknown }
  const validText = (text: unknown) => typeof text === 'string' && text.length > 0 && text.length <= 1_000
  if (!validText(input.title)) return false
  if (input.source === 'demo') return validText(input.messageId)
  return input.source === 'gmail' && validText(input.accountId) && validText(input.threadId)
}

function createMessageWindow(input: MessageWindowRequest) {
  const key = input.source === 'demo' ? `demo:${input.messageId}` : `gmail:${input.accountId}:${input.threadId}`
  const existing = messageWindows.get(key)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
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
      preload: join(__dirname, '../preload/preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  messageWindows.set(key, messageWindow)
  configureRendererWindow(messageWindow)
  messageWindow.once('ready-to-show', () => messageWindow.show())
  messageWindow.once('closed', () => messageWindows.delete(key))
  loadRenderer(messageWindow, input.source === 'demo'
    ? { view: 'message', source: 'demo', messageId: input.messageId }
    : { view: 'message', source: 'gmail', accountId: input.accountId, threadId: input.threadId })
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
      preload: join(__dirname, '../preload/preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
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
  mainWindow.on('show', () => void mailWorker?.request({ type: 'polling', payload: { intervalMs: 60_000 } }))
  mainWindow.on('hide', () => void mailWorker?.request({ type: 'polling', payload: { intervalMs: 5 * 60_000 } }))
  mainWindow.on('close', (event) => {
    const closeToTray = loadState().settings.closeToTray
    if (!quitting && closeToTray) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })
  configureRendererWindow(mainWindow)
  loadRenderer(mainWindow, process.env.AERIO_CAPTURE_PATH ? { workspace: 'gmail' } : undefined)
  return mainWindow
}

function openMainWindow(compose = false) {
  if (!mainWindow) {
    const window = createWindow()
    if (compose) window.webContents.once('did-finish-load', () => window.webContents.send('command:compose'))
    return
  }
  mainWindow.show()
  mainWindow.focus()
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
    if (Notification.isSupported()) new Notification({ title: input.title.slice(0, 80), body: input.body.slice(0, 240), icon: iconPath() }).show()
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
  ipcMain.handle('gmail:accounts:list', () => requireMailWorker().request<GmailAccountSummary[]>({ type: 'accounts:list' }))
  ipcMain.handle('gmail:accounts:connect', async () => {
    const authorized = await requireVault().authorize()
    const account: GmailAccountSummary = {
      id: authorized.accountId,
      provider: 'gmail',
      email: authorized.email,
      displayName: authorized.email.split('@')[0],
      color: accountColor(authorized.accountId),
      status: 'connecting',
      archived: false
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
    const account: GmailAccountSummary = {
      id: authorized.accountId,
      provider: 'microsoft',
      email: authorized.email,
      displayName: authorized.displayName,
      color: accountColor(authorized.accountId),
      status: 'connecting',
      archived: false
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
    const account: GmailAccountSummary = {
      id: accountId,
      provider: input.provider,
      email: input.email,
      displayName: input.displayName?.trim() || input.email.split('@')[0],
      color: accountColor(accountId),
      status: 'connecting',
      archived: false
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
  ipcMain.handle('gmail:accounts:disconnect', async (_event, accountId: string, mode: 'archive' | 'delete') => {
    await requireVault().remove(accountId)
    await requireMailWorker().request({ type: 'accounts:disconnect', payload: { accountId, mode } })
    accountProviders.delete(accountId)
  })
  ipcMain.handle('gmail:labels:list', (_event, accountIds?: string[]) =>
    requireMailWorker().request<GmailLabel[]>({ type: 'labels:list', payload: { accountIds } }))
  ipcMain.handle('gmail:mail:list', (_event, query: MailQuery) =>
    requireMailWorker().request<MailPage>({ type: 'mail:list', payload: query }))
  ipcMain.handle('gmail:mail:thread', (_event, accountId: string, threadId: string, allowRemoteImages?: boolean) =>
    requireMailWorker().request<GmailThreadDetail>({ type: 'mail:thread', payload: { accountId, threadId, allowRemoteImages } }))
  ipcMain.handle('gmail:mail:action', (_event, input: ApplyMailActionInput) =>
    requireMailWorker().request<PendingOperation>({ type: 'mail:action', payload: input }))
  ipcMain.handle('gmail:mail:undo', (_event, operationId: string) =>
    requireMailWorker().request<boolean>({ type: 'mail:undo', payload: { operationId } }))
  ipcMain.handle('gmail:drafts:save', (_event, input: GmailDraftInput) =>
    requireMailWorker().request({ type: 'drafts:save', payload: validateDraft(input) }))
  ipcMain.handle('gmail:drafts:send', (_event, input: GmailDraftInput) =>
    requireMailWorker().request({ type: 'drafts:send', payload: validateDraft(input) }))
  ipcMain.handle('gmail:sync:start', (_event, accountId?: string) =>
    requireMailWorker().request({ type: 'sync:start', payload: { accountId } }))
  ipcMain.handle('gmail:sync:pause', (_event, accountId: string) =>
    requireMailWorker().request({ type: 'sync:pause', payload: { accountId } }))
  ipcMain.handle('gmail:sync:resume', (_event, accountId: string) =>
    requireMailWorker().request({ type: 'sync:resume', payload: { accountId } }))
  ipcMain.handle('gmail:sync:progress', () =>
    requireMailWorker().request<SyncProgress[]>({ type: 'sync:progress' }))
  ipcMain.handle('gmail:storage', () =>
    requireMailWorker().request<MailStorageStats>({ type: 'storage:stats' }))
  ipcMain.handle('gmail:network', (_event, online: boolean) =>
    requireMailWorker().request({ type: 'network', payload: { online } }))
  ipcMain.handle('gmail:attachment:open', async (_event, accountId: string, messageId: string, attachmentId: string, filename: string) => {
    const directory = join(tmpdir(), 'aerio-attachments')
    mkdirSync(directory, { recursive: true })
    const targetPath = join(directory, `${crypto.randomUUID()}-${safeFilename(filename)}`)
    await requireMailWorker().request({ type: 'attachment:extract', payload: { accountId, messageId, attachmentId, targetPath } })
    const error = await shell.openPath(targetPath)
    return error ? { error } : {}
  })
  ipcMain.handle('gmail:attachment:save', async (_event, accountId: string, messageId: string, attachmentId: string, filename: string) => {
    const options: Electron.SaveDialogOptions = { title: 'Save attachment', defaultPath: safeFilename(filename) }
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return {}
    await requireMailWorker().request({ type: 'attachment:extract', payload: { accountId, messageId, attachmentId, targetPath: result.filePath } })
    return { savedPath: result.filePath }
  })
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  await initializeDatabase()
  await initializeMail()
  registerIpc()
  registerRemoteImageProtocol()
  createWindow()
  createTray()

  app.on('activate', () => {
    if (!mainWindow) createWindow()
    else mainWindow.show()
  })
})

app.on('before-quit', () => {
  quitting = true
  void mailWorker?.close()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !loadState().settings.closeToTray) app.quit()
})
