import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MailDatabase } from './mail/database'
import { MessageLocalStore } from './mail/message-local-store'
import { holdMailMergesForRestore, MAIL_MERGE_ACTIVE } from './mail/mail-merge-store'
import { MailTemplateStore } from './mail/template-store'
import { InterchangeStore } from './productivity/interchange-store'
import { ProductivityStore } from './productivity/store'
import { TaskStore } from './productivity/task-store'
import { countRows, PROFILE_PREVIEW_LABELS, profileTableExists, type ProfileBackupLayout } from './profile-backup'

export const RESTORED_SEND_HOLD_MESSAGE = 'Held after restoring a profile backup. Review this message and send it again if it is still needed.'
export const RESTORED_MERGE_HOLD_MESSAGE = 'Held after restoring a profile backup. This message may have been sent after the backup was taken; check Sent, then resend or skip.'
export const RESTORED_ACCOUNT_MESSAGE = 'Restored from a profile backup. Sign in again to resume synchronization.'
const OUTGOING = `status IN ('queued','send-pending','scheduled','syncing')`
const ACTIVE_TASK_WRITE = `status IN ('queued','running','failed','conflict','review')`

/** Mirrors the preferences schema in main.ts so a staged copy is always openable. */
const PREFERENCES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS app_preferences (id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS app_lock (id INTEGER PRIMARY KEY CHECK (id = 1), salt TEXT NOT NULL, verifier TEXT NOT NULL, updated_at TEXT NOT NULL)
`

function withDatabase<T>(path: string, callback: (db: DatabaseSync) => T) {
  const db = new DatabaseSync(path)
  try { return callback(db) } finally { db.close() }
}

/**
 * Everything in a full profile backup. Credentials live only in
 * `oauth-vault.dat`, which is deliberately absent from this allowlist.
 */
export const PROFILE_BACKUP_LAYOUT: ProfileBackupLayout = {
  databases: [
    {
      file: 'aerio-state.sqlite',
      label: 'Preferences',
      // The app-lock verifier is device security, not data: it is stripped from backups.
      scrubBackup: (db) => { if (profileTableExists(db, 'app_lock')) db.exec('DELETE FROM app_lock') },
      prepareRestore: (path, context) => withDatabase(path, (db) => {
        db.exec(PREFERENCES_SCHEMA)
        db.exec('DELETE FROM app_lock')
        if (!existsSync(context.livePath)) return
        // Keep this device's current app lock (or lack of one) across the restore.
        const live = new DatabaseSync(context.livePath, { readOnly: true })
        try {
          const lock = profileTableExists(live, 'app_lock') ? live.prepare('SELECT salt,verifier,updated_at FROM app_lock WHERE id=1').get() as { salt: string; verifier: string; updated_at: string } | undefined : undefined
          if (lock) db.prepare('INSERT INTO app_lock(id,salt,verifier,updated_at) VALUES(1,?,?,?)').run(lock.salt, lock.verifier, lock.updated_at)
        } finally { live.close() }
      }),
      summarize: (db) => [{ label: 'Preferences', count: countRows(db, 'app_preferences') }]
    },
    {
      file: 'aerio.sqlite',
      label: 'Mail cache, drafts, rules, and queued changes',
      prepareRestore: (path, context) => {
        // Opening the store applies every idempotent schema upgrade, so an
        // older backup is migrated in staging before it can replace live data.
        new MailDatabase(path, join(dirname(path), 'mail')).close()
        withDatabase(path, (db) => {
          context.report.heldSends += Number(db.prepare(`UPDATE gmail_drafts SET status='failed',delivery_at=NULL,error=?,updated_at=? WHERE ${OUTGOING}`).run(RESTORED_SEND_HOLD_MESSAGE, new Date().toISOString()).changes)
          context.report.heldSends += holdMailMergesForRestore(db, RESTORED_MERGE_HOLD_MESSAGE)
          context.report.accountsToReauthorize += Number(db.prepare(`UPDATE gmail_accounts SET status='needs-auth',error=? WHERE archived=0`).run(RESTORED_ACCOUNT_MESSAGE).changes)
        })
      },
      summarize: (db) => [
        { label: PROFILE_PREVIEW_LABELS.accounts, count: countRows(db, 'gmail_accounts', 'archived=0') },
        { label: 'Cached messages', count: countRows(db, 'gmail_messages') },
        { label: 'Drafts', count: countRows(db, 'gmail_drafts', `status NOT IN ('sent','discarded','discard-queued')`) },
        { label: PROFILE_PREVIEW_LABELS.heldSends, count: countRows(db, 'gmail_drafts', OUTGOING) },
        { label: 'Queued mail changes', count: countRows(db, 'gmail_operations', `status IN ('queued','running')`) },
        { label: 'Mail rules', count: countRows(db, 'mail_rules') },
        { label: 'Quick actions', count: countRows(db, 'mail_quick_actions') },
        { label: 'Saved searches', count: countRows(db, 'mail_saved_searches') },
        { label: 'Reply watches', count: countRows(db, 'mail_reply_watches', `status='pending'`) },
        { label: 'Unfinished mail merges', count: countRows(db, 'mail_merge_jobs', MAIL_MERGE_ACTIVE) }
      ]
    },
    {
      file: 'message-local.sqlite',
      label: 'Message categories and links',
      prepareRestore: (path) => new MessageLocalStore(path).close(),
      summarize: (db) => [{ label: 'Messages with local categories or links', count: countRows(db, 'message_local') }]
    },
    {
      file: 'mail-templates.sqlite',
      label: 'Mail templates and QuickText',
      prepareRestore: (path) => new MailTemplateStore(path, join(dirname(path), 'template-attachments')).close(),
      summarize: (db) => [{ label: 'Mail templates and snippets', count: countRows(db, 'mail_templates') }]
    },
    {
      file: 'productivity.sqlite',
      label: 'Local Tasks, Notes, Contacts, local calendars, and calendar cache',
      prepareRestore: (path) => { new ProductivityStore(path).close(); new InterchangeStore(path).close() },
      summarize: (db) => {
        const module = (name: string) => {
          if (!profileTableExists(db, 'local_module_state')) return 0
          const row = db.prepare('SELECT payload_json FROM local_module_state WHERE module=?').get(name) as { payload_json: string } | undefined
          try { return row ? (JSON.parse(row.payload_json) as unknown[]).length : 0 } catch { return 0 }
        }
        return [
          { label: 'Local tasks', count: module('tasks') }, { label: 'Notes', count: module('notes') }, { label: 'Local contacts', count: countRows(db, 'local_contacts') },
          { label: 'Local calendars and subscriptions', count: countRows(db, 'interchange_calendars') }
        ]
      }
    },
    {
      file: 'provider-tasks.sqlite',
      label: 'Connected task cache and pending writes',
      prepareRestore: (path, context) => {
        if (!existsSync(path)) return
        context.report.heldTaskWrites += withDatabase(path, (db) => countRows(db, 'task_operations', ACTIVE_TASK_WRITE) + countRows(db, 'task_list_operations', ACTIVE_TASK_WRITE))
        // Round-trip through the connected-task backup path so restored writes
        // get the same `restored-write` review hold and cleared checkpoints.
        const store = new TaskStore(path)
        try { store.restoreBackup(store.exportBackup()) } finally { store.close() }
      },
      summarize: (db) => [
        { label: 'Connected tasks', count: countRows(db, 'task_entities') },
        { label: PROFILE_PREVIEW_LABELS.heldTaskWrites, count: countRows(db, 'task_operations', ACTIVE_TASK_WRITE) + countRows(db, 'task_list_operations', ACTIVE_TASK_WRITE) }
      ]
    }
  ],
  directories: [
    { name: 'mail', label: 'Downloaded messages and draft attachments' },
    { name: 'note-attachments', label: 'Note attachments' },
    { name: 'template-attachments', label: 'Template attachments' }
  ]
}
