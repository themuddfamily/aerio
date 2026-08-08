import { beforeAll, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const posted: any[] = []
  let messageHandler: ((message: any) => void) | undefined
  let credential: any = { type: 'oauth', accessToken: 'token' }
  let credentialError: string | undefined
  const port = {
    on: vi.fn((_event: string, handler: (message: any) => void) => { messageHandler = handler }),
    postMessage: vi.fn((message: any) => {
      posted.push(message)
      if (message.kind === 'credential-request') queueMicrotask(() => messageHandler?.({
        kind: 'credential-response', id: message.id, credential, error: credentialError
      }))
    })
  }

  const operation = { id: 'operation-1', accountId: 'account-1', kind: 'archive', status: 'queued' }
  const account = {
    id: 'account-1', provider: 'gmail', email: 'person@example.test', displayName: 'Personal', color: '#123456',
    status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true
  }
  const db: Record<string, any> = {}
  const method = (name: string, value?: any) => { db[name] = vi.fn(typeof value === 'function' ? value : () => value) }
  method('close')
  method('listAccounts', () => [account])
  method('upsertAccount')
  method('getAccount', () => account)
  method('disconnectAccount')
  method('listLabels', () => [{ id: 'INBOX' }])
  method('suggestRecipients', () => [{ email: 'ada@example.test' }])
  method('listThreads', () => ({ items: [], total: 0 }))
  method('folderUnreadCounts', () => ({ inbox: 2 }))
  method('accountUnreadCounts', () => ({ 'account-1': 2 }))
  method('folderUnreadCounts', () => ({ inbox: 2, all: 3 }))
  method('accountUnreadCounts', () => ({ 'account-1': 2 }))
  method('getThread', () => ({ accountId: 'account-1', id: 'thread-1', subject: 'Subject', messages: [{ id: 'message-1', html: '<p>raw</p>', sanitizedHtml: '', text: 'text' }] }))
  method('getMessageRaw', () => undefined)
  method('applyLocalAction', () => operation)
  method('undoOperation', () => true)
  method('listDrafts', () => [{ id: 'draft-1' }])
  method('getDraftRecord', () => ({ id: 'draft-1' }))
  method('snoozeThreads', () => [{ accountId: 'account-1', threadId: 'thread-1' }])
  method('unsnoozeThreads', () => true)
  method('updateAccountSettings', () => ({ ...account }))
  method('setAccountStatus')
  method('getSyncProgress', () => [])
  method('saveDraft', (input: any, state: any) => ({ id: input.id, ...state, updatedAt: '2026-08-08T10:00:00Z' }))
  method('getDraft', () => undefined)
  method('updateDraftResult')
  method('cancelDraftDelivery', () => ({ id: 'draft-1', status: 'cancelled' }))
  method('requestDraftDiscard', () => ({ id: 'draft-1', status: 'discarding' }))
  method('deleteDraftRecord')
  method('listRules', () => [])
  method('saveRule', (input: any) => ({ ...input, id: input.id ?? 'rule-1' }))
  method('deleteRule', () => true)
  method('getRule', () => undefined)
  method('matchingThreadIdsForRule', () => [])
  method('recordRuleMatch')
  method('storageStats', (free: number) => ({ totalBytes: 100, freeBytes: free, accounts: [] }))
  method('resetForFullSync')
  method('diagnosticHealth', () => ({ integrity: 'ok' }))
  method('releaseDueSnoozes', () => [])
  method('dueOperations', () => [])
  method('draftsToDiscard', () => [])
  method('draftsToSync', () => [])
  method('queuedDrafts', () => [])
  method('matchingRulesForMessage', () => [])
  method('rawPath', () => 'C:\\content\\raw.eml')
  method('hasMessage', () => false)
  method('upsertMessage')
  method('upsertLabels')
  method('replaceLabels')
  method('getSyncCheckpoint', () => undefined)
  method('resetInventory')
  method('addInventory')
  method('reconcileInventory')
  method('completeInventory')
  method('retryFailedSyncItems')
  method('pendingMessageIds', () => [])
  method('markSyncItem')
  method('syncFailureCount', () => 0)
  method('setAccountHistory')
  method('getAccountHistory', () => undefined)
  method('deleteMessage')
  method('reconcileRemoteFolder')
  method('updateMessageLabels')
  method('getProviderState', (_id: string, fallback: any) => fallback)
  method('setProviderState')
  method('updateSyncProgress')
  method('messagesNeedingDownload', () => [])
  method('upsertInventory')
  method('replaceInventory')
  method('remoteMessagesForThreads', () => [])
  method('updateOperation')
  method('operationAttempts', () => 0)
  method('rescheduleOperation')
  method('restoreOperationSnapshot')

  const gmail = {
    getAccessToken: undefined as undefined | ((id: string) => Promise<string>),
    getProfile: vi.fn().mockResolvedValue({ emailAddress: 'person@example.test', historyId: '1' }),
    createDraft: vi.fn().mockResolvedValue({ id: 'remote-draft', message: { id: 'gmail-revision-2' } }),
    updateDraft: vi.fn().mockResolvedValue({ id: 'remote-draft', message: { id: 'gmail-revision-2' } }),
    draftRevision: vi.fn().mockResolvedValue('gmail-revision-1'),
    deleteDraft: vi.fn().mockResolvedValue(undefined), sendDraft: vi.fn().mockResolvedValue(undefined), sendMessage: vi.fn().mockResolvedValue(undefined),
    trashThreads: vi.fn().mockResolvedValue(undefined), untrashThreads: vi.fn().mockResolvedValue(undefined), modifyThreads: vi.fn().mockResolvedValue(undefined),
    listLabels: vi.fn().mockResolvedValue([]), inventory: vi.fn().mockResolvedValue({ messages: [], nextPageToken: undefined }),
    getMessages: vi.fn().mockResolvedValue([]), history: vi.fn().mockResolvedValue({ history: [], historyId: '1' }),
    listMessages: vi.fn().mockResolvedValue({ messages: [], nextPageToken: undefined }),
    getRawMessage: vi.fn().mockResolvedValue({ id: 'message-1', threadId: 'thread-1', historyId: '1', raw: Buffer.from('raw').toString('base64url'), labelIds: ['INBOX'], internalDate: '1786183200000' }),
    listHistory: vi.fn().mockResolvedValue({ history: [], historyId: '1' })
  }
  const microsoft = {
    getAccessToken: undefined as undefined | (() => Promise<string>),
    listFolders: vi.fn().mockResolvedValue([]), applyAction: vi.fn().mockResolvedValue(undefined),
    saveDraft: vi.fn().mockResolvedValue({ id: 'remote-draft', revision: 'microsoft-revision-2' }),
    draftRevision: vi.fn().mockResolvedValue('microsoft-revision-1'), deleteDraft: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined),
    delta: vi.fn().mockResolvedValue({ messages: [], deltaLink: 'delta' }), messageRaw: vi.fn().mockResolvedValue(Buffer.from('raw'))
  }
  const imap = {
    verify: vi.fn().mockResolvedValue(undefined), listFolders: vi.fn().mockResolvedValue([]), applyAction: vi.fn().mockResolvedValue(undefined),
    saveDraft: vi.fn().mockResolvedValue('remote-draft'), deleteDraft: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined),
    withConnection: vi.fn(async (callback: (connection: any) => Promise<void>) => callback({})),
    inventoryFolder: vi.fn().mockResolvedValue({ refs: [], uidValidity: '1', uidNext: 1 }),
    fetchRaw: vi.fn().mockResolvedValue({ raw: Buffer.from('raw'), labels: ['INBOX'], internalDate: '2026-08-08T10:00:00Z', size: 3 })
  }

  return {
    port, posted, db, account, operation, gmail, microsoft, imap,
    MailDatabase: vi.fn(function () { return db }),
    GmailClient: vi.fn(function (_id: string, getAccessToken: (id: string) => Promise<string>) { gmail.getAccessToken = getAccessToken; return gmail }),
    MicrosoftGraphClient: vi.fn(function (getAccessToken: () => Promise<string>) { microsoft.getAccessToken = getAccessToken; return microsoft }),
    ImapSmtpClient: vi.fn(function () { return imap }),
    postalParse: vi.fn().mockResolvedValue({ attachments: [] }),
    notification: vi.fn((): { accountId: string; title: string; body: string } | undefined => undefined),
    sanitize: vi.fn((html: string, remote?: boolean) => `safe:${remote}:${html}`),
    source: vi.fn(() => ({ headers: 'headers', source: 'source' })),
    fs: {
      copyFileSync: vi.fn(), existsSync: vi.fn(() => false), mkdirSync: vi.fn(), readFileSync: vi.fn(() => Buffer.from('raw')),
      readdirSync: vi.fn((): string[] => []), renameSync: vi.fn(), rmSync: vi.fn(),
      statfsSync: vi.fn(() => ({ bavail: 2n, bsize: 4096n })), writeFileSync: vi.fn()
    },
    setCredential(value: any) { credential = value; credentialError = undefined },
    setCredentialError(value: string) { credential = undefined; credentialError = value },
    emit(message: any) { messageHandler?.(message) }
  }
})

vi.mock('node:worker_threads', () => ({ parentPort: mocks.port }))
vi.mock('node:fs', () => mocks.fs)
vi.mock('postal-mime', () => ({ default: { parse: mocks.postalParse } }))
vi.mock('./mail/database', () => ({ MailDatabase: mocks.MailDatabase }))
vi.mock('./mail/gmail-client', () => ({
  GmailClient: mocks.GmailClient,
  GmailApiError: class GmailApiError extends Error { constructor(message: string, public status: number) { super(message) } }
}))
vi.mock('./mail/microsoft-client', () => ({
  MicrosoftGraphClient: mocks.MicrosoftGraphClient,
  MicrosoftGraphError: class MicrosoftGraphError extends Error { constructor(message: string, public status: number) { super(message) } },
  microsoftLabels: vi.fn(() => []), microsoftMessageLabels: vi.fn(() => [])
}))
vi.mock('./mail/imap-client', () => ({
  ImapSmtpClient: mocks.ImapSmtpClient,
  labelsForImapFolders: vi.fn(() => [])
}))
vi.mock('./mail/message-security', () => ({ sanitizeMessageHtml: mocks.sanitize }))
vi.mock('./mail/new-mail', () => ({ buildNewMailNotification: mocks.notification }))
vi.mock('./mail/message-source', () => ({ parseMessageSource: mocks.source }))
vi.mock('./mail/mime-builder', () => ({ createMime: vi.fn(() => 'mime'), createMimeBuffer: vi.fn(() => Buffer.from('mime')) }))

import './mail-worker'

let nextId = 0
async function request(command: any) {
  const id = `request-${++nextId}`
  mocks.emit({ kind: 'request', id, command })
  await vi.waitFor(() => expect(mocks.posted.some((message) => message.kind === 'response' && message.id === id)).toBe(true))
  return [...mocks.posted].reverse().find((message: any) => message.kind === 'response' && message.id === id)
}

describe.sequential('mail worker protocol routing', () => {
  beforeAll(() => { mocks.posted.length = 0 })

  it('rejects commands before initialization, then starts the database and timers', async () => {
    await expect(request({ type: 'accounts:list' })).resolves.toMatchObject({
      error: { code: 'worker-error', message: 'Database is not initialized' }
    })
    const response = await request({ type: 'initialize', payload: { databasePath: 'mail.db', contentPath: 'C:\\content' } })
    expect(response).toMatchObject({ kind: 'response', result: undefined })
    expect(mocks.MailDatabase).toHaveBeenCalledWith('mail.db', 'C:\\content')
  })

  it('routes account, label, recipient, list, thread, source, action, and undo commands', async () => {
    await expect(request({ type: 'accounts:list' })).resolves.toMatchObject({ result: [mocks.account] })
    await expect(request({ type: 'accounts:upsert', payload: mocks.account })).resolves.toMatchObject({ result: mocks.account })
    expect(mocks.db.upsertAccount).toHaveBeenCalledWith(mocks.account)

    mocks.db.getAccount.mockReturnValueOnce(undefined)
    await expect(request({ type: 'accounts:verify', payload: { accountId: 'missing' } })).resolves.toMatchObject({ error: { message: 'Account not found' } })
    mocks.db.getAccount.mockReturnValueOnce({ ...mocks.account, provider: 'gmail' })
    await request({ type: 'accounts:verify', payload: { accountId: 'account-1' } })
    expect(mocks.gmail.getProfile).toHaveBeenCalled()
    mocks.db.getAccount.mockReturnValueOnce({ ...mocks.account, provider: 'microsoft' })
    await request({ type: 'accounts:verify', payload: { accountId: 'account-1' } })
    expect(mocks.microsoft.listFolders).toHaveBeenCalled()
    mocks.db.getAccount.mockReturnValueOnce({ ...mocks.account, provider: 'imap' })
    mocks.setCredential({ type: 'imap', config: { email: 'imap@example.test' } })
    await request({ type: 'accounts:verify', payload: { accountId: 'account-1' } })
    expect(mocks.imap.verify).toHaveBeenCalled()
    mocks.setCredential({ type: 'oauth', accessToken: 'token' })

    await request({ type: 'accounts:disconnect', payload: { accountId: 'account-1', mode: 'archive' } })
    expect(mocks.db.disconnectAccount).toHaveBeenCalledWith('account-1', 'archive')
    await expect(request({ type: 'labels:list', payload: { accountIds: ['account-1'] } })).resolves.toMatchObject({ result: [{ id: 'INBOX' }] })
    await expect(request({ type: 'recipients:suggest', payload: { query: 'ada' } })).resolves.toMatchObject({ result: [{ email: 'ada@example.test' }] })
    await expect(request({ type: 'mail:list', payload: { folder: 'inbox' } })).resolves.toMatchObject({ result: { total: 0 } })
    await expect(request({ type: 'mail:unread-counts', payload: {} })).resolves.toMatchObject({ result: { inbox: 2 } })
    await expect(request({ type: 'mail:account-unread-counts' })).resolves.toMatchObject({ result: { 'account-1': 2 } })
    await expect(request({ type: 'mail:unread-counts', payload: { accountIds: ['account-1'] } })).resolves.toMatchObject({ result: { inbox: 2, all: 3 } })
    expect(mocks.db.folderUnreadCounts).toHaveBeenCalledWith(['account-1'])
    await expect(request({ type: 'mail:account-unread-counts' })).resolves.toMatchObject({ result: { 'account-1': 2 } })
    expect(mocks.db.accountUnreadCounts).toHaveBeenCalled()
    const thread = await request({ type: 'mail:thread', payload: { accountId: 'account-1', threadId: 'thread-1', allowRemoteImages: true } })
    expect(thread.result.messages[0].sanitizedHtml).toBe('safe:true:<p>raw</p>')

    mocks.db.getMessageRaw.mockReturnValueOnce(undefined)
    await expect(request({ type: 'mail:source', payload: { accountId: 'account-1', messageId: 'missing' } })).resolves.toMatchObject({ error: { message: 'The original message is not available offline' } })
    mocks.db.getMessageRaw.mockReturnValueOnce('raw.eml')
    await expect(request({ type: 'mail:source', payload: { accountId: 'account-1', messageId: 'message-1' } })).resolves.toMatchObject({ result: { headers: 'headers' } })
    expect(mocks.source).toHaveBeenCalledWith(Buffer.from('raw'))

    await expect(request({ type: 'mail:action', payload: { accountId: 'account-1', threadIds: ['thread-1'], action: 'archive' } })).resolves.toMatchObject({ result: mocks.operation })
    mocks.db.undoOperation.mockReturnValueOnce(true).mockReturnValueOnce(false)
    await expect(request({ type: 'mail:undo', payload: { operationId: 'operation-1' } })).resolves.toMatchObject({ result: true })
    await expect(request({ type: 'mail:undo', payload: { operationId: 'operation-2' } })).resolves.toMatchObject({ result: false })
  })

  it('routes snooze, account settings, drafts, and attachment staging', async () => {
    await expect(request({ type: 'mail:snooze', payload: { accountId: 'account-1', threadIds: ['thread-1'], until: '2026-08-09T10:00:00Z' } })).resolves.toMatchObject({ result: expect.any(Array) })
    mocks.db.unsnoozeThreads.mockReturnValueOnce(true).mockReturnValueOnce(false)
    await expect(request({ type: 'mail:unsnooze', payload: { accountId: 'account-1', threadIds: ['thread-1'] } })).resolves.toMatchObject({ result: true })
    await expect(request({ type: 'mail:unsnooze', payload: { accountId: 'account-1', threadIds: ['thread-1'] } })).resolves.toMatchObject({ result: false })

    mocks.db.updateAccountSettings.mockReturnValueOnce({ ...mocks.account, syncEnabled: false })
    await request({ type: 'accounts:update', payload: { accountId: 'account-1', syncEnabled: false } })
    expect(mocks.db.setAccountStatus).toHaveBeenCalledWith('account-1', 'paused')

    await expect(request({ type: 'drafts:list', payload: {} })).resolves.toMatchObject({ result: [{ id: 'draft-1' }] })
    await expect(request({ type: 'drafts:get', payload: { id: 'draft-1' } })).resolves.toMatchObject({ result: { id: 'draft-1' } })
    const input = { id: 'draft-local', accountId: 'account-1', to: [], cc: [], bcc: [], subject: 'Draft', text: 'Body', references: [], attachmentPaths: [] }
    await expect(request({ type: 'drafts:save', payload: input })).resolves.toMatchObject({ result: { id: 'draft-local', status: 'synced' } })
    await expect(request({ type: 'drafts:send', payload: input })).resolves.toMatchObject({ result: { id: 'draft-local', status: 'send-pending' } })
    await expect(request({ type: 'drafts:schedule', payload: { input, deliveryAt: '2026-08-09T10:00:00Z' } })).resolves.toMatchObject({ result: { status: 'scheduled' } })
    await expect(request({ type: 'drafts:cancel-send', payload: { id: 'draft-local' } })).resolves.toMatchObject({ result: { status: 'cancelled' } })
    mocks.db.getDraft.mockReturnValueOnce(undefined)
    await expect(request({ type: 'drafts:delete', payload: { id: 'gone' } })).resolves.toMatchObject({ result: { status: 'discarded' } })

    mocks.db.getMessageRaw.mockReturnValueOnce(undefined)
    await expect(request({ type: 'drafts:stage-message-attachments', payload: { draftId: 'draft', accountId: 'account-1', messageId: 'missing' } })).resolves.toMatchObject({ error: { message: 'The original message is not available offline' } })
    mocks.db.getMessageRaw.mockReturnValueOnce('raw.eml')
    mocks.postalParse.mockResolvedValueOnce({ attachments: [{ filename: 'file.txt', mimeType: 'text/plain', content: 'hello', encoding: 'utf8' }] })
    const staged = await request({ type: 'drafts:stage-message-attachments', payload: { draftId: 'draft', accountId: 'account-1', messageId: 'message-1' } })
    expect(staged.result[0]).toMatchObject({ name: 'file.txt', size: 5 })
  })

  it('routes rules, sync controls, storage, diagnostics, attachment extraction, network, and polling', async () => {
    await expect(request({ type: 'rules:list', payload: {} })).resolves.toMatchObject({ result: [] })
    await expect(request({ type: 'rules:save', payload: { accountId: 'account-1', name: 'Rule' } })).resolves.toMatchObject({ result: { id: 'rule-1' } })
    await expect(request({ type: 'rules:delete', payload: { id: 'rule-1' } })).resolves.toMatchObject({ result: true })
    mocks.db.getRule.mockReturnValueOnce(undefined)
    await expect(request({ type: 'rules:run', payload: { id: 'missing' } })).resolves.toMatchObject({ error: { message: 'Rule not found' } })
    mocks.db.getRule.mockReturnValueOnce({ id: 'rule-1', accountId: 'account-1', actions: [{ action: 'archive' }] })
    mocks.db.matchingThreadIdsForRule.mockReturnValueOnce(['thread-1'])
    await expect(request({ type: 'rules:run', payload: { id: 'rule-1' } })).resolves.toMatchObject({ result: { matched: 1, operations: 1 } })

    mocks.db.listAccounts.mockReturnValueOnce([]).mockReturnValueOnce([])
    await request({ type: 'sync:start', payload: {} })
    await request({ type: 'sync:start', payload: { accountId: 'account-1' } })
    await request({ type: 'sync:pause', payload: { accountId: 'account-1' } })
    await expect(request({ type: 'sync:progress' })).resolves.toMatchObject({ result: [] })
    await expect(request({ type: 'storage:stats' })).resolves.toMatchObject({ result: { freeBytes: 8192 } })

    mocks.db.getAccount.mockReturnValueOnce(undefined)
    await expect(request({ type: 'sync:rebuild', payload: { accountId: 'missing' } })).resolves.toMatchObject({ error: { message: 'Account not found' } })
    mocks.db.getAccount.mockReturnValueOnce({ ...mocks.account, syncEnabled: false })
    await expect(request({ type: 'sync:rebuild', payload: { accountId: 'account-1' } })).resolves.toMatchObject({ error: { message: 'Enable synchronization for this account before rebuilding it' } })
    await expect(request({ type: 'diagnostics:health' })).resolves.toMatchObject({ result: { integrity: 'ok' } })

    mocks.db.getMessageRaw.mockReturnValueOnce(undefined)
    await expect(request({ type: 'attachment:extract', payload: { accountId: 'account-1', messageId: 'missing', attachmentId: 'a', targetPath: 'out' } })).resolves.toMatchObject({ error: { message: 'The original message is not available offline' } })
    await request({ type: 'network', payload: { online: false } })
    await request({ type: 'network', payload: { online: true } })
    await request({ type: 'polling', payload: { intervalMs: 50, immediate: true } })
  })

  it('handles credential errors and ignores unknown credential responses', async () => {
    mocks.emit({ kind: 'credential-response', id: 'unknown', credential: { type: 'oauth', accessToken: 'x' } })
    // A non-Error rejection is serialized into a worker-error response.
    mocks.db.listAccounts.mockImplementationOnce(() => { throw 'database exploded' })
    await expect(request({ type: 'accounts:list' })).resolves.toMatchObject({ error: { code: 'worker-error', message: 'database exploded' } })
  })

  it('runs a full Gmail inventory, downloads messages, and applies history changes', async () => {
    mocks.fs.statfsSync.mockReturnValue({ bavail: 2_000_000n, bsize: 4096n })
    mocks.db.getAccount.mockReturnValue(mocks.account)
    mocks.db.getAccountHistory.mockReturnValue(undefined)
    mocks.db.getSyncCheckpoint.mockReturnValue(undefined)
    mocks.db.getSyncProgress.mockReturnValue([])
    mocks.db.pendingMessageIds.mockReturnValueOnce([{ id: 'gmail-message', threadId: 'gmail-thread' }]).mockReturnValue([])
    mocks.db.hasMessage.mockReturnValue(false)
    mocks.db.matchingRulesForMessage.mockReturnValue([{ id: 'incoming-rule', accountId: 'account-1', enabled: true, name: 'Archive notices', conditions: {}, actions: [{ action: 'archive' }] }])
    mocks.notification.mockReturnValue({ accountId: 'account-1', title: 'New mail', body: 'A new message arrived' })
    mocks.gmail.listMessages.mockResolvedValueOnce({ messages: [{ id: 'gmail-message', threadId: 'gmail-thread' }], nextPageToken: undefined })
    mocks.gmail.getRawMessage.mockImplementation(async (id: string) => ({
      id, threadId: id === 'gmail-message' ? 'gmail-thread' : 'new-thread', historyId: '2',
      raw: Buffer.from(`raw:${id}`).toString('base64url'), labelIds: ['INBOX', 'UNREAD'], internalDate: '1786183200000', snippet: 'Preview'
    }))
    mocks.gmail.listHistory.mockResolvedValueOnce({
      historyId: '2',
      history: [{ id: '2', messagesAdded: [{ message: { id: 'new-message', threadId: 'new-thread' } }], labelsAdded: [{ message: { id: 'gmail-message', threadId: 'gmail-thread' } }], messagesDeleted: [{ message: { id: 'deleted-message', threadId: 'old-thread' } }] }]
    })
    mocks.postalParse.mockResolvedValue({
      from: { name: 'Ada', address: 'ada@example.test' },
      to: [{ group: [{ name: 'Grace', address: 'grace@example.test' }] }], cc: [{ address: 'team@example.test' }],
      date: '2026-08-08T10:00:00Z', subject: 'Worker message', messageId: '<worker@example.test>', references: '<root@example.test> <prior@example.test>',
      text: 'Worker body', html: '<p>Worker body</p>',
      attachments: [{ filename: 'report.pdf', contentId: 'report', mimeType: 'application/pdf', content: Buffer.from('pdf') }]
    })

    await request({ type: 'sync:resume', payload: { accountId: 'account-1' } })
    await vi.waitFor(() => expect(mocks.db.setAccountHistory).toHaveBeenCalledWith('account-1', '2', true))
    expect(mocks.db.replaceLabels).toHaveBeenCalled()
    expect(mocks.db.resetInventory).toHaveBeenCalledWith('account-1')
    expect(mocks.db.upsertMessage).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Worker message', fromEmail: 'ada@example.test', to: ['Grace <grace@example.test>'] }))
    expect(mocks.db.deleteMessage).toHaveBeenCalledWith('account-1', 'deleted-message')
    expect(mocks.db.recordRuleMatch).toHaveBeenCalledWith('incoming-rule', 1)
    expect(mocks.notification).toHaveBeenCalled()
    expect(mocks.posted).toContainEqual(expect.objectContaining({ kind: 'event', event: expect.objectContaining({ type: 'sync-progress', payload: expect.objectContaining({ phase: 'complete' }) }) }))
    mocks.db.matchingRulesForMessage.mockReturnValue([])
    mocks.notification.mockReturnValue(undefined)
  })

  it('runs Microsoft delta synchronization including removed folders and messages', async () => {
    mocks.db.getAccount.mockReturnValue({ ...mocks.account, provider: 'microsoft' })
    mocks.db.getAccountHistory.mockReturnValue(undefined)
    mocks.db.getProviderState.mockImplementation((_id: string, fallback: any) => ({ ...fallback, deltaLinks: { removed: 'old-delta' } }))
    mocks.db.hasMessage.mockReturnValue(false)
    mocks.microsoft.listFolders.mockResolvedValueOnce([{ id: 'inbox', displayName: 'Inbox', specialUse: 'inbox' }])
    mocks.microsoft.delta.mockResolvedValueOnce({
      deltaLink: 'new-delta',
      messages: [
        { id: 'graph-message', conversationId: 'graph-thread', receivedDateTime: '2026-08-08T10:00:00Z' },
        { id: 'graph-removed', '@removed': { reason: 'deleted' } }
      ]
    })
    mocks.postalParse.mockResolvedValue({ from: { address: 'graph@example.test' }, subject: 'Graph message', text: 'Graph body', attachments: [] })

    await request({ type: 'sync:resume', payload: { accountId: 'account-1' } })
    await vi.waitFor(() => expect(mocks.microsoft.messageRaw).toHaveBeenCalledWith('graph-message'))
    await vi.waitFor(() => expect(mocks.db.setProviderState).toHaveBeenCalledWith('account-1', expect.objectContaining({ deltaLinks: { inbox: 'new-delta' } })))
    expect(mocks.db.reconcileRemoteFolder).toHaveBeenCalledWith('account-1', 'removed', expect.any(Set))
    expect(mocks.db.deleteMessage).toHaveBeenCalledWith('account-1', 'graph-removed')
    expect(mocks.db.reconcileInventory).toHaveBeenCalledWith('account-1')
  })

  it('runs IMAP inventory and message download with UID validity reconciliation', async () => {
    mocks.setCredential({ type: 'imap', config: { email: 'imap@example.test' } })
    mocks.db.getAccount.mockReturnValue({ ...mocks.account, provider: 'imap' })
    mocks.db.getAccountHistory.mockReturnValue('previous-sync')
    mocks.db.getProviderState.mockImplementation((_id: string, fallback: any) => ({ ...fallback, folders: { INBOX: { uidValidity: 'old' } } }))
    mocks.db.pendingMessageIds.mockReturnValueOnce([{ id: 'imap-message', threadId: 'temporary-thread', remoteFolderId: 'INBOX', remoteUid: '7' }]).mockReturnValue([])
    mocks.db.hasMessage.mockReturnValueOnce(true).mockReturnValueOnce(false).mockReturnValue(false)
    mocks.imap.listFolders.mockResolvedValueOnce([{ path: 'INBOX', name: 'Inbox', specialUse: 'inbox' }])
    mocks.imap.inventoryFolder.mockResolvedValueOnce({ refs: [{ id: 'imap-message', threadId: 'temporary-thread', folder: 'INBOX', uid: 7, labels: ['INBOX'] }], uidValidity: 'new', uidNext: 8, highestModseq: '4' })
    mocks.postalParse.mockResolvedValue({ from: { group: [{ name: 'IMAP Sender', address: 'imap-sender@example.test' }] }, subject: 'IMAP message', messageId: '<imap@example.test>', references: '<thread@example.test>', text: 'IMAP body', attachments: [] })

    await request({ type: 'sync:resume', payload: { accountId: 'account-1' } })
    await vi.waitFor(() => expect(mocks.imap.fetchRaw).toHaveBeenCalled())
    await vi.waitFor(() => expect(mocks.db.setAccountHistory).toHaveBeenCalledWith('account-1', expect.stringMatching(/^imap:/), true))
    expect(mocks.db.updateMessageLabels).toHaveBeenCalledWith('account-1', 'imap-message', ['INBOX'], 'new:7')
    expect(mocks.db.reconcileRemoteFolder).toHaveBeenCalledWith('account-1', 'INBOX', expect.any(Set))
    mocks.setCredential({ type: 'oauth', accessToken: 'token' })
  })

  it('processes queued provider operations and retries or restores failures', async () => {
    mocks.db.getAccount.mockReturnValue(mocks.account)
    mocks.db.dueOperations.mockReturnValueOnce([
      { id: 'trash', account_id: 'account-1', kind: 'trash', thread_ids_json: '["thread-1"]', label_id: null },
      { id: 'untrash', account_id: 'account-1', kind: 'untrash', thread_ids_json: '["thread-2"]', label_id: null },
      { id: 'move', account_id: 'account-1', kind: 'move', thread_ids_json: '["thread-3"]', label_id: 'Project' },
      { id: 'read', account_id: 'account-1', kind: 'read', thread_ids_json: '["thread-4"]', label_id: null }
    ]).mockReturnValue([])
    await request({ type: 'network', payload: { online: true } })
    await vi.waitFor(() => expect(mocks.db.updateOperation).toHaveBeenCalledWith('read', 'succeeded'))
    expect(mocks.gmail.trashThreads).toHaveBeenCalledWith(['thread-1'])
    expect(mocks.gmail.untrashThreads).toHaveBeenCalledWith(['thread-2'])
    expect(mocks.gmail.modifyThreads).toHaveBeenCalledWith(['thread-3'], ['Project'], ['INBOX', 'TRASH', 'SPAM'])
    expect(mocks.gmail.modifyThreads).toHaveBeenCalledWith(['thread-4'], [], ['UNREAD'])

    mocks.gmail.modifyThreads.mockRejectedValueOnce(new Error('temporary provider failure'))
    mocks.db.operationAttempts.mockReturnValueOnce(2)
    mocks.db.dueOperations.mockReturnValueOnce([{ id: 'retry', account_id: 'account-1', kind: 'star', thread_ids_json: '["thread-1"]', label_id: null }]).mockReturnValue([])
    await request({ type: 'network', payload: { online: true } })
    await vi.waitFor(() => expect(mocks.db.rescheduleOperation).toHaveBeenCalledWith('retry', 'temporary provider failure', 8_000))

    mocks.gmail.modifyThreads.mockRejectedValueOnce(new Error('permanent provider failure'))
    mocks.db.operationAttempts.mockReturnValueOnce(5)
    mocks.db.dueOperations.mockReturnValueOnce([{ id: 'failed', account_id: 'account-1', kind: 'unread', thread_ids_json: '["thread-1"]', label_id: null }]).mockReturnValue([])
    await request({ type: 'network', payload: { online: true } })
    await vi.waitFor(() => expect(mocks.db.restoreOperationSnapshot).toHaveBeenCalledWith('failed', 'failed', 'permanent provider failure'))
  })

  it('synchronizes, delivers, and discards queued Gmail drafts', async () => {
    const row = (id: string) => ({
      id, account_id: 'account-1', thread_id: null, in_reply_to: null, references_json: '[]', to_json: '["ada@example.test"]', cc_json: '[]', bcc_json: '[]',
      subject: `Draft ${id}`, body_text: 'Body', body_html: null, attachment_paths_json: '[]', gmail_draft_id: id === 'discard' ? 'remote-discard' : null
    })
    mocks.db.getAccount.mockReturnValue(mocks.account)
    mocks.db.getDraft.mockImplementation((id: string) => id === 'discard' ? row(id) : undefined)
    mocks.db.draftsToDiscard.mockReturnValueOnce([row('discard')]).mockReturnValue([])
    mocks.db.draftsToSync.mockReturnValueOnce([row('sync')]).mockReturnValue([])
    mocks.db.queuedDrafts.mockReturnValueOnce([row('deliver')]).mockReturnValue([])
    await request({ type: 'network', payload: { online: true } })
    await vi.waitFor(() => expect(mocks.gmail.deleteDraft).toHaveBeenCalledWith('remote-discard'))
    await vi.waitFor(() => expect(mocks.gmail.createDraft).toHaveBeenCalled())
    await vi.waitFor(() => expect(mocks.gmail.sendMessage).toHaveBeenCalled())
    expect(mocks.db.deleteDraftRecord).toHaveBeenCalledWith('discard')
    expect(mocks.db.updateDraftResult).toHaveBeenCalledWith('deliver', expect.objectContaining({ status: 'sent' }))
  })

  it('extracts string and binary attachments and rejects unknown attachment ids', async () => {
    const filename = 'photo.png', contentId = 'photo', mimeType = 'image/png'
    const id = `part-0-${Buffer.from(`${filename}:${contentId}:${mimeType}`).toString('base64url').slice(0, 16)}`
    mocks.db.getMessageRaw.mockReturnValue('raw.eml')
    mocks.postalParse.mockResolvedValue({ attachments: [{ filename, contentId, mimeType, content: 'aGVsbG8=', encoding: 'base64' }] })
    await expect(request({ type: 'attachment:extract', payload: { accountId: 'account-1', messageId: 'message-1', attachmentId: id, targetPath: 'photo.png' } })).resolves.toMatchObject({ result: undefined })
    expect(mocks.fs.writeFileSync).toHaveBeenCalledWith('photo.png', Buffer.from('hello'))

    mocks.postalParse.mockResolvedValueOnce({ attachments: [{ filename: 'binary.bin', mimeType: 'application/octet-stream', content: new Uint8Array([1, 2, 3]).buffer }] })
    await expect(request({ type: 'attachment:extract', payload: { accountId: 'account-1', messageId: 'message-1', attachmentId: 'unknown', targetPath: 'binary.bin' } })).resolves.toMatchObject({ error: { message: 'Attachment not found' } })
  })

  it('validates provider credential callbacks and missing credential responses', async () => {
    mocks.setCredential({ type: 'oauth', accessToken: 'oauth-token' })
    mocks.db.getAccount.mockReturnValue(mocks.account)
    await request({ type: 'accounts:verify', payload: { accountId: 'account-1' } })
    await expect(mocks.gmail.getAccessToken?.('account-1')).resolves.toBe('oauth-token')
    await expect(mocks.gmail.getAccessToken?.('account-1')).resolves.toBe('oauth-token')

    mocks.db.getAccount.mockReturnValue({ ...mocks.account, provider: 'microsoft' })
    await request({ type: 'accounts:verify', payload: { accountId: 'account-1' } })
    await expect(mocks.microsoft.getAccessToken?.()).resolves.toBe('oauth-token')

    mocks.setCredential({ type: 'imap', config: { email: 'imap@example.test' } })
    await expect(mocks.gmail.getAccessToken?.('account-1')).rejects.toThrow('does not have OAuth credentials')
    mocks.db.getAccount.mockReturnValue({ ...mocks.account, provider: 'imap' })
    mocks.setCredential(undefined)
    await expect(request({ type: 'accounts:verify', payload: { accountId: 'account-1' } })).resolves.toMatchObject({ error: { message: 'Unable to access the account credentials' } })
    mocks.setCredential({ type: 'oauth', accessToken: 'token' })
  })

  it('pauses low-disk synchronization and marks authentication failures for reconnection', async () => {
    mocks.db.getAccount.mockReturnValue(mocks.account)
    mocks.db.getAccountHistory.mockReturnValue(undefined)
    mocks.db.getSyncProgress.mockReturnValue([{ accountId: 'account-1', phase: 'paused', completed: 0, total: 0, transferredBytes: 0, pausedReason: 'disk', updatedAt: new Date().toISOString() }])
    mocks.fs.statfsSync.mockReturnValue({ bavail: 1n, bsize: 4096n })
    await request({ type: 'sync:resume', payload: { accountId: 'account-1' } })
    await vi.waitFor(() => expect(mocks.db.setAccountStatus).toHaveBeenCalledWith('account-1', 'paused', 'Sync paused because disk space is low'))

    mocks.fs.statfsSync.mockReturnValue({ bavail: 2_000_000n, bsize: 4096n })
    mocks.db.getSyncProgress.mockReturnValue([])
    mocks.gmail.getProfile.mockRejectedValueOnce(new Error('authentication failed'))
    await request({ type: 'sync:resume', payload: { accountId: 'account-1' } })
    await vi.waitFor(() => expect(mocks.db.setAccountStatus).toHaveBeenCalledWith('account-1', 'needs-auth', 'authentication failed'))
  })

  it('applies Microsoft and IMAP operations including released snoozes', async () => {
    mocks.db.releaseDueSnoozes.mockReturnValueOnce([{ accountId: 'account-1', threadId: 'snoozed-thread' }]).mockReturnValue([])
    mocks.db.remoteMessagesForThreads.mockReturnValue([{ id: 'remote-message', remoteFolderId: 'INBOX', remoteUid: '7' }])
    mocks.db.getProviderState.mockReturnValue({ deltaLinks: {}, specialFolders: { archive: 'archive-folder', inbox: 'inbox-folder', deleteditems: 'trash-folder' } })
    mocks.db.getAccount.mockReturnValue({ ...mocks.account, provider: 'microsoft' })
    mocks.db.dueOperations.mockReturnValueOnce([{ id: 'ms-archive', account_id: 'account-1', kind: 'archive', thread_ids_json: '["thread-1"]', label_id: null }]).mockReturnValue([])
    await request({ type: 'network', payload: { online: true } })
    await vi.waitFor(() => expect(mocks.microsoft.applyAction).toHaveBeenCalledWith(['remote-message'], 'archive', 'archive-folder'))
    expect(mocks.db.applyLocalAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'unarchive', threadIds: ['snoozed-thread'] }), expect.any(String), 0)

    mocks.setCredential({ type: 'imap', config: { email: 'imap@example.test' } })
    mocks.db.getAccount.mockReturnValue({ ...mocks.account, provider: 'imap' })
    mocks.db.dueOperations.mockReturnValueOnce([{ id: 'imap-label', account_id: 'account-1', kind: 'label', thread_ids_json: '["thread-2"]', label_id: 'Work' }]).mockReturnValue([])
    await request({ type: 'network', payload: { online: true } })
    await vi.waitFor(() => expect(mocks.imap.applyAction).toHaveBeenCalledWith([{ folder: 'INBOX', uid: 7 }], 'label', 'Work'))
    mocks.setCredential({ type: 'oauth', accessToken: 'token' })
  })

  it('saves and delivers Microsoft and IMAP drafts and records provider failures', async () => {
    const input = { id: 'provider-draft', accountId: 'account-1', to: ['ada@example.test'], cc: [], bcc: [], subject: 'Provider draft', text: 'Body', references: [], attachmentPaths: [] }
    mocks.db.getAccount.mockReturnValue({ ...mocks.account, provider: 'microsoft' })
    mocks.db.getDraft.mockReturnValue({ gmail_draft_id: 'existing-remote' })
    await expect(request({ type: 'drafts:save', payload: input })).resolves.toMatchObject({ result: { status: 'synced', remoteDraftId: 'remote-draft' } })
    expect(mocks.microsoft.saveDraft).toHaveBeenCalledWith(expect.any(Buffer), 'existing-remote')

    mocks.microsoft.saveDraft.mockRejectedValueOnce(new Error('draft provider failed'))
    await expect(request({ type: 'drafts:save', payload: { ...input, id: 'failed-draft' } })).resolves.toMatchObject({ result: { status: 'failed', error: 'draft provider failed' } })

    const row = { id: 'imap-delivery', account_id: 'account-1', thread_id: null, in_reply_to: null, references_json: '[]', to_json: '["ada@example.test"]', cc_json: '["team@example.test"]', bcc_json: '[]', subject: 'IMAP delivery', body_text: 'Body', body_html: '<p>Body</p>', attachment_paths_json: '[]', gmail_draft_id: 'imap-remote' }
    mocks.setCredential({ type: 'imap', config: { email: 'imap@example.test' } })
    mocks.db.getAccount.mockReturnValue({ ...mocks.account, provider: 'imap' })
    mocks.db.getDraft.mockReturnValue(row)
    mocks.db.queuedDrafts.mockReturnValueOnce([row]).mockReturnValue([])
    await request({ type: 'network', payload: { online: true } })
    await vi.waitFor(() => expect(mocks.imap.send).toHaveBeenCalledWith(expect.any(Buffer), ['ada@example.test', 'team@example.test']))
    expect(mocks.imap.deleteDraft).toHaveBeenCalledWith('imap-remote')

    mocks.imap.deleteDraft.mockRejectedValueOnce(new Error('discard provider failed'))
    mocks.db.getDraft.mockReturnValue({ ...row, id: 'discard-imap' })
    await expect(request({ type: 'drafts:delete', payload: { id: 'discard-imap' } })).resolves.toMatchObject({ result: { status: 'failed', error: 'discard provider failed' } })
    mocks.setCredential({ type: 'oauth', accessToken: 'token' })
  })

  it('refuses to replace Gmail and Microsoft drafts changed by another client', async () => {
    const input = { id: 'remote-conflict', accountId: 'account-1', to: ['ada@example.test'], cc: [], bcc: [], subject: 'Shared draft', text: 'Body', references: [], attachmentPaths: [] }
    const storedDraft = { gmail_draft_id: 'provider-draft', remote_revision: 'provider-revision-1' }
    mocks.db.updateDraftResult.mockClear()
    mocks.gmail.updateDraft.mockClear()
    mocks.db.getAccount.mockReturnValue(mocks.account)
    mocks.db.getDraft.mockReturnValue(storedDraft)
    mocks.gmail.draftRevision.mockResolvedValueOnce('provider-revision-from-another-client')

    await expect(request({ type: 'drafts:save', payload: input })).resolves.toMatchObject({
      error: { message: expect.stringMatching(/changed after it was opened in another mail client/) }
    })
    expect(mocks.gmail.updateDraft).not.toHaveBeenCalled()
    expect(mocks.db.updateDraftResult).toHaveBeenCalledWith(input.id, expect.objectContaining({
      status: 'failed', error: expect.stringMatching(/another mail client/)
    }))

    mocks.db.updateDraftResult.mockClear()
    mocks.microsoft.saveDraft.mockClear()
    mocks.db.getAccount.mockReturnValue({ ...mocks.account, provider: 'microsoft' })
    mocks.db.getDraft.mockReturnValue(storedDraft)
    mocks.microsoft.draftRevision.mockResolvedValueOnce('provider-revision-from-another-client')
    await expect(request({ type: 'drafts:save', payload: { ...input, id: 'microsoft-conflict' } })).resolves.toMatchObject({
      error: { message: expect.stringMatching(/changed after it was opened in another mail client/) }
    })
    expect(mocks.microsoft.saveDraft).not.toHaveBeenCalled()
    expect(mocks.db.updateDraftResult).toHaveBeenCalledWith('microsoft-conflict', expect.objectContaining({ status: 'failed' }))

    mocks.db.getAccount.mockReturnValue(mocks.account)
    mocks.db.getDraft.mockReturnValue(undefined)
  })

  it('stores sparse Gmail messages with parser, address, attachment, and metadata defaults', async () => {
    mocks.fs.statfsSync.mockReturnValue({ bavail: 2_000_000n, bsize: 4096n })
    mocks.db.getAccount.mockReturnValue(mocks.account)
    mocks.db.getAccountHistory.mockReturnValue(undefined)
    mocks.db.getSyncCheckpoint.mockReturnValue({ total: 1, inventory_complete: 1, initial_history_id: '7' })
    mocks.db.getSyncProgress.mockReturnValue([])
    mocks.db.pendingMessageIds.mockReturnValueOnce([{ id: 'sparse', threadId: 'sparse-thread' }]).mockReturnValue([])
    mocks.db.hasMessage.mockReturnValue(false)
    mocks.db.syncFailureCount.mockReturnValue(0)
    mocks.gmail.getRawMessage.mockResolvedValueOnce({ id: 'sparse', threadId: 'sparse-thread', raw: Buffer.from('sparse').toString('base64url') })
    mocks.postalParse.mockResolvedValueOnce({
      from: { group: [] },
      to: [{ group: [{ address: 'member@example.test' }] }, { name: 'Named', address: 'named@example.test' }, { address: 'plain@example.test' }],
      attachments: [
        { mimeType: '', content: 'hello' },
        { filename: 'binary.bin', mimeType: 'application/octet-stream', content: new Uint8Array([1, 2]).buffer }
      ]
    })
    mocks.db.upsertMessage.mockClear()
    await request({ type: 'sync:resume', payload: { accountId: 'account-1' } })
    await vi.waitFor(() => expect(mocks.db.upsertMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: 'sparse', historyId: '0', fromName: '', fromEmail: '', subject: '(No subject)', text: '', html: '', labelIds: [],
      to: ['member@example.test', 'Named <named@example.test>', 'plain@example.test'], snippet: '', sizeEstimate: 6
    })))
    expect(mocks.db.upsertMessage).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [expect.objectContaining({ filename: 'attachment-1', mimeType: 'application/octet-stream', size: 5 }), expect.objectContaining({ size: 2 })]
    }))
  })

  it('records download failures, singular and plural retry errors, and Gmail authentication API failures', async () => {
    const { GmailApiError } = await import('./mail/gmail-client')
    const { MicrosoftGraphError } = await import('./mail/microsoft-client')
    mocks.fs.statfsSync.mockReturnValue({ bavail: 2_000_000n, bsize: 4096n })
    mocks.db.getAccount.mockReturnValue(mocks.account)
    mocks.db.getAccountHistory.mockReturnValue(undefined)
    mocks.db.getSyncCheckpoint.mockReturnValue({ total: 2, inventory_complete: 1, initial_history_id: '8' })
    mocks.db.getSyncProgress.mockReturnValue([])
    mocks.db.pendingMessageIds.mockReturnValueOnce([{ id: 'plain-failure', threadId: 't1' }, { id: 'error-failure', threadId: 't2' }]).mockReturnValue([])
    mocks.gmail.getRawMessage.mockRejectedValueOnce('plain failure').mockRejectedValueOnce(new Error('ordinary failure'))
    mocks.db.syncFailureCount.mockReturnValueOnce(1)
    mocks.db.setAccountStatus.mockClear()
    await request({ type: 'sync:resume', payload: { accountId: 'account-1' } })
    await vi.waitFor(() => expect(mocks.db.setAccountStatus).toHaveBeenCalledWith('account-1', 'error', '1 message could not be downloaded after repeated attempts'))
    expect(mocks.db.markSyncItem).toHaveBeenCalledWith('account-1', 'plain-failure', 'failed', 'plain failure')

    mocks.db.pendingMessageIds.mockReturnValueOnce([{ id: 'auth-failure', threadId: 't3' }]).mockReturnValue([])
    mocks.db.syncFailureCount.mockReturnValue(0)
    mocks.gmail.getRawMessage.mockRejectedValueOnce(new GmailApiError('token rejected', 401))
    await request({ type: 'sync:resume', payload: { accountId: 'account-1' } })
    await vi.waitFor(() => expect(mocks.db.setAccountStatus).toHaveBeenCalledWith('account-1', 'needs-auth', 'token rejected'))

    mocks.db.getAccount.mockReturnValue({ ...mocks.account, provider: 'microsoft' })
    mocks.microsoft.listFolders.mockRejectedValueOnce(new MicrosoftGraphError('Microsoft token rejected', 401))
    await request({ type: 'sync:resume', payload: { accountId: 'account-1' } })
    await vi.waitFor(() => expect(mocks.db.setAccountStatus).toHaveBeenCalledWith('account-1', 'needs-auth', 'Microsoft token rejected'))

    mocks.db.getAccount.mockReturnValue(mocks.account)
    mocks.db.pendingMessageIds.mockReturnValueOnce([])
    mocks.db.syncFailureCount.mockReturnValueOnce(2)
    await request({ type: 'sync:resume', payload: { accountId: 'account-1' } })
    await vi.waitFor(() => expect(mocks.db.setAccountStatus).toHaveBeenCalledWith('account-1', 'error', '2 messages could not be downloaded after repeated attempts'))
  })

  it('recovers expired Microsoft deltas and updates existing and failed incremental messages', async () => {
    const { MicrosoftGraphError } = await import('./mail/microsoft-client')
    mocks.setCredential({ type: 'oauth', accessToken: 'token' })
    mocks.db.getAccount.mockReturnValue({ ...mocks.account, provider: 'microsoft' })
    mocks.db.getAccountHistory.mockReturnValue('existing-history')
    mocks.db.getSyncProgress.mockReturnValue([])
    mocks.db.getProviderState.mockImplementation((_id: string, fallback: any) => ({ ...fallback, deltaLinks: { inbox: 'expired' } }))
    mocks.microsoft.listFolders.mockResolvedValueOnce([{ id: 'inbox', displayName: 'Inbox' }, { id: 'archive', displayName: 'Archive', specialUse: 'archive' }])
    mocks.microsoft.delta
      .mockRejectedValueOnce(new MicrosoftGraphError('expired', 410))
      .mockResolvedValueOnce({ messages: [
        { id: 'existing', receivedDateTime: '2026-08-08T10:00:00Z' },
        { id: 'parse-failure', conversationId: 'failure-thread', sentDateTime: '2026-08-08T11:00:00Z' }
      ], deltaLink: undefined })
      .mockResolvedValueOnce({ messages: [{ id: 'existing', conversationId: 'archive-thread', receivedDateTime: '2026-08-08T10:00:00Z' }], deltaLink: 'archive-delta' })
    mocks.db.hasMessage.mockImplementation((_account: string, id: string) => id === 'existing')
    mocks.microsoft.messageRaw.mockResolvedValueOnce(Buffer.from('bad'))
    mocks.postalParse.mockRejectedValueOnce('parse failed')
    mocks.notification.mockReturnValue({ accountId: 'account-1', title: 'Incremental mail', body: 'New' })
    mocks.db.setProviderState.mockClear()
    await request({ type: 'sync:resume', payload: { accountId: 'account-1' } })
    await vi.waitFor(() => expect(mocks.db.setProviderState).toHaveBeenCalledWith('account-1', expect.objectContaining({ deltaLinks: { archive: 'archive-delta' } })))
    expect(mocks.microsoft.delta).toHaveBeenCalledWith('inbox', undefined)
    expect(mocks.db.updateMessageLabels).toHaveBeenCalledWith('account-1', 'existing', expect.any(Array), expect.stringMatching(/^graph:/), expect.any(Object))
    expect(mocks.db.markSyncItem).toHaveBeenCalledWith('account-1', 'parse-failure', 'failed', 'parse failed')
    mocks.notification.mockReturnValue(undefined)
  })

  it('handles invalid and fallback IMAP references during an incremental synchronization', async () => {
    mocks.setCredential({ type: 'imap', config: { email: 'imap@example.test' } })
    mocks.db.getAccount.mockReturnValue({ ...mocks.account, provider: 'imap' })
    mocks.db.getAccountHistory.mockReturnValue('existing-history')
    mocks.db.getSyncProgress.mockReturnValue([])
    mocks.db.getProviderState.mockImplementation((_id: string, fallback: any) => ({ ...fallback, folders: { INBOX: { uidValidity: 'same' } } }))
    mocks.imap.listFolders.mockResolvedValueOnce([{ path: 'INBOX', name: 'Inbox' }])
    mocks.imap.inventoryFolder.mockResolvedValueOnce({ refs: [], uidValidity: 'same' })
    mocks.db.pendingMessageIds.mockReturnValueOnce([
      { id: 'missing-folder', threadId: 't1', remoteFolderId: 'Gone', remoteUid: '1' },
      { id: 'bad-uid', threadId: 't2', remoteFolderId: 'INBOX', remoteUid: 'not-a-number' },
      { id: 'fallback-thread', threadId: 'original-thread', remoteFolderId: 'INBOX', remoteUid: '3' },
      { id: 'fetch-error', threadId: 'error-thread', remoteFolderId: 'INBOX', remoteUid: '4' }
    ]).mockReturnValue([])
    mocks.db.hasMessage.mockReturnValue(false)
    mocks.imap.fetchRaw
      .mockResolvedValueOnce({ raw: Buffer.from('fallback'), labels: [], internalDate: undefined, size: undefined })
      .mockRejectedValueOnce('fetch failed')
    mocks.postalParse
      .mockResolvedValueOnce({ inReplyTo: '<reply-root@example.test>', attachments: [] })
      .mockResolvedValueOnce({ inReplyTo: '<reply-root@example.test>', attachments: [] })
    mocks.notification.mockReturnValue({ accountId: 'account-1', title: 'IMAP mail', body: 'New' })
    await request({ type: 'sync:resume', payload: { accountId: 'account-1' } })
    await vi.waitFor(() => expect(mocks.db.setAccountHistory).toHaveBeenCalledWith('account-1', expect.stringMatching(/^imap:/), true))
    expect(mocks.db.markSyncItem).toHaveBeenCalledWith('account-1', 'missing-folder', 'failed', 'The IMAP message reference is invalid')
    expect(mocks.db.markSyncItem).toHaveBeenCalledWith('account-1', 'bad-uid', 'failed', 'The IMAP message reference is invalid')
    expect(mocks.db.markSyncItem).toHaveBeenCalledWith('account-1', 'fetch-error', 'failed', 'fetch failed')
    mocks.notification.mockReturnValue(undefined)
    mocks.setCredential({ type: 'oauth', accessToken: 'token' })
  })

  it('maps every Gmail label action and covers operation fallbacks and snooze failures', async () => {
    mocks.db.getAccount.mockReturnValue(mocks.account)
    mocks.db.releaseDueSnoozes.mockReturnValueOnce([{ accountId: 'account-1', threadId: 'gone-thread' }]).mockReturnValue([])
    mocks.db.applyLocalAction.mockImplementationOnce(() => { throw new Error('gone') }).mockImplementation(() => mocks.operation)
    const kinds = [
      ['archive', null], ['unarchive', null], ['unread', null], ['star', null], ['unstar', null],
      ['important', null], ['unimportant', null], ['label', 'Label'], ['label', null], ['unlabel', 'Label'],
      ['unlabel', null], ['move', 'INBOX'], ['move', 'TRASH'], ['unknown', null]
    ]
    mocks.db.dueOperations.mockReturnValueOnce(kinds.map(([kind, label], index) => ({
      id: `all-${index}`, account_id: 'account-1', kind, thread_ids_json: '["thread"]', label_id: label
    }))).mockReturnValue([])
    await request({ type: 'network', payload: { online: true } })
    await vi.waitFor(() => expect(mocks.db.updateOperation).toHaveBeenCalledWith(`all-${kinds.length - 1}`, 'succeeded'))
    expect(mocks.gmail.trashThreads).toHaveBeenCalledWith(['thread'])
    expect(mocks.gmail.modifyThreads).toHaveBeenCalledWith(['thread'], [], [])

    mocks.gmail.modifyThreads.mockRejectedValueOnce('plain provider failure')
    mocks.db.operationAttempts.mockReturnValueOnce(0)
    mocks.db.dueOperations.mockReturnValueOnce([{ id: 'plain-op', account_id: 'account-1', kind: 'read', thread_ids_json: '["thread"]', label_id: null }]).mockReturnValue([])
    await request({ type: 'network', payload: { online: true } })
    await vi.waitFor(() => expect(mocks.db.rescheduleOperation).toHaveBeenCalledWith('plain-op', 'plain provider failure', 2_000))
  })

  it('covers offline, remote-id, missing-account, staged-file, and provider draft branches', async () => {
    const input = { id: 'matrix', accountId: 'account-1', to: ['ada@example.test'], cc: [], bcc: [], subject: 'Matrix', text: 'Body', references: [], attachmentPaths: [] }
    mocks.db.getAccount.mockReturnValue(mocks.account)
    mocks.db.getDraft.mockReturnValue(undefined)
    await request({ type: 'network', payload: { online: false } })
    await expect(request({ type: 'drafts:save', payload: { ...input, id: 'offline-save' } })).resolves.toMatchObject({ result: { status: 'local' } })
    await request({ type: 'drafts:send', payload: { ...input, id: 'offline-send' } })
    const offlineRow = { id: 'offline-delivery', account_id: 'account-1', thread_id: null, in_reply_to: null, references_json: '[]', to_json: '["ada@example.test"]', cc_json: '[]', bcc_json: '[]', subject: 'Offline', body_text: 'Body', body_html: null, attachment_paths_json: '[]', gmail_draft_id: null }
    mocks.db.queuedDrafts.mockReturnValueOnce([offlineRow]).mockReturnValue([])
    await request({ type: 'network', payload: { online: true } })

    mocks.db.getDraft.mockReturnValue({ gmail_draft_id: 'remote-gmail' })
    await request({ type: 'drafts:save', payload: { ...input, id: 'gmail-update' } })
    expect(mocks.gmail.updateDraft).toHaveBeenCalledWith('remote-gmail', expect.any(String), undefined)
    const deliveryRow = (id: string, remoteId: string | null) => ({
      id, account_id: 'account-1', thread_id: null, in_reply_to: null, references_json: '[]', to_json: '["ada@example.test"]',
      cc_json: '[]', bcc_json: '[]', subject: 'Delivery', body_text: 'Body', body_html: null, attachment_paths_json: '[]', gmail_draft_id: remoteId
    })
    mocks.db.queuedDrafts.mockReturnValueOnce([deliveryRow('gmail-send-existing', 'remote-gmail')]).mockReturnValue([])
    await request({ type: 'network', payload: { online: true } })
    await vi.waitFor(() => expect(mocks.gmail.sendDraft).toHaveBeenCalledWith('remote-gmail', expect.any(String)))

    mocks.db.getAccount.mockReturnValue(undefined)
    mocks.db.getDraft.mockReturnValue(undefined)
    await request({ type: 'drafts:save', payload: { ...input, id: 'default-provider' } })
    mocks.gmail.createDraft.mockRejectedValueOnce('plain draft failure')
    await expect(request({ type: 'drafts:save', payload: { ...input, id: 'plain-failed' } })).resolves.toMatchObject({ result: { status: 'failed', error: 'plain draft failure' } })

    mocks.db.getAccount.mockReturnValue({ ...mocks.account, provider: 'microsoft' })
    mocks.db.getDraft.mockReturnValue({ gmail_draft_id: null })
    mocks.db.queuedDrafts.mockReturnValueOnce([deliveryRow('microsoft-send', null)]).mockReturnValue([])
    await request({ type: 'network', payload: { online: true } })
    await vi.waitFor(() => expect(mocks.microsoft.send).toHaveBeenCalledWith(expect.any(Buffer), undefined))
    mocks.db.getDraft.mockReturnValue({ id: 'discard-ms', account_id: 'account-1', gmail_draft_id: 'remote-ms' })
    await expect(request({ type: 'drafts:delete', payload: { id: 'discard-ms' } })).resolves.toMatchObject({ result: { status: 'discarded' } })
    expect(mocks.microsoft.deleteDraft).toHaveBeenCalledWith('remote-ms')

    mocks.db.getAccount.mockReturnValue(mocks.account)
    mocks.db.getDraft.mockReturnValue({ id: 'discard-gmail', account_id: 'account-1', gmail_draft_id: 'remote-gmail' })
    await request({ type: 'drafts:delete', payload: { id: 'discard-gmail' } })
    expect(mocks.gmail.deleteDraft).toHaveBeenCalledWith('remote-gmail')

    const stagedPath = `C:\\content\\drafts\\staged-id\\already.txt`
    mocks.fs.existsSync.mockReturnValue(true)
    mocks.fs.readdirSync.mockReturnValue(['stale.txt'])
    mocks.db.getDraft.mockReturnValue(undefined)
    await request({ type: 'drafts:save', payload: { ...input, id: 'staged-id', attachmentPaths: [stagedPath] } })
    expect(mocks.fs.copyFileSync).not.toHaveBeenCalledWith(stagedPath, expect.any(String))
    expect(mocks.fs.rmSync).toHaveBeenCalledWith(expect.stringContaining('stale.txt'), { force: true })
    mocks.fs.existsSync.mockReturnValue(false)
    mocks.fs.readdirSync.mockReturnValue([])
  })

  it('checks credential-type failures and the remaining account-update and rebuild paths', async () => {
    mocks.db.getAccount.mockReturnValue({ ...mocks.account, provider: 'imap' })
    mocks.setCredential({ type: 'oauth', accessToken: 'token' })
    await expect(request({ type: 'accounts:verify', payload: { accountId: 'account-1' } })).resolves.toMatchObject({ error: { message: 'The IMAP account does not have server credentials' } })
    mocks.db.getAccount.mockReturnValue({ ...mocks.account, provider: 'microsoft' })
    mocks.setCredential({ type: 'imap', config: {} })
    await request({ type: 'accounts:verify', payload: { accountId: 'account-1' } })
    await expect(mocks.microsoft.getAccessToken?.()).rejects.toThrow('does not have OAuth credentials')

    mocks.setCredential({ type: 'oauth', accessToken: 'token' })
    mocks.db.updateAccountSettings.mockReturnValueOnce({ ...mocks.account, syncEnabled: true, status: 'paused' })
    mocks.db.getAccount.mockReturnValue(mocks.account)
    await request({ type: 'accounts:update', payload: { accountId: 'account-1', syncEnabled: true } })
    expect(mocks.db.setAccountStatus).toHaveBeenCalledWith('account-1', 'syncing')
    mocks.db.getAccount.mockReturnValue({ ...mocks.account, syncEnabled: true })
    await request({ type: 'sync:rebuild', payload: { accountId: 'account-1' } })
    expect(mocks.db.resetForFullSync).toHaveBeenCalledWith('account-1')
  })

  it('applies paginated Gmail history additions, label changes, deletions, and expired checkpoints', async () => {
    const { GmailApiError } = await import('./mail/gmail-client')
    mocks.fs.statfsSync.mockReturnValue({ bavail: 2_000_000n, bsize: 4096n })
    mocks.db.getAccount.mockReturnValue(mocks.account)
    mocks.db.getAccountHistory.mockReturnValue('history-1')
    mocks.db.getSyncProgress.mockReturnValue([])
    mocks.db.hasMessage.mockReturnValue(false)
    mocks.postalParse.mockResolvedValue({ attachments: [], text: 'body', subject: 'History message' })
    mocks.gmail.listHistory.mockClear()
    mocks.gmail.listHistory
      .mockResolvedValueOnce({
        historyId: 'history-2', nextPageToken: 'next', history: [{
          id: 'history-2',
          messagesDeleted: [{ message: { id: 'deleted', threadId: 'deleted-thread' } }],
          messagesAdded: [{ message: { id: 'new', threadId: 'new-thread' } }],
          labelsAdded: [{ message: { id: 'labelled', threadId: 'label-thread' } }],
          labelsRemoved: [{ message: { id: 'missing', threadId: 'missing-thread' } }]
        }]
      })
      .mockResolvedValueOnce({ history: [{ id: '', labelsAdded: [] }] })
    mocks.gmail.getRawMessage.mockImplementation(async (id: string) => {
      if (id === 'missing') throw new GmailApiError('gone', 404)
      return { id, threadId: `${id}-thread`, historyId: 'history-2', raw: Buffer.from('raw').toString('base64url'), labelIds: ['INBOX'] }
    })
    mocks.notification.mockReturnValue({ accountId: 'account-1', title: 'New history mail', body: 'New' })
    mocks.db.setAccountHistory.mockClear()
    await request({ type: 'sync:resume', payload: { accountId: 'account-1' } })
    await vi.waitFor(() => expect(mocks.db.setAccountHistory).toHaveBeenCalledWith('account-1', 'history-2', true))
    expect(mocks.gmail.listHistory).toHaveBeenNthCalledWith(2, 'history-1', 'next')
    expect(mocks.db.deleteMessage).toHaveBeenCalledWith('account-1', 'missing')
    expect(mocks.posted).toContainEqual(expect.objectContaining({ kind: 'event', event: expect.objectContaining({ type: 'new-mail' }) }))

    mocks.gmail.listHistory.mockRejectedValueOnce(new GmailApiError('expired history', 404))
    mocks.db.getSyncCheckpoint.mockReturnValue({ total: 1, inventory_complete: 1, initial_history_id: 'fresh' })
    mocks.db.pendingMessageIds.mockReturnValue([])
    mocks.gmail.listHistory.mockResolvedValue({ history: [], historyId: 'fresh' })
    await request({ type: 'sync:resume', payload: { accountId: 'account-1' } })
    await vi.waitFor(() => expect(mocks.db.resetInventory).toHaveBeenCalled())
    mocks.notification.mockReturnValue(undefined)
  })

  it('reconciles removed Microsoft folders/messages and changed IMAP UID validity', async () => {
    mocks.setCredential({ type: 'oauth', accessToken: 'token' })
    mocks.db.getAccount.mockReturnValue({ ...mocks.account, provider: 'microsoft' })
    mocks.db.getAccountHistory.mockReturnValue(undefined)
    mocks.db.getSyncProgress.mockReturnValue([])
    mocks.db.getProviderState.mockImplementation((_id: string, fallback: any) => ({ ...fallback, deltaLinks: { removedFolder: 'old-delta' } }))
    mocks.microsoft.listFolders.mockResolvedValueOnce([{ id: 'inbox', displayName: 'Inbox', specialUse: 'inbox' }])
    mocks.microsoft.delta.mockResolvedValueOnce({ messages: [{ id: 'removed-message', '@removed': { reason: 'deleted' } }], deltaLink: undefined })
    mocks.db.reconcileInventory.mockClear()
    mocks.db.deleteMessage.mockClear()
    await request({ type: 'sync:resume', payload: { accountId: 'account-1' } })
    await vi.waitFor(() => expect(mocks.db.setAccountHistory).toHaveBeenCalledWith('account-1', expect.stringMatching(/^graph:/), true))
    expect(mocks.db.reconcileRemoteFolder).toHaveBeenCalledWith('account-1', 'removedFolder', expect.any(Set))
    expect(mocks.db.deleteMessage).toHaveBeenCalledWith('account-1', 'removed-message')
    expect(mocks.db.reconcileInventory).toHaveBeenCalledWith('account-1')

    mocks.setCredential({ type: 'imap', config: { email: 'imap@example.test' } })
    mocks.db.getAccount.mockReturnValue({ ...mocks.account, provider: 'imap' })
    mocks.db.getAccountHistory.mockReturnValue('imap-history')
    mocks.db.getProviderState.mockImplementation((_id: string, fallback: any) => ({ ...fallback, folders: { INBOX: { uidValidity: 'old' } } }))
    mocks.imap.listFolders.mockResolvedValueOnce([{ path: 'INBOX', name: 'Inbox' }])
    mocks.imap.inventoryFolder.mockResolvedValueOnce({ refs: [{ id: 'existing', threadId: 'thread', folder: 'INBOX', uid: 9, labels: ['INBOX'] }], uidValidity: 'new', uidNext: 10, highestModseq: '5' })
    mocks.db.hasMessage.mockReturnValue(true)
    mocks.db.pendingMessageIds.mockReturnValue([])
    await request({ type: 'sync:resume', payload: { accountId: 'account-1' } })
    await vi.waitFor(() => expect(mocks.db.updateMessageLabels).toHaveBeenCalledWith('account-1', 'existing', ['INBOX'], 'new:9'))
    expect(mocks.db.reconcileRemoteFolder).toHaveBeenCalledWith('account-1', 'INBOX', expect.any(Set))
    mocks.setCredential({ type: 'oauth', accessToken: 'token' })
  })

  it('covers final operation failures, provider destinations, IMAP drafts, and binary attachment staging', async () => {
    mocks.db.getAccount.mockReturnValue(mocks.account)
    mocks.db.operationAttempts.mockReturnValueOnce(5)
    mocks.gmail.modifyThreads.mockRejectedValueOnce('permanent failure')
    mocks.db.dueOperations.mockReturnValueOnce([{ id: 'final-failure', account_id: 'account-1', kind: 'read', thread_ids_json: '["thread"]', label_id: null }]).mockReturnValue([])
    await request({ type: 'network', payload: { online: true } })
    await vi.waitFor(() => expect(mocks.db.restoreOperationSnapshot).toHaveBeenCalledWith('final-failure', 'failed', 'permanent failure'))
    mocks.gmail.modifyThreads.mockResolvedValue(undefined)

    mocks.db.getAccount.mockReturnValue({ ...mocks.account, provider: 'microsoft' })
    mocks.db.getProviderState.mockImplementation((_id: string, fallback: any) => ({ ...fallback, specialFolders: { deleteditems: 'trash', archive: 'archive', inbox: 'inbox' } }))
    mocks.db.remoteMessagesForThreads.mockReturnValue([{ id: 'remote-message' }])
    mocks.db.dueOperations.mockReturnValueOnce([
      { id: 'ms-trash', account_id: 'account-1', kind: 'trash', thread_ids_json: '["thread"]', label_id: null },
      { id: 'ms-untrash', account_id: 'account-1', kind: 'untrash', thread_ids_json: '["thread"]', label_id: null },
      { id: 'ms-folder', account_id: 'account-1', kind: 'move', thread_ids_json: '["thread"]', label_id: 'folder:custom' }
    ]).mockReturnValue([])
    await request({ type: 'network', payload: { online: true } })
    await vi.waitFor(() => expect(mocks.db.updateOperation).toHaveBeenCalledWith('ms-folder', 'succeeded'))
    expect(mocks.microsoft.applyAction).toHaveBeenCalledWith(['remote-message'], 'trash', 'trash')
    expect(mocks.microsoft.applyAction).toHaveBeenCalledWith(['remote-message'], 'untrash', 'inbox')
    expect(mocks.microsoft.applyAction).toHaveBeenCalledWith(['remote-message'], 'move', 'custom')

    const input = { id: 'imap-save', accountId: 'account-1', to: ['ada@example.test'], cc: [], bcc: [], subject: 'IMAP', text: 'Body', references: [], attachmentPaths: [] }
    mocks.setCredential({ type: 'imap', config: { email: 'imap@example.test' } })
    mocks.db.getAccount.mockReturnValue({ ...mocks.account, provider: 'imap' })
    mocks.db.getDraft.mockReturnValue({ gmail_draft_id: null })
    await expect(request({ type: 'drafts:save', payload: input })).resolves.toMatchObject({ result: { status: 'synced', remoteDraftId: 'remote-draft' } })
    expect(mocks.imap.saveDraft).toHaveBeenCalledWith(expect.any(Buffer), undefined)

    mocks.db.getMessageRaw.mockReturnValueOnce('raw.eml')
    mocks.postalParse.mockResolvedValueOnce({ attachments: [
      { filename: '', content: new Uint8Array([1, 2]).buffer },
      { filename: 'typed.bin', content: new Uint8Array([3, 4]) }
    ] })
    const staged = await request({ type: 'drafts:stage-message-attachments', payload: { draftId: 'binary', accountId: 'account-1', messageId: 'message' } })
    expect(staged.result.map((item: any) => item.name)).toEqual(['attachment-1', 'typed.bin'])
    mocks.setCredential({ type: 'oauth', accessToken: 'token' })
  })

  it('handles empty and stale rules plus local, invalid, and failed queued drafts', async () => {
    const emptyRule = { id: 'empty-rule', accountId: 'account-1', actions: [{ action: 'archive' }] }
    mocks.db.getRule.mockReturnValueOnce(emptyRule)
    mocks.db.matchingThreadIdsForRule.mockReturnValueOnce([])
    await expect(request({ type: 'rules:run', payload: { id: 'empty-rule' } })).resolves.toMatchObject({ result: { matched: 0, operations: 0 } })

    const staleRule = { id: 'stale-rule', accountId: 'account-1', actions: [{ action: 'archive' }] }
    mocks.db.getRule.mockReturnValueOnce(staleRule)
    mocks.db.matchingThreadIdsForRule.mockReturnValueOnce(['gone-thread'])
    mocks.db.applyLocalAction.mockImplementationOnce(() => { throw new Error('stale thread') })
    await expect(request({ type: 'rules:run', payload: { id: 'stale-rule' } })).resolves.toMatchObject({ result: { matched: 1, operations: 0 } })

    const row = (id: string, to = '["ada@example.test"]') => ({
      id, account_id: 'account-1', thread_id: null, in_reply_to: null, references_json: '[]', to_json: to,
      cc_json: '[]', bcc_json: '[]', subject: id, body_text: 'Body', body_html: null, attachment_paths_json: '[]', gmail_draft_id: null
    })
    const discard = row('discard-local')
    mocks.db.getAccount.mockReturnValue(mocks.account)
    mocks.db.getDraft.mockImplementation((id: string) => id === 'discard-local' ? discard : undefined)
    mocks.db.draftsToDiscard.mockReturnValueOnce([discard]).mockReturnValue([])
    mocks.db.draftsToSync.mockReturnValueOnce([row('invalid-recipient', '["unfinished"]')]).mockReturnValue([])
    mocks.db.queuedDrafts.mockReturnValueOnce([row('failed-delivery')]).mockReturnValue([])
    mocks.gmail.sendMessage.mockRejectedValueOnce('plain send failure')
    await request({ type: 'network', payload: { online: true } })
    await vi.waitFor(() => expect(mocks.db.updateDraftResult).toHaveBeenCalledWith('failed-delivery', expect.objectContaining({ status: 'failed', error: 'plain send failure' })))
    expect(mocks.db.deleteDraftRecord).toHaveBeenCalledWith('discard-local')
    expect(mocks.db.updateDraftResult).not.toHaveBeenCalledWith('invalid-recipient', expect.anything())
  })

  it('resumes a paginated Gmail inventory with notifications disabled', async () => {
    mocks.fs.statfsSync.mockReturnValue({ bavail: 2_000_000n, bsize: 4096n })
    mocks.db.getAccount.mockReturnValue({ ...mocks.account, notifications: false })
    mocks.db.getAccountHistory.mockReturnValue(undefined)
    mocks.db.getSyncCheckpoint.mockReturnValue({ total: 3, inventory_complete: 0, page_token: 'resume-page', initial_history_id: '42' })
    mocks.db.getSyncProgress.mockReturnValue([{ accountId: 'account-1', phase: 'inventory', completed: 1, total: 3, transferredBytes: 0, updatedAt: new Date().toISOString() }])
    mocks.db.pendingMessageIds.mockReturnValue([])
    mocks.gmail.listMessages
      .mockResolvedValueOnce({ messages: undefined, nextPageToken: 'last-page' })
      .mockResolvedValueOnce({ messages: [], nextPageToken: undefined })
    mocks.gmail.listHistory.mockResolvedValue({ history: [], historyId: '42' })
    mocks.db.setAccountHistory.mockClear()

    await request({ type: 'sync:resume', payload: { accountId: 'account-1' } })
    await vi.waitFor(() => expect(mocks.db.setAccountHistory).toHaveBeenCalledWith('account-1', '42', true))
    expect(mocks.gmail.listMessages).toHaveBeenCalledWith('resume-page')
    expect(mocks.gmail.listMessages).toHaveBeenCalledWith('last-page')
  })

  it('maps Gmail status errors, explicit credential failures, and non-immediate polling', async () => {
    const { GmailApiError } = await import('./mail/gmail-client')
    mocks.db.getAccount.mockReturnValue(mocks.account)
    mocks.gmail.getProfile.mockRejectedValueOnce(new GmailApiError('rate limited', 429))
    await expect(request({ type: 'accounts:verify', payload: { accountId: 'account-1' } })).resolves.toMatchObject({ error: { code: 'gmail-429', message: 'rate limited' } })

    mocks.setCredentialError('Credential vault unavailable')
    await expect(mocks.microsoft.getAccessToken?.()).rejects.toThrow('Credential vault unavailable')
    mocks.setCredential({ type: 'oauth', accessToken: 'token' })
    await expect(request({ type: 'polling', payload: { intervalMs: 60_000, immediate: false } })).resolves.toMatchObject({ result: undefined })
  })

  it('covers sparse provider operations, draft destinations, staging, and binary extraction', async () => {
    mocks.db.getAccount.mockReturnValue(undefined)
    mocks.db.dueOperations.mockReturnValueOnce([{ id: 'default-gmail', account_id: 'missing', kind: 'read', thread_ids_json: '["thread"]', label_id: null }]).mockReturnValue([])
    await request({ type: 'network', payload: { online: true } })
    await vi.waitFor(() => expect(mocks.db.updateOperation).toHaveBeenCalledWith('default-gmail', 'succeeded'))

    mocks.setCredential({ type: 'imap', config: { email: 'imap@example.test' } })
    mocks.db.getAccount.mockReturnValue({ ...mocks.account, provider: 'imap' })
    mocks.db.remoteMessagesForThreads.mockReturnValue([{ id: 'missing-ref' }, { id: 'valid-ref', remoteFolderId: 'INBOX', remoteUid: '9' }])
    mocks.db.dueOperations.mockReturnValueOnce([{ id: 'imap-sparse', account_id: 'account-1', kind: 'read', thread_ids_json: '["thread"]', label_id: null }]).mockReturnValue([])
    await request({ type: 'network', payload: { online: true } })
    await vi.waitFor(() => expect(mocks.imap.applyAction).toHaveBeenCalledWith([{ folder: 'INBOX', uid: 9 }], 'read', undefined))

    const invalidDraft = { accountId: 'account-1', to: ['unfinished'], cc: [], bcc: [], subject: 'Local only', text: '', references: [], attachmentPaths: [] }
    await expect(request({ type: 'drafts:save', payload: invalidDraft })).resolves.toMatchObject({ result: { status: 'local' } })
    await expect(request({ type: 'drafts:save', payload: { ...invalidDraft, id: '' } })).resolves.toMatchObject({ result: { status: 'local' } })

    const providerInput = { id: 'provider-matrix', accountId: 'account-1', to: ['ada@example.test'], cc: [], bcc: [], subject: 'Provider matrix', text: 'Body', references: [], attachmentPaths: [] }
    mocks.setCredential({ type: 'oauth', accessToken: 'token' })
    mocks.db.getAccount.mockReturnValue({ ...mocks.account, provider: 'microsoft' })
    mocks.db.getDraft.mockReturnValue({ gmail_draft_id: null })
    await request({ type: 'drafts:save', payload: providerInput })
    expect(mocks.microsoft.saveDraft).toHaveBeenCalledWith(expect.any(Buffer), undefined)

    const row = (id: string, remoteId: string | null) => ({
      id, account_id: 'account-1', thread_id: 'thread-id', in_reply_to: '<reply@example.test>', references_json: '[]', to_json: '["ada@example.test"]',
      cc_json: '[]', bcc_json: '[]', subject: id, body_text: 'Body', body_html: null, attachment_paths_json: '[]', gmail_draft_id: remoteId
    })
    mocks.db.getDraft.mockReturnValue(row('microsoft-remote-send', 'remote-ms'))
    mocks.db.queuedDrafts.mockReturnValueOnce([row('microsoft-remote-send', 'remote-ms')]).mockReturnValue([])
    await request({ type: 'network', payload: { online: true } })
    await vi.waitFor(() => expect(mocks.microsoft.send).toHaveBeenCalledWith(expect.any(Buffer), 'remote-ms'))

    mocks.setCredential({ type: 'imap', config: { email: 'imap@example.test' } })
    mocks.db.getAccount.mockReturnValue({ ...mocks.account, provider: 'imap' })
    mocks.db.getDraft.mockReturnValue({ gmail_draft_id: 'remote-imap' })
    await request({ type: 'drafts:save', payload: { ...providerInput, id: 'imap-remote-save' } })
    expect(mocks.imap.saveDraft).toHaveBeenCalledWith(expect.any(Buffer), 'remote-imap')

    mocks.db.getDraft.mockReturnValue(row('imap-no-remote-send', null))
    mocks.db.queuedDrafts.mockReturnValueOnce([row('imap-no-remote-send', null)]).mockReturnValue([])
    await request({ type: 'network', payload: { online: true } })
    await vi.waitFor(() => expect(mocks.imap.send).toHaveBeenCalledWith(expect.any(Buffer), ['ada@example.test']))

    mocks.setCredential({ type: 'oauth', accessToken: 'token' })
    mocks.db.getAccount.mockReturnValue(undefined)
    mocks.db.getDraft.mockReturnValue({ ...row('discard-plain-failure', 'remote-gmail'), account_id: 'missing' })
    mocks.gmail.deleteDraft.mockRejectedValueOnce('plain discard failure')
    await expect(request({ type: 'drafts:delete', payload: { id: 'discard-plain-failure' } })).resolves.toMatchObject({ result: { status: 'failed', error: 'plain discard failure' } })

    const filename = 'typed.bin', mimeType = 'application/octet-stream'
    const attachmentId = `part-0-${Buffer.from(`${filename}::${mimeType}`).toString('base64url').slice(0, 16)}`
    mocks.db.getMessageRaw.mockReturnValue('raw.eml')
    mocks.postalParse.mockResolvedValueOnce({ attachments: [{ filename, mimeType, content: new Uint8Array([5, 6]) }] })
    await expect(request({ type: 'attachment:extract', payload: { accountId: 'account-1', messageId: 'binary', attachmentId, targetPath: 'typed.bin' } })).resolves.toMatchObject({ result: undefined })
    expect(mocks.fs.writeFileSync).toHaveBeenCalledWith('typed.bin', Buffer.from([5, 6]))

    mocks.postalParse.mockResolvedValueOnce({ attachments: [{ filename: 'base64.txt', mimeType: 'text/plain', content: 'aGVsbG8=', encoding: 'base64' }] })
    const staged = await request({ type: 'drafts:stage-message-attachments', payload: { draftId: 'base64-stage', accountId: 'account-1', messageId: 'message' } })
    expect(staged.result[0]).toMatchObject({ name: 'base64.txt', size: 5 })
    mocks.setCredential({ type: 'oauth', accessToken: 'token' })
  })

  it('shuts down cleanly', async () => {
    await expect(request({ type: 'shutdown' })).resolves.toMatchObject({ result: undefined })
    expect(mocks.db.close).toHaveBeenCalledOnce()
    await expect(request({ type: 'accounts:list' })).resolves.toMatchObject({ error: { message: 'Database is not initialized' } })
  })
})
