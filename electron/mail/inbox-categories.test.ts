import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary, MailProviderId, MailRule } from '../../src/mail-types'
import type { MailCategoryId } from '../../src/mail-category-types'
import { MailDatabase, type ParsedMailMessage } from './database'
import { assignMailCategory } from './inbox-categories'
import { categoryHintFromHeaders, handleInboxCategoryCommand } from './inbox-category-worker'
import { applyPendingProfileRestore, createProfileBackup, previewProfileBackup, stageProfileRestore } from '../profile-backup'
import { PROFILE_BACKUP_LAYOUT } from '../profile-backup-layout'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) })
const temporary = (name: string) => { const directory = mkdtempSync(join(tmpdir(), `aerio-categories-${name}-`)); directories.push(directory); return directory }

const account = (id: string, provider: MailProviderId = 'gmail', overrides: Partial<MailAccountSummary> = {}): Omit<MailAccountSummary, 'lastSyncAt' | 'error'> => ({
  id, provider, email: `${id}@example.com`, displayName: id, color: '#6558e8', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true, ...overrides
})

function message(threadId: string, overrides: Partial<ParsedMailMessage> = {}): ParsedMailMessage {
  return {
    accountId: 'gmail-1', id: `${threadId}-m`, threadId, historyId: '1', internalDate: '2026-09-01T10:00:00.000Z', fromName: 'Ada', fromEmail: 'ada@example.com',
    to: ['me@example.com'], cc: [], subject: `Subject ${threadId}`, messageIdHeader: `<${threadId}-${overrides.accountId ?? 'gmail-1'}@example.com>`, references: [], snippet: threadId,
    text: threadId, html: '', labelIds: ['INBOX'], sizeEstimate: 10, rawPath: `${threadId}.eml`, attachments: [], ...overrides
  }
}

const open = (directory: string) => new MailDatabase(join(directory, 'aerio.sqlite'), join(directory, 'mail'))

function setup() {
  const directory = temporary('db')
  const database = open(directory)
  database.upsertAccount(account('gmail-1'))
  return { database, directory }
}

const tab = (database: MailDatabase, category: string, accountIds?: string[]) =>
  database.listThreads({ folder: 'inbox', category, accountIds }).items.map((item) => item.id)

describe('inbox category provider mappings', () => {
  it('maps Gmail CATEGORY_* labels to the matching tabs and CATEGORY_PERSONAL to Primary', () => {
    const { database } = setup()
    database.upsertMessage(message('social', { labelIds: ['INBOX', 'CATEGORY_SOCIAL'] }))
    database.upsertMessage(message('promo', { labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] }))
    database.upsertMessage(message('update', { labelIds: ['INBOX', 'CATEGORY_UPDATES'] }))
    database.upsertMessage(message('personal', { labelIds: ['INBOX', 'CATEGORY_PERSONAL'], fromEmail: 'noreply@shop.example' }))
    database.upsertMessage(message('forum', { labelIds: ['INBOX', 'CATEGORY_FORUMS'] }))
    expect(tab(database, 'social')).toEqual(['social'])
    expect(tab(database, 'promotions')).toEqual(['promo'])
    expect(tab(database, 'updates')).toEqual(['update'])
    // Forums is off by default, so that conversation shows in Primary next to the CATEGORY_PERSONAL one.
    expect(tab(database, 'primary').sort()).toEqual(['forum', 'personal'])
    expect(tab(database, 'forums')).toEqual([])
    const items = Object.fromEntries(database.listThreads({ folder: 'inbox' }).items.map((item) => [item.id, item]))
    expect(items.social).toMatchObject({ category: 'social', categorySource: 'provider' })
    expect(items.personal).toMatchObject({ category: 'primary', categorySource: 'provider' })
    // Category labels stay out of the visible label list and the thread's other flags.
    expect(items.social.labelIds).toContain('CATEGORY_SOCIAL')
    database.close()
  })

  it('maps Outlook Focused to Primary and Other to the heuristic bucket, falling back to Updates', () => {
    const { database } = setup()
    database.upsertAccount(account('outlook', 'microsoft'))
    database.upsertMessage(message('focused', { accountId: 'outlook', labelIds: ['INBOX', 'folder:inbox', 'INFERENCE_FOCUSED'], fromEmail: 'news@shop.example', categoryHint: 'promotions' }))
    database.upsertMessage(message('other-plain', { accountId: 'outlook', labelIds: ['INBOX', 'folder:inbox', 'INFERENCE_OTHER'], fromEmail: 'person@example.com', categoryHint: 'primary' }))
    database.upsertMessage(message('other-social', { accountId: 'outlook', labelIds: ['INBOX', 'folder:inbox', 'INFERENCE_OTHER'], fromEmail: 'notification@facebookmail.com' }))
    database.upsertMessage(message('other-bulk', { accountId: 'outlook', labelIds: ['INBOX', 'folder:inbox', 'INFERENCE_OTHER'], fromEmail: 'deals@shop.example', categoryHint: 'promotions' }))
    expect(tab(database, 'primary', ['outlook'])).toEqual(['focused'])
    expect(tab(database, 'updates', ['outlook'])).toEqual(['other-plain'])
    expect(tab(database, 'social', ['outlook'])).toEqual(['other-social'])
    expect(tab(database, 'promotions', ['outlook'])).toEqual(['other-bulk'])
    database.close()
  })

  it('classifies IMAP and Local Folders mail locally from headers and sender domains', () => {
    const { database } = setup()
    database.upsertAccount(account('imap', 'imap'))
    const hint = (from: string, headers: Record<string, string>) => categoryHintFromHeaders(from, Object.entries(headers).map(([key, value]) => ({ key, value })))
    database.upsertMessage(message('newsletter', { accountId: 'imap', fromEmail: 'news@shop.example', categoryHint: hint('news@shop.example', { 'List-Unsubscribe': '<mailto:u@shop.example>' }) }))
    database.upsertMessage(message('list', { accountId: 'imap', fromEmail: 'dev@lists.example', categoryHint: hint('dev@lists.example', { 'List-Id': '<dev.lists.example>', 'List-Post': '<mailto:dev@lists.example>' }) }))
    database.upsertMessage(message('github', { accountId: 'imap', fromEmail: 'notifications@github.com' }))
    database.upsertMessage(message('friend', { accountId: 'imap', fromEmail: 'grace@example.org' }))
    database.upsertMessage(message('bulk', { accountId: 'imap', fromEmail: 'team@vendor.example', categoryHint: hint('team@vendor.example', { Precedence: 'bulk' }) }))
    expect(tab(database, 'promotions', ['imap']).sort()).toEqual(['bulk', 'newsletter'])
    expect(tab(database, 'updates', ['imap'])).toEqual(['github'])
    expect(tab(database, 'primary', ['imap']).sort()).toEqual(['friend', 'list'])
    database.inboxCategories.saveTabs({ tabs: [...database.inboxCategories.tabs().tabs.map((item) => item.id === 'forums' ? { ...item, enabled: true } : item)] })
    expect(tab(database, 'forums', ['imap'])).toEqual(['list'])
    expect(database.listThreads({ folder: 'inbox', accountIds: ['imap'] }).items.find((item) => item.id === 'github')).toMatchObject({ category: 'updates', categorySource: 'heuristic' })
    database.close()
  })
})

describe('inbox category precedence', () => {
  it('ranks manual override > mail-rule action > sender rule > domain rule > provider > heuristic, and SQL agrees with the resolver', () => {
    const { database } = setup()
    const store = database.inboxCategories
    database.upsertMessage(message('t', { labelIds: ['INBOX', 'CATEGORY_UPDATES'], fromEmail: 'news@mail.shop.example', categoryHint: 'promotions' }))
    const current = () => ({ ...store.resolve('gmail-1', 't'), listed: (['primary', 'social', 'promotions', 'updates'] as const).find((category) => tab(database, category).includes('t')) })
    expect(current()).toEqual({ category: 'updates', source: 'provider', listed: 'updates' })
    store.saveRule({ kind: 'domain', pattern: 'shop.example', category: 'social' })
    expect(current()).toEqual({ category: 'social', source: 'sender-rule', listed: 'social' })
    // A more specific domain wins over a broader one; an exact address beats both.
    store.saveRule({ kind: 'domain', pattern: 'mail.shop.example', category: 'promotions' })
    expect(current()).toMatchObject({ category: 'promotions', listed: 'promotions' })
    store.saveRule({ kind: 'address', pattern: 'news@mail.shop.example', category: 'primary' })
    expect(current()).toEqual({ category: 'primary', source: 'sender-rule', listed: 'primary' })
    store.setOverride('gmail-1', ['t'], 'updates', 'mail-rule')
    expect(current()).toEqual({ category: 'updates', source: 'mail-rule', listed: 'updates' })
    store.setOverride('gmail-1', ['t'], 'social', 'manual')
    expect(current()).toEqual({ category: 'social', source: 'manual', listed: 'social' })
    // A later mail-rule action never replaces the user's own choice.
    expect(store.setOverride('gmail-1', ['t'], 'promotions', 'mail-rule')).toBe(0)
    expect(current()).toMatchObject({ category: 'social', source: 'manual' })
    // Clearing the override returns to the rules.
    store.setOverride('gmail-1', ['t'], undefined, 'manual')
    expect(current()).toEqual({ category: 'primary', source: 'sender-rule', listed: 'primary' })
    for (const rule of store.rules()) store.deleteRule(rule.id)
    expect(current()).toEqual({ category: 'updates', source: 'provider', listed: 'updates' })
    database.close()
  })

  it('classifies a conversation by its newest received message, not the user’s own reply', () => {
    const { database } = setup()
    database.upsertMessage(message('t', { fromEmail: 'deals@shop.example', labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] }))
    database.upsertMessage(message('t', { id: 't-reply', messageIdHeader: '<reply@example.com>', internalDate: '2026-09-02T10:00:00.000Z', fromEmail: 'gmail-1@example.com', labelIds: ['SENT'], rawPath: 'reply.eml' }))
    expect(tab(database, 'promotions')).toEqual(['t'])
    expect(database.inboxCategories.signals('gmail-1', 't')?.senderEmail).toBe('deals@shop.example')
    database.close()
  })

  it('keeps pinned conversations first within a tab', () => {
    const { database } = setup()
    for (const [index, id] of ['a', 'b', 'c'].entries()) database.upsertMessage(message(id, { internalDate: `2026-09-0${index + 1}T10:00:00.000Z`, labelIds: ['INBOX', 'CATEGORY_SOCIAL'] }))
    database.upsertMessage(message('elsewhere', { internalDate: '2026-09-09T10:00:00.000Z' }))
    database.applyLocalAction({ accountId: 'gmail-1', threadIds: ['a'], action: 'pin' })
    expect(tab(database, 'social')).toEqual(['a', 'c', 'b'])
    expect(database.listThreads({ folder: 'inbox', category: 'social', pageSize: 1 }).total).toBe(3)
    // Categories only filter the Inbox.
    expect(database.listThreads({ folder: 'all', category: 'social' }).total).toBe(4)
    database.close()
  })

  it('folds disabled and removed tabs into Primary', () => {
    const { database } = setup()
    const store = database.inboxCategories
    database.upsertMessage(message('custom'))
    database.upsertMessage(message('promo', { labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] }))
    store.saveTabs({ tabs: [...store.tabs().tabs, { id: 'custom:receipts', name: 'Receipts', enabled: true, builtIn: false }] })
    store.setOverride('gmail-1', ['custom'], 'custom:receipts', 'manual')
    expect(tab(database, 'custom:receipts')).toEqual(['custom'])
    store.saveTabs({ tabs: store.tabs().tabs.filter((item) => item.id !== 'custom:receipts').map((item) => item.id === 'promotions' ? { ...item, enabled: false } : item) })
    expect(tab(database, 'primary').sort()).toEqual(['custom', 'promo'])
    expect(tab(database, 'custom:receipts')).toEqual([])
    expect(database.listThreads({ folder: 'inbox' }).items.every((item) => item.category === 'primary')).toBe(true)
    database.close()
  })
})

describe('inbox category persistence and counts', () => {
  it('keeps manual reassignments through a resync, a restart, and archiving; deleting the account removes them', () => {
    const { database, directory } = setup()
    database.upsertMessage(message('t', { labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] }))
    assignMailCategory(database, { accountId: 'gmail-1', threadIds: ['t'], category: 'primary' })
    database.close()
    const reopened = open(directory)
    expect(tab(reopened, 'primary')).toEqual(['t'])
    reopened.deleteMessage('gmail-1', 't-m')
    expect(reopened.inboxCategories.signals('gmail-1', 't')).toBeUndefined()
    reopened.upsertMessage(message('t', { labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] }))
    expect(reopened.listThreads({ folder: 'inbox' }).items[0]).toMatchObject({ id: 't', category: 'primary', categorySource: 'manual' })
    reopened.disconnectAccount('gmail-1', 'archive')
    expect(tab(reopened, 'primary')).toEqual(['t'])
    reopened.disconnectAccount('gmail-1', 'delete')
    expect(reopened.inboxCategories.override('gmail-1', 't')).toBeUndefined()
    reopened.close()
  })

  it('backfills conversations cached before categories existed', () => {
    const { database, directory } = setup()
    database.upsertMessage(message('old', { labelIds: ['INBOX', 'CATEGORY_SOCIAL'] }))
    database.close()
    const raw = new DatabaseSync(join(directory, 'aerio.sqlite'))
    raw.exec(`DELETE FROM mail_category_signals; DELETE FROM mail_category_state;`)
    raw.close()
    const reopened = open(directory)
    expect(reopened.inboxCategories.signals('gmail-1', 'old')).toMatchObject({ provider: 'social' })
    expect(tab(reopened, 'social')).toEqual(['old'])
    reopened.close()
  })

  it('counts unread and total conversations per tab and sums every account in the unified view', () => {
    const { database } = setup()
    database.upsertAccount(account('imap', 'imap'))
    database.upsertMessage(message('g1', { labelIds: ['INBOX', 'UNREAD', 'CATEGORY_SOCIAL'] }))
    database.upsertMessage(message('g2', { labelIds: ['INBOX', 'CATEGORY_SOCIAL'] }))
    database.upsertMessage(message('g3', { labelIds: ['INBOX', 'UNREAD'] }))
    database.upsertMessage(message('g-trash', { labelIds: ['INBOX', 'UNREAD', 'TRASH', 'CATEGORY_SOCIAL'] }))
    database.upsertMessage(message('g-archived', { labelIds: ['UNREAD', 'CATEGORY_SOCIAL'] }))
    // The same thread id in another account is a different conversation.
    database.upsertMessage(message('g1', { accountId: 'imap', id: 'imap-g1', labelIds: ['INBOX', 'UNREAD'], fromEmail: 'friend@linkedin.com' }))
    database.upsertMessage(message('i2', { accountId: 'imap', labelIds: ['INBOX', 'UNREAD'], fromEmail: 'grace@example.org' }))
    database.upsertMessage(message('i-snoozed', { accountId: 'imap', labelIds: ['INBOX', 'UNREAD'], fromEmail: 'grace@example.org' }))
    database.snoozeThreads('imap', ['i-snoozed'], new Date(Date.now() + 60 * 60_000).toISOString())
    expect(database.inboxCategories.counts(['gmail-1'])).toMatchObject({ primary: { unread: 1, total: 1 }, social: { unread: 1, total: 2 }, promotions: { unread: 0, total: 0 } })
    expect(database.inboxCategories.counts(['imap'])).toMatchObject({ primary: { unread: 1, total: 1 }, social: { unread: 1, total: 1 } })
    const unified = database.inboxCategories.counts()
    expect(unified).toMatchObject({ primary: { unread: 2, total: 2 }, social: { unread: 2, total: 3 }, updates: { unread: 0, total: 0 } })
    expect(unified.forums).toBeUndefined()
    const visible = Object.values(unified).reduce((sum, value) => sum + value.unread, 0)
    expect(visible).toBe(database.folderUnreadCounts().inbox)
    // Unified lists hold the same conversations as the counts.
    expect(database.listThreads({ folder: 'inbox', category: 'social' }).total).toBe(3)
    database.close()
  })

  it('is included in profile backups and restored', async () => {
    const profile = temporary('profile')
    const state = new DatabaseSync(join(profile, 'aerio-state.sqlite'))
    state.exec(`CREATE TABLE app_preferences (id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    state.prepare('INSERT INTO app_preferences VALUES(1,1,?,?)').run('{"settings":{}}', '2026-10-01T00:00:00Z')
    state.close()
    const database = open(profile)
    database.upsertAccount(account('gmail-1'))
    database.upsertMessage(message('t'))
    database.inboxCategories.saveRule({ kind: 'domain', pattern: 'example.com', category: 'updates' })
    database.inboxCategories.setOverride('gmail-1', ['t'], 'social', 'manual')
    database.close()
    const { path } = await createProfileBackup({ userData: profile, directory: temporary('target'), layout: PROFILE_BACKUP_LAYOUT, appVersion: '0.6.0', trigger: 'manual' })
    const preview = await previewProfileBackup(path, profile, PROFILE_BACKUP_LAYOUT)
    expect(preview.counts.find((item) => item.label === 'Inbox classification rules')?.count).toBe(1)
    expect(preview.counts.find((item) => item.label === 'Conversations moved between inbox tabs')?.count).toBe(1)
    const live = open(profile)
    live.inboxCategories.setOverride('gmail-1', ['t'], undefined, 'manual')
    live.close()
    await stageProfileRestore({ backupPath: path, userData: profile, layout: PROFILE_BACKUP_LAYOUT })
    expect(applyPendingProfileRestore(profile)).toMatchObject({ status: 'applied' })
    const restored = open(profile)
    try {
      expect(restored.listThreads({ folder: 'inbox' }).items[0]).toMatchObject({ category: 'social', categorySource: 'manual' })
    } finally { restored.close() }
  })
})

describe('inbox category reassignment', () => {
  it('queues Gmail category label changes through the normal operation queue and can remember the sender', () => {
    const { database } = setup()
    database.upsertMessage(message('t', { labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'], fromEmail: 'News@Shop.Example' }))
    const result = assignMailCategory(database, { accountId: 'gmail-1', threadIds: ['t'], category: 'social', remember: 'domain' })
    expect(result).toMatchObject({ updated: 1, providerOperations: 2, rule: { kind: 'domain', pattern: 'shop.example', category: 'social' } })
    const operations = database.dueOperations(10).map((row) => [String(row.kind), String(row.label_id)])
    expect(operations).toEqual([['label', 'CATEGORY_SOCIAL'], ['unlabel', 'CATEGORY_PROMOTIONS']])
    expect(database.getThread('gmail-1', 't').messages[0].labelIds).toEqual(expect.arrayContaining(['INBOX', 'CATEGORY_SOCIAL']))
    expect(database.getThread('gmail-1', 't').messages[0].labelIds).not.toContain('CATEGORY_PROMOTIONS')
    expect(tab(database, 'social')).toEqual(['t'])
    // The remembered domain classifies new mail from that sender.
    database.upsertMessage(message('later', { fromEmail: 'offers@shop.example' }))
    expect(database.inboxCategories.resolve('gmail-1', 'later')).toEqual({ category: 'social', source: 'sender-rule' })
    database.close()
  })

  it('sets Outlook Focused or Other on Inbox messages and keeps custom tabs, IMAP, and archived accounts local', () => {
    const { database } = setup()
    database.upsertAccount(account('outlook', 'microsoft'))
    database.upsertAccount(account('imap', 'imap'))
    database.upsertMessage(message('o', { accountId: 'outlook', labelIds: ['INBOX', 'folder:inbox', 'INFERENCE_FOCUSED'] }))
    expect(assignMailCategory(database, { accountId: 'outlook', threadIds: ['o'], category: 'promotions' }).providerOperations).toBe(2)
    expect(database.dueOperations(10).map((row) => [String(row.kind), String(row.label_id)])).toEqual([['label', 'INFERENCE_OTHER'], ['unlabel', 'INFERENCE_FOCUSED']])
    expect(tab(database, 'promotions', ['outlook'])).toEqual(['o'])
    // Moving back to the same provider value queues nothing new.
    expect(assignMailCategory(database, { accountId: 'outlook', threadIds: ['o'], category: 'updates' }).providerOperations).toBe(0)

    database.upsertMessage(message('i', { accountId: 'imap' }))
    expect(assignMailCategory(database, { accountId: 'imap', threadIds: ['i'], category: 'social' }).providerOperations).toBe(0)
    database.inboxCategories.saveTabs({ tabs: [...database.inboxCategories.tabs().tabs, { id: 'custom:travel', name: 'Travel', enabled: true, builtIn: false }] })
    database.upsertMessage(message('g'))
    expect(assignMailCategory(database, { accountId: 'gmail-1', threadIds: ['g'], category: 'custom:travel' as MailCategoryId }).providerOperations).toBe(0)
    database.upsertAccount(account('gmail-1', 'gmail', { archived: true }))
    expect(assignMailCategory(database, { accountId: 'gmail-1', threadIds: ['g'], category: 'social' }).providerOperations).toBe(0)
    expect(() => assignMailCategory(database, { accountId: 'gmail-1', threadIds: ['missing'], category: 'social' })).toThrow('not found')
    expect(() => assignMailCategory(database, { accountId: 'gmail-1', threadIds: ['g'], remember: 'address' })).toThrow('Choose a tab')
    database.close()
  })

  it('emits changes for the worker commands and reloads every account after settings changes', () => {
    const { database } = setup()
    database.upsertAccount(account('imap', 'imap'))
    database.upsertMessage(message('t'))
    const emit = vi.fn()
    expect(handleInboxCategoryCommand(database, { type: 'categories:tabs' }, emit)).toMatchObject({ tabs: expect.any(Array) })
    handleInboxCategoryCommand(database, { type: 'categories:assign', payload: { accountId: 'gmail-1', threadIds: ['t'], category: 'updates' } }, emit)
    expect(emit).toHaveBeenLastCalledWith({ type: 'mail-changed', payload: { accountId: 'gmail-1', threadIds: ['t'] } })
    emit.mockClear()
    const rule = handleInboxCategoryCommand(database, { type: 'categories:save-rule', payload: { kind: 'address', pattern: 'a@b.example', category: 'social' } }, emit) as { id: string }
    expect(emit.mock.calls.map((call) => call[0].payload.accountId).sort()).toEqual(['gmail-1', 'imap'])
    expect(handleInboxCategoryCommand(database, { type: 'categories:rules' }, emit)).toHaveLength(1)
    handleInboxCategoryCommand(database, { type: 'categories:delete-rule', payload: { id: rule.id } }, emit)
    expect(database.inboxCategories.rules()).toEqual([])
    expect(handleInboxCategoryCommand(database, { type: 'categories:counts', payload: {} }, emit)).toMatchObject({ updates: { total: 1 } })
    database.close()
  })
})

describe('inbox category mail rules', () => {
  const rule = (overrides: Partial<MailRule> = {}): MailRule => ({
    id: 'rule', accountId: 'gmail-1', name: 'Rule', enabled: true, match: 'all', conditions: [{ field: 'category', operator: 'is', value: 'social' }],
    actions: [{ action: 'star' }], exceptions: [], trigger: 'incoming', execution: 'local', createdAt: '', updatedAt: '', matchCount: 0, ...overrides
  })

  it('evaluates "category is" against the tab the conversation is in', () => {
    const { database } = setup()
    database.upsertMessage(message('s', { labelIds: ['INBOX', 'CATEGORY_SOCIAL'] }))
    database.upsertMessage(message('p', { labelIds: ['INBOX'] }))
    const saved = database.saveRule(rule())
    expect(database.matchingThreadIdsForRule(saved)).toEqual(['s'])
    const record = message('s', { labelIds: ['INBOX', 'CATEGORY_SOCIAL'] })
    expect(database.matchingRulesForMessage(record).map((item) => item.id)).toEqual([saved.id])
    expect(database.matchingRulesForMessage(message('p')).map((item) => item.id)).toEqual([])
    database.inboxCategories.setOverride('gmail-1', ['p'], 'social', 'manual')
    expect(database.matchingThreadIdsForRule(saved).sort()).toEqual(['p', 's'])
    database.close()
  })
})
