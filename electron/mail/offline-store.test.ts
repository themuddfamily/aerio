import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { addAccount, cleanupOfflineFixtures, offlineDatabase, seedFull } from './offline-test-fixtures'

afterEach(cleanupOfflineFixtures)

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

describe('offline scope store (E36)', () => {
  it('stores account defaults, folder overrides and Load more/Load all, and rejects Local Folders and POP3', () => {
    const { database } = offlineDatabase()
    addAccount(database, 'local', 'local-folders')
    addAccount(database, 'pop3', 'pop3-1')
    const store = database.offline
    expect(store.settings('account-1')).toMatchObject({ supported: true, defaults: { downloadMode: 'full', window: { unit: 'all' } }, overrides: [] })
    store.setAccountPolicy('account-1', { downloadMode: 'headers', window: { unit: 'days', amount: 30 } })
    store.setFolderOverride('account-1', 'INBOX', { downloadMode: 'full' })
    store.extend('account-1', 'INBOX', 'more')
    store.extend('account-1', 'INBOX', 'more')
    store.extend('account-1', 'Label_1', 'all')
    const settings = store.settings('account-1')
    expect(settings.defaults).toEqual({ downloadMode: 'headers', window: { unit: 'days', amount: 30 } })
    expect(settings.overrides).toEqual([expect.objectContaining({ labelId: 'INBOX', downloadMode: 'full' })])
    expect(settings.overrides[0].window).toBeUndefined()
    expect(settings.extensions).toEqual([{ labelId: 'INBOX', extraSteps: 2 }, { labelId: 'Label_1', extraSteps: 0, loadAllUntil: expect.any(String) }])
    expect(store.availability('account-1', 'INBOX').policy).toEqual({ downloadMode: 'full', window: { unit: 'days', amount: 90 } })
    // Load all ends after a day and clears itself.
    expect(store.expireExtensions(new Date(Date.now() + 2 * 86_400_000))).toEqual(['account-1'])
    expect(store.settings('account-1').extensions).toEqual([{ labelId: 'INBOX', extraSteps: 2 }])
    store.setFolderOverride('account-1', 'INBOX', null)
    expect(store.settings('account-1').overrides).toEqual([])
    expect(store.settings('local-folders').supported).toBe(false)
    expect(() => store.setAccountPolicy('local-folders', { downloadMode: 'headers', window: { unit: 'all', amount: 0 } })).toThrow('always available offline')
    expect(() => store.setFolderOverride('pop3-1', 'INBOX', { downloadMode: 'headers' })).toThrow('always available offline')
    addAccount(database, 'exchange', 'ews-1')
    expect(store.settings('ews-1')).toMatchObject({ supported: false, unsupportedReason: expect.stringMatching(/Exchange accounts always download full offline content/) })
    expect(() => store.setAccountPolicy('ews-1', { downloadMode: 'headers', window: { unit: 'all', amount: 0 } })).toThrow('not available for them yet')
    expect(store.policyCount()).toBe(1)
  })

  it('narrowing reclaims bodies and originals but keeps header rows, drafts, pending writes and provider-shared copies', async () => {
    const { database } = offlineDatabase()
    const recent = await seedFull(database, 'account-1', { id: 'recent', date: daysAgo(2), labels: ['INBOX'], attachment: true })
    const old = await seedFull(database, 'account-1', { id: 'old', date: daysAgo(90), labels: ['INBOX'] })
    const draft = await seedFull(database, 'account-1', { id: 'draft', date: daysAgo(90), labels: ['DRAFT'] })
    const pending = await seedFull(database, 'account-1', { id: 'pending', date: daysAgo(90), labels: ['INBOX'] })
    // The same message filed under a label that keeps everything (Gmail labels share one row).
    const labelled = await seedFull(database, 'account-1', { id: 'labelled', date: daysAgo(90), labels: ['INBOX', 'Label_keep'] })
    database.applyLocalAction({ accountId: 'account-1', threadIds: ['thread-pending'], action: 'star' }, 'op-1', 60_000)
    const before = database.storageStats(0).totalBytes
    database.offline.setAccountPolicy('account-1', { downloadMode: 'bodies', window: { unit: 'days', amount: 30 } })
    database.offline.setFolderOverride('account-1', 'Label_keep', { downloadMode: 'full', window: { unit: 'all', amount: 0 } })
    const result = database.offline.evict('account-1', database.offline.context('account-1'))
    expect(result.messages).toBe(2)
    expect(result.bytes).toBeGreaterThan(0)
    // Within the window but bodies-only: the original (with its attachment) goes, the text stays.
    expect(existsSync(recent)).toBe(false)
    expect(database.offline.contentState('account-1', 'recent')).toBe('body')
    const recentMessage = database.getThread('account-1', 'thread-recent').messages[0]
    expect(recentMessage.text).toContain('Body of recent')
    expect(recentMessage.attachments).toHaveLength(1)
    // Outside the window: only the header row remains, and it is still listed.
    expect(existsSync(old)).toBe(false)
    expect(database.offline.contentState('account-1', 'old')).toBe('headers')
    expect(database.getThread('account-1', 'thread-old').messages[0]).toMatchObject({ subject: 'Subject old', text: '', html: '' })
    expect(database.listThreads({ folder: 'inbox' }).items.map((item) => item.id)).toContain('thread-old')
    expect(database.listThreads({ folder: 'all', search: 'Body' }).items.map((item) => item.id)).not.toContain('thread-old')
    // Never evicted: provider drafts, conversations with queued changes, and copies another location wants.
    for (const [id, path] of [['draft', draft], ['pending', pending], ['labelled', labelled]] as const) {
      expect(existsSync(path)).toBe(true)
      expect(database.offline.contentState('account-1', id)).toBe('full')
    }
    expect(database.storageStats(0).totalBytes).toBeLessThan(before)
    // Nothing more to reclaim the second time.
    expect(database.offline.evict('account-1', database.offline.context('account-1'))).toEqual({ messages: 0, bytes: 0 })
  })

  it('keeps every IMAP copy of a message when any copy’s folder wants it', async () => {
    const { database } = offlineDatabase('imap')
    const inbox = await seedFull(database, 'account-1', { id: 'copy-inbox', date: daysAgo(60), labels: ['folder:INBOX', 'INBOX'], messageId: '<shared@example.com>', remoteFolderId: 'INBOX', remoteUid: '1' })
    const archive = await seedFull(database, 'account-1', { id: 'copy-archive', date: daysAgo(60), labels: ['folder:Archive'], messageId: '<shared@example.com>', remoteFolderId: 'Archive', remoteUid: '9' })
    const lonely = await seedFull(database, 'account-1', { id: 'lonely', date: daysAgo(60), labels: ['folder:Archive'], remoteFolderId: 'Archive', remoteUid: '10' })
    database.offline.setAccountPolicy('account-1', { downloadMode: 'headers', window: { unit: 'days', amount: 14 } })
    database.offline.setFolderOverride('account-1', 'folder:INBOX', { downloadMode: 'full', window: { unit: 'all', amount: 0 } })
    expect(database.offline.evict('account-1', database.offline.context('account-1')).messages).toBe(1)
    expect(existsSync(inbox)).toBe(true)
    expect(existsSync(archive)).toBe(true)
    expect(existsSync(lonely)).toBe(false)
  })

  it('never evicts Local Folders mail', async () => {
    const { database } = offlineDatabase('local', 'local-folders')
    const path = await seedFull(database, 'local-folders', { id: 'kept', date: daysAgo(900), labels: ['folder:local-1'] })
    expect(database.offline.evict('local-folders', { defaults: { downloadMode: 'headers', window: { unit: 'days', amount: 1 } }, overrides: [], extensions: [] })).toEqual({ messages: 0, bytes: 0 })
    expect(existsSync(path)).toBe(true)
    expect(database.offline.searchCoverage('local-folders', true, false)).toEqual({ accountId: 'local-folders', complete: true, serverSearch: false, reasons: [] })
  })

  it('plans upgrades when a policy widens and queues them for download', async () => {
    const { database } = offlineDatabase()
    await seedFull(database, 'account-1', { id: 'a', date: daysAgo(3), labels: ['INBOX'] })
    database.offline.setAccountPolicy('account-1', { downloadMode: 'headers', window: { unit: 'all', amount: 0 } })
    database.offline.evict('account-1', database.offline.context('account-1'))
    expect(database.offline.contentState('account-1', 'a')).toBe('headers')
    database.offline.setAccountPolicy('account-1', { downloadMode: 'full', window: { unit: 'all', amount: 0 } })
    const plan = database.offline.planContent('account-1', database.offline.context('account-1'))
    expect(plan).toEqual({ upgrades: ['a'], downgrades: [] })
    expect(database.offline.queueDownloads('account-1', plan.upgrades)).toBe(1)
    expect(database.pendingMessageIds('account-1', 10).map((item) => item.id)).toEqual(['a'])
  })

  it('reports availability per account and folder, and whether search covers the whole mailbox', async () => {
    const { database } = offlineDatabase()
    await seedFull(database, 'account-1', { id: 'new', date: daysAgo(1), labels: ['INBOX'] })
    await seedFull(database, 'account-1', { id: 'body', date: daysAgo(2), labels: ['Label_1'] })
    await seedFull(database, 'account-1', { id: 'aged', date: daysAgo(400), labels: ['INBOX'] })
    expect(database.offline.searchCoverage('account-1', true, true)).toEqual({ accountId: 'account-1', complete: true, serverSearch: true, reasons: [] })
    database.offline.setAccountPolicy('account-1', { downloadMode: 'full', window: { unit: 'months', amount: 6 } })
    database.offline.setFolderOverride('account-1', 'Label_1', { downloadMode: 'bodies' })
    database.offline.evict('account-1', database.offline.context('account-1'))
    const account = database.offline.availability('account-1')
    expect(account).toMatchObject({ total: 3, full: 1, bodyOnly: 1, headersOnly: 1, outsideWindow: 1, windowStart: expect.any(String) })
    expect(database.offline.availability('account-1', 'INBOX')).toMatchObject({ total: 2, full: 1, headersOnly: 1, outsideWindow: 1 })
    expect(database.offline.availability('account-1', 'Label_1')).toMatchObject({ total: 1, bodyOnly: 1, policy: { downloadMode: 'bodies' } })
    const coverage = database.offline.searchCoverage('account-1', true, true)
    expect(coverage.complete).toBe(false)
    expect(coverage.reasons).toEqual([
      'Mail outside the sync window (last 6 months) is not downloaded',
      '1 message has only headers downloaded',
      'Attachments of 1 message are not downloaded'
    ])
    expect(database.offline.searchCoverage('account-1', false, false).reasons).toContain('The mailbox is still downloading')
  })

  it('lists only the conversations a server search found', async () => {
    const { database } = offlineDatabase()
    await seedFull(database, 'account-1', { id: 'hit', date: daysAgo(1), labels: ['INBOX'] })
    await seedFull(database, 'account-1', { id: 'miss', date: daysAgo(1), labels: ['INBOX'] })
    database.offline.saveSearchHits('search-1', [{ accountId: 'account-1', threadId: 'thread-hit' }])
    expect(database.listThreads({ folder: 'all', serverSearchId: 'search-1' })).toMatchObject({ total: 1, items: [{ id: 'thread-hit' }] })
    // Old searches are pruned when a new one is saved.
    database.offline.saveSearchHits('search-2', [], new Date(Date.now() + 2 * 86_400_000))
    expect(database.listThreads({ folder: 'all', serverSearchId: 'search-1' }).total).toBe(0)
  })

  it('keeps cached mail older than the window when a windowed inventory is reconciled', async () => {
    const { database } = offlineDatabase()
    await seedFull(database, 'account-1', { id: 'ancient', date: daysAgo(500), labels: ['INBOX'] })
    await seedFull(database, 'account-1', { id: 'deleted-on-server', date: daysAgo(5), labels: ['INBOX'] })
    database.resetInventory('account-1')
    database.addInventory('account-1', [])
    expect(database.offline.retainOutsideWindow('account-1', new Date(Date.now() - 30 * 86_400_000))).toBe(1)
    database.reconcileInventory('account-1')
    expect(database.hasMessage('account-1', 'ancient')).toBe(true)
    expect(database.hasMessage('account-1', 'deleted-on-server')).toBe(false)
    expect(database.offline.idsBefore('account-1', 'INBOX', new Date())).toEqual(new Set())
  })
})
