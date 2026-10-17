import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { MailDatabase } from './mail/database'
import { MailTemplateStore } from './mail/template-store'
import { ProductivityStore } from './productivity/store'
import { TaskStore } from './productivity/task-store'
import { applyPendingProfileRestore, createProfileBackup, previewProfileBackup, stageProfileRestore } from './profile-backup'
import { PROFILE_BACKUP_LAYOUT, RESTORED_ACCOUNT_MESSAGE, RESTORED_MERGE_HOLD_MESSAGE, RESTORED_SEND_HOLD_MESSAGE } from './profile-backup-layout'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) })
const temporary = (name: string) => { const directory = mkdtempSync(join(tmpdir(), `aerio-profile-layout-${name}-`)); directories.push(directory); return directory }

const account = { id: 'account-1', provider: 'gmail' as const, email: 'person@example.com', displayName: 'Person', color: '#6558e8', status: 'ready' as const, archived: false, signature: '', notifications: true, syncEnabled: true }
const draft = (id: string) => ({ id, accountId: 'account-1', to: ['ada@example.com'], cc: [], bcc: [], subject: id, text: `Body ${id}`, attachmentPaths: [] })
const future = () => new Date(Date.now() + 86_400_000).toISOString()

function preferences(profile: string, withLock = true) {
  const db = new DatabaseSync(join(profile, 'aerio-state.sqlite'))
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS app_preferences (id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS app_lock (id INTEGER PRIMARY KEY CHECK (id = 1), salt TEXT NOT NULL, verifier TEXT NOT NULL, updated_at TEXT NOT NULL)`)
  db.prepare('INSERT OR REPLACE INTO app_preferences VALUES(1,1,?,?)').run(JSON.stringify({ settings: { theme: 'dark' } }), '2026-10-01T00:00:00Z')
  if (withLock) db.prepare('INSERT OR REPLACE INTO app_lock VALUES(1,?,?,?)').run('old-salt', 'old-verifier-value', '2026-10-01T00:00:00Z')
  db.close()
}

function makeProfile() {
  const profile = temporary('live')
  preferences(profile)
  const mail = new MailDatabase(join(profile, 'aerio.sqlite'), join(profile, 'mail'))
  mail.upsertAccount(account)
  const rawPath = join(profile, 'mail', 'account-1', 'me', 'message-1.eml')
  mkdirSync(join(profile, 'mail', 'account-1', 'me'), { recursive: true })
  writeFileSync(rawPath, 'From: ada@example.com\r\n\r\nHello')
  mail.upsertMessage({
    accountId: 'account-1', id: 'message-1', threadId: 'thread-1', historyId: '1', internalDate: '2026-09-01T10:00:00.000Z', fromName: 'Ada', fromEmail: 'ada@example.com',
    to: ['person@example.com'], cc: [], subject: 'Hello', messageIdHeader: '<m1@example.com>', references: [], snippet: 'Hello', text: 'Hello', html: '<p>Hello</p>',
    labelIds: ['INBOX'], sizeEstimate: 10, rawPath, attachments: []
  })
  mail.saveDraft(draft('local-draft'))
  mail.saveDraft(draft('scheduled'), { status: 'scheduled', deliveryAt: future() })
  mail.saveDraft(draft('undo-window'), { status: 'send-pending', deliveryAt: new Date(Date.now() - 1_000).toISOString() })
  mail.saveDraft(draft('outbox'), { status: 'queued' })
  mail.applyLocalAction({ accountId: 'account-1', threadIds: ['thread-1'], action: 'star' })
  mail.saveRule({ accountId: 'account-1', name: 'Star Ada', enabled: true, match: 'all', conditions: [{ field: 'from', operator: 'contains', value: 'ada' }], actions: [{ action: 'star' }] })
  mail.close()
  const templates = new MailTemplateStore(join(profile, 'mail-templates.sqlite'), join(profile, 'template-attachments'))
  templates.save({ kind: 'template', name: 'Greeting', subject: 'Hi', html: '<p>Hi</p>', attachments: [] })
  templates.close()
  const productivity = new ProductivityStore(join(profile, 'productivity.sqlite'))
  productivity.saveLocal({ tasks: [{ id: 'task', listId: 'Work', title: 'Task', priority: 'normal', completed: false, subtasks: [] }], notes: [], contacts: [] })
  productivity.close()
  const tasks = new TaskStore(join(profile, 'provider-tasks.sqlite'))
  const list = { id: 'account-1:list', accountId: 'account-1', provider: 'gmail' as const, remoteId: 'list', title: 'Work', readOnly: false }
  tasks.replaceProviderSnapshot('account-1', 'gmail', { lists: [list], tasks: [{ id: 'account-1:list:t', accountId: 'account-1', provider: 'gmail', remoteId: 't', listId: list.id, remoteListId: 'list', title: 'Remote', completed: false, revision: 'v1', readOnly: false }], checkpoints: { [list.id]: '2026-10-01T00:00:00Z' } })
  tasks.update(tasks.entities('account-1', 'gmail')[0].id, { title: 'Changed offline' })
  tasks.close()
  writeFileSync(join(profile, 'oauth-vault.dat'), 'encrypted-refresh-token')
  writeFileSync(join(profile, 'openpgp-keyring.dat'), 'wrapped-openpgp-keys')
  return profile
}

const backupOf = (profile: string) => createProfileBackup({ userData: profile, directory: temporary('target'), layout: PROFILE_BACKUP_LAYOUT, appVersion: '0.6.0', trigger: 'scheduled' })

describe('full profile layout', () => {
  it('backs up mail, drafts, queued work, rules, templates, local modules, and preferences without credentials', async () => {
    const profile = makeProfile()
    const { path } = await backupOf(profile)
    expect(readFileSync(join(path, 'data', 'aerio-state.sqlite')).includes('old-verifier-value')).toBe(false)
    expect(existsSync(join(path, 'data', 'oauth-vault.dat'))).toBe(false)
    expect(existsSync(join(path, 'data', 'openpgp-keyring.dat'))).toBe(false)
    const preview = await previewProfileBackup(path, profile, PROFILE_BACKUP_LAYOUT)
    const counts = Object.fromEntries(preview.counts.map((item) => [item.label, item.count]))
    expect(counts).toMatchObject({
      Preferences: 1, 'Mail accounts': 1, 'Cached messages': 1, Drafts: 4, 'Outgoing or scheduled sends': 3, 'Queued mail changes': 1, 'Mail rules': 1,
      'Mail templates and snippets': 1, 'Local tasks': 1, 'Connected tasks': 1, 'Pending connected task changes': 1
    })
    expect(preview).toMatchObject({ heldSends: 3, heldTaskWrites: 1, accountsToReauthorize: 1, trigger: 'scheduled' })
    expect(preview.warnings.join('\n')).toContain('3 outgoing or scheduled messages will be held for review')
  })

  it('restores with sends held, accounts reauthorizing, task writes under review, and this device’s app lock kept', async () => {
    const profile = makeProfile()
    const { path } = await backupOf(profile)
    // Change the device after the backup: new app lock, sent draft, new vault.
    preferences(profile)
    const live = new DatabaseSync(join(profile, 'aerio-state.sqlite'))
    live.prepare('UPDATE app_lock SET salt=?,verifier=? WHERE id=1').run('new-salt', 'new-verifier')
    live.close()

    const report = await stageProfileRestore({ backupPath: path, userData: profile, layout: PROFILE_BACKUP_LAYOUT })
    expect(report).toMatchObject({ heldSends: 3, heldTaskWrites: 1, accountsToReauthorize: 1, rebasedPaths: false })
    expect(applyPendingProfileRestore(profile)).toMatchObject({ status: 'applied' })

    const mail = new MailDatabase(join(profile, 'aerio.sqlite'), join(profile, 'mail'))
    try {
      // Nothing restored is eligible to send by itself, even after the worker reopens the store.
      expect(mail.queuedDrafts()).toEqual([])
      const drafts = Object.fromEntries(mail.listDrafts().map((item) => [item.id, item]))
      for (const id of ['scheduled', 'undo-window', 'outbox']) expect(drafts[id]).toMatchObject({ status: 'failed', error: RESTORED_SEND_HOLD_MESSAGE, deliveryAt: undefined })
      expect(drafts['local-draft'].status).toBe('local')
      expect(mail.listAccounts()[0]).toMatchObject({ status: 'needs-auth', error: RESTORED_ACCOUNT_MESSAGE })
      expect(mail.listRules()).toHaveLength(1)
      expect(mail.rawExists(join(profile, 'mail', 'account-1', 'me', 'message-1.eml'))).toBe(true)
    } finally { mail.close() }
    const state = new DatabaseSync(join(profile, 'aerio-state.sqlite'), { readOnly: true })
    expect(state.prepare('SELECT salt,verifier FROM app_lock').get()).toMatchObject({ salt: 'new-salt', verifier: 'new-verifier' })
    expect(JSON.parse(String((state.prepare('SELECT payload FROM app_preferences').get() as { payload: string }).payload))).toEqual({ settings: { theme: 'dark' } })
    state.close()
    const tasks = new TaskStore(join(profile, 'provider-tasks.sqlite'))
    expect(tasks.operations().map((operation) => [operation.status, operation.error])).toEqual([['review', 'restored-write']])
    tasks.close()
    expect(readFileSync(join(profile, 'oauth-vault.dat'), 'utf8')).toBe('encrypted-refresh-token')
    expect(readFileSync(join(profile, 'openpgp-keyring.dat'), 'utf8')).toBe('wrapped-openpgp-keys')
  })

  it('holds every unsent recipient of an unfinished mail merge for review after a restore', async () => {
    const profile = makeProfile()
    const mail = new MailDatabase(join(profile, 'aerio.sqlite'), join(profile, 'mail'))
    const merge = (id: string) => mail.mailMerge.create(id, { accountId: 'account-1', subject: 'Hi', text: 'Hi', attachmentPaths: [], recipients: [{ email: 'a@example.com' }, { email: 'b@example.com' }, { email: 'c@example.com' }], limits: { perMinute: 60, dailyCap: 100 } })
    merge('running')
    mail.mailMerge.claim('running', 0)
    mail.mailMerge.markSent('running', 0, undefined)
    merge('finished')
    mail.mailMerge.cancel('finished')
    mail.close()
    const { path } = await backupOf(profile)
    expect(Object.fromEntries((await previewProfileBackup(path, profile, PROFILE_BACKUP_LAYOUT)).counts.map((item) => [item.label, item.count]))).toMatchObject({ 'Unfinished mail merges': 1 })

    const report = await stageProfileRestore({ backupPath: path, userData: profile, layout: PROFILE_BACKUP_LAYOUT })
    expect(report.heldSends).toBe(3 + 2)
    applyPendingProfileRestore(profile)
    const restored = new MailDatabase(join(profile, 'aerio.sqlite'), join(profile, 'mail'))
    try {
      expect(restored.mailMerge.get('running')).toMatchObject({ status: 'needs-review', lastError: RESTORED_MERGE_HOLD_MESSAGE, counts: { sent: 1, ambiguous: 2, pending: 0 } })
      expect(restored.mailMerge.get('finished')).toMatchObject({ status: 'cancelled', counts: { cancelled: 3 } })
      expect(restored.mailMerge.dueJobs(new Date(Date.now() + 86_400_000).toISOString())).toEqual([])
    } finally { restored.close() }
  })

  it('does not restore an app lock from the backup onto a device without one', async () => {
    const profile = makeProfile()
    const { path } = await backupOf(profile)
    const live = new DatabaseSync(join(profile, 'aerio-state.sqlite'))
    live.exec('DELETE FROM app_lock')
    live.close()
    await stageProfileRestore({ backupPath: path, userData: profile, layout: PROFILE_BACKUP_LAYOUT })
    applyPendingProfileRestore(profile)
    const state = new DatabaseSync(join(profile, 'aerio-state.sqlite'), { readOnly: true })
    expect(state.prepare('SELECT COUNT(*) count FROM app_lock').get()).toMatchObject({ count: 0 })
    state.close()
  })

  it('migrates an older-format mail database in staging and still holds its queued sends', async () => {
    const profile = temporary('legacy')
    // A pre-delivery-time schema: no delivery_at/send options, folder journal, receipts, or reply watches.
    const legacy = new DatabaseSync(join(profile, 'aerio.sqlite'))
    legacy.exec(`
      CREATE TABLE gmail_accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, avatar_url TEXT, color TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'connecting', archived INTEGER NOT NULL DEFAULT 0, history_id TEXT, last_sync_at TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE gmail_drafts (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, gmail_draft_id TEXT, thread_id TEXT, in_reply_to TEXT, references_json TEXT NOT NULL DEFAULT '[]', to_json TEXT NOT NULL DEFAULT '[]', cc_json TEXT NOT NULL DEFAULT '[]', bcc_json TEXT NOT NULL DEFAULT '[]', subject TEXT NOT NULL DEFAULT '', body_text TEXT NOT NULL DEFAULT '', body_html TEXT, attachment_paths_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'local', error TEXT, updated_at TEXT NOT NULL);
      INSERT INTO gmail_accounts VALUES('legacy','old@example.com','Old','', '#123456','ready',0,NULL,NULL,NULL,'2025-01-01','2025-01-01');
      INSERT INTO gmail_drafts(id,account_id,subject,status,updated_at) VALUES('old-outbox','legacy','Queued long ago','queued','2025-01-01T00:00:00Z');
    `)
    legacy.close()
    const { path } = await backupOf(profile)
    const preview = await previewProfileBackup(path, profile, PROFILE_BACKUP_LAYOUT)
    expect(preview.heldSends).toBe(1)
    const restoreTarget = temporary('restore-target')
    const report = await stageProfileRestore({ backupPath: path, userData: restoreTarget, layout: PROFILE_BACKUP_LAYOUT })
    expect(report).toMatchObject({ heldSends: 1, accountsToReauthorize: 1, rebasedPaths: true })
    applyPendingProfileRestore(restoreTarget)
    const mail = new MailDatabase(join(restoreTarget, 'aerio.sqlite'), join(restoreTarget, 'mail'))
    try {
      expect(mail.queuedDrafts()).toEqual([])
      expect(mail.listDrafts()[0]).toMatchObject({ id: 'old-outbox', status: 'failed', error: RESTORED_SEND_HOLD_MESSAGE })
      expect(mail.listAccounts()[0]).toMatchObject({ provider: 'gmail', status: 'needs-auth', syncEnabled: true })
    } finally { mail.close() }
    // Databases that did not exist in the old profile are created empty and remain openable.
    const productivity = new ProductivityStore(join(restoreTarget, 'productivity.sqlite'))
    expect(productivity.localSnapshot().tasks).toEqual([])
    productivity.close()
  })
})
