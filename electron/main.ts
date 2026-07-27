import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, Tray } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import initSqlJs, { type Database } from 'sql.js'
import { createDemoState } from '../src/demo-data'
import type { AppState, Attachment } from '../src/types'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let database: Database | null = null
let databasePath = ''
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
  databasePath = join(app.getPath('userData'), 'aerio.sqlite')
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

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('resize', saveBounds)
  mainWindow.on('move', saveBounds)
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized-state', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized-state', false))
  mainWindow.on('close', (event) => {
    const closeToTray = loadState().settings.closeToTray
    if (!quitting && closeToTray) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../../dist/index.html'))
  }
}

function createTray() {
  const path = iconPath()
  const image = path ? nativeImage.createFromPath(path).resize({ width: 20, height: 20 }) : nativeImage.createEmpty()
  tray = new Tray(image)
  tray.setToolTip('Aerio')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Aerio', click: () => { mainWindow?.show(); mainWindow?.focus() } },
    { type: 'separator' },
    { label: 'Compose message', click: () => { mainWindow?.show(); mainWindow?.webContents.send('command:compose') } },
    { type: 'separator' },
    { label: 'Quit Aerio', click: () => { quitting = true; app.quit() } }
  ]))
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus() })
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
    return result.filePaths.map((path) => ({
      id: crypto.randomUUID(),
      name: basename(path),
      size: 0,
      path,
      mime: extname(path).slice(1)
    }))
  })
  ipcMain.handle('notification:show', (_event, input: { title: string; body: string }) => {
    if (Notification.isSupported()) new Notification({ title: input.title.slice(0, 80), body: input.body.slice(0, 240), icon: iconPath() }).show()
  })
  ipcMain.handle('window:minimize', () => mainWindow?.minimize())
  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize()
    else mainWindow?.maximize()
  })
  ipcMain.handle('window:close', () => mainWindow?.close())
  ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false)
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  await initializeDatabase()
  registerIpc()
  createWindow()
  createTray()

  app.on('activate', () => {
    if (!mainWindow) createWindow()
    else mainWindow.show()
  })
})

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !loadState().settings.closeToTray) app.quit()
})
