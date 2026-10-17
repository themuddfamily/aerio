import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commitDownloadedRaw, downloadGmailMessage, downloadGraphMessage, downloadImapMessage, removePartialDownloads, upgradeStoredMessage } from './offline-download'
import { createOfflineCommands } from './offline-commands'
import { cleanupOfflineFixtures, mime, offlineDatabase, offlineDeps, seedFull } from './offline-test-fixtures'
import type { MailDatabase } from './database'

afterEach(cleanupOfflineFixtures)

const DAY = 86_400_000
const daysAgo = (days: number) => new Date(Date.now() - days * DAY)
const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url')

function gmailFake(messages: Record<string, { labels: string[]; date: Date; subject?: string; attachment?: boolean }>) {
  const raw = (id: string) => mime({ messageId: `<${id}@example.com>`, subject: messages[id].subject ?? `Subject ${id}`, date: messages[id].date.toISOString(), body: `Body of ${id}`, ...(messages[id].attachment ? { attachment: { name: 'notes.txt', content: 'attached words' } } : {}) })
  const headers = (id: string) => [{ name: 'From', value: 'Ada <ada@example.com>' }, { name: 'Subject', value: messages[id].subject ?? `Subject ${id}` }, { name: 'Message-ID', value: `<${id}@example.com>` }, { name: 'Date', value: messages[id].date.toUTCString() }]
  const base = (id: string) => ({ id, threadId: `thread-${id}`, labelIds: messages[id].labels, historyId: '5', internalDate: String(messages[id].date.getTime()), snippet: `Snippet ${id}`, sizeEstimate: 500 })
  return {
    getRawMessage: vi.fn(async (id: string) => ({ ...base(id), raw: b64url(raw(id)) })),
    getMessage: vi.fn(async (id: string, format: 'metadata' | 'full') => ({
      ...base(id),
      payload: format === 'metadata' ? { headers: headers(id) } : {
        mimeType: 'multipart/mixed', headers: headers(id), parts: [
          { mimeType: 'text/plain', body: { size: 10, data: b64url(`Body of ${id}`) } },
          ...(messages[id].attachment ? [{ mimeType: 'text/plain', filename: 'notes.txt', body: { size: 14, attachmentId: 'att-1' } }] : [])
        ]
      }
    })),
    listMessages: vi.fn(async (_page?: string, _query?: string) => ({ messages: Object.keys(messages).map((id) => ({ id, threadId: `thread-${id}` })) }))
  }
}

function setPolicy(database: MailDatabase, downloadMode: 'full' | 'bodies' | 'headers', amount?: number) {
  database.offline.setAccountPolicy('account-1', { downloadMode, window: amount ? { unit: 'days', amount } : { unit: 'all', amount: 0 } })
}

describe('policy-aware provider downloads (E36)', () => {
  it('Gmail downloads raw for full content, format=full for bodies and format=metadata for headers, by label', async () => {
    const { database } = offlineDatabase()
    const deps = offlineDeps(database)
    const gmail = gmailFake({
      inbox: { labels: ['INBOX'], date: daysAgo(2) },
      kept: { labels: ['INBOX', 'Label_keep'], date: daysAgo(200), attachment: true },
      reading: { labels: ['Label_read'], date: daysAgo(3), attachment: true },
      stale: { labels: ['INBOX'], date: daysAgo(200) }
    })
    setPolicy(database, 'headers', 30)
    database.offline.setFolderOverride('account-1', 'Label_keep', { downloadMode: 'full', window: { unit: 'all', amount: 0 } })
    database.offline.setFolderOverride('account-1', 'Label_read', { downloadMode: 'bodies' })
    database.addInventory('account-1', ['inbox', 'kept', 'reading', 'stale'].map((id) => ({ id, threadId: `thread-${id}` })))
    const context = database.offline.context('account-1')
    expect(await downloadGmailMessage(deps, gmail, 'account-1', 'inbox', context)).toMatchObject({ outcome: 'stored' })
    expect(await downloadGmailMessage(deps, gmail, 'account-1', 'kept', context)).toMatchObject({ outcome: 'stored' })
    expect(await downloadGmailMessage(deps, gmail, 'account-1', 'reading', context)).toMatchObject({ outcome: 'stored' })
    expect(await downloadGmailMessage(deps, gmail, 'account-1', 'stale', context)).toEqual({ outcome: 'outside' })
    expect(gmail.getRawMessage.mock.calls.map(([id]) => id)).toEqual(['kept'])
    expect(gmail.getMessage).toHaveBeenCalledWith('reading', 'full')
    expect(database.offline.contentState('account-1', 'inbox')).toBe('headers')
    expect(database.getThread('account-1', 'thread-inbox').messages[0]).toMatchObject({ subject: 'Subject inbox', fromEmail: 'ada@example.com', text: '' })
    expect(database.offline.contentState('account-1', 'kept')).toBe('full')
    expect(database.offline.contentState('account-1', 'reading')).toBe('body')
    expect(database.getThread('account-1', 'thread-reading').messages[0]).toMatchObject({ text: 'Body of reading', attachments: [expect.objectContaining({ filename: 'notes.txt', id: expect.stringMatching(/^remote-/) })] })
    // Outside every window: nothing stored, and the inventory entry is dropped so a wider window finds it again.
    expect(database.hasMessage('account-1', 'stale')).toBe(false)
    expect(database.pendingMessageIds('account-1', 10).map((item) => item.id)).toEqual([])
    // A label change on a cached message only refreshes labels; nothing is downloaded again.
    gmail.getRawMessage.mockClear()
    expect(await downloadGmailMessage(deps, gmail, 'account-1', 'kept', context)).toEqual({ outcome: 'current' })
    expect(gmail.getRawMessage).not.toHaveBeenCalled()
  })

  it('Gmail with the default scope downloads raw directly, like before', async () => {
    const { database } = offlineDatabase()
    const gmail = gmailFake({ a: { labels: ['INBOX'], date: daysAgo(400) } })
    await downloadGmailMessage(offlineDeps(database), gmail, 'account-1', 'a', database.offline.context('account-1'))
    expect(gmail.getMessage).not.toHaveBeenCalled()
    expect(database.offline.contentState('account-1', 'a')).toBe('full')
    // A cached original that disappeared from disk is downloaded again; Rebuild (refresh) always downloads.
    rmSync(database.getMessageRaw('account-1', 'a')!)
    await downloadGmailMessage(offlineDeps(database), gmail, 'account-1', 'a', database.offline.context('account-1'))
    expect(gmail.getRawMessage).toHaveBeenCalledTimes(2)
    expect(database.rawExists(database.getMessageRaw('account-1', 'a')!)).toBe(true)
    await downloadGmailMessage(offlineDeps(database), gmail, 'account-1', 'a', database.offline.context('account-1'), true)
    expect(gmail.getRawMessage).toHaveBeenCalledTimes(3)
  })

  it('Graph selects header fields, body fields or the MIME original', async () => {
    const { database } = offlineDatabase('microsoft')
    const deps = offlineDeps(database)
    const fields = (id: string, withBody: boolean) => ({ id, subject: `Graph ${id}`, from: { emailAddress: { name: 'Bo', address: 'bo@example.com' } }, internetMessageId: `<${id}@x>`, receivedDateTime: daysAgo(1).toISOString(), bodyPreview: 'preview', hasAttachments: true, ...(withBody ? { body: { contentType: 'html' as const, content: '<p>Graph body</p>' } } : {}) })
    const graph = {
      messageRaw: vi.fn(async (id: string) => mime({ messageId: `<${id}@x>`, subject: 'Raw', date: daysAgo(1).toISOString() })),
      messageFields: vi.fn(async (id: string, withBody: boolean) => fields(id, withBody)),
      attachmentList: vi.fn(async () => [{ id: 'att', name: 'deck.pptx', contentType: 'application/vnd.ms-powerpoint', size: 4000 }]),
      search: vi.fn()
    }
    setPolicy(database, 'headers', 30)
    database.offline.setFolderOverride('account-1', 'folder:f-reading', { downloadMode: 'bodies' })
    database.offline.setFolderOverride('account-1', 'folder:f-full', { downloadMode: 'full' })
    const context = database.offline.context('account-1')
    const message = (id: string, days = 1) => ({ id, conversationId: `conv-${id}`, receivedDateTime: daysAgo(days).toISOString() })
    await downloadGraphMessage(deps, graph, 'account-1', { message: message('h'), folderId: 'f-inbox', labels: ['folder:f-inbox', 'INBOX'], threadId: 'conv-h' }, context)
    await downloadGraphMessage(deps, graph, 'account-1', { message: message('b'), folderId: 'f-reading', labels: ['folder:f-reading'], threadId: 'conv-b' }, context)
    await downloadGraphMessage(deps, graph, 'account-1', { message: message('f'), folderId: 'f-full', labels: ['folder:f-full'], threadId: 'conv-f' }, context)
    expect(await downloadGraphMessage(deps, graph, 'account-1', { message: message('old', 90), folderId: 'f-inbox', labels: ['folder:f-inbox', 'INBOX'], threadId: 'conv-old' }, context)).toEqual({ outcome: 'outside' })
    expect(graph.messageFields.mock.calls).toEqual([['h', false], ['b', true]])
    expect(graph.attachmentList).toHaveBeenCalledTimes(1)
    expect(graph.messageRaw.mock.calls).toEqual([['f']])
    expect(database.getThread('account-1', 'conv-h').messages[0]).toMatchObject({ subject: 'Graph h', fromName: 'Bo', text: '' })
    expect(database.getThread('account-1', 'conv-b').messages[0]).toMatchObject({ html: '<p>Graph body</p>', text: 'Graph body', attachments: [expect.objectContaining({ filename: 'deck.pptx' })] })
    expect(database.offline.contentState('account-1', 'f')).toBe('full')
  })

  it('IMAP fetches BODYSTRUCTURE and headers (plus text parts) instead of BODY[]', async () => {
    const { database } = offlineDatabase('imap')
    const deps = offlineDeps(database)
    const partial = (withBody: boolean) => ({ headers: 'From: Cy <cy@example.com>\r\nSubject: IMAP partial\r\nMessage-ID: <p@x>\r\nReferences: <root@x>\r\n\r\n', text: withBody ? 'plain body' : '', html: '', attachments: [{ filename: 'a.pdf', mimeType: 'application/pdf', size: 99 }], internalDate: daysAgo(2).toISOString(), labels: ['folder:INBOX', 'INBOX'], size: 1234 })
    const imap = {
      fetchPartial: vi.fn(async (_c: unknown, _f: unknown, _uid: number, withBody: boolean) => partial(withBody)),
      fetchRaw: vi.fn(async () => ({ raw: mime({ messageId: '<r@x>', subject: 'Raw IMAP', date: daysAgo(2).toISOString() }), internalDate: daysAgo(2).toISOString(), labels: ['folder:INBOX', 'INBOX'], size: 300 }))
    }
    const folder = { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' }
    setPolicy(database, 'headers')
    await downloadImapMessage(deps, imap, {} as never, 'account-1', folder, { id: 'i1', threadId: 'tmp', uid: 1, uidValidity: '7' }, database.offline.context('account-1'))
    expect(imap.fetchRaw).not.toHaveBeenCalled()
    expect(imap.fetchPartial).toHaveBeenCalledTimes(1)
    expect(database.offline.contentState('account-1', 'i1')).toBe('headers')
    expect(database.getThread('account-1', database.offline.messageRow('account-1', 'i1')!.threadId).messages[0]).toMatchObject({ subject: 'IMAP partial', attachments: [expect.objectContaining({ filename: 'a.pdf' })] })
    setPolicy(database, 'bodies')
    await downloadImapMessage(deps, imap, {} as never, 'account-1', folder, { id: 'i2', threadId: 'tmp', uid: 2, uidValidity: '7' }, database.offline.context('account-1'))
    expect(imap.fetchPartial.mock.calls.map((call) => call[3])).toEqual([false, false, true])
    expect(database.offline.contentState('account-1', 'i2')).toBe('body')
    setPolicy(database, 'full')
    await downloadImapMessage(deps, imap, {} as never, 'account-1', folder, { id: 'i3', threadId: 'tmp', uid: 3, uidValidity: '7' }, database.offline.context('account-1'))
    expect(imap.fetchRaw).toHaveBeenCalledTimes(1)
    expect(imap.fetchPartial).toHaveBeenCalledTimes(3)
  })

  it('opening a header-only message downloads it online and shows a notice offline', async () => {
    const { database } = offlineDatabase()
    const deps = offlineDeps(database)
    const gmail = gmailFake({ m: { labels: ['INBOX'], date: daysAgo(1), attachment: true } })
    setPolicy(database, 'headers')
    await downloadGmailMessage(deps, gmail, 'account-1', 'm', database.offline.context('account-1'))
    let online = false
    const changed = vi.fn()
    const commands = createOfflineCommands({ ...deps, clients: { gmail: () => gmail, microsoft: vi.fn(), imap: vi.fn() } as never, online: () => online, resync: vi.fn(), changed })
    const offlineThread = await commands.annotateThread('account-1', database.getThread('account-1', 'thread-m'))
    expect(offlineThread.messages[0].offline).toEqual({ state: 'headers', notice: 'Not downloaded — connect to load' })
    await expect(commands.ensureRaw('account-1', 'm')).rejects.toThrow('Not downloaded — connect to load.')
    online = true
    gmail.getRawMessage.mockRejectedValueOnce(new Error('Gmail is unavailable'))
    expect((await commands.annotateThread('account-1', database.getThread('account-1', 'thread-m'))).messages[0].offline?.notice).toBe('Couldn’t download this message: Gmail is unavailable')
    const opened = await commands.annotateThread('account-1', database.getThread('account-1', 'thread-m'))
    expect(opened.messages[0].offline).toBeUndefined()
    expect(opened.messages[0].text).toContain('Body of m')
    expect(database.offline.contentState('account-1', 'm')).toBe('full')
    expect(existsSync(await commands.ensureRaw('account-1', 'm'))).toBe(true)
  })

  it('downloads an attachment on demand for a message stored without attachments', async () => {
    const { database } = offlineDatabase()
    const deps = offlineDeps(database)
    const gmail = gmailFake({ m: { labels: ['INBOX'], date: daysAgo(1), attachment: true } })
    setPolicy(database, 'bodies')
    await downloadGmailMessage(deps, gmail, 'account-1', 'm', database.offline.context('account-1'))
    expect(database.rawExists(database.getMessageRaw('account-1', 'm')!)).toBe(false)
    const changed = vi.fn()
    const commands = createOfflineCommands({ ...deps, clients: { gmail: () => gmail } as never, online: () => true, resync: vi.fn(), changed })
    const thread = await commands.annotateThread('account-1', database.getThread('account-1', 'thread-m'))
    expect(thread.messages[0].offline).toEqual({ state: 'body' })
    const path = await commands.ensureRaw('account-1', 'm')
    expect(database.rawExists(path)).toBe(true)
    expect(changed).toHaveBeenCalledWith('account-1')
    expect(database.getThread('account-1', 'thread-m').messages[0].attachments).toEqual([expect.objectContaining({ filename: 'notes.txt', id: 'part-0' })])
  })

  it('an interrupted download leaves no partial original and resumes from the queue', async () => {
    const { database, contentPath } = offlineDatabase()
    const deps = offlineDeps(database)
    const path = database.rawPath('account-1', 'cut')
    // A failure after writing but before committing removes the temporary file and stores nothing.
    await expect(commitDownloadedRaw(path, Buffer.from('half a messa'), async () => { throw new Error('connection reset') })).rejects.toThrow('connection reset')
    expect(existsSync(path)).toBe(false)
    expect(existsSync(`${path}.partial`)).toBe(false)
    // A crash leaves only a .partial file, which the next start removes.
    writeFileSync(`${path}.partial`, 'half')
    mkdirSync(join(contentPath, 'drafts'), { recursive: true })
    writeFileSync(join(contentPath, 'drafts', 'keep.eml.partial'), 'draft attachment')
    expect(removePartialDownloads(contentPath)).toBe(1)
    expect(readdirSync(join(contentPath, 'drafts'))).toEqual(['keep.eml.partial'])
    // The queued message is still pending after a failed download and completes on the retry.
    const gmail = gmailFake({ cut: { labels: ['INBOX'], date: daysAgo(1) } })
    database.addInventory('account-1', [{ id: 'cut', threadId: 'thread-cut' }])
    gmail.getRawMessage.mockRejectedValueOnce(new Error('socket hang up'))
    await expect(downloadGmailMessage(deps, gmail, 'account-1', 'cut', database.offline.context('account-1'))).rejects.toThrow('socket hang up')
    expect(database.hasMessage('account-1', 'cut')).toBe(false)
    expect(database.pendingMessageIds('account-1', 5).map((item) => item.id)).toEqual(['cut'])
    await downloadGmailMessage(deps, gmail, 'account-1', 'cut', database.offline.context('account-1'))
    expect(database.pendingMessageIds('account-1', 5)).toEqual([])
    expect(existsSync(path)).toBe(true)
    expect(existsSync(`${path}.partial`)).toBe(false)
  })

  it('upgrades cached messages after a policy widens', async () => {
    const { database } = offlineDatabase('microsoft')
    const deps = offlineDeps(database)
    await seedFull(database, 'account-1', { id: 'g1', date: daysAgo(3).toISOString(), labels: ['folder:inbox', 'INBOX'], remoteFolderId: 'inbox', remoteUid: 'g1' })
    setPolicy(database, 'headers')
    database.offline.evict('account-1', database.offline.context('account-1'))
    const graph = {
      messageRaw: vi.fn(async () => mime({ messageId: '<g1@example.com>', subject: 'Subject g1', date: daysAgo(3).toISOString(), body: 'Body again' })),
      messageFields: vi.fn(async (id: string) => ({ id, subject: 'Subject g1', body: { contentType: 'text' as const, content: 'Body text only' } })),
      attachmentList: vi.fn(async () => []),
      search: vi.fn()
    }
    const clients = { microsoft: () => graph } as never
    setPolicy(database, 'bodies')
    await upgradeStoredMessage(deps, clients, 'account-1', 'g1', database.offline.context('account-1'))
    expect(database.offline.contentState('account-1', 'g1')).toBe('body')
    expect(graph.messageRaw).not.toHaveBeenCalled()
    setPolicy(database, 'full')
    await upgradeStoredMessage(deps, clients, 'account-1', 'g1', database.offline.context('account-1'))
    expect(database.offline.contentState('account-1', 'g1')).toBe('full')
    expect(await upgradeStoredMessage(deps, clients, 'account-1', 'g1', database.offline.context('account-1'))).toEqual({ outcome: 'current' })
  })
})

describe('offline scope commands (E36)', () => {
  it('applies narrowing and widening policies, Load more/Load all, and daily maintenance', async () => {
    const { database } = offlineDatabase()
    const deps = offlineDeps(database)
    const old = await seedFull(database, 'account-1', { id: 'old', date: daysAgo(100).toISOString(), labels: ['INBOX'] })
    const resync = vi.fn()
    const changed = vi.fn()
    const commands = createOfflineCommands({ ...deps, clients: {} as never, online: () => true, resync, changed })
    commands.setAccountPolicy('account-1', { downloadMode: 'full', window: { unit: 'days', amount: 30 } })
    expect(existsSync(old)).toBe(false)
    expect(database.hasMessage('account-1', 'old')).toBe(true)
    expect(resync).toHaveBeenCalledWith('account-1')
    expect(changed).toHaveBeenCalledWith('account-1')
    // Load all for the Inbox wants the old message again and queues it.
    const [settings] = commands.extend({ accountIds: ['account-1'], folder: 'inbox', mode: 'all' })
    expect(settings.extensions).toEqual([expect.objectContaining({ labelId: 'INBOX', loadAllUntil: expect.any(String) })])
    expect(database.pendingMessageIds('account-1', 5).map((item) => item.id)).toEqual(['old'])
    expect(commands.availability('account-1', 'INBOX')).toMatchObject({ outsideWindow: 0, loadAllUntil: expect.any(String) })
    // Load more on the whole account adds one more window length.
    commands.extend({ accountIds: ['account-1'], folder: 'all', mode: 'more' })
    expect(commands.settings('account-1').extensions).toContainEqual({ labelId: '', extraSteps: 1 })
    expect(commands.maintain('account-1').messages).toBe(0)
    expect(commands.maintain('account-1')).toEqual({ messages: 0, bytes: 0 })
    commands.expire(new Date(Date.now() + 2 * DAY))
    expect(commands.settings('account-1').extensions.find((item) => item.labelId === 'INBOX')).toBeUndefined()
    expect(commands.searchCoverage(['account-1'])).toEqual([expect.objectContaining({ accountId: 'account-1', complete: false, serverSearch: true })])
    expect(commands.reclaim('account-1')).toEqual({ messages: 0, bytes: 0 })
  })

  it('searches Gmail, Microsoft and IMAP servers and lists the matches, adding uncached ones as header rows', async () => {
    const { database } = offlineDatabase()
    const { addAccount } = await import('./offline-test-fixtures')
    addAccount(database, 'microsoft', 'ms-1')
    addAccount(database, 'imap', 'imap-1')
    addAccount(database, 'local', 'local-1')
    const deps = offlineDeps(database)
    await seedFull(database, 'account-1', { id: 'known', date: daysAgo(1).toISOString(), labels: ['INBOX'] })
    const gmail = gmailFake({ known: { labels: ['INBOX'], date: daysAgo(1) }, remote: { labels: ['Label_x'], date: daysAgo(800) } })
    const graph = {
      search: vi.fn(async () => [{ id: 'ms-msg', conversationId: 'ms-conv', parentFolderId: 'f1', receivedDateTime: daysAgo(500).toISOString() }]),
      messageFields: vi.fn(async (id: string) => ({ id, subject: 'Found on Exchange', internetMessageId: '<ms@x>' })),
      attachmentList: vi.fn(), messageRaw: vi.fn()
    }
    const imap = {
      withConnection: vi.fn(async (callback: (connection: unknown) => Promise<unknown>) => callback({})),
      listFolders: vi.fn(async () => [{ path: 'INBOX', name: 'INBOX' }]),
      searchText: vi.fn(async () => [{ uid: 4, id: 'imap-hit', uidValidity: '3' }]),
      fetchPartial: vi.fn(async () => ({ headers: 'Subject: Found on IMAP\r\n\r\n', text: '', html: '', attachments: [], internalDate: daysAgo(700).toISOString(), labels: ['folder:INBOX', 'INBOX'], size: 10 })),
      fetchRaw: vi.fn()
    }
    let online = true
    const commands = createOfflineCommands({ ...deps, clients: { gmail: () => gmail, microsoft: () => graph, imap: async () => imap } as never, online: () => online, resync: vi.fn(), changed: vi.fn() })
    const result = await commands.serverSearch({ accountIds: ['account-1', 'ms-1', 'imap-1', 'local-1'], query: 'quarterly' })
    expect(gmail.listMessages).toHaveBeenCalledWith(undefined, 'quarterly')
    expect(graph.search).toHaveBeenCalledWith('quarterly', 250)
    expect(imap.searchText).toHaveBeenCalledWith({}, { path: 'INBOX', name: 'INBOX' }, 'quarterly')
    expect(result).toMatchObject({ matched: 4, added: 3, errors: [] })
    expect(database.offline.contentState('account-1', 'remote')).toBe('headers')
    expect(database.listThreads({ folder: 'all', serverSearchId: result.searchId }).items.map((item) => item.subject).sort()).toEqual(['Found on Exchange', 'Found on IMAP', 'Subject known', 'Subject remote'])
    graph.search.mockRejectedValueOnce(new Error('Search is throttled'))
    expect((await commands.serverSearch({ accountIds: ['ms-1'], query: 'x' })).errors).toEqual([{ accountId: 'ms-1', message: 'Search is throttled' }])
    online = false
    await expect(commands.serverSearch({ accountIds: ['account-1'], query: 'x' })).rejects.toThrow('Connect to the internet')
  })
})
