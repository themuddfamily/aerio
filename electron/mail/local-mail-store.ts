import type { DatabaseSync } from 'node:sqlite'
import type {
  CreateMailFolderInput,
  DeleteMailFolderInput,
  MailFolderMutationResult,
  MailImportDuplicatePolicy,
  MailImportItem,
  MailImportItemStatus,
  MailImportJob,
  MailImportStatus,
  MailLabel,
  MailboxVariant,
  UpdateMailFolderInput
} from '../../src/mail-types'
import { LOCAL_FOLDER_DELIMITER, LOCAL_FOLDERS_ACCOUNT_ID, localFoldersAccount, type MailImportSourceKind } from '../../src/lib/local-folders'
import { mailFolderDescendants, mailFolderLeafName, mailFolderNameConflict, mailFolderNameError } from '../../src/lib/mail-folders'
import type { MailDatabase } from './database'
import { FolderConflictError, FolderNotEmptyError } from './folder-errors'

type Row = Record<string, string | number | bigint | null>

const nowIso = () => new Date().toISOString()
const json = <T>(value: unknown, fallback: T): T => {
  try { return typeof value === 'string' && value ? JSON.parse(value) as T : fallback } catch { return fallback }
}

export interface MailImportPlanEntry {
  kind: MailImportSourceKind
  path: string
  /** Folder path below the job's parent folder, outermost first. */
  folder: string[]
  size: number
}

export interface MailImportOptions {
  parentLabelId?: string
  duplicates: MailImportDuplicatePolicy
  mboxVariant: MailboxVariant
}

export interface MailImportCursor {
  /** Index of the plan entry being imported. */
  entry: number
  /** Byte offset of the next mbox message in that entry (0 for EML files). */
  offset: number
}

export interface StoredImportJob extends MailImportJob {
  plan: MailImportPlanEntry[]
  options: MailImportOptions
  cursor: MailImportCursor
}

export interface ImportItemInput {
  key: string
  status: MailImportItemStatus
  reason: string
  sourcePath: string
  sourceKind: MailImportSourceKind
  contentOffset?: number
  storedBytes?: number
  labelIds?: string[]
  subject?: string
  from?: string
  date?: string
  size?: number
  messageIdHeader?: string
  sha256?: string
  duplicateOf?: string
}

export interface StoredImportItem extends MailImportItem {
  sourceKind: MailImportSourceKind
  contentOffset: number
  storedBytes: number
  labelIds: string[]
  sha256?: string
}

// Durable state for the Local Folders pseudo-account: its folder tree, the
// content fingerprints used for duplicate review, and resumable import jobs.
// Messages themselves live in the shared mail tables like any other account.
export class LocalMailStore {
  constructor(private readonly db: DatabaseSync, private readonly mail: MailDatabase) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_mail_fingerprints (
        account_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        header_message_id TEXT,
        PRIMARY KEY (account_id, message_id),
        FOREIGN KEY (account_id, message_id) REFERENCES gmail_messages(account_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS local_mail_fingerprints_hash ON local_mail_fingerprints(account_id, sha256);
      CREATE INDEX IF NOT EXISTS local_mail_fingerprints_header ON local_mail_fingerprints(account_id, header_message_id);

      CREATE TABLE IF NOT EXISTS mail_import_jobs (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        label TEXT NOT NULL,
        plan_json TEXT NOT NULL DEFAULT '[]',
        options_json TEXT NOT NULL DEFAULT '{}',
        cursor_json TEXT NOT NULL DEFAULT '{"entry":0,"offset":0}',
        imported INTEGER NOT NULL DEFAULT 0,
        duplicates INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        processed_bytes INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        current_source TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS mail_import_items (
        job_id TEXT NOT NULL REFERENCES mail_import_jobs(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        source_path TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        content_offset INTEGER NOT NULL DEFAULT 0,
        stored_bytes INTEGER NOT NULL DEFAULT 0,
        label_ids_json TEXT NOT NULL DEFAULT '[]',
        subject TEXT NOT NULL DEFAULT '',
        from_text TEXT NOT NULL DEFAULT '',
        date TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        header_message_id TEXT,
        sha256 TEXT,
        duplicate_of TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (job_id, key)
      );
      CREATE INDEX IF NOT EXISTS mail_import_items_status ON mail_import_items(job_id, status);
    `)
    // An import cut off by a crash or quit resumes from its saved cursor when
    // the user chooses Resume; nothing restarts behind their back.
    this.db.prepare(`UPDATE mail_import_jobs SET status='interrupted',error='Aerio closed while this import was running. Resume to continue where it stopped.',updated_at=? WHERE status='running'`).run(nowIso())
  }

  account() {
    return this.mail.getAccount(LOCAL_FOLDERS_ACCOUNT_ID)
  }

  ensureAccount() {
    const existing = this.account()
    if (existing) return existing
    this.mail.upsertAccount(localFoldersAccount())
    return this.account()!
  }

  isLocal(accountId: string) {
    return this.mail.getAccount(accountId)?.provider === 'local'
  }

  // Marks queued Local Folders changes as done once their undo window passes:
  // the change is already applied to the local copy and has no server.
  completeDueOperations() {
    const rows = this.db.prepare(`
      SELECT o.id,o.account_id,o.kind FROM gmail_operations o JOIN gmail_accounts a ON a.id=o.account_id
      WHERE a.provider='local' AND o.status='queued' AND o.execute_after<=?
    `).all(nowIso()) as Row[]
    const update = this.db.prepare(`UPDATE gmail_operations SET status='succeeded',updated_at=? WHERE id=?`)
    for (const row of rows) update.run(nowIso(), String(row.id))
    return rows.map((row) => ({ id: String(row.id), accountId: String(row.account_id), kind: String(row.kind) }))
  }

  // ---- Folders -----------------------------------------------------------

  private labels(accountId: string) {
    return this.mail.listLabels([accountId])
  }

  private folderResult(accountId: string, extra: Partial<MailFolderMutationResult> = {}): MailFolderMutationResult {
    return { labels: this.labels(accountId), renamed: {}, ...extra }
  }

  private fullName(parent: MailLabel | undefined, name: string) {
    return parent ? `${parent.name}${LOCAL_FOLDER_DELIMITER}${name}` : name
  }

  private insertFolder(accountId: string, name: string, parent: MailLabel | undefined) {
    const id = `folder:local-${crypto.randomUUID()}`
    this.db.prepare('INSERT INTO gmail_labels(account_id,id,name,type,color,parent_id) VALUES(?,?,?,?,NULL,?)')
      .run(accountId, id, this.fullName(parent, name), 'user', parent?.id ?? null)
    return id
  }

  createFolder(input: CreateMailFolderInput): MailFolderMutationResult {
    const name = input.name.trim()
    const nameError = mailFolderNameError(name, 'local')
    if (nameError) throw new Error(nameError)
    if (input.color !== undefined) throw new Error('Local Folders do not support folder colors')
    const labels = this.labels(input.accountId)
    const parent = input.parentId ? labels.find((label) => label.id === input.parentId) : undefined
    if (input.parentId && !parent) throw new FolderConflictError('The parent folder no longer exists. The folder list was refreshed.')
    if (mailFolderNameConflict(input.accountId, name, parent?.id, labels)) throw new Error(`A folder named “${name}” already exists here`)
    const id = this.insertFolder(input.accountId, name, parent)
    const refreshed = this.labels(input.accountId)
    return { label: refreshed.find((label) => label.id === id), labels: refreshed, renamed: {} }
  }

  // Finds or creates each folder of an imported path so repeated and resumed
  // imports merge into the same folders instead of creating copies.
  ensureFolderPath(accountId: string, parentId: string | undefined, segments: string[]) {
    let parent = parentId ? this.labels(accountId).find((label) => label.id === parentId) : undefined
    if (parentId && !parent) throw new Error('The destination folder no longer exists')
    for (const raw of segments) {
      const name = raw.replaceAll(LOCAL_FOLDER_DELIMITER, '-').replaceAll(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200) || 'Untitled'
      const labels = this.labels(accountId)
      const existing = mailFolderNameConflict(accountId, name, parent?.id, labels)
      if (existing) {
        parent = existing
        continue
      }
      const id = this.insertFolder(accountId, name, parent)
      parent = this.labels(accountId).find((label) => label.id === id)
    }
    if (!parent) throw new Error('Choose a destination folder')
    return parent.id
  }

  updateFolder(input: UpdateMailFolderInput): MailFolderMutationResult {
    const labels = this.labels(input.accountId)
    const label = labels.find((item) => item.id === input.labelId)
    if (!label) throw new FolderConflictError('This folder no longer exists. The folder list was refreshed.')
    if (input.color !== undefined) throw new Error('Local Folders do not support folder colors')
    const currentName = mailFolderLeafName(label, labels)
    const name = input.name === undefined ? currentName : input.name.trim()
    const parentId = input.parentId === undefined ? label.parentId : input.parentId ?? undefined
    const nameError = mailFolderNameError(name, 'local')
    if (nameError) throw new Error(nameError)
    const descendants = mailFolderDescendants(label, labels)
    if (parentId && (parentId === label.id || descendants.some((item) => item.id === parentId))) throw new Error('A folder cannot be moved inside itself')
    const parent = parentId ? labels.find((item) => item.id === parentId) : undefined
    if (parentId && !parent) throw new FolderConflictError('The parent folder no longer exists. The folder list was refreshed.')
    if (mailFolderNameConflict(input.accountId, name, parent?.id, labels, label.id)) throw new Error(`A folder named “${name}” already exists here`)
    // Ids are stable; only the stored full names of the folder and its
    // subfolders change, so messages and rules keep their references.
    const oldName = label.name
    const newName = this.fullName(parent, name)
    const rename = this.db.prepare('UPDATE gmail_labels SET name=?,parent_id=? WHERE account_id=? AND id=?')
    const renameChild = this.db.prepare('UPDATE gmail_labels SET name=? WHERE account_id=? AND id=?')
    this.mail.transaction(() => {
      rename.run(newName, parent?.id ?? null, input.accountId, label.id)
      for (const child of descendants) {
        if (child.name.startsWith(`${oldName}${LOCAL_FOLDER_DELIMITER}`)) renameChild.run(newName + child.name.slice(oldName.length), input.accountId, child.id)
      }
    })
    const refreshed = this.labels(input.accountId)
    return { label: refreshed.find((item) => item.id === label.id), labels: refreshed, renamed: {} }
  }

  deleteFolder(input: DeleteMailFolderInput): MailFolderMutationResult {
    const labels = this.labels(input.accountId)
    const label = labels.find((item) => item.id === input.labelId)
    if (!label) throw new FolderConflictError('This folder no longer exists. The folder list was refreshed.')
    if (mailFolderDescendants(label, labels).length) throw new Error('Delete or move this folder’s subfolders first')
    const pending = this.mail.pendingOperationsForLabel(input.accountId, label.id)
    if (pending) throw new Error(`${pending} pending mail change${pending === 1 ? ' still uses' : 's still use'} this folder. Wait a few seconds or undo ${pending === 1 ? 'it' : 'them'}, then try again.`)
    const messages = this.db.prepare(`SELECT id,label_ids_json FROM gmail_messages WHERE account_id=? AND EXISTS(SELECT 1 FROM json_each(label_ids_json) WHERE value=?)`).all(input.accountId, label.id) as Row[]
    if (messages.length && !input.confirmNonEmpty) throw new FolderNotEmptyError(messages.length)
    // Like a server folder delete, the messages go to Trash rather than vanishing.
    for (const row of messages) {
      const next = new Set(json<string[]>(row.label_ids_json, []).filter((item) => item !== label.id))
      next.add('TRASH')
      this.mail.updateMessageLabels(input.accountId, String(row.id), [...next], `local:${Date.now()}`)
    }
    this.db.prepare('DELETE FROM gmail_labels WHERE account_id=? AND id=?').run(input.accountId, label.id)
    return this.folderResult(input.accountId, { deletedId: label.id })
  }

  // ---- Fingerprints and duplicates ---------------------------------------

  addFingerprint(accountId: string, messageId: string, sha256: string, headerMessageId?: string) {
    this.db.prepare(`INSERT INTO local_mail_fingerprints(account_id,message_id,sha256,header_message_id) VALUES(?,?,?,?)
      ON CONFLICT(account_id,message_id) DO UPDATE SET sha256=excluded.sha256,header_message_id=excluded.header_message_id`)
      .run(accountId, messageId, sha256, headerMessageId?.toLowerCase() ?? null)
  }

  // An identical file (same SHA-256) wins over a Message-ID match, which can
  // also mean an edited or re-sent copy and is reported as such.
  findDuplicate(accountId: string, sha256: string, headerMessageId: string | undefined, excludeId?: string) {
    const lookup = (column: 'sha256' | 'header_message_id', value: string) => this.db.prepare(`
      SELECT f.message_id,m.subject,m.label_ids_json FROM local_mail_fingerprints f
      JOIN gmail_messages m ON m.account_id=f.account_id AND m.id=f.message_id
      WHERE f.account_id=? AND f.${column}=? AND f.message_id<>? LIMIT 1
    `).get(accountId, value, excludeId ?? '') as Row | undefined
    const identical = lookup('sha256', sha256)
    if (identical) return { messageId: String(identical.message_id), subject: String(identical.subject), labelIds: json<string[]>(identical.label_ids_json, []), reason: 'identical' as const }
    if (!headerMessageId) return undefined
    const sameId = lookup('header_message_id', headerMessageId.toLowerCase())
    if (sameId) return { messageId: String(sameId.message_id), subject: String(sameId.subject), labelIds: json<string[]>(sameId.label_ids_json, []), reason: 'message-id' as const }
    return undefined
  }

  internalDate(accountId: string, messageId: string) {
    const row = this.db.prepare('SELECT internal_date FROM gmail_messages WHERE account_id=? AND id=?').get(accountId, messageId) as Row | undefined
    return row?.internal_date ? String(row.internal_date) : undefined
  }

  messagesWithHash(accountId: string, sha256: string) {
    return (this.db.prepare(`SELECT f.message_id,m.label_ids_json FROM local_mail_fingerprints f JOIN gmail_messages m ON m.account_id=f.account_id AND m.id=f.message_id WHERE f.account_id=? AND f.sha256=?`)
      .all(accountId, sha256) as Row[]).map((row) => ({ messageId: String(row.message_id), labelIds: json<string[]>(row.label_ids_json, []) }))
  }

  // ---- Import jobs --------------------------------------------------------

  createJob(input: { id?: string; accountId: string; label: string; plan: MailImportPlanEntry[]; options: MailImportOptions }) {
    const id = input.id ?? crypto.randomUUID()
    const timestamp = nowIso()
    const total = input.plan.reduce((sum, entry) => sum + entry.size, 0)
    this.db.prepare(`INSERT INTO mail_import_jobs(id,account_id,status,label,plan_json,options_json,total_bytes,created_at,updated_at) VALUES(?,?,'queued',?,?,?,?,?,?)`)
      .run(id, input.accountId, input.label, JSON.stringify(input.plan), JSON.stringify(input.options), total, timestamp, timestamp)
    return this.getJob(id)!
  }

  private jobFromRow(row: Row): StoredImportJob {
    const plan = json<MailImportPlanEntry[]>(row.plan_json, [])
    const pendingReview = Number((this.db.prepare(`SELECT COUNT(*) count FROM mail_import_items WHERE job_id=? AND status='duplicate'`).get(String(row.id)) as Row).count)
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      status: String(row.status) as MailImportStatus,
      label: String(row.label),
      sources: plan.length,
      imported: Number(row.imported),
      duplicates: Number(row.duplicates),
      failed: Number(row.failed),
      skipped: Number(row.skipped),
      pendingReview,
      processedBytes: Number(row.processed_bytes),
      totalBytes: Number(row.total_bytes),
      ...(row.current_source ? { currentSource: String(row.current_source) } : {}),
      ...(row.error ? { error: String(row.error) } : {}),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(row.finished_at ? { finishedAt: String(row.finished_at) } : {}),
      plan,
      options: json<MailImportOptions>(row.options_json, { duplicates: 'review', mboxVariant: 'mboxrd' }),
      cursor: json<MailImportCursor>(row.cursor_json, { entry: 0, offset: 0 })
    }
  }

  getJob(id: string) {
    const row = this.db.prepare('SELECT * FROM mail_import_jobs WHERE id=?').get(id) as Row | undefined
    return row ? this.jobFromRow(row) : undefined
  }

  listJobs() {
    return (this.db.prepare('SELECT * FROM mail_import_jobs ORDER BY created_at DESC, rowid DESC').all() as Row[]).map((row) => this.jobFromRow(row))
  }

  nextQueuedJob() {
    const row = this.db.prepare(`SELECT * FROM mail_import_jobs WHERE status='queued' ORDER BY created_at, rowid LIMIT 1`).get() as Row | undefined
    return row ? this.jobFromRow(row) : undefined
  }

  setJobStatus(id: string, status: MailImportStatus, error?: string) {
    const finished = status === 'completed' || status === 'cancelled' || status === 'failed'
    this.db.prepare('UPDATE mail_import_jobs SET status=?,error=?,updated_at=?,finished_at=? WHERE id=?')
      .run(status, error ?? null, nowIso(), finished ? nowIso() : null, id)
    return this.getJob(id)!
  }

  // Saves the cursor and counters together so a restart resumes after the
  // last message whose outcome is already recorded.
  saveProgress(id: string, progress: { cursor: MailImportCursor; processedBytes: number; currentSource?: string; counts: Pick<MailImportJob, 'imported' | 'duplicates' | 'failed' | 'skipped'> }) {
    this.db.prepare('UPDATE mail_import_jobs SET cursor_json=?,processed_bytes=?,current_source=?,imported=?,duplicates=?,failed=?,skipped=?,updated_at=? WHERE id=?')
      .run(JSON.stringify(progress.cursor), progress.processedBytes, progress.currentSource ?? null, progress.counts.imported, progress.counts.duplicates, progress.counts.failed, progress.counts.skipped, nowIso(), id)
  }

  adjustImported(id: string, delta: number) {
    this.db.prepare('UPDATE mail_import_jobs SET imported=imported+?,updated_at=? WHERE id=?').run(delta, nowIso(), id)
  }

  deleteJob(id: string) {
    this.db.prepare('DELETE FROM mail_import_jobs WHERE id=?').run(id)
  }

  hasItem(jobId: string, key: string) {
    return Boolean(this.db.prepare('SELECT 1 found FROM mail_import_items WHERE job_id=? AND key=?').get(jobId, key))
  }

  addItem(jobId: string, item: ImportItemInput) {
    this.db.prepare(`
      INSERT INTO mail_import_items(job_id,key,status,reason,source_path,source_kind,content_offset,stored_bytes,label_ids_json,subject,from_text,date,size,header_message_id,sha256,duplicate_of,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(job_id,key) DO UPDATE SET status=excluded.status,reason=excluded.reason,duplicate_of=excluded.duplicate_of
    `).run(
      jobId, item.key, item.status, item.reason, item.sourcePath, item.sourceKind, item.contentOffset ?? 0, item.storedBytes ?? 0,
      JSON.stringify(item.labelIds ?? []), item.subject ?? '', item.from ?? '', item.date ?? null, item.size ?? 0,
      item.messageIdHeader ?? null, item.sha256 ?? null, item.duplicateOf ?? null, nowIso()
    )
  }

  setItemStatus(jobId: string, key: string, status: MailImportItemStatus, reason?: string) {
    if (reason === undefined) this.db.prepare('UPDATE mail_import_items SET status=? WHERE job_id=? AND key=?').run(status, jobId, key)
    else this.db.prepare('UPDATE mail_import_items SET status=?,reason=? WHERE job_id=? AND key=?').run(status, reason, jobId, key)
  }

  listItems(jobId: string, limit = 2_000): StoredImportItem[] {
    const rows = this.db.prepare(`
      SELECT i.*,m.subject duplicate_subject FROM mail_import_items i
      LEFT JOIN mail_import_jobs j ON j.id=i.job_id
      LEFT JOIN gmail_messages m ON m.account_id=j.account_id AND m.id=i.duplicate_of
      WHERE i.job_id=? ORDER BY CASE i.status WHEN 'duplicate' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END, i.rowid LIMIT ?
    `).all(jobId, limit) as Row[]
    return rows.map((row) => ({
      key: String(row.key),
      jobId: String(row.job_id),
      status: String(row.status) as MailImportItemStatus,
      reason: String(row.reason),
      source: String(row.source_path),
      subject: String(row.subject),
      from: String(row.from_text),
      ...(row.date ? { date: String(row.date) } : {}),
      size: Number(row.size),
      ...(row.header_message_id ? { messageIdHeader: String(row.header_message_id) } : {}),
      ...(row.duplicate_of ? { duplicateOf: { messageId: String(row.duplicate_of), subject: row.duplicate_subject === null ? '(no longer in Local Folders)' : String(row.duplicate_subject) } } : {}),
      sourceKind: String(row.source_kind) as MailImportSourceKind,
      contentOffset: Number(row.content_offset),
      storedBytes: Number(row.stored_bytes),
      labelIds: json<string[]>(row.label_ids_json, []),
      ...(row.sha256 ? { sha256: String(row.sha256) } : {})
    }))
  }
}
