import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type {
  MailBuiltInCategory,
  MailCategoryAssignInput,
  MailCategoryAssignResult,
  MailCategoryCounts,
  MailCategoryId,
  MailCategoryRule,
  MailCategoryRuleInput,
  MailCategorySource,
  MailInboxTabsConfig
} from '../../src/mail-category-types'
import {
  MICROSOFT_FOCUSED_LABEL,
  MICROSOFT_OTHER_LABEL,
  classifyMailHeuristically,
  defaultInboxTabs,
  gmailCategoryLabelChange,
  isBuiltInCategory,
  isMailCategoryId,
  microsoftInferenceFor,
  normalizeCategoryRulePattern,
  normalizeInboxTabs,
  providerMailCategory,
  resolveMailCategory,
  senderDomain,
  validateCategoryRuleInput,
  visibleInboxTab
} from '../../src/lib/mail-categories'
import type { MailDatabase } from './database'

/**
 * Inbox category classification (E33). Everything is keyed by
 * (account_id, thread_id) and kept apart from the cached thread rows, like
 * pins: a resync that drops and re-downloads a conversation keeps its manual
 * reassignment, and the signals are recomputed from the new copy.
 *
 * - mail_category_overrides: manual reassignments and mail-rule actions.
 * - mail_category_rules: sender address / domain rules (global, all accounts).
 * - mail_category_signals: per-conversation sender, provider category, and
 *   heuristic category, refreshed whenever the conversation is rebuilt.
 * - mail_category_hints: the header-based heuristic for each downloaded
 *   message, computed at ingest when the raw headers are at hand.
 * - mail_inbox_tabs: the ordered tab configuration.
 */

interface DatabaseRow {
  [key: string]: string | number | bigint | null
}

const nowIso = () => new Date().toISOString()
const SIGNAL = (column: string) => `(SELECT s.${column} FROM mail_category_signals s WHERE s.account_id=t.account_id AND s.thread_id=t.id)`
const SENDER = `COALESCE(${SIGNAL('sender_email')},lower(t.sender_email))`
const DOMAIN = `COALESCE(${SIGNAL('sender_domain')},lower(substr(t.sender_email,instr(t.sender_email,'@')+1)))`

/**
 * The stored category of conversation `t`, in precedence order. It must agree
 * with resolveMailCategory; tests compare the two.
 */
export const MAIL_CATEGORY_SQL = `COALESCE(
  (SELECT o.category FROM mail_category_overrides o WHERE o.account_id=t.account_id AND o.thread_id=t.id),
  (SELECT r.category FROM mail_category_rules r WHERE r.kind='address' AND r.pattern=${SENDER}),
  (SELECT r.category FROM mail_category_rules r WHERE r.kind='domain' AND (${DOMAIN}=r.pattern OR ${DOMAIN} LIKE '%.'||r.pattern) ORDER BY length(r.pattern) DESC LIMIT 1),
  ${SIGNAL('provider_category')},
  ${SIGNAL('heuristic_category')},
  'primary')`

export interface CategoryMessageRow {
  row: DatabaseRow
  labels: Set<string>
}

export class MailInboxCategoryStore {
  private statements = new Map<string, StatementSync>()
  private rulesCache?: MailCategoryRule[]
  private tabsCache?: MailInboxTabsConfig

  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mail_inbox_tabs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        position INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mail_category_rules (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('address','domain')),
        pattern TEXT NOT NULL,
        category TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (kind, pattern)
      );
      CREATE TABLE IF NOT EXISTS mail_category_overrides (
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        category TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('manual','mail-rule')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, thread_id)
      );
      CREATE TABLE IF NOT EXISTS mail_category_signals (
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        sender_email TEXT NOT NULL,
        sender_domain TEXT NOT NULL,
        provider_category TEXT,
        heuristic_category TEXT NOT NULL,
        PRIMARY KEY (account_id, thread_id)
      );
      CREATE TABLE IF NOT EXISTS mail_category_hints (
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        heuristic TEXT NOT NULL,
        PRIMARY KEY (account_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS mail_category_hints_thread ON mail_category_hints(account_id, thread_id);
      CREATE TABLE IF NOT EXISTS mail_category_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
  }

  private stmt(sql: string) {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  // ------------------------------------------------------------- Tabs

  tabs(): MailInboxTabsConfig {
    if (this.tabsCache) return this.tabsCache
    const rows = this.stmt('SELECT * FROM mail_inbox_tabs ORDER BY position').all() as DatabaseRow[]
    this.tabsCache = rows.length
      ? normalizeInboxTabs({ tabs: rows.map((row) => ({ id: String(row.id) as MailCategoryId, name: String(row.name), enabled: Boolean(row.enabled), builtIn: isBuiltInCategory(String(row.id)) })) })
      : defaultInboxTabs()
    return this.tabsCache
  }

  saveTabs(value: unknown): MailInboxTabsConfig {
    const config = normalizeInboxTabs(value)
    this.stmt('DELETE FROM mail_inbox_tabs').run()
    config.tabs.forEach((tab, index) => this.stmt('INSERT INTO mail_inbox_tabs(id,name,enabled,position) VALUES(?,?,?,?)').run(tab.id, tab.name, tab.enabled ? 1 : 0, index))
    this.tabsCache = undefined
    return this.tabs()
  }

  // ------------------------------------------------------------ Rules

  rules(): MailCategoryRule[] {
    if (!this.rulesCache) {
      this.rulesCache = (this.stmt('SELECT * FROM mail_category_rules ORDER BY kind,pattern').all() as DatabaseRow[]).map((row) => ({
        id: String(row.id),
        kind: String(row.kind) as MailCategoryRule['kind'],
        pattern: String(row.pattern),
        category: String(row.category) as MailCategoryId,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at)
      }))
    }
    return this.rulesCache
  }

  /** Saving a rule for an existing address or domain replaces that rule's category. */
  saveRule(value: MailCategoryRuleInput): MailCategoryRule {
    const input = validateCategoryRuleInput(value)
    const at = nowIso()
    const existing = this.stmt('SELECT id FROM mail_category_rules WHERE kind=? AND pattern=?').get(input.kind, input.pattern) as DatabaseRow | undefined
    const id = input.id ?? (existing ? String(existing.id) : crypto.randomUUID())
    if (existing && String(existing.id) !== id) this.stmt('DELETE FROM mail_category_rules WHERE id=?').run(String(existing.id))
    this.stmt(`INSERT INTO mail_category_rules(id,kind,pattern,category,created_at,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,pattern=excluded.pattern,category=excluded.category,updated_at=excluded.updated_at`)
      .run(id, input.kind, input.pattern, input.category, at, at)
    this.rulesCache = undefined
    return this.rules().find((rule) => rule.id === id)!
  }

  deleteRule(id: string) {
    this.stmt('DELETE FROM mail_category_rules WHERE id=?').run(id)
    this.rulesCache = undefined
  }

  private ruleFor(email: string, domain: string) {
    const rules = this.rules()
    const address = rules.find((rule) => rule.kind === 'address' && rule.pattern === email)?.category
    const domainRule = rules
      .filter((rule) => rule.kind === 'domain' && (domain === rule.pattern || domain.endsWith(`.${rule.pattern}`)))
      .sort((left, right) => right.pattern.length - left.pattern.length)[0]?.category
    return { address, domain: domainRule }
  }

  // -------------------------------------------------------- Overrides

  /**
   * Stores (or with no category, clears) a per-conversation assignment.
   * A mail rule's action never replaces the user's own manual reassignment.
   */
  setOverride(accountId: string, threadIds: string[], category: MailCategoryId | undefined, source: 'manual' | 'mail-rule', at = nowIso()) {
    let changed = 0
    for (const threadId of new Set(threadIds)) {
      if (!category) {
        changed += Number(this.stmt('DELETE FROM mail_category_overrides WHERE account_id=? AND thread_id=?').run(accountId, threadId).changes)
      } else if (source === 'manual') {
        this.stmt(`INSERT INTO mail_category_overrides(account_id,thread_id,category,source,updated_at) VALUES(?,?,?,'manual',?)
          ON CONFLICT(account_id,thread_id) DO UPDATE SET category=excluded.category,source='manual',updated_at=excluded.updated_at`).run(accountId, threadId, category, at)
        changed += 1
      } else {
        changed += Number(this.stmt(`INSERT INTO mail_category_overrides(account_id,thread_id,category,source,updated_at) VALUES(?,?,?,'mail-rule',?)
          ON CONFLICT(account_id,thread_id) DO UPDATE SET category=excluded.category,updated_at=excluded.updated_at WHERE mail_category_overrides.source<>'manual'`).run(accountId, threadId, category, at).changes)
      }
    }
    return changed
  }

  override(accountId: string, threadId: string) {
    const row = this.stmt('SELECT category,source FROM mail_category_overrides WHERE account_id=? AND thread_id=?').get(accountId, threadId) as DatabaseRow | undefined
    return row ? { category: String(row.category), source: String(row.source) as 'manual' | 'mail-rule' } : undefined
  }

  // ---------------------------------------------------------- Signals

  /** Records the header-based heuristic of a downloaded message. */
  recordHint(accountId: string, messageId: string, threadId: string, heuristic: MailBuiltInCategory | undefined) {
    if (!heuristic) return
    this.stmt(`INSERT INTO mail_category_hints(account_id,message_id,thread_id,heuristic) VALUES(?,?,?,?)
      ON CONFLICT(account_id,message_id) DO UPDATE SET thread_id=excluded.thread_id,heuristic=excluded.heuristic`).run(accountId, messageId, threadId, heuristic)
  }

  /**
   * Recomputes a conversation's signals from its newest received message
   * (Sent copies and drafts are skipped, so replying never reclassifies it).
   */
  refreshThread(accountId: string, threadId: string, messages: CategoryMessageRow[]) {
    const received = [...messages].reverse().find((message) => !message.labels.has('SENT') && !message.labels.has('DRAFT')) ?? messages.at(-1)
    if (!received) return this.forgetThread(accountId, threadId)
    const email = String(received.row.from_email ?? '').trim().toLowerCase()
    const hint = this.stmt('SELECT heuristic FROM mail_category_hints WHERE account_id=? AND message_id=?').get(accountId, String(received.row.id)) as DatabaseRow | undefined
    const heuristic = hint && isBuiltInCategory(String(hint.heuristic)) ? String(hint.heuristic) as MailBuiltInCategory : classifyMailHeuristically({ fromEmail: email })
    const provider = providerMailCategory(received.labels, heuristic)
    this.stmt(`INSERT INTO mail_category_signals(account_id,thread_id,sender_email,sender_domain,provider_category,heuristic_category) VALUES(?,?,?,?,?,?)
      ON CONFLICT(account_id,thread_id) DO UPDATE SET sender_email=excluded.sender_email,sender_domain=excluded.sender_domain,
        provider_category=excluded.provider_category,heuristic_category=excluded.heuristic_category`)
      .run(accountId, threadId, email, senderDomain(email), provider ?? null, heuristic)
  }

  /** Drops derived signals for a conversation that no longer exists locally; overrides stay. */
  forgetThread(accountId: string, threadId: string) {
    this.stmt('DELETE FROM mail_category_signals WHERE account_id=? AND thread_id=?').run(accountId, threadId)
    this.stmt('DELETE FROM mail_category_hints WHERE account_id=? AND thread_id=? AND message_id NOT IN (SELECT id FROM gmail_messages WHERE account_id=? AND thread_id=?)').run(accountId, threadId, accountId, threadId)
  }

  signals(accountId: string, threadId: string) {
    const row = this.stmt('SELECT * FROM mail_category_signals WHERE account_id=? AND thread_id=?').get(accountId, threadId) as DatabaseRow | undefined
    return row ? {
      senderEmail: String(row.sender_email),
      senderDomain: String(row.sender_domain),
      provider: row.provider_category ? String(row.provider_category) : undefined,
      heuristic: String(row.heuristic_category)
    } : undefined
  }

  /** One-time fill for conversations cached before categories existed (header hints are not available for them). */
  backfill(rebuild: (accountId: string, threadId: string) => void) {
    if (this.stmt(`SELECT 1 FROM mail_category_state WHERE key='signals-backfilled'`).get()) return 0
    const rows = this.stmt('SELECT account_id,id FROM gmail_threads t WHERE NOT EXISTS(SELECT 1 FROM mail_category_signals s WHERE s.account_id=t.account_id AND s.thread_id=t.id)').all() as DatabaseRow[]
    for (const row of rows) rebuild(String(row.account_id), String(row.id))
    this.stmt(`INSERT OR REPLACE INTO mail_category_state(key,value) VALUES('signals-backfilled',?)`).run(nowIso())
    return rows.length
  }

  // --------------------------------------------------------- Resolving

  /** The category and its source for one conversation, before disabled tabs fold into Primary. */
  resolve(accountId: string, threadId: string, fallbackSender = ''): { category: MailCategoryId; source: MailCategorySource } {
    const signals = this.signals(accountId, threadId)
    const email = signals?.senderEmail ?? fallbackSender.trim().toLowerCase()
    const rule = this.ruleFor(email, signals?.senderDomain ?? senderDomain(email))
    return resolveMailCategory({ override: this.override(accountId, threadId), addressRule: rule.address, domainRule: rule.domain, provider: signals?.provider, heuristic: signals?.heuristic })
  }

  /** The tab a conversation appears in. */
  tabFor(accountId: string, threadId: string, fallbackSender = '') {
    return visibleInboxTab(this.resolve(accountId, threadId, fallbackSender).category, this.tabs())
  }

  /** SQL condition (over alias `t`) that keeps the conversations of one tab. */
  filter(category: string): { clause: string; params: string[] } | undefined {
    const tabs = this.tabs()
    const enabled = tabs.tabs.filter((tab) => tab.enabled && tab.id !== 'primary').map((tab) => tab.id)
    if (category === 'primary') {
      return enabled.length ? { clause: `${MAIL_CATEGORY_SQL} NOT IN (${enabled.map(() => '?').join(',')})`, params: enabled } : undefined
    }
    // A disabled or unknown tab shows nothing rather than everything.
    if (!enabled.includes(category as MailCategoryId)) return { clause: '0=1', params: [] }
    return { clause: `${MAIL_CATEGORY_SQL}=?`, params: [category] }
  }

  /** Inbox conversations (not trashed or snoozed) per visible tab; with no accounts given, all accounts are summed. */
  counts(accountIds?: string[]): MailCategoryCounts {
    const config = this.tabs()
    const accountFilter = accountIds?.length ? `AND t.account_id IN (${accountIds.map(() => '?').join(',')})` : ''
    const rows = this.db.prepare(`
      SELECT ${MAIL_CATEGORY_SQL} category,COUNT(*) total,COALESCE(SUM(t.unread),0) unread
      FROM gmail_threads t JOIN gmail_accounts a ON a.id=t.account_id
      WHERE t.inbox=1 AND t.trashed=0 ${accountFilter}
        AND NOT EXISTS(SELECT 1 FROM mail_snoozes z WHERE z.account_id=t.account_id AND z.thread_id=t.id AND z.snoozed_until>?)
      GROUP BY 1
    `).all(...(accountIds ?? []), nowIso()) as DatabaseRow[]
    const counts: MailCategoryCounts = Object.fromEntries(config.tabs.filter((tab) => tab.enabled).map((tab) => [tab.id, { unread: 0, total: 0 }]))
    for (const row of rows) {
      const tab = visibleInboxTab(String(row.category), config)
      counts[tab].total += Number(row.total)
      counts[tab].unread += Number(row.unread)
    }
    return counts
  }
}

// ------------------------------------------------------- Reassignment

/**
 * Manually moves conversations to a tab (or back to automatic), optionally
 * remembering the sender or domain, and keeps the provider in step through
 * the normal mail-change queue: Gmail gets the matching CATEGORY_* label (and
 * loses the others); Outlook Inbox messages are set to Focused (Primary) or
 * Other (every other tab). Custom tabs and IMAP/Local Folders stay local.
 */
export function assignMailCategory(database: MailDatabase, input: MailCategoryAssignInput): MailCategoryAssignResult {
  const account = database.getAccount(input.accountId)
  if (!account) throw new Error('Account not found')
  const threadIds = [...new Set(input.threadIds)]
  if (!threadIds.length) throw new Error('Select at least one conversation')
  if (input.category !== undefined && !isMailCategoryId(input.category)) throw new Error('Choose an inbox tab')
  if (input.remember && !input.category) throw new Error('Choose a tab to remember for this sender')
  const store = database.inboxCategories
  const known = threadIds.filter((threadId) => store.signals(input.accountId, threadId) || database.remoteMessagesForThreads(input.accountId, [threadId]).length)
  if (known.length !== threadIds.length) throw new Error('A selected conversation was not found')

  const updated = store.setOverride(input.accountId, threadIds, input.category, 'manual')
  let rule: MailCategoryRule | undefined
  if (input.remember && input.category) {
    const sender = store.signals(input.accountId, threadIds[0])?.senderEmail ?? ''
    const pattern = normalizeCategoryRulePattern(input.remember, input.remember === 'domain' ? senderDomain(sender) : sender)
    if (!pattern) throw new Error('This conversation has no sender address to remember')
    rule = store.saveRule({ kind: input.remember, pattern, category: input.category })
  }

  let providerOperations = 0
  const category = input.category && isBuiltInCategory(input.category) ? input.category : undefined
  if (category && !account.archived && (account.provider === 'gmail' || account.provider === 'microsoft')) {
    const messages = database.remoteMessagesForThreads(input.accountId, threadIds)
    const queue = (action: 'label' | 'unlabel', labelId: string, targets: string[]) => {
      if (!targets.length) return
      database.applyLocalAction({ accountId: input.accountId, threadIds: targets, action, labelId }, crypto.randomUUID(), 0)
      providerOperations += 1
    }
    const threadsWhere = (predicate: (labels: string[]) => boolean) => [...new Set(messages.filter((message) => predicate(message.labelIds)).map((message) => message.threadId))]
    if (account.provider === 'gmail') {
      const change = gmailCategoryLabelChange(category)
      queue('label', change.add, threadsWhere((labels) => !labels.includes(change.add)))
      for (const label of change.remove) queue('unlabel', label, threadsWhere((labels) => labels.includes(label)))
    } else {
      const add = microsoftInferenceFor(category) === 'focused' ? MICROSOFT_FOCUSED_LABEL : MICROSOFT_OTHER_LABEL
      const remove = add === MICROSOFT_FOCUSED_LABEL ? MICROSOFT_OTHER_LABEL : MICROSOFT_FOCUSED_LABEL
      queue('label', add, threadsWhere((labels) => labels.includes('INBOX') && !labels.includes(add)))
      queue('unlabel', remove, threadsWhere((labels) => labels.includes(remove)))
    }
  }
  return { updated, ...(rule ? { rule } : {}), providerOperations }
}
