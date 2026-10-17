import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { rmSync, statSync } from 'node:fs'
import type {
  MailDownloadMode,
  MailFolderOfflineOverride,
  MailFolderViewExtension,
  MailOfflineAvailability,
  MailOfflineContentState,
  MailOfflinePolicy,
  MailOfflineReclaimResult,
  MailOfflineSettings,
  MailSearchCoverage,
  MailSyncWindow
} from '../../src/offline-sync-types'
import {
  DEFAULT_OFFLINE_POLICY,
  LOAD_ALL_DURATION_MS,
  MODE_RANK,
  STATE_RANK,
  combineWanted,
  describeWindow,
  earliestStart,
  messageLocations,
  resolveLocationPolicy,
  stateForMode,
  wantedContent,
  type MailWantedContent,
  type OfflinePolicyContext
} from '../../src/lib/offline-sync'

/**
 * Offline download and synchronization scope (E36): per-account defaults,
 * per-folder overrides, temporary "Load more/Load all" widening, what each
 * cached message holds locally, and cache eviction. Everything lives in the
 * mail database, so profile backups include the policies.
 *
 * Eviction only ever removes local copies of bodies and originals. Header
 * rows stay so the message list stays complete, and provider mail is never
 * touched.
 */

interface DatabaseRow {
  [key: string]: string | number | bigint | null
}

const nowIso = () => new Date().toISOString()
const json = <T>(value: unknown, fallback: T): T => {
  try { return typeof value === 'string' && value ? JSON.parse(value) as T : fallback } catch { return fallback }
}
const isMode = (value: unknown): value is MailDownloadMode => value === 'full' || value === 'bodies' || value === 'headers'
const windowFrom = (unit: unknown, amount: unknown): MailSyncWindow | undefined =>
  unit === 'all' ? { unit: 'all', amount: 0 } : unit === 'days' || unit === 'months' ? { unit, amount: Number(amount) } : undefined
const SERVER_SEARCH_RETENTION_MS = 24 * 60 * 60_000
/**
 * Local Folders and POP3 keep all of their mail on this computer; there is
 * nothing to scope or evict. On-premises Exchange (EWS) always downloads full
 * content: its sync has no scope support yet, so it is never trimmed either.
 */
export const OFFLINE_EXEMPT_PROVIDERS = new Set(['local', 'pop3', 'exchange'])
export function offlineExemptReason(provider: string) {
  return provider === 'exchange'
    ? 'On-premises Exchange accounts always download full offline content; offline scope settings are not available for them yet.'
    : 'All mail in this account is stored on this computer, so it is always available offline and fully searchable.'
}

export interface OfflineMessageRow {
  id: string
  threadId: string
  historyId: string
  internalDate: string
  labelIds: string[]
  remoteFolderId?: string
  remoteUid?: string
  rawPath: string
  state: MailOfflineContentState
}

export interface OfflineContentPlan {
  /** Messages whose locations want more than is stored (within the window). */
  upgrades: string[]
  /** Messages storing more than any location wants. */
  downgrades: { id: string; target: MailOfflineContentState }[]
}

export class MailOfflineStore {
  private statements = new Map<string, StatementSync>()

  /** `transaction` is the mail database's, so these writes nest inside a caller's transaction. */
  constructor(private readonly db: DatabaseSync, private readonly transaction: <T>(callback: () => T) => T) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mail_offline_policies (
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        label_id TEXT NOT NULL,
        download_mode TEXT,
        window_unit TEXT,
        window_amount INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, label_id)
      );
      CREATE TABLE IF NOT EXISTS mail_offline_extensions (
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        label_id TEXT NOT NULL,
        extra_steps INTEGER NOT NULL DEFAULT 0,
        load_all_until TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, label_id)
      );
      CREATE TABLE IF NOT EXISTS mail_message_content (
        account_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, message_id),
        FOREIGN KEY (account_id, message_id) REFERENCES gmail_messages(account_id, id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS mail_server_search_hits (
        search_id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (search_id, account_id, thread_id)
      );
      CREATE INDEX IF NOT EXISTS mail_server_search_hits_created ON mail_server_search_hits(created_at);
    `)
  }

  private stmt(sql: string) {
    const cached = this.statements.get(sql)
    if (cached) return cached
    const statement = this.db.prepare(sql)
    this.statements.set(sql, statement)
    return statement
  }

  private provider(accountId: string) {
    const row = this.stmt('SELECT provider FROM gmail_accounts WHERE id=?').get(accountId) as DatabaseRow | undefined
    if (!row) throw new Error('Account not found')
    return String(row.provider)
  }

  // ---- Policies ---------------------------------------------------------

  settings(accountId: string): MailOfflineSettings {
    const provider = this.provider(accountId)
    const supported = !OFFLINE_EXEMPT_PROVIDERS.has(provider)
    const rows = this.stmt('SELECT * FROM mail_offline_policies WHERE account_id=? ORDER BY label_id').all(accountId) as DatabaseRow[]
    const defaultsRow = rows.find((row) => row.label_id === '')
    const defaults: MailOfflinePolicy = {
      downloadMode: isMode(defaultsRow?.download_mode) ? defaultsRow!.download_mode as MailDownloadMode : DEFAULT_OFFLINE_POLICY.downloadMode,
      window: windowFrom(defaultsRow?.window_unit, defaultsRow?.window_amount) ?? DEFAULT_OFFLINE_POLICY.window
    }
    const overrides: MailFolderOfflineOverride[] = rows.filter((row) => row.label_id !== '').map((row) => {
      const window = windowFrom(row.window_unit, row.window_amount)
      return {
        labelId: String(row.label_id),
        ...(isMode(row.download_mode) ? { downloadMode: row.download_mode } : {}),
        ...(window ? { window } : {}),
        updatedAt: String(row.updated_at)
      }
    })
    const extensions: MailFolderViewExtension[] = (this.stmt('SELECT * FROM mail_offline_extensions WHERE account_id=? ORDER BY label_id').all(accountId) as DatabaseRow[]).map((row) => ({
      labelId: String(row.label_id),
      extraSteps: Number(row.extra_steps),
      ...(row.load_all_until ? { loadAllUntil: String(row.load_all_until) } : {})
    }))
    return supported ? { accountId, supported, defaults, overrides, extensions } : { accountId, supported, unsupportedReason: offlineExemptReason(provider), defaults: DEFAULT_OFFLINE_POLICY, overrides: [], extensions: [] }
  }

  context(accountId: string, now = new Date()): OfflinePolicyContext {
    const settings = this.settings(accountId)
    return { defaults: settings.defaults, overrides: settings.overrides, extensions: settings.extensions, now }
  }

  setAccountPolicy(accountId: string, policy: MailOfflinePolicy) {
    if (OFFLINE_EXEMPT_PROVIDERS.has(this.provider(accountId))) throw new Error(offlineExemptReason(this.provider(accountId)))
    this.stmt(`INSERT INTO mail_offline_policies(account_id,label_id,download_mode,window_unit,window_amount,updated_at) VALUES(?,'',?,?,?,?)
      ON CONFLICT(account_id,label_id) DO UPDATE SET download_mode=excluded.download_mode,window_unit=excluded.window_unit,window_amount=excluded.window_amount,updated_at=excluded.updated_at`)
      .run(accountId, policy.downloadMode, policy.window.unit, policy.window.amount, nowIso())
    return this.settings(accountId)
  }

  setFolderOverride(accountId: string, labelId: string, override: { downloadMode?: MailDownloadMode; window?: MailSyncWindow } | null) {
    if (!labelId) throw new Error('Choose a folder')
    if (OFFLINE_EXEMPT_PROVIDERS.has(this.provider(accountId))) throw new Error(offlineExemptReason(this.provider(accountId)))
    if (!override) this.stmt('DELETE FROM mail_offline_policies WHERE account_id=? AND label_id=?').run(accountId, labelId)
    else this.stmt(`INSERT INTO mail_offline_policies(account_id,label_id,download_mode,window_unit,window_amount,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(account_id,label_id) DO UPDATE SET download_mode=excluded.download_mode,window_unit=excluded.window_unit,window_amount=excluded.window_amount,updated_at=excluded.updated_at`)
      .run(accountId, labelId, override.downloadMode ?? null, override.window?.unit ?? null, override.window?.amount ?? 0, nowIso())
    return this.settings(accountId)
  }

  /** "Load more" adds one window step; "Load all" lifts the window for a day. */
  extend(accountId: string, labelId: string, mode: 'more' | 'all', now = new Date()) {
    if (OFFLINE_EXEMPT_PROVIDERS.has(this.provider(accountId))) return this.settings(accountId)
    const current = this.stmt('SELECT extra_steps,load_all_until FROM mail_offline_extensions WHERE account_id=? AND label_id=?').get(accountId, labelId) as DatabaseRow | undefined
    const steps = Number(current?.extra_steps ?? 0) + (mode === 'more' ? 1 : 0)
    const loadAllUntil = mode === 'all' ? new Date(now.getTime() + LOAD_ALL_DURATION_MS).toISOString() : current?.load_all_until ? String(current.load_all_until) : null
    this.stmt(`INSERT INTO mail_offline_extensions(account_id,label_id,extra_steps,load_all_until,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(account_id,label_id) DO UPDATE SET extra_steps=excluded.extra_steps,load_all_until=excluded.load_all_until,updated_at=excluded.updated_at`)
      .run(accountId, labelId, steps, loadAllUntil, now.toISOString())
    return this.settings(accountId)
  }

  /** Clears "Load all" periods that have ended; returns the accounts whose scope narrowed. */
  expireExtensions(now = new Date()) {
    const rows = this.stmt('SELECT DISTINCT account_id FROM mail_offline_extensions WHERE load_all_until IS NOT NULL AND load_all_until<=?').all(now.toISOString()) as DatabaseRow[]
    this.stmt('UPDATE mail_offline_extensions SET load_all_until=NULL WHERE load_all_until IS NOT NULL AND load_all_until<=?').run(now.toISOString())
    this.stmt('DELETE FROM mail_offline_extensions WHERE extra_steps=0 AND load_all_until IS NULL').run()
    return rows.map((row) => String(row.account_id))
  }

  /** The policies backup previews count. */
  policyCount() {
    return Number((this.stmt('SELECT COUNT(*) count FROM mail_offline_policies').get() as DatabaseRow).count)
  }

  // ---- Per-message content ---------------------------------------------

  /** Called inside the message upsert transaction. */
  recordContent(accountId: string, messageId: string, state: MailOfflineContentState) {
    this.stmt(`INSERT INTO mail_message_content(account_id,message_id,state,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(account_id,message_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at`).run(accountId, messageId, state, nowIso())
  }

  /** Messages stored before E36 have no row and were downloaded in full. */
  contentState(accountId: string, messageId: string): MailOfflineContentState | undefined {
    const row = this.stmt(`SELECT COALESCE(c.state,'full') state FROM gmail_messages m LEFT JOIN mail_message_content c ON c.account_id=m.account_id AND c.message_id=m.id WHERE m.account_id=? AND m.id=?`).get(accountId, messageId) as DatabaseRow | undefined
    return row ? String(row.state) as MailOfflineContentState : undefined
  }

  messageRow(accountId: string, messageId: string): OfflineMessageRow | undefined {
    const row = this.stmt(`SELECT m.id,m.thread_id,m.history_id,m.internal_date,m.label_ids_json,m.remote_folder_id,m.remote_uid,m.raw_path,COALESCE(c.state,'full') state
      FROM gmail_messages m LEFT JOIN mail_message_content c ON c.account_id=m.account_id AND c.message_id=m.id WHERE m.account_id=? AND m.id=?`).get(accountId, messageId) as DatabaseRow | undefined
    if (!row) return undefined
    return {
      id: String(row.id),
      threadId: String(row.thread_id),
      historyId: String(row.history_id),
      internalDate: String(row.internal_date),
      labelIds: json<string[]>(row.label_ids_json, []),
      ...(row.remote_folder_id ? { remoteFolderId: String(row.remote_folder_id) } : {}),
      ...(row.remote_uid ? { remoteUid: String(row.remote_uid) } : {}),
      rawPath: String(row.raw_path),
      state: String(row.state) as MailOfflineContentState
    }
  }

  private accountRows(accountId: string) {
    return this.stmt(`SELECT m.id,m.thread_id,m.internal_date,m.label_ids_json,m.header_message_id,m.remote_folder_id,m.raw_path,m.size_estimate,
        length(m.body_text)+length(m.body_html) body_bytes,COALESCE(c.state,'full') state
      FROM gmail_messages m LEFT JOIN mail_message_content c ON c.account_id=m.account_id AND c.message_id=m.id WHERE m.account_id=?`).all(accountId) as DatabaseRow[]
  }

  /**
   * Decides, for every cached message, what its locations want. Copies of
   * one message (same Message-ID: IMAP copies, or a message filed in several
   * folders) share the most complete wish of any copy.
   */
  planContent(accountId: string, context: OfflinePolicyContext): OfflineContentPlan {
    const rows = this.accountRows(accountId)
    const wanted = new Map<string, MailWantedContent>()
    const groups = new Map<string, MailWantedContent>()
    for (const row of rows) {
      const value = wantedContent(context, String(row.internal_date), json<string[]>(row.label_ids_json, []))
      wanted.set(String(row.id), value)
      const key = row.header_message_id ? String(row.header_message_id).trim().toLowerCase() : ''
      if (key) groups.set(key, combineWanted([groups.get(key) ?? 'outside', value]))
    }
    const plan: OfflineContentPlan = { upgrades: [], downgrades: [] }
    for (const row of rows) {
      const id = String(row.id)
      const key = row.header_message_id ? String(row.header_message_id).trim().toLowerCase() : ''
      const value = key ? groups.get(key)! : wanted.get(id)!
      const state = String(row.state) as MailOfflineContentState
      const target: MailOfflineContentState = value === 'outside' ? 'headers' : stateForMode(value)
      if (value !== 'outside' && STATE_RANK[state] < MODE_RANK[value]) plan.upgrades.push(id)
      else if (STATE_RANK[state] > STATE_RANK[target]) plan.downgrades.push({ id, target })
    }
    return plan
  }

  /** Queues messages for download so the provider sync fetches the missing content. */
  queueDownloads(accountId: string, messageIds: readonly string[]) {
    if (!messageIds.length) return 0
    const queue = this.stmt(`INSERT INTO gmail_sync_items(account_id,message_id,thread_id,status,remote_folder_id,remote_uid)
      SELECT account_id,id,thread_id,'pending',remote_folder_id,remote_uid FROM gmail_messages WHERE account_id=? AND id=?
      ON CONFLICT(account_id,message_id) DO UPDATE SET status='pending',attempts=0,error=NULL`)
    this.transaction(() => {
      for (const id of messageIds) queue.run(accountId, id)
      const total = Number((this.stmt('SELECT COUNT(*) count FROM gmail_sync_items WHERE account_id=?').get(accountId) as DatabaseRow).count)
      this.stmt('UPDATE gmail_sync_state SET total=?,updated_at=? WHERE account_id=?').run(total, nowIso(), accountId)
    })
    return messageIds.length
  }

  /** Forgets an inventory entry that is outside every window and was never stored, so widening the window lists it again. */
  dropSyncItem(accountId: string, messageId: string) {
    this.stmt('DELETE FROM gmail_sync_items WHERE account_id=? AND message_id=? AND NOT EXISTS(SELECT 1 FROM gmail_messages m WHERE m.account_id=? AND m.id=?)').run(accountId, messageId, accountId, messageId)
  }

  /** Threads with queued or running provider changes, and provider drafts, are never evicted. */
  private protectedMessages(accountId: string) {
    const threads = new Set<string>()
    for (const row of this.stmt(`SELECT thread_ids_json FROM gmail_operations WHERE account_id=? AND status IN ('queued','running')`).all(accountId) as DatabaseRow[]) {
      for (const id of json<string[]>(row.thread_ids_json, [])) threads.add(id)
    }
    for (const row of this.stmt('SELECT thread_id FROM gmail_drafts WHERE account_id=? AND thread_id IS NOT NULL').all(accountId) as DatabaseRow[]) threads.add(String(row.thread_id))
    return threads
  }

  /**
   * Reclaims local bodies and originals the policy no longer wants. Never
   * touches Local Folders, drafts, or conversations with pending writes, and
   * never deletes a message row or anything on the provider.
   */
  evict(accountId: string, context: OfflinePolicyContext): MailOfflineReclaimResult {
    if (OFFLINE_EXEMPT_PROVIDERS.has(this.provider(accountId))) return { messages: 0, bytes: 0 }
    const plan = this.planContent(accountId, context)
    if (!plan.downgrades.length) return { messages: 0, bytes: 0 }
    const protectedThreads = this.protectedMessages(accountId)
    const select = this.stmt('SELECT thread_id,label_ids_json,raw_path,length(body_text)+length(body_html) body_bytes FROM gmail_messages WHERE account_id=? AND id=?')
    let messages = 0
    let bytes = 0
    for (const { id, target } of plan.downgrades) {
      const row = select.get(accountId, id) as DatabaseRow | undefined
      if (!row) continue
      if (protectedThreads.has(String(row.thread_id)) || json<string[]>(row.label_ids_json, []).includes('DRAFT')) continue
      const rawPath = String(row.raw_path)
      let rawBytes = 0
      try { rawBytes = statSync(rawPath).size } catch { rawBytes = 0 }
      this.transaction(() => {
        if (target === 'headers') {
          this.stmt(`UPDATE gmail_messages SET body_text='',body_html='' WHERE account_id=? AND id=?`).run(accountId, id)
          this.stmt(`UPDATE gmail_fts SET body='' WHERE account_id=? AND message_id=?`).run(accountId, id)
        }
        this.recordContent(accountId, id, target)
      })
      // The database no longer points at the file as content, so removing it last cannot lose a body still in use.
      try { rmSync(rawPath, { force: true }) } catch { /* A file that cannot be removed is retried by the next reclaim. */ }
      messages += 1
      bytes += rawBytes + (target === 'headers' ? Number(row.body_bytes ?? 0) : 0)
    }
    return { messages, bytes }
  }

  /**
   * Marks cached messages older than `start` as already inventoried, so a
   * provider listing limited to the window does not delete their header rows.
   */
  retainOutsideWindow(accountId: string, start: Date | undefined, remoteFolderId?: string) {
    if (!start) return 0
    const result = this.stmt(`INSERT OR IGNORE INTO gmail_sync_items(account_id,message_id,thread_id,status,remote_folder_id,remote_uid)
      SELECT account_id,id,thread_id,'complete',remote_folder_id,remote_uid FROM gmail_messages
      WHERE account_id=? AND internal_date<? AND (? IS NULL OR remote_folder_id=?)`).run(accountId, start.toISOString(), remoteFolderId ?? null, remoteFolderId ?? null)
    return Number(result.changes)
  }

  /** Cached ids in a provider folder that are older than the window start. */
  idsBefore(accountId: string, remoteFolderId: string, start: Date | undefined) {
    if (!start) return new Set<string>()
    return new Set((this.stmt('SELECT id FROM gmail_messages WHERE account_id=? AND remote_folder_id=? AND internal_date<?').all(accountId, remoteFolderId, start.toISOString()) as DatabaseRow[]).map((row) => String(row.id)))
  }

  // ---- Reporting --------------------------------------------------------

  availability(accountId: string, labelId?: string, now = new Date()): MailOfflineAvailability {
    const context = this.context(accountId, now)
    const local = OFFLINE_EXEMPT_PROVIDERS.has(this.provider(accountId))
    const resolved = resolveLocationPolicy(context, labelId ?? '')
    const remoteFolderId = labelId?.startsWith('folder:') ? labelId.slice(7) : undefined
    const result: MailOfflineAvailability = {
      accountId,
      ...(labelId ? { labelId } : {}),
      total: 0, full: 0, bodyOnly: 0, headersOnly: 0, outsideWindow: 0, bytes: 0,
      policy: local ? DEFAULT_OFFLINE_POLICY : resolved.policy,
      ...(!local && (labelId ? resolved.start : earliestStart(context)) ? { windowStart: (labelId ? resolved.start : earliestStart(context))!.toISOString() } : {}),
      extraSteps: resolved.extraSteps,
      ...(resolved.loadAllUntil ? { loadAllUntil: resolved.loadAllUntil } : {})
    }
    for (const row of this.accountRows(accountId)) {
      const labels = json<string[]>(row.label_ids_json, [])
      if (labelId && !labels.includes(labelId) && !(remoteFolderId && row.remote_folder_id === remoteFolderId)) continue
      result.total += 1
      const state = String(row.state) as MailOfflineContentState
      if (state === 'full') {
        result.full += 1
        result.bytes += Number(row.size_estimate ?? 0)
      } else if (state === 'body') {
        result.bodyOnly += 1
        result.bytes += Number(row.body_bytes ?? 0)
      } else result.headersOnly += 1
      if (local) continue
      const outside = labelId
        ? Boolean(resolved.start && Date.parse(String(row.internal_date)) < resolved.start.getTime())
        : wantedContent(context, String(row.internal_date), labels) === 'outside'
      if (outside) result.outsideWindow += 1
    }
    return result
  }

  /** Whether local search sees the whole mailbox, and why not. */
  searchCoverage(accountId: string, inventoryComplete: boolean, serverSearch: boolean, now = new Date()): MailSearchCoverage {
    if (OFFLINE_EXEMPT_PROVIDERS.has(this.provider(accountId))) return { accountId, complete: true, serverSearch: false, reasons: [] }
    const context = this.context(accountId, now)
    const reasons: string[] = []
    const limited = [resolveLocationPolicy(context, ''), ...context.overrides.map((item) => resolveLocationPolicy(context, item.labelId))].filter((item) => item.start)
    if (limited.length) {
      const windows = [...new Set(limited.map((item) => describeWindow(item.policy.window).toLowerCase()))]
      reasons.push(`Mail outside the sync window (${windows.join(', ')}) is not downloaded`)
    }
    const counts = this.stmt(`SELECT COALESCE(c.state,'full') state,COUNT(*) count FROM gmail_messages m LEFT JOIN mail_message_content c ON c.account_id=m.account_id AND c.message_id=m.id WHERE m.account_id=? GROUP BY 1`).all(accountId) as DatabaseRow[]
    const count = (state: MailOfflineContentState) => Number(counts.find((row) => row.state === state)?.count ?? 0)
    if (count('headers')) reasons.push(`${count('headers').toLocaleString('en-US')} message${count('headers') === 1 ? ' has' : 's have'} only headers downloaded`)
    if (count('body')) reasons.push(`Attachments of ${count('body').toLocaleString('en-US')} message${count('body') === 1 ? '' : 's'} are not downloaded`)
    if (!inventoryComplete) reasons.push('The mailbox is still downloading')
    return { accountId, complete: reasons.length === 0, serverSearch, reasons }
  }

  // ---- Server search ----------------------------------------------------

  saveSearchHits(searchId: string, hits: { accountId: string; threadId: string }[], now = new Date()) {
    this.stmt('DELETE FROM mail_server_search_hits WHERE created_at<?').run(new Date(now.getTime() - SERVER_SEARCH_RETENTION_MS).toISOString())
    const insert = this.stmt('INSERT OR IGNORE INTO mail_server_search_hits(search_id,account_id,thread_id,created_at) VALUES(?,?,?,?)')
    this.transaction(() => {
      for (const hit of hits) insert.run(searchId, hit.accountId, hit.threadId, now.toISOString())
    })
  }
}

/** Restricts a thread listing to one server search's matches; bound to the search id. */
export const SERVER_SEARCH_CLAUSE = 'EXISTS(SELECT 1 FROM mail_server_search_hits h WHERE h.search_id=? AND h.account_id=t.account_id AND h.thread_id=t.id)'
