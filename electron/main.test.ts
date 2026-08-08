import { beforeAll, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  process.env.AERIO_TEST_HIDDEN = '1'
  delete process.env.AERIO_CAPTURE_PATH
  delete process.env.ELECTRON_RENDERER_URL

  const ipcHandlers = new Map<string, (...args: any[]) => any>()
  const appHandlers = new Map<string, (...args: any[]) => any>()
  const protocolHandlers = new Map<string, (request: { url: string }) => Promise<Response>>()
  const windows: any[] = []
  let preferencesPayload: string | undefined
  let accounts: any[] = [{
    id: 'a1b2', provider: 'gmail', email: 'person@example.test', displayName: 'Person', color: '#123456',
    status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true
  }]
  let workerFailure: Error | undefined
  let dialogOpenResult: any = { canceled: true, filePaths: [] }
  let dialogSaveResult: any = { canceled: true }
  let storeSnapshot: any = { calendars: [], events: [], contacts: [], sync: [] }
  let statResult: any = { size: 12, isFile: () => true }
  let readResult: string | Error = new Error('missing')

  class FakeWebContents {
    handlers = new Map<string, (...args: any[]) => any>()
    onceHandlers = new Map<string, (...args: any[]) => any>()
    send = vi.fn()
    setWindowOpenHandler = vi.fn((handler: (...args: any[]) => any) => { this.handlers.set('window-open', handler) })
    on = vi.fn((event: string, handler: (...args: any[]) => any) => { this.handlers.set(event, handler) })
    once = vi.fn((event: string, handler: (...args: any[]) => any) => { this.onceHandlers.set(event, handler) })
    getURL = vi.fn(() => 'file:///aerio/index.html')
    capturePage = vi.fn(async () => ({ toPNG: () => Buffer.from('capture') }))
  }

  class FakeBrowserWindow {
    static getAllWindows = vi.fn(() => windows.filter((window) => !window.destroyed))
    static fromWebContents = vi.fn((sender: any) => windows.find((window) => window.webContents === sender))
    webContents = new FakeWebContents()
    handlers = new Map<string, (...args: any[]) => any>()
    onceHandlers = new Map<string, (...args: any[]) => any>()
    destroyed = false
    minimized = false
    maximized = false
    visible = true
    focused = true
    constructor(public options: any) { windows.push(this) }
    on = vi.fn((event: string, handler: (...args: any[]) => any) => { this.handlers.set(event, handler); return this })
    once = vi.fn((event: string, handler: (...args: any[]) => any) => { this.onceHandlers.set(event, handler); return this })
    loadFile = vi.fn(async () => undefined)
    loadURL = vi.fn(async () => undefined)
    isDestroyed = vi.fn(() => this.destroyed)
    isMinimized = vi.fn(() => this.minimized)
    isMaximized = vi.fn(() => this.maximized)
    isVisible = vi.fn(() => this.visible)
    isFocused = vi.fn(() => this.focused)
    minimize = vi.fn(() => { this.minimized = true })
    maximize = vi.fn(() => { this.maximized = true })
    unmaximize = vi.fn(() => { this.maximized = false })
    restore = vi.fn(() => { this.minimized = false })
    show = vi.fn(() => { this.visible = true })
    hide = vi.fn(() => { this.visible = false })
    focus = vi.fn(() => { this.focused = true })
    close = vi.fn()
    getBounds = vi.fn(() => ({ x: 10, y: 20, width: 1200, height: 800 }))
  }

  class FakeDatabaseSync {
    exec = vi.fn()
    close = vi.fn()
    prepare = vi.fn((sql: string) => ({
      get: vi.fn(() => sql.includes('SELECT payload') && preferencesPayload ? { payload: preferencesPayload } : undefined),
      run: vi.fn((_schema: number, payload: string) => { if (sql.includes('INSERT INTO app_preferences')) preferencesPayload = payload })
    }))
  }

  const vault = {
    status: vi.fn(() => ({ configured: true })), microsoftStatus: vi.fn(() => ({ configured: true })),
    configureMicrosoft: vi.fn((clientId: string) => ({ clientId })), importConfig: vi.fn(() => ({ configured: true })),
    authorize: vi.fn(async () => ({ accountId: 'abcdef', email: 'google@example.test' })),
    authorizeMicrosoft: vi.fn(async () => ({ accountId: '123456', email: 'ms@example.test', displayName: 'Microsoft Person' })),
    credential: vi.fn(() => ({ type: 'oauth', accessToken: 'token' })), accessToken: vi.fn(async () => 'google-token'),
    microsoftAccessToken: vi.fn(async () => 'microsoft-token'), hasGoogleCalendarWriteAccess: vi.fn(() => true),
    hasMicrosoftCalendarWriteAccess: vi.fn(() => true), hasGoogleContactsWriteAccess: vi.fn(() => true),
    hasMicrosoftContactsWriteAccess: vi.fn(() => true),
    remove: vi.fn(async () => undefined), imapSettings: vi.fn(() => ({ imapHost: 'imap.example.test' })),
    imapCredential: vi.fn(() => ({ provider: 'imap', email: 'imap@example.test', username: 'imap@example.test', password: 'old' })),
    storeImap: vi.fn()
  }
  const worker = {
    request: vi.fn(async (command: any): Promise<any> => {
      if (workerFailure) { const error = workerFailure; workerFailure = undefined; throw error }
      switch (command.type) {
        case 'accounts:list': return accounts
        case 'drafts:list': return [{ id: 'draft-1', attachmentPaths: ['C:\\approved.txt'] }]
        case 'drafts:get': return { id: command.payload.id, attachmentPaths: ['C:\\approved-get.txt'] }
        case 'drafts:stage-message-attachments': return [{ path: 'C:\\staged.txt', name: 'staged.txt', size: 1 }]
        case 'diagnostics:health': return { integrity: 'ok' }
        default: return { command: command.type, payload: command.payload }
      }
    }),
    close: vi.fn(async () => undefined)
  }
  let workerEvent: ((event: any) => void) | undefined
  const MailWorkerClient = vi.fn(function (_path: string, _credential: any, event: (value: any) => void) {
    workerEvent = event
    return worker
  })

  const store = {
    snapshot: vi.fn(() => storeSnapshot), localSnapshot: vi.fn(() => ({ tasks: [], notes: [] })), saveLocal: vi.fn(),
    setSyncing: vi.fn(), setError: vi.fn(), replaceAccount: vi.fn((_id: string, _provider: string, data: any) => {
      storeSnapshot = { ...storeSnapshot, ...data }
    }), removeAccount: vi.fn(), upsertEvent: vi.fn(), deleteEvent: vi.fn(), upsertContact: vi.fn(), deleteContact: vi.fn(), close: vi.fn()
  }
  const google = {
    sync: vi.fn(async () => ({ calendars: [], events: [], contacts: [] })),
    createEvent: vi.fn(async (_calendar: any, input: any) => ({ ...input, accountId: 'a1b2', provider: 'gmail', remoteId: 'remote', readOnly: false })),
    updateEvent: vi.fn(async (_calendar: any, _current: any, input: any) => ({ ...input, accountId: 'a1b2', provider: 'gmail', remoteId: 'remote', readOnly: false })),
    deleteEvent: vi.fn(async () => undefined),
    createContact: vi.fn(async (input: any) => ({ ...input, id: 'a1b2:google-contact:people/new', accountId: 'a1b2', provider: 'gmail', remoteId: 'people/new', readOnly: false })),
    updateContact: vi.fn(async (_current: any, input: any) => ({ ...input, accountId: 'a1b2', provider: 'gmail', remoteId: 'people/existing', readOnly: false })),
    deleteContact: vi.fn(async () => undefined)
  }
  const microsoft = {
    sync: vi.fn(async () => ({ calendars: [], events: [], contacts: [] })),
    createEvent: vi.fn(async (_calendar: any, input: any) => ({ ...input, accountId: '123456', provider: 'microsoft', remoteId: 'remote', readOnly: false })),
    updateEvent: vi.fn(async (_calendar: any, _current: any, input: any) => ({ ...input, accountId: '123456', provider: 'microsoft', remoteId: 'remote', readOnly: false })),
    deleteEvent: vi.fn(async () => undefined),
    createContact: vi.fn(async (input: any) => ({ ...input, id: '123456:microsoft-contact:new', accountId: '123456', provider: 'microsoft', remoteId: 'new', readOnly: false })),
    updateContact: vi.fn(async (_current: any, input: any) => ({ ...input, accountId: '123456', provider: 'microsoft', remoteId: 'existing', readOnly: false })),
    deleteContact: vi.fn(async () => undefined)
  }
  const updateManager = {
    status: vi.fn(() => ({ phase: 'idle', currentVersion: '0.4.0' })), check: vi.fn(async () => ({ phase: 'current' })),
    download: vi.fn(async () => ({ phase: 'ready' })), install: vi.fn(), start: vi.fn(), stop: vi.fn()
  }
  const diagnosticLogger = { log: vi.fn(), exportBundle: vi.fn() }
  const imapClient = { verify: vi.fn(async () => undefined) }
  const image = {
    isEmpty: vi.fn(() => false), getSize: vi.fn(() => ({ width: 512, height: 256 })),
    resize: vi.fn(() => image), toDataURL: vi.fn(() => 'data:image/png;base64,AA=='), toPNG: vi.fn(() => Buffer.from('png'))
  }

  return {
    ipcHandlers, appHandlers, protocolHandlers, windows, FakeBrowserWindow, FakeDatabaseSync,
    vault, worker, MailWorkerClient, store, google, microsoft, updateManager, diagnosticLogger, imapClient, image,
    get accounts() { return accounts }, set accounts(value: any[]) { accounts = value },
    failWorker(error: Error) { workerFailure = error }, emitWorker(event: any) { workerEvent?.(event) },
    setOpenResult(value: any) { dialogOpenResult = value }, setSaveResult(value: any) { dialogSaveResult = value },
    setStoreSnapshot(value: any) { storeSnapshot = value },
    setStatResult(value: any) { statResult = value },
    setReadResult(value: string | Error) { readResult = value },
    app: {
      isPackaged: false, requestSingleInstanceLock: vi.fn(() => true), quit: vi.fn(), setAppUserModelId: vi.fn(),
      getPath: vi.fn(() => 'C:\\aerio-test'), getAppPath: vi.fn(() => 'C:\\aerio'), getVersion: vi.fn(() => '0.4.0'),
      on: vi.fn((event: string, handler: (...args: any[]) => any) => { appHandlers.set(event, handler) }),
      whenReady: vi.fn(() => Promise.resolve())
    },
    ipcMain: { handle: vi.fn((channel: string, handler: (...args: any[]) => any) => ipcHandlers.set(channel, handler)) },
    dialog: {
      showOpenDialog: vi.fn(async () => dialogOpenResult), showSaveDialog: vi.fn(async () => dialogSaveResult)
    },
    protocol: {
      registerSchemesAsPrivileged: vi.fn(),
      handle: vi.fn((scheme: string, handler: (request: { url: string }) => Promise<Response>) => protocolHandlers.set(scheme, handler))
    },
    shell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => '') },
    nativeImage: { createFromPath: vi.fn(() => image), createFromBuffer: vi.fn(() => image), createEmpty: vi.fn(() => image) },
    Notification: class {
      static isSupported(): boolean { return true }
      on = vi.fn(); show = vi.fn()
      constructor(public options: any) {}
    },
    Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn((template: any[]) => template) },
    Tray: class { setToolTip = vi.fn(); setContextMenu = vi.fn(); on = vi.fn() },
    fs: {
      existsSync: vi.fn(() => false), mkdirSync: vi.fn(), readFileSync: vi.fn(() => { if (readResult instanceof Error) throw readResult; return readResult }),
      statSync: vi.fn(() => { if (statResult instanceof Error) throw statResult; return statResult }), writeFileSync: vi.fn()
    },
    lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    net: { fetch: vi.fn(async () => new Response(Uint8Array.from([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } })) },
    validateImap: vi.fn((input: any) => input)
  }
})

vi.mock('electron', () => ({
  app: mocks.app, BrowserWindow: mocks.FakeBrowserWindow, dialog: mocks.dialog, ipcMain: mocks.ipcMain,
  Menu: mocks.Menu, nativeImage: mocks.nativeImage, net: mocks.net, Notification: mocks.Notification,
  protocol: mocks.protocol, shell: mocks.shell, Tray: mocks.Tray
}))
vi.mock('node:fs', () => mocks.fs)
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }))
vi.mock('node:sqlite', () => ({ DatabaseSync: mocks.FakeDatabaseSync }))
vi.mock('./mail/oauth-vault', () => ({ OAuthVault: vi.fn(function () { return mocks.vault }) }))
vi.mock('./mail/worker-client', () => ({ MailWorkerClient: mocks.MailWorkerClient }))
vi.mock('./mail/imap-client', () => ({ ImapSmtpClient: vi.fn(function () { return mocks.imapClient }) }))
vi.mock('./mail/provider-presets', () => ({ PROVIDER_PRESETS: [{ id: 'gmail' }], validateImapAccount: mocks.validateImap }))
vi.mock('./diagnostics', () => ({ DiagnosticLogger: vi.fn(function () { return mocks.diagnosticLogger }) }))
vi.mock('./update-manager', () => ({ UpdateManager: vi.fn(function () { return mocks.updateManager }) }))
vi.mock('./productivity/store', () => ({ ProductivityStore: vi.fn(function () { return mocks.store }) }))
vi.mock('./productivity/google-connector', () => ({ GoogleProductivityConnector: vi.fn(function () { return mocks.google }) }))
vi.mock('./productivity/microsoft-connector', () => ({ MicrosoftProductivityConnector: vi.fn(function () { return mocks.microsoft }) }))

const event = () => ({ sender: mocks.windows[0]?.webContents ?? {} })
const invoke = (channel: string, ...args: any[]) => {
  const handler = mocks.ipcHandlers.get(channel)
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`)
  return handler(event(), ...args)
}

describe.sequential('Electron main process', () => {
  beforeAll(async () => {
    await import('./main')
    await vi.waitFor(() => expect(mocks.ipcHandlers.size).toBeGreaterThan(40))
  })

  it('boots storage, mail, updates, a secured renderer window, and the remote-image protocol', async () => {
    expect(mocks.app.requestSingleInstanceLock).toHaveBeenCalledOnce()
    expect(mocks.MailWorkerClient).toHaveBeenCalledOnce()
    expect(mocks.worker.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'initialize' }))
    expect(mocks.updateManager.start).toHaveBeenCalledOnce()
    expect(mocks.windows).toHaveLength(1)
    expect(mocks.windows[0].options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false })
    expect(mocks.protocolHandlers.has('aerio-image')).toBe(true)
    expect(await invoke('preferences:load')).toMatchObject({ schemaVersion: 1, settings: { theme: 'system' } })
  })

  it('validates and saves preferences and local productivity data', async () => {
    const preferences = { schemaVersion: 1 as const, settings: { theme: 'dark', density: 'compact', closeToTray: false, notifications: true, startModule: 'calendar' } }
    expect(invoke('preferences:save', preferences)).toHaveProperty('savedAt')
    expect(await invoke('preferences:load')).toMatchObject(preferences)
    expect(() => invoke('preferences:save', { settings: { theme: 'ultraviolet' } })).toThrow(/invalid/)

    await invoke('productivity:local-save', {
      tasks: [{ id: 'task', listId: 'Today', title: 'Test', priority: 'normal', completed: false, subtasks: [] }],
      notes: [{ id: 'note', folder: 'Notes', title: 'Note', content: 'Body', tags: [], pinned: false, archived: false, updatedAt: '2026-08-08T10:00:00Z' }]
    })
    expect(mocks.store.saveLocal).toHaveBeenCalled()
    expect(() => invoke('productivity:local-save', { tasks: 'bad', notes: [] })).toThrow(/invalid/)
    expect(() => invoke('productivity:sync', '')).toThrow(/valid account/)
    await expect(invoke('productivity:sync', 'a1b2')).resolves.toMatchObject({ calendars: [] })
    expect(invoke('productivity:snapshot')).toBe(mocks.store.snapshot())
    expect(invoke('productivity:local-snapshot')).toEqual({ tasks: [], notes: [] })
  })

  it('rejects every unsafe preference and local-data shape while preserving valid profile fields', () => {
    const base = { theme: 'system', density: 'comfortable', closeToTray: true, notifications: true, startModule: 'mail' }
    for (const settings of [
      null, { ...base, density: 'wide' }, { ...base, closeToTray: 'yes' }, { ...base, notifications: 1 },
      { ...base, startModule: 'weather' }, { ...base, profile: null }, { ...base, profile: { displayName: 123 } }
    ]) expect(() => invoke('preferences:save', { schemaVersion: 1, settings })).toThrow(/invalid/)
    const profile = { ...base, profile: { displayName: 'Aerio User', email: 'person@example.test', avatarDataUrl: 'data:image/png;base64,AA==' } }
    expect(invoke('preferences:save', { schemaVersion: 1, settings: profile })).toHaveProperty('savedAt')
    for (const snapshot of [
      null, { tasks: [], notes: 'bad' }, { tasks: [{ id: 1, title: 'Task' }], notes: [] },
      { tasks: [], notes: [{ id: 'note', title: 'Note' }] }
    ]) expect(() => invoke('productivity:local-save', snapshot)).toThrow(/invalid/)
  })

  it('routes standard account, message, action, rule, sync, and diagnostics commands', async () => {
    expect(await invoke('gmail:credentials:status')).toEqual({ configured: true })
    expect(await invoke('mail:credentials:microsoft-status')).toEqual({ configured: true })
    expect(await invoke('mail:credentials:microsoft-configure', 'client')).toEqual({ clientId: 'client' })
    expect(await invoke('mail:providers:presets')).toEqual([{ id: 'gmail' }])
    for (const [channel, args] of [
      ['mail:accounts:list', []], ['mail:labels:list', [['a1b2']]], ['mail:recipients:suggest', ['ada', ['a1b2']]],
      ['mail:threads:list', [{ folder: 'inbox' }]], ['mail:folders:unread-counts', [['a1b2']]], ['mail:accounts:unread-counts', []], ['mail:threads:get', ['a1b2', 'thread', true]],
      ['mail:message:source', ['a1b2', 'message']], ['mail:actions:apply', [{ action: 'archive' }]],
      ['mail:actions:undo', ['operation']], ['mail:rules:list', [['a1b2']]], ['mail:sync:start', ['a1b2']],
      ['mail:sync:pause', ['a1b2']], ['mail:sync:resume', ['a1b2']], ['mail:sync:rebuild', ['a1b2']],
      ['mail:sync:progress', []], ['mail:storage', []], ['mail:diagnostics:health', []], ['mail:network', [true]]
    ] as Array<[string, any[]]>) await invoke(channel, ...args)
    const routed = mocks.worker.request.mock.calls.map(([command]) => command.type)
    expect(routed).toEqual(expect.arrayContaining(['mail:list', 'mail:unread-counts', 'mail:account-unread-counts', 'mail:thread', 'mail:action', 'rules:list', 'sync:rebuild', 'storage:stats']))
  })

  it('accepts unfinished recipients while saving but requires complete recipients when sending', async () => {
    const draft = { id: 'draft', accountId: 'a1b2', to: ['unfinished'], cc: [], bcc: [], subject: 'Hello', text: 'Body', attachmentPaths: [] }
    await expect(invoke('mail:drafts:save', draft)).resolves.toMatchObject({ command: 'drafts:save' })
    expect(() => invoke('mail:drafts:send', draft)).toThrow(/Finish or correct/)
    const sendable = { ...draft, to: ['reader@example.test'] }
    await invoke('mail:drafts:send', sendable)
    await invoke('mail:drafts:schedule', sendable, new Date(Date.now() + 60_000).toISOString())
    await expect(invoke('mail:drafts:list', ['a1b2'])).resolves.toHaveLength(1)
    await expect(invoke('mail:drafts:get', 'draft-1')).resolves.toMatchObject({ id: 'draft-1' })
    await invoke('mail:drafts:stage-message-attachments', 'draft', 'a1b2', 'message')
    await invoke('mail:drafts:save', { ...sendable, attachmentPaths: ['C:\\approved.txt', 'C:\\approved-get.txt', 'C:\\staged.txt'] })
    await invoke('mail:drafts:cancel-send', 'draft')
    await invoke('mail:drafts:delete', 'draft')
  })

  it('rejects malformed draft, snooze, rule, account, and message-window requests', async () => {
    const emptyDraft = { accountId: '', to: [], cc: [], bcc: [], subject: '', text: '', attachmentPaths: [] }
    expect(() => invoke('mail:drafts:save', emptyDraft)).toThrow(/sending account/)
    expect(() => invoke('mail:drafts:send', { ...emptyDraft, accountId: 'a1b2' })).toThrow(/recipient/)
    expect(() => invoke('mail:drafts:cancel-send', '')).toThrow(/queued message id/)
    await expect(invoke('mail:drafts:get', '')).rejects.toThrow(/draft id/)
    await expect(invoke('mail:drafts:stage-message-attachments', '', 'a1b2', 'message')).rejects.toThrow(/staging/)
    expect(() => invoke('mail:snooze', '', [], new Date(Date.now() + 60_000).toISOString())).toThrow(/valid conversations/)
    expect(() => invoke('mail:unsnooze', 'a1b2', [])).toThrow(/valid conversations/)
    expect(() => invoke('mail:rules:delete', '')).toThrow(/rule id/)
    expect(() => invoke('mail:rules:run', '')).toThrow(/rule id/)
    expect(() => invoke('mail:accounts:verify', '')).toThrow(/account id/)
    expect(() => invoke('window:open-message', { source: 'connected' })).toThrow(/Invalid message/)
  })

  it('enforces draft limits, approved attachments, and safe future dates', () => {
    const draft = { id: 'draft', accountId: 'a1b2', to: ['reader@example.test'], cc: [], bcc: [], subject: 'Subject', text: 'Body', attachmentPaths: [] }
    for (const [change, message] of [
      [{ to: 'bad' }, /draft is invalid/], [{ id: '' }, /draft id/],
      [{ to: Array.from({ length: 501 }, () => 'a@example.test') }, /500 recipients/],
      [{ to: ['x'.repeat(501)] }, /recipient entry/], [{ subject: 'x'.repeat(999) }, /subject/],
      [{ text: 'x'.repeat(20_000_001) }, /body/], [{ attachmentPaths: Array.from({ length: 51 }, (_, i) => `file-${i}`) }, /50 attachments/],
      [{ attachmentPaths: ['C:\\not-approved.txt'] }, /not selected through Aerio/]
    ] as Array<[Record<string, unknown>, RegExp]>) expect(() => invoke('mail:drafts:save', { ...draft, ...change })).toThrow(message)
    expect(() => invoke('mail:drafts:schedule', draft, new Date(Date.now() - 1_000).toISOString())).toThrow(/future/)
    expect(() => invoke('mail:drafts:schedule', draft, new Date(Date.now() + 367 * 86_400_000).toISOString())).toThrow(/one year/)
    expect(() => invoke('mail:drafts:schedule', draft, 'not-a-date')).toThrow(/future/)
    mocks.setStatResult({ size: 12, isFile: () => false })
    expect(() => invoke('mail:drafts:save', { ...draft, attachmentPaths: ['C:\\approved.txt'] })).toThrow(/no longer available/)
    mocks.setStatResult({ size: 21 * 1024 * 1024, isFile: () => true })
    expect(() => invoke('mail:drafts:save', { ...draft, attachmentPaths: ['C:\\approved.txt'] })).toThrow(/20 MB/)
    mocks.setStatResult({ size: 12, isFile: () => true })
  })

  it('normalizes account settings, creates all account types, reconnects OAuth, and disconnects accounts', async () => {
    await invoke('mail:accounts:update', { accountId: 'a1b2', displayName: '  Renamed  ', color: '#abcdef', signature: '', notifications: true, syncEnabled: true })
    expect(() => invoke('mail:accounts:update', { displayName: '', color: '#bad', signature: '' })).toThrow(/sender name/)
    await expect(invoke('mail:accounts:connect')).resolves.toMatchObject({ provider: 'gmail', email: 'google@example.test' })
    await expect(invoke('mail:accounts:connect-microsoft')).resolves.toMatchObject({ provider: 'microsoft', displayName: 'Microsoft Person' })
    await expect(invoke('mail:accounts:connect-imap', { provider: 'imap', email: 'imap@example.test', username: 'imap@example.test', password: 'secret', imapHost: 'imap.example.test' }))
      .resolves.toMatchObject({ provider: 'imap' })

    mocks.accounts = [{ ...mocks.accounts[0], provider: 'gmail' }]
    await invoke('mail:accounts:reconnect', 'a1b2')
    expect(mocks.vault.authorize).toHaveBeenCalled()
    await invoke('mail:accounts:disconnect', 'a1b2', 'archive')
    expect(mocks.store.removeAccount).toHaveBeenCalledWith('a1b2')
  })

  it('validates reconnect and IMAP settings and cleans up failed account connections', async () => {
    mocks.accounts = []
    await expect(invoke('mail:accounts:reconnect', 'missing')).rejects.toThrow(/not found/)
    mocks.accounts = [{ id: 'imap-id', provider: 'imap', email: 'imap@example.test' }]
    await expect(invoke('mail:accounts:reconnect', 'imap-id')).rejects.toThrow(/IMAP account/)
    expect(invoke('mail:accounts:imap-settings', 'imap-id')).toEqual({ imapHost: 'imap.example.test' })
    await expect(invoke('mail:accounts:imap-update', 'imap-id', { password: ' new ' })).resolves.toEqual({ imapHost: 'imap.example.test' })
    await expect(invoke('mail:accounts:imap-update', 'imap-id', null)).rejects.toThrow(/valid IMAP/)
    await expect(invoke('mail:accounts:imap-update', 'imap-id', { password: 3 })).rejects.toThrow(/valid password/)

    mocks.failWorker(new Error('cannot add'))
    await expect(invoke('mail:accounts:connect')).rejects.toThrow('cannot add')
    expect(mocks.vault.remove).toHaveBeenCalledWith('abcdef')
    mocks.failWorker(new Error('cannot add Microsoft'))
    await expect(invoke('mail:accounts:connect-microsoft')).rejects.toThrow('cannot add Microsoft')
    expect(mocks.worker.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'accounts:disconnect' }))
    mocks.failWorker(new Error('cannot add IMAP'))
    await expect(invoke('mail:accounts:connect-imap', { provider: 'imap', email: 'imap@example.test', username: 'imap@example.test', password: 'secret', imapHost: 'imap.example.test' }))
      .rejects.toThrow('cannot add IMAP')
  })

  it('handles attachments, profile images, credential imports, and diagnostic exports', async () => {
    mocks.setOpenResult({ canceled: false, filePaths: ['C:\\folder\\report.pdf'] })
    await expect(invoke('files:choose')).resolves.toEqual([expect.objectContaining({ name: 'report.pdf', size: 12, mime: 'pdf' })])
    await expect(invoke('profile:image:choose')).resolves.toBe('data:image/png;base64,AA==')
    await expect(invoke('gmail:credentials:import')).resolves.toEqual({ configured: true })

    mocks.setSaveResult({ canceled: false, filePath: 'C:\\saved\\attachment.txt' })
    await expect(invoke('mail:attachment:save', 'a1b2', 'message', 'attachment', 'bad:<name>.txt')).resolves.toEqual({ savedPath: 'C:\\saved\\attachment.txt' })
    await expect(invoke('mail:attachment:open', 'a1b2', 'message', 'attachment', 'bad:<name>.txt')).resolves.toEqual({})
    await expect(invoke('mail:diagnostics:export')).resolves.toEqual({ savedPath: 'C:\\saved\\attachment.txt' })
    expect(mocks.diagnosticLogger.exportBundle).toHaveBeenCalled()
  })

  it('handles cancelled and invalid file dialogs without touching mail data', async () => {
    mocks.setOpenResult({ canceled: true, filePaths: [] })
    await expect(invoke('files:choose')).resolves.toEqual([])
    await expect(invoke('profile:image:choose')).resolves.toBeUndefined()
    await expect(invoke('gmail:credentials:import')).resolves.toEqual({ configured: true })
    mocks.setSaveResult({ canceled: true })
    await expect(invoke('mail:attachment:save', 'a1b2', 'message', 'attachment', 'file.txt')).resolves.toEqual({})
    await expect(invoke('mail:diagnostics:export')).resolves.toEqual({})
    mocks.shell.openPath.mockResolvedValueOnce('No application')
    await expect(invoke('mail:attachment:open', 'a1b2', 'message', 'attachment', 'file.txt')).resolves.toEqual({ error: 'No application' })
  })

  it('exports and restores validated local-data backups', async () => {
    const snapshot = {
      tasks: [{ id: 'task', listId: 'Today', title: 'Task', priority: 'normal', completed: false, subtasks: [] }],
      notes: [{ id: 'note', folder: 'Notes', title: 'Note', content: 'Body', tags: [], pinned: false, archived: false, updatedAt: '2026-08-08T10:00:00Z' }],
      contacts: [{ id: 'contact', name: 'Ada', email: 'ada@example.test', group: 'Personal', favorite: false, color: '#4d8f78', source: 'local' }]
    }
    mocks.store.localSnapshot.mockReturnValueOnce(snapshot as any)
    mocks.setSaveResult({ canceled: false, filePath: 'C:\\backup.json' })
    await expect(invoke('productivity:local-export')).resolves.toEqual({ savedPath: 'C:\\backup.json' })
    expect(mocks.fs.writeFileSync).toHaveBeenCalledWith('C:\\backup.json', expect.stringContaining('aerio-local-data'), expect.objectContaining({ encoding: 'utf8' }))

    mocks.setOpenResult({ canceled: false, filePaths: ['C:\\backup.json'] })
    mocks.setStatResult({ size: 1024, isFile: () => true })
    mocks.setReadResult(JSON.stringify({ format: 'aerio-local-data', schemaVersion: 1, exportedAt: '2026-08-08T10:00:00Z', data: snapshot }))
    await expect(invoke('productivity:local-import')).resolves.toEqual(snapshot)
    expect(mocks.store.saveLocal).toHaveBeenCalledWith(snapshot)

    mocks.setReadResult('{broken')
    await expect(invoke('productivity:local-import')).rejects.toThrow(/not a readable/)
    mocks.setOpenResult({ canceled: true, filePaths: [] })
    mocks.setSaveResult({ canceled: true })
  })

  it('creates and reuses message windows and enforces navigation rules', () => {
    const request = { source: 'connected', accountId: 'a1b2', threadId: 'thread', title: 'A message' }
    invoke('window:open-message', request)
    expect(mocks.windows).toHaveLength(2)
    invoke('window:open-message', request)
    expect(mocks.windows).toHaveLength(2)
    const messageWindow = mocks.windows[1]
    messageWindow.minimized = true
    invoke('window:open-message', request)
    expect(messageWindow.restore).toHaveBeenCalled()
    messageWindow.onceHandlers.get('ready-to-show')?.()
    messageWindow.onceHandlers.get('closed')?.()
    invoke('window:open-message', request)
    expect(mocks.windows).toHaveLength(3)
    const window = mocks.windows[0]
    invoke('window:minimize'); expect(window.minimize).toHaveBeenCalled()
    invoke('window:maximize'); expect(window.maximize).toHaveBeenCalled()
    invoke('window:maximize'); expect(window.unmaximize).toHaveBeenCalled()
    expect(invoke('window:is-maximized')).toBe(false)
    invoke('window:close'); expect(window.close).toHaveBeenCalled()

    const openHandler = window.webContents.handlers.get('window-open')!
    expect(openHandler({ url: 'about:blank', frameName: 'aerio-modal-settings' })).toMatchObject({ action: 'allow' })
    expect(openHandler({ url: 'https://example.test', frameName: '' })).toEqual({ action: 'deny' })
    expect(mocks.shell.openExternal).toHaveBeenCalledWith('https://example.test')
  })

  it('responds to renderer-window lifecycle and navigation events', async () => {
    const window = mocks.windows[0]
    window.handlers.get('maximize')?.()
    window.handlers.get('unmaximize')?.()
    expect(window.webContents.send).toHaveBeenCalledWith('window:maximized-state', true)
    const child = new mocks.FakeBrowserWindow({})
    window.webContents.handlers.get('did-create-window')?.(child, { frameName: 'aerio-modal-child' })
    expect(child.webContents.setWindowOpenHandler).toHaveBeenCalled()
    const preventDefault = vi.fn()
    window.webContents.handlers.get('will-navigate')?.({ preventDefault }, 'https://outside.example')
    expect(preventDefault).toHaveBeenCalled()
    window.webContents.handlers.get('will-navigate')?.({ preventDefault }, window.webContents.getURL())
    window.handlers.get('resize')?.(); window.handlers.get('move')?.()
    window.handlers.get('show')?.(); window.handlers.get('restore')?.(); window.handlers.get('hide')?.(); window.handlers.get('blur')?.(); window.handlers.get('minimize')?.()
    await vi.waitFor(() => expect(mocks.worker.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'polling' })))
    window.handlers.get('close')?.({ preventDefault })
    window.handlers.get('closed')?.()
    mocks.appHandlers.get('activate')?.()
    expect(mocks.windows.length).toBeGreaterThan(3)
  })

  it('proxies only safe remote images and validates sender favicon domains', async () => {
    const handle = mocks.protocolHandlers.get('aerio-image')!
    expect((await handle({ url: 'aerio-image://unknown/path' })).status).toBe(404)
    expect((await handle({ url: 'aerio-image://favicon/not%20a%20domain' })).status).toBe(403)
    expect((await handle({ url: 'aerio-image://favicon/example.com' })).status).toBe(200)
    const encoded = Buffer.from('https://example.com/image.png').toString('base64url')
    expect((await handle({ url: `aerio-image://fetch/${encoded}` })).status).toBe(200)
    const local = Buffer.from('http://localhost/private').toString('base64url')
    expect((await handle({ url: `aerio-image://fetch/${local}` })).status).toBe(403)
    expect((await handle({ url: 'aerio-image://fetch/not-valid-url' })).status).toBe(400)
  })

  it('blocks private DNS results, non-web schemes, empty images, and failed favicon requests', async () => {
    const handle = mocks.protocolHandlers.get('aerio-image')!
    const ftp = Buffer.from('ftp://example.com/image').toString('base64url')
    expect((await handle({ url: `aerio-image://fetch/${ftp}` })).status).toBe(403)
    const encoded = Buffer.from('https://private.example/image').toString('base64url')
    mocks.lookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }] as never)
    expect((await handle({ url: `aerio-image://fetch/${encoded}` })).status).toBe(403)
    mocks.net.fetch.mockResolvedValueOnce(new Response('', { status: 404 }))
    expect((await handle({ url: 'aerio-image://favicon/missing.example' })).status).toBe(404)
    mocks.net.fetch.mockResolvedValueOnce(new Response(Uint8Array.from([1]), { status: 200, headers: { 'content-length': String(600 * 1024) } }))
    expect((await handle({ url: 'aerio-image://favicon/large.example' })).status).toBe(404)
    mocks.net.fetch.mockResolvedValueOnce(new Response(Uint8Array.from([1]), { status: 200 }))
    mocks.image.isEmpty.mockReturnValueOnce(true)
    expect((await handle({ url: 'aerio-image://favicon/empty.example' })).status).toBe(404)
    mocks.net.fetch.mockRejectedValueOnce(new Error('network unavailable'))
    expect((await handle({ url: 'aerio-image://favicon/error.example' })).status).toBe(404)
    expect((await handle({ url: 'aerio-image://favicon/example.com' })).status).toBe(200)
  })

  it('covers Microsoft productivity sync and records connector failures', async () => {
    await invoke('mail:accounts:connect-microsoft')
    await expect(invoke('productivity:sync', '123456')).resolves.toMatchObject({ calendars: expect.any(Array) })
    expect(mocks.microsoft.sync).toHaveBeenCalled()
    await invoke('mail:accounts:connect')
    mocks.google.sync.mockRejectedValueOnce(new Error('Google productivity failed'))
    await expect(invoke('productivity:sync', 'abcdef')).rejects.toThrow('Google productivity failed')
    expect(mocks.store.setError).toHaveBeenCalledWith('abcdef', 'Google productivity failed')
  })

  it('runs valid mail snooze and filtering requests and validates event input', async () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    await invoke('mail:snooze', 'a1b2', ['thread'], future)
    await invoke('mail:unsnooze', 'a1b2', ['thread'])
    const rule = {
      accountId: 'a1b2', name: '  Newsletters ', enabled: true, match: 'all',
      conditions: [{ field: 'from', operator: 'contains', value: ' news@example.test ' }], actions: [{ action: 'archive' }]
    }
    await invoke('mail:rules:save', rule)
    expect(mocks.worker.request).toHaveBeenCalledWith(expect.objectContaining({
      type: 'rules:save', payload: expect.objectContaining({ name: 'Newsletters', conditions: [expect.objectContaining({ value: 'news@example.test' })] })
    }))
    expect(() => invoke('mail:rules:save', { ...rule, conditions: [] })).toThrow(/conditions/)
    expect(() => invoke('productivity:event-create', { title: '' })).toThrow(/valid event/)
  })

  it('creates, updates, and deletes writable Google calendar events', async () => {
    const calendar = { id: 'calendar', accountId: 'abcdef', provider: 'gmail', remoteId: 'remote-calendar', name: 'Work', canWrite: true }
    const input = {
      id: 'event', calendarId: 'calendar', title: 'Planning', start: '2026-08-10T09:00:00Z', end: '2026-08-10T10:00:00Z',
      color: '#6558e8', attendees: ['ada@example.test'], reminderMinutes: 15, recurrence: 'weekly'
    }
    mocks.setStoreSnapshot({ calendars: [calendar], events: [], contacts: [], sync: [] })
    await expect(invoke('productivity:event-create', input)).resolves.toBeDefined()
    expect(mocks.google.createEvent).toHaveBeenCalled()
    const current = { ...input, accountId: 'abcdef', provider: 'gmail', remoteId: 'remote-event', readOnly: false }
    mocks.setStoreSnapshot({ calendars: [calendar], events: [current], contacts: [], sync: [] })
    await expect(invoke('productivity:event-update', { ...input, title: 'Updated' })).resolves.toBeDefined()
    await expect(invoke('productivity:event-delete', 'event')).resolves.toBeDefined()
    expect(mocks.google.deleteEvent).toHaveBeenCalled()
    expect(() => invoke('productivity:event-delete', '')).toThrow(/valid event/)
  })

  it('rejects unavailable, read-only, moved, and unsupported calendar writes', async () => {
    const eventInput = { id: 'event', calendarId: 'calendar', title: 'Event', start: '2026-08-10T09:00:00Z', end: '2026-08-10T10:00:00Z', color: '#fff', attendees: [], reminderMinutes: 0 }
    mocks.setStoreSnapshot({ calendars: [], events: [], contacts: [], sync: [] })
    await expect(invoke('productivity:event-create', eventInput)).rejects.toThrow(/calendar is no longer/)
    await expect(invoke('productivity:event-update', eventInput)).rejects.toThrow(/event is no longer/)
    await expect(invoke('productivity:event-delete', 'event')).rejects.toThrow(/event is no longer/)
    const microsoftCalendar = { id: 'calendar', accountId: '123456', provider: 'microsoft' }
    const readOnly = { ...eventInput, accountId: '123456', provider: 'microsoft', remoteId: 'remote', readOnly: true }
    mocks.setStoreSnapshot({ calendars: [microsoftCalendar], events: [readOnly], contacts: [], sync: [] })
    await expect(invoke('productivity:event-create', eventInput)).rejects.toThrow(/cannot be edited/)
    await expect(invoke('productivity:event-update', eventInput)).rejects.toThrow(/cannot be edited/)
    await expect(invoke('productivity:event-delete', 'event')).rejects.toThrow(/cannot be deleted/)
  })

  it('creates, updates, and deletes writable provider contacts', async () => {
    const input = { id: 'contact', name: 'Ada Lovelace', email: 'ada@example.test', phone: '+44', company: 'Analytical', title: 'Programmer', group: 'Google', notes: 'Notes', favorite: false, color: '#4d8f78' }
    await invoke('mail:accounts:connect')
    mocks.setStoreSnapshot({ calendars: [], events: [], contacts: [], sync: [] })
    await expect(invoke('productivity:contact-create', 'abcdef', input)).resolves.toMatchObject({ contact: expect.objectContaining({ remoteId: 'people/new' }) })
    expect(mocks.google.createContact).toHaveBeenCalledWith(input)

    const current = { ...input, id: 'abcdef:google-contact:people/existing', remoteId: 'people/existing', accountId: 'abcdef', provider: 'gmail', readOnly: false }
    mocks.setStoreSnapshot({ calendars: [], events: [], contacts: [current], sync: [] })
    await expect(invoke('productivity:contact-update', { ...input, id: current.id, name: 'Ada King' })).resolves.toBeDefined()
    await expect(invoke('productivity:contact-delete', current.id)).resolves.toBeDefined()
    expect(mocks.google.updateContact).toHaveBeenCalled()
    expect(mocks.google.deleteContact).toHaveBeenCalledWith(current)
  })

  it('validates provider contact writes and protects unavailable or read-only records', async () => {
    const valid = { id: 'contact', name: 'Ada', email: '', group: 'Google', favorite: false, color: '#4d8f78' }
    for (const [accountId, input] of [[3, valid], ['', valid], ['a1b2', { ...valid, name: '' }], ['a1b2', { ...valid, favorite: 'yes' }]]) {
      expect(() => invoke('productivity:contact-create', accountId as any, input)).toThrow()
    }
    expect(() => invoke('productivity:contact-delete', '')).toThrow(/valid contact/)
    mocks.setStoreSnapshot({ calendars: [], events: [], contacts: [], sync: [] })
    await expect(invoke('productivity:contact-update', valid)).rejects.toThrow(/no longer available/)
    await expect(invoke('productivity:contact-delete', 'missing')).rejects.toThrow(/no longer available/)
    const readOnly = { ...valid, remoteId: 'remote', accountId: 'a1b2', provider: 'gmail', readOnly: true }
    mocks.setStoreSnapshot({ calendars: [], events: [], contacts: [readOnly], sync: [] })
    await expect(invoke('productivity:contact-update', readOnly)).rejects.toThrow(/enable Contacts editing/)
    await expect(invoke('productivity:contact-delete', readOnly.id)).rejects.toThrow(/enable Contacts editing/)
  })

  it('exposes update controls and validates valid rule actions', async () => {
    expect(invoke('app:update:status')).toEqual({ phase: 'idle', currentVersion: '0.4.0' })
    await expect(invoke('app:update:check')).resolves.toEqual({ phase: 'current' })
    await expect(invoke('app:update:download')).resolves.toEqual({ phase: 'ready' })
    invoke('app:update:install'); expect(mocks.updateManager.install).toHaveBeenCalled()
    const base = { accountId: 'a1b2', name: 'Rule', enabled: true, match: 'any', conditions: [{ field: 'subject', operator: 'contains', value: 'hello' }] }
    await invoke('mail:rules:save', { ...base, actions: [{ action: 'label', labelId: 'label' }] })
    for (const rule of [
      null, { ...base, actions: [] }, { ...base, actions: [{ action: 'unknown' }] },
      { ...base, actions: [{ action: 'move' }] }, { ...base, conditions: [{ field: 'unknown', operator: 'contains', value: 'x' }], actions: [{ action: 'archive' }] }
    ]) expect(() => invoke('mail:rules:save', rule)).toThrow()
    await invoke('mail:rules:delete', 'rule')
    await invoke('mail:rules:run', 'rule')
  })

  it('exhaustively validates draft, rule, preference, and local-module boundaries', async () => {
    const draft = { id: 'draft', accountId: 'a1b2', to: ['reader@example.test'], cc: [], bcc: [], subject: 'Subject', text: 'Body', attachmentPaths: [] }
    for (const change of [
      { accountId: 3 }, { accountId: 'x'.repeat(201) }, { id: 3 }, { id: 'x'.repeat(201) },
      { cc: 'bad' }, { bcc: 'bad' }, { attachmentPaths: 'bad' }, { to: [3] },
      { subject: 3 }, { html: 3 }, { html: 'x'.repeat(20_000_001) }, { text: 3 },
      { attachmentPaths: [3] }
    ] as Array<Record<string, unknown>>) expect(() => invoke('mail:drafts:save', { ...draft, ...change })).toThrow()
    expect(() => invoke('mail:drafts:schedule', draft, 3)).toThrow(/valid scheduled send time/)
    expect(() => invoke('mail:drafts:schedule', draft, '')).toThrow(/valid scheduled send time/)
    expect(() => invoke('mail:drafts:schedule', draft, 'x'.repeat(101))).toThrow(/valid scheduled send time/)
    mocks.setStatResult(new Error('gone'))
    expect(() => invoke('mail:drafts:save', { ...draft, attachmentPaths: ['C:\\approved.txt'] })).toThrow(/no longer available/)
    mocks.setStatResult({ size: 12, isFile: () => true })

    const base = { accountId: 'a1b2', name: 'Rule', enabled: true, match: 'all', conditions: [{ field: 'from', operator: 'contains', value: 'x' }], actions: [{ action: 'archive' }] }
    const invalidRules = [
      { ...base, id: 3 }, { ...base, id: '' }, { ...base, id: 'x'.repeat(201) },
      { ...base, accountId: 3 }, { ...base, accountId: '' }, { ...base, accountId: 'x'.repeat(201) },
      { ...base, name: 3 }, { ...base, name: ' ' }, { ...base, name: 'x'.repeat(201) },
      { ...base, enabled: 'yes' }, { ...base, match: 'none' }, { ...base, conditions: 'bad' },
      { ...base, conditions: Array.from({ length: 11 }, () => base.conditions[0]) }, { ...base, actions: 'bad' },
      { ...base, actions: Array.from({ length: 11 }, () => base.actions[0]) },
      { ...base, conditions: [null] }, { ...base, conditions: [{ field: 'from', operator: 'bad', value: 'x' }] },
      { ...base, conditions: [{ field: 'from', operator: 'contains', value: 3 }] },
      { ...base, conditions: [{ field: 'from', operator: 'contains', value: ' ' }] },
      { ...base, conditions: [{ field: 'from', operator: 'contains', value: 'x'.repeat(501) }] },
      { ...base, actions: [null] }, { ...base, actions: [{ action: 'label', labelId: 3 }] },
      { ...base, actions: [{ action: 'label', labelId: '' }] }, { ...base, actions: [{ action: 'move', labelId: 'x'.repeat(501) }] }
    ]
    for (const rule of invalidRules) expect(() => invoke('mail:rules:save', rule)).toThrow()
    await invoke('mail:rules:save', { ...base, id: 'rule', actions: [{ action: 'move', labelId: 'folder' }] })

    for (const snapshot of [
      3, {}, { tasks: 'bad', notes: [] }, { tasks: [], notes: 'bad' },
      { tasks: Array.from({ length: 100_001 }, () => ({})), notes: [] },
      { tasks: [], notes: Array.from({ length: 100_001 }, () => ({ id: 'n', title: 'n', content: '' })) },
      { tasks: [null], notes: [] }, { tasks: [{ id: 3, title: 'x' }], notes: [] },
      { tasks: [{ id: 'x', title: 3 }], notes: [] }, { tasks: [{ id: 'x'.repeat(301), title: 'x' }], notes: [] },
      { tasks: [{ id: 'x', title: 'x'.repeat(10_001) }], notes: [] }, { tasks: [], notes: [null] },
      { tasks: [], notes: [{ id: 3, title: 'x', content: '' }] }, { tasks: [], notes: [{ id: 'n', title: 3, content: '' }] },
      { tasks: [], notes: [{ id: 'n', title: 'x', content: 3 }] }, { tasks: [], notes: [{ id: 'x'.repeat(301), title: 'x', content: '' }] },
      { tasks: [], notes: [{ id: 'n', title: 'x'.repeat(10_001), content: '' }] }, { tasks: [], notes: [{ id: 'n', title: 'x', content: 'x'.repeat(10_000_001) }] }
    ]) expect(() => invoke('productivity:local-save', snapshot)).toThrow(/invalid/)

    const settings = { theme: 'system', density: 'comfortable', closeToTray: true, notifications: true, startModule: 'mail' }
    expect(invoke('preferences:save', { settings: { ...settings, profile: { displayName: 'Alex Avery', email: 'alex@aerio.app' } } })).toHaveProperty('savedAt')
    expect((invoke('preferences:load') as any).settings.profile).toBeUndefined()
    expect(invoke('preferences:save', { settings: { ...settings, profile: { displayName: 'Name only' } } })).toHaveProperty('savedAt')
  })

  it('checks every calendar-event boundary and provider write constraint', async () => {
    const valid = {
      id: 'event', calendarId: 'calendar', title: 'Event', start: '2026-08-10T09:00:00Z', end: '2026-08-10T10:00:00Z',
      location: 'Room', description: 'Notes', color: '#fff', attendees: ['a@example.test'], reminderMinutes: 0, recurrence: 'none'
    }
    const invalid = [
      null, 3, { ...valid, id: 3 }, { ...valid, id: '' }, { ...valid, id: 'x'.repeat(501) },
      { ...valid, calendarId: 3 }, { ...valid, calendarId: '' }, { ...valid, title: 3 }, { ...valid, title: ' ' },
      { ...valid, start: 3 }, { ...valid, start: 'x'.repeat(101) }, { ...valid, end: 3 }, { ...valid, end: 'x'.repeat(101) },
      { ...valid, start: 'bad' }, { ...valid, end: 'bad' }, { ...valid, end: valid.start },
      { ...valid, location: 3 }, { ...valid, location: 'x'.repeat(2_001) }, { ...valid, description: 3 }, { ...valid, description: 'x'.repeat(100_001) },
      { ...valid, color: 3 }, { ...valid, color: 'x'.repeat(101) }, { ...valid, attendees: 'bad' },
      { ...valid, attendees: Array.from({ length: 1_001 }, () => 'a@example.test') }, { ...valid, attendees: [3] }, { ...valid, attendees: ['x'.repeat(501)] },
      { ...valid, reminderMinutes: 1.5 }, { ...valid, reminderMinutes: -1 }, { ...valid, reminderMinutes: 40_321 }, { ...valid, recurrence: 'yearly' }
    ]
    for (const input of invalid) expect(() => invoke('productivity:event-create', input)).toThrow(/valid event/)

    const calendar = { id: 'calendar', accountId: 'abcdef', provider: 'gmail', remoteId: 'remote-calendar', name: 'Work', canWrite: true }
    mocks.setStoreSnapshot({ calendars: [calendar], events: [], contacts: [], sync: [] })
    for (const recurrence of [undefined, 'none', 'daily', 'weekly', 'monthly']) {
      await invoke('productivity:event-create', { ...valid, recurrence })
    }
    const current = { ...valid, accountId: 'abcdef', provider: 'gmail', remoteId: 'remote-event', readOnly: false }
    mocks.setStoreSnapshot({ calendars: [], events: [current], contacts: [], sync: [] })
    await expect(invoke('productivity:event-update', valid)).rejects.toThrow(/calendar is no longer/)
    await expect(invoke('productivity:event-delete', 'event')).rejects.toThrow(/calendar is no longer/)
    mocks.setStoreSnapshot({ calendars: [calendar], events: [current], contacts: [], sync: [] })
    await expect(invoke('productivity:event-update', { ...valid, calendarId: 'moved' })).rejects.toThrow(/Moving an existing event/)
    const unsupported = { ...calendar, provider: 'microsoft' }
    mocks.setStoreSnapshot({ calendars: [unsupported], events: [current], contacts: [], sync: [] })
    await expect(invoke('productivity:event-update', valid)).rejects.toThrow(/connection changed/)
    await expect(invoke('productivity:event-delete', 'event')).rejects.toThrow(/connection changed/)
    for (const eventId of [3, '', 'x'.repeat(501)]) expect(() => invoke('productivity:event-delete', eventId)).toThrow(/valid event/)
  })

  it('blocks every private-address family and permits public IPv4 and IPv6 image hosts', async () => {
    const handle = mocks.protocolHandlers.get('aerio-image')!
    const fetchFor = async (host: string, address: string) => {
      mocks.lookup.mockResolvedValueOnce([{ address, family: address.includes(':') ? 6 : 4 }] as never)
      const encoded = Buffer.from(`https://${host}/image.png`).toString('base64url')
      return handle({ url: `aerio-image://fetch/${encoded}` })
    }
    for (const [index, address] of [
      '0.1.2.3', '10.1.2.3', '127.1.2.3', '100.64.0.1', '169.254.1.1', '172.16.1.1', '172.31.1.1', '192.168.1.1', '224.0.0.1',
      '::1', '::', 'fc00::1', 'fd00::1', 'fe80::1', 'fe90::1', 'fea0::1', 'feb0::1', 'not-an-ip'
    ].entries()) expect((await fetchFor(`private-${index}.example`, address)).status).toBe(403)
    expect((await fetchFor('public-v4.example', '100.128.0.1')).status).toBe(200)
    expect((await fetchFor('public-v6.example', '2001:4860:4860::8888')).status).toBe(200)
    mocks.lookup.mockResolvedValueOnce([] as never)
    const none = Buffer.from('https://no-address.example/image.png').toString('base64url')
    expect((await handle({ url: `aerio-image://fetch/${none}` })).status).toBe(403)
    for (const host of ['localhost', 'sub.localhost', 'printer.local']) {
      const encoded = Buffer.from(`https://${host}/image.png`).toString('base64url')
      expect((await handle({ url: `aerio-image://fetch/${encoded}` })).status).toBe(403)
    }
  })

  it('covers favicon normalization, in-flight de-duplication, and image/profile edge cases', async () => {
    const handle = mocks.protocolHandlers.get('aerio-image')!
    mocks.net.fetch.mockResolvedValueOnce(new Response(new Uint8Array(), { status: 200 }))
    expect((await handle({ url: 'aerio-image://favicon/zero.example' })).status).toBe(404)
    mocks.net.fetch.mockResolvedValueOnce(new Response(Uint8Array.from([1]), { status: 200 }))
    mocks.image.toPNG.mockReturnValueOnce(Buffer.alloc(0))
    expect((await handle({ url: 'aerio-image://favicon/no-normalized.example' })).status).toBe(404)

    let release!: (value: Response) => void
    const pending = new Promise<Response>((resolve) => { release = resolve })
    mocks.net.fetch.mockReturnValueOnce(pending as never)
    const first = handle({ url: 'aerio-image://favicon/concurrent.example' })
    const second = handle({ url: 'aerio-image://favicon/concurrent.example' })
    release(new Response(Uint8Array.from([1]), { status: 200 }))
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)

    mocks.setOpenResult({ canceled: false, filePaths: ['C:\\portrait.png'] })
    mocks.image.isEmpty.mockReturnValueOnce(true)
    await expect(invoke('profile:image:choose')).rejects.toThrow(/could not be opened/)
    mocks.image.getSize.mockReturnValueOnce({ width: 64, height: 64 })
    await expect(invoke('profile:image:choose')).resolves.toBe('data:image/png;base64,AA==')
    mocks.setOpenResult({ canceled: false, filePaths: ['C:\\creds.json'] })
    await expect(invoke('gmail:credentials:import')).resolves.toEqual({ configured: true })
    expect(mocks.vault.importConfig).toHaveBeenCalledWith('C:\\creds.json')
  })

  it('covers reconnect variants, account-setting limits, worker-event diagnostics, and app lifecycle hooks', async () => {
    mocks.accounts = [{ id: '123456', provider: 'microsoft', email: 'ms@example.test' }]
    await invoke('mail:accounts:reconnect', '123456')
    expect(mocks.vault.authorizeMicrosoft).toHaveBeenCalledWith({ accountId: '123456', email: 'ms@example.test' })
    expect(() => invoke('mail:accounts:imap-settings', '123456')).toThrow(/does not use IMAP/)
    mocks.accounts = [{ id: 'abcdef', provider: 'gmail', email: 'person@example.test' }]
    expect(() => invoke('mail:accounts:imap-settings', 'abcdef')).toThrow(/does not use IMAP/)
    for (const input of [
      null, { accountId: 3, displayName: 'Name', color: '#123456', signature: '' },
      { accountId: 'id', displayName: ' ', color: '#123456', signature: '' },
      { accountId: 'id', displayName: 'x'.repeat(201), color: '#123456', signature: '' },
      { accountId: 'id', displayName: 'Name', color: 'red', signature: '' },
      { accountId: 'id', displayName: 'Name', color: '#123456', signature: 3 },
      { accountId: 'id', displayName: 'Name', color: '#123456', signature: 'x'.repeat(20_001) }
    ]) expect(() => invoke('mail:accounts:update', input)).toThrow()

    mocks.emitWorker({ type: 'sync-progress', payload: { accountId: 'a1b2', phase: 'error', error: 'failed' } })
    mocks.emitWorker({ type: 'connectivity', payload: { online: false } })
    mocks.emitWorker({ type: 'new-mail', payload: { accountId: 'a1b2', count: 1, sender: '', subject: '' } })
    const secondInstance = mocks.appHandlers.get('second-instance')
    secondInstance?.()
    mocks.appHandlers.get('window-all-closed')?.()
    const rejectionHandler = process.listeners('unhandledRejection').at(-1) as ((reason: unknown) => void) | undefined
    rejectionHandler?.('plain failure')
    const exceptionHandler = process.listeners('uncaughtExceptionMonitor').at(-1) as ((error: Error) => void) | undefined
    exceptionHandler?.(new Error('monitored'))
    expect(mocks.diagnosticLogger.log).toHaveBeenCalled()
  })

  it('covers renderer fallbacks, optional IPC results, and ownerless dialogs', async () => {
    const activeMain = mocks.windows.filter((window) => window.options.title === 'Aerio').at(-1)
    const openHandler = activeMain.webContents.handlers.get('window-open')!
    expect(openHandler({ url: 'file:///blocked', frameName: '' })).toEqual({ action: 'deny' })
    const plainChild = new mocks.FakeBrowserWindow({ title: 'Plain child' })
    activeMain.webContents.handlers.get('did-create-window')?.(plainChild, { frameName: 'ordinary-window' })
    expect(plainChild.webContents.setWindowOpenHandler).not.toHaveBeenCalled()
    const preventDefault = vi.fn()
    activeMain.webContents.handlers.get('will-navigate')?.({ preventDefault }, 'file:///blocked')
    expect(preventDefault).toHaveBeenCalled()

    for (const input of [null, {}, { title: 3 }, { title: 'Message', source: 'local', accountId: 'a', threadId: 't' }, { title: 'Message', source: 'connected', accountId: '', threadId: 't' }, { title: 'Message', source: 'connected', accountId: 'a', threadId: 't', messageId: '' }]) {
      expect(() => invoke('window:open-message', input)).toThrow(/Invalid message/)
    }
    invoke('window:open-message', { title: 'Message with id', source: 'connected', accountId: 'a', threadId: 't', messageId: 'm' })
    expect(mocks.windows.at(-1).loadFile).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ query: expect.objectContaining({ messageId: 'm' }) }))
    expect(mocks.ipcHandlers.get('window:is-maximized')!({ sender: {} })).toBe(false)
    expect(() => mocks.ipcHandlers.get('window:maximize')!({ sender: {} })).not.toThrow()

    expect(() => invoke('productivity:event-update', { title: '' })).toThrow(/valid event/)
    await invoke('mail:recipients:suggest', 42 as any)
    expect(mocks.worker.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'recipients:suggest', payload: expect.objectContaining({ query: '' }) }))
    await invoke('mail:accounts:imap-update', 'imap-id', {})
    expect(mocks.validateImap).toHaveBeenCalledWith(expect.objectContaining({ password: 'old' }))
    mocks.worker.request.mockResolvedValueOnce(undefined)
    await expect(invoke('mail:drafts:get', 'missing')).resolves.toBeUndefined()

    activeMain.handlers.get('closed')?.()
    mocks.setOpenResult({ canceled: false, filePaths: [] })
    await expect(invoke('files:choose')).resolves.toEqual([])
    await expect(invoke('gmail:credentials:import')).resolves.toEqual({ configured: true })
    mocks.setOpenResult({ canceled: false, filePaths: ['C:\\large-profile.png'] })
    mocks.image.getSize.mockReturnValueOnce({ width: 512, height: 256 })
    const profileHandler = mocks.ipcHandlers.get('profile:image:choose')!
    await expect(profileHandler({ sender: {} })).resolves.toBe('data:image/png;base64,AA==')
    expect(mocks.image.resize).toHaveBeenCalledWith({ width: 256, height: 128, quality: 'best' })
    mocks.setSaveResult({ canceled: false })
    await expect(invoke('mail:attachment:save', 'a', 'm', 'x', '...')).resolves.toEqual({})
    await expect(mocks.ipcHandlers.get('mail:diagnostics:export')!({ sender: {} })).resolves.toEqual({})

    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173/'
    mocks.appHandlers.get('activate')?.()
    expect(mocks.windows.filter((window) => window.options.title === 'Aerio').at(-1).loadURL).toHaveBeenCalledWith('http://localhost:5173/')
    delete process.env.ELECTRON_RENDERER_URL
    invoke('preferences:save', { schemaVersion: 1, settings: { theme: 'system', density: 'comfortable', closeToTray: false, notifications: true, startModule: 'mail' } })
    mocks.appHandlers.get('window-all-closed')?.()
    expect(mocks.app.quit).toHaveBeenCalled()
  })

  it('forwards worker events, updates polling, and releases services during shutdown', async () => {
    mocks.emitWorker({ type: 'sync-progress', payload: { accountId: 'a1b2', phase: 'ready' } })
    expect(mocks.windows.some((window) => window.webContents.send.mock.calls.some(([channel, value]: any[]) => channel === 'mail:event' && value.type === 'sync-progress'))).toBe(true)
    mocks.windows.at(-1).handlers.get('focus')?.()
    await vi.waitFor(() => expect(mocks.worker.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'polling' })))
    mocks.appHandlers.get('before-quit')?.()
    mocks.appHandlers.get('will-quit')?.()
    expect(mocks.updateManager.stop).toHaveBeenCalled()
    expect(mocks.store.close).toHaveBeenCalled()
    expect(mocks.worker.close).toHaveBeenCalled()
  })
})
