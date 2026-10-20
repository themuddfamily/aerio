import type { DatabaseSync } from 'node:sqlite'
import type { MailAccountSummary, MailDraftInput } from '../../src/mail-types'
import {
  primaryIdentityId,
  type MailSenderIdentity,
  type MailSenderIdentityInput,
  type MailSenderIdentitySource,
  type MailSenderIdentityStatus,
  type MailSignature,
  type MailSignatureInput
} from '../../src/mail-identity-types'
import { isCompleteMailAddress } from '../../src/lib/mail-address'
import { sanitizeTemplateHtml, templateTextFromHtml } from './template-store'

export const MAX_MAIL_SIGNATURES = 500
export const MAX_IDENTITIES_PER_ACCOUNT = 200
export const MAIL_SIGNATURE_HTML_MAX = 1_000_000
const MAX_REPLY_TO = 10

/** A provider-reported address that the account is allowed to send as. */
export interface DiscoveredSenderIdentity {
  email: string
  name?: string
  replyTo?: string[]
  status: MailSenderIdentityStatus
  /** Provider-side signature HTML (Gmail), imported as a managed signature. */
  signatureHtml?: string
}

type Row = Record<string, string | number | bigint | null>

const nowIso = () => new Date().toISOString()
const lower = (value: string) => value.trim().toLowerCase()
const parseList = (value: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(value ?? '[]'))
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/** Validates and trims a Reply-To list; every entry must be a complete address. */
export function normalizeReplyTo(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > MAX_REPLY_TO) throw new Error(`Use at most ${MAX_REPLY_TO} Reply-To addresses`)
  const addresses = value.map((item) => typeof item === 'string' ? item.replaceAll(/[\r\n]+/g, ' ').trim() : '').filter(Boolean)
  if (addresses.some((item) => !isCompleteMailAddress(item))) throw new Error('Enter complete Reply-To email addresses')
  return addresses
}

/**
 * Sender identities, signatures, and the per-draft sender choice. Lives in the
 * mail database so identities and draft choices are removed with their
 * account or draft via foreign keys.
 */
export class MailIdentityStore {
  constructor(private readonly db: DatabaseSync) {
    this.migrate()
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mail_sender_identities (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        reply_to_json TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        new_signature_id TEXT,
        reply_signature_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS mail_sender_identities_address ON mail_sender_identities(account_id, email COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS mail_signatures (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        html TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mail_draft_senders (
        draft_id TEXT PRIMARY KEY REFERENCES gmail_drafts(id) ON DELETE CASCADE,
        identity_id TEXT,
        reply_to_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS mail_identity_refresh (
        account_id TEXT PRIMARY KEY REFERENCES gmail_accounts(id) ON DELETE CASCADE,
        refreshed_at TEXT NOT NULL
      );
    `)
    // Send as / send on behalf of a shared or delegated mailbox (E40); existing rows are plain aliases.
    const columns = new Set((this.db.prepare('PRAGMA table_info(mail_sender_identities)').all() as { name: string }[]).map((column) => column.name))
    if (!columns.has('delegation')) this.db.exec('ALTER TABLE mail_sender_identities ADD COLUMN delegation TEXT')
  }

  private identity(row: Row): MailSenderIdentity {
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      email: String(row.email),
      name: String(row.name),
      replyTo: parseList(row.reply_to_json),
      source: String(row.source) as MailSenderIdentitySource,
      status: String(row.status) as MailSenderIdentityStatus,
      isDefault: Boolean(row.is_default),
      ...(row.new_signature_id ? { newSignatureId: String(row.new_signature_id) } : {}),
      ...(row.reply_signature_id ? { replySignatureId: String(row.reply_signature_id) } : {}),
      ...(row.delegation === 'send-as' || row.delegation === 'send-on-behalf' ? { delegation: row.delegation } : {}),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }
  }

  /** Keeps the primary identity in step with the account address and display name. */
  private ensurePrimary(account: MailAccountSummary) {
    const id = primaryIdentityId(account.id)
    const existing = this.db.prepare('SELECT email,name FROM mail_sender_identities WHERE id=?').get(id) as Row | undefined
    const timestamp = nowIso()
    if (!existing) {
      // A manual alias that later became the account address is folded into the primary row.
      this.db.prepare(`DELETE FROM mail_sender_identities WHERE account_id=? AND email=? COLLATE NOCASE`).run(account.id, account.email)
      const hasDefault = this.db.prepare('SELECT 1 FROM mail_sender_identities WHERE account_id=? AND is_default=1').get(account.id)
      this.db.prepare(`INSERT INTO mail_sender_identities(id,account_id,email,name,reply_to_json,source,status,is_default,created_at,updated_at) VALUES(?,?,?,?,'[]','primary','verified',?,?,?)`)
        .run(id, account.id, account.email, account.displayName, hasDefault ? 0 : 1, timestamp, timestamp)
    } else if (existing.email !== account.email || existing.name !== account.displayName) {
      this.db.prepare(`DELETE FROM mail_sender_identities WHERE account_id=? AND id<>? AND email=? COLLATE NOCASE`).run(account.id, id, account.email)
      this.db.prepare('UPDATE mail_sender_identities SET email=?,name=?,updated_at=? WHERE id=?').run(account.email, account.displayName, timestamp, id)
    }
    if (!this.db.prepare('SELECT 1 FROM mail_sender_identities WHERE account_id=? AND is_default=1').get(account.id)) {
      this.db.prepare('UPDATE mail_sender_identities SET is_default=1 WHERE id=?').run(id)
    }
  }

  list(accounts: MailAccountSummary[], accountIds?: string[]): MailSenderIdentity[] {
    const selected = accountIds?.length ? accounts.filter((account) => accountIds.includes(account.id)) : accounts
    for (const account of selected) this.ensurePrimary(account)
    if (!selected.length) return []
    const rows = this.db.prepare(`
      SELECT * FROM mail_sender_identities WHERE account_id IN (${selected.map(() => '?').join(',')})
      ORDER BY account_id, CASE source WHEN 'primary' THEN 0 ELSE 1 END, email COLLATE NOCASE
    `).all(...selected.map((account) => account.id)) as Row[]
    return rows.map((row) => this.identity(row))
  }

  get(id: string): MailSenderIdentity | undefined {
    const row = this.db.prepare('SELECT * FROM mail_sender_identities WHERE id=?').get(id) as Row | undefined
    return row ? this.identity(row) : undefined
  }

  save(account: MailAccountSummary, input: MailSenderIdentityInput): MailSenderIdentity {
    if (!input || typeof input !== 'object' || input.accountId !== account.id) throw new Error('Choose a valid mail account')
    if (input.id !== undefined && (typeof input.id !== 'string' || !input.id || input.id.length > 300)) throw new Error('The sender identity is invalid')
    if (typeof input.name !== 'string' || input.name.length > 200) throw new Error('Use a sender name of at most 200 characters')
    if (typeof input.email !== 'string' || !isCompleteMailAddress(input.email) || /[<>]/.test(input.email)) throw new Error('Enter a complete sender email address')
    this.ensurePrimary(account)
    const existing = input.id ? this.get(input.id) : undefined
    if (input.id && (!existing || existing.accountId !== account.id)) throw new Error('That sender identity no longer exists')
    const email = existing && existing.source !== 'manual' ? existing.email : input.email.trim()
    const duplicate = this.db.prepare('SELECT id FROM mail_sender_identities WHERE account_id=? AND email=? COLLATE NOCASE AND id<>?').get(account.id, email, existing?.id ?? '') as Row | undefined
    if (duplicate) throw new Error(`${email} is already a sender address for this account`)
    if (!existing && Number((this.db.prepare('SELECT COUNT(*) count FROM mail_sender_identities WHERE account_id=?').get(account.id) as Row).count) >= MAX_IDENTITIES_PER_ACCOUNT) {
      throw new Error(`An account can have at most ${MAX_IDENTITIES_PER_ACCOUNT} sender addresses`)
    }
    const signatureId = (value: unknown, current?: string) => {
      if (value === undefined) return current
      if (value === '') return undefined
      if (typeof value !== 'string' || !this.getSignature(value)) throw new Error('That signature no longer exists')
      return value
    }
    const newSignatureId = signatureId(input.newSignatureId, existing?.newSignatureId)
    const replySignatureId = signatureId(input.replySignatureId, existing?.replySignatureId)
    const replyTo = input.replyTo === undefined ? existing?.replyTo ?? [] : normalizeReplyTo(input.replyTo)
    if (input.delegation !== undefined && input.delegation !== null && input.delegation !== 'send-as' && input.delegation !== 'send-on-behalf') throw new Error('Choose send as or send on behalf')
    if (input.delegation && ((existing && existing.source !== 'manual') || (account.provider !== 'exchange' && account.provider !== 'microsoft'))) {
      throw new Error('Send as and send on behalf are available for added addresses of Exchange and Microsoft 365 accounts')
    }
    const delegation = input.delegation === undefined ? existing?.delegation : input.delegation ?? undefined
    const timestamp = nowIso()
    const id = existing?.id ?? crypto.randomUUID()
    // The primary display name is the account's sender name, edited in account settings.
    const name = existing?.source === 'primary' ? existing.name : input.name.replaceAll(/[\r\n]+/g, ' ').trim()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (input.isDefault) this.db.prepare('UPDATE mail_sender_identities SET is_default=0 WHERE account_id=?').run(account.id)
      this.db.prepare(`
        INSERT INTO mail_sender_identities(id,account_id,email,name,reply_to_json,source,status,is_default,new_signature_id,reply_signature_id,delegation,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name,reply_to_json=excluded.reply_to_json,is_default=excluded.is_default,
          new_signature_id=excluded.new_signature_id,reply_signature_id=excluded.reply_signature_id,delegation=excluded.delegation,updated_at=excluded.updated_at
      `).run(id, account.id, email, name, JSON.stringify(replyTo), existing?.source ?? 'manual', existing?.status ?? 'unverified',
        input.isDefault ? 1 : existing?.isDefault && input.isDefault !== false ? 1 : 0, newSignatureId ?? null, replySignatureId ?? null, delegation ?? null, existing?.createdAt ?? timestamp, timestamp)
      if (!this.db.prepare('SELECT 1 FROM mail_sender_identities WHERE account_id=? AND is_default=1').get(account.id)) {
        this.db.prepare('UPDATE mail_sender_identities SET is_default=1 WHERE id=?').run(primaryIdentityId(account.id))
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.get(id)!
  }

  delete(id: string) {
    const existing = this.get(id)
    if (!existing) return
    if (existing.source !== 'manual') throw new Error('Provider sender addresses are managed by the provider; refresh them instead')
    this.db.prepare('DELETE FROM mail_sender_identities WHERE id=?').run(id)
    if (existing.isDefault) this.db.prepare('UPDATE mail_sender_identities SET is_default=1 WHERE id=?').run(primaryIdentityId(existing.accountId))
  }

  /**
   * Replaces the provider-sourced identities for an account. Local choices
   * (default, Reply-To overrides, signature assignments) survive a refresh.
   */
  replaceProviderIdentities(account: MailAccountSummary, source: Extract<MailSenderIdentitySource, 'gmail' | 'microsoft'>, discovered: DiscoveredSenderIdentity[]) {
    this.ensurePrimary(account)
    const timestamp = nowIso()
    const seen = new Set<string>()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const item of discovered.slice(0, MAX_IDENTITIES_PER_ACCOUNT)) {
        if (!isCompleteMailAddress(item.email) || /[<>]/.test(item.email)) continue
        const key = lower(item.email)
        if (seen.has(key)) continue
        seen.add(key)
        let replyTo: string[] = []
        try { replyTo = normalizeReplyTo(item.replyTo ?? []) } catch { replyTo = [] }
        const current = this.db.prepare('SELECT * FROM mail_sender_identities WHERE account_id=? AND email=? COLLATE NOCASE').get(account.id, item.email) as Row | undefined
        let id: string
        if (current?.source === 'primary') {
          id = String(current.id)
          if (replyTo.length && parseList(current.reply_to_json).length === 0) this.db.prepare('UPDATE mail_sender_identities SET reply_to_json=?,updated_at=? WHERE id=?').run(JSON.stringify(replyTo), timestamp, id)
        } else if (current) {
          id = String(current.id)
          // A manual alias the provider now reports becomes provider-managed.
          this.db.prepare('UPDATE mail_sender_identities SET source=?,status=?,name=CASE WHEN ?<>\'\' THEN ? ELSE name END,reply_to_json=CASE WHEN reply_to_json=\'[]\' THEN ? ELSE reply_to_json END,updated_at=? WHERE id=?')
            .run(source, item.status, item.name?.trim() ?? '', item.name?.trim() ?? '', JSON.stringify(replyTo), timestamp, id)
        } else {
          id = crypto.randomUUID()
          this.db.prepare(`INSERT INTO mail_sender_identities(id,account_id,email,name,reply_to_json,source,status,is_default,created_at,updated_at) VALUES(?,?,?,?,?,?,?,0,?,?)`)
            .run(id, account.id, item.email.trim(), item.name?.trim() || account.displayName, JSON.stringify(replyTo), source, item.status, timestamp, timestamp)
        }
        if (item.signatureHtml?.trim()) this.importProviderSignature(id, `${source}:${account.id}:${key}`, `${item.email.trim()} (${source === 'gmail' ? 'Gmail' : 'Microsoft'})`, item.signatureHtml)
      }
      const stale = (this.db.prepare('SELECT id,email,is_default FROM mail_sender_identities WHERE account_id=? AND source=?').all(account.id, source) as Row[])
        .filter((row) => !seen.has(lower(String(row.email))))
      for (const row of stale) this.db.prepare('DELETE FROM mail_sender_identities WHERE id=?').run(String(row.id))
      if (!this.db.prepare('SELECT 1 FROM mail_sender_identities WHERE account_id=? AND is_default=1').get(account.id)) {
        this.db.prepare('UPDATE mail_sender_identities SET is_default=1 WHERE id=?').run(primaryIdentityId(account.id))
      }
      this.db.prepare('INSERT INTO mail_identity_refresh(account_id,refreshed_at) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET refreshed_at=excluded.refreshed_at').run(account.id, timestamp)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.list([account])
  }

  /** Records a refresh for providers without discoverable aliases so it is not retried on every list. */
  markRefreshed(accountId: string) {
    this.db.prepare('INSERT INTO mail_identity_refresh(account_id,refreshed_at) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET refreshed_at=excluded.refreshed_at').run(accountId, nowIso())
  }

  refreshedAt(accountId: string) {
    const row = this.db.prepare('SELECT refreshed_at FROM mail_identity_refresh WHERE account_id=?').get(accountId) as Row | undefined
    return row ? String(row.refreshed_at) : undefined
  }

  private importProviderSignature(identityId: string, signatureId: string, name: string, html: string) {
    const safe = sanitizeTemplateHtml(html.slice(0, MAIL_SIGNATURE_HTML_MAX))
    const timestamp = nowIso()
    this.db.prepare(`INSERT INTO mail_signatures(id,name,html,text,created_at,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET html=excluded.html,text=excluded.text,updated_at=excluded.updated_at`).run(signatureId, name, safe, templateTextFromHtml(safe), timestamp, timestamp)
    this.db.prepare('UPDATE mail_sender_identities SET new_signature_id=COALESCE(new_signature_id,?),reply_signature_id=COALESCE(reply_signature_id,?) WHERE id=?').run(signatureId, signatureId, identityId)
  }

  private signature(row: Row): MailSignature {
    return { id: String(row.id), name: String(row.name), html: String(row.html), text: String(row.text), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
  }

  listSignatures(): MailSignature[] {
    return (this.db.prepare('SELECT * FROM mail_signatures ORDER BY name COLLATE NOCASE, id').all() as Row[]).map((row) => this.signature(row))
  }

  getSignature(id: string): MailSignature | undefined {
    const row = this.db.prepare('SELECT * FROM mail_signatures WHERE id=?').get(id) as Row | undefined
    return row ? this.signature(row) : undefined
  }

  saveSignature(input: MailSignatureInput): MailSignature {
    if (!input || typeof input !== 'object') throw new Error('The signature is invalid')
    if (input.id !== undefined && (typeof input.id !== 'string' || !input.id || input.id.length > 300)) throw new Error('The signature is invalid')
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200) throw new Error('Give the signature a name of at most 200 characters')
    if (typeof input.html !== 'string' || input.html.length > MAIL_SIGNATURE_HTML_MAX) throw new Error('The signature is too large')
    const existing = input.id ? this.getSignature(input.id) : undefined
    if (!existing && this.listSignatures().length >= MAX_MAIL_SIGNATURES) throw new Error(`Aerio stores at most ${MAX_MAIL_SIGNATURES} signatures`)
    const name = input.name.trim()
    if (this.db.prepare('SELECT 1 FROM mail_signatures WHERE name=? COLLATE NOCASE AND id<>?').get(name, existing?.id ?? input.id ?? '')) throw new Error(`A signature named “${name}” already exists`)
    const html = sanitizeTemplateHtml(input.html)
    const timestamp = nowIso()
    const signature: MailSignature = { id: existing?.id ?? input.id ?? crypto.randomUUID(), name, html, text: templateTextFromHtml(html), createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp }
    this.db.prepare(`INSERT INTO mail_signatures(id,name,html,text,created_at,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,html=excluded.html,text=excluded.text,updated_at=excluded.updated_at`)
      .run(signature.id, signature.name, signature.html, signature.text, signature.createdAt, signature.updatedAt)
    return signature
  }

  /** Called inside the mail database transaction after validating a portable settings snapshot. */
  applySynchronizedSignatures(data: import('../../src/settings-sync-types').PortableSignatures, accounts: MailAccountSummary[]) {
    this.db.prepare('UPDATE mail_sender_identities SET new_signature_id=NULL,reply_signature_id=NULL').run()
    this.db.prepare('DELETE FROM mail_signatures').run()
    const timestamp = nowIso()
    for (const signature of data.definitions) {
      const html = sanitizeTemplateHtml(signature.html)
      this.db.prepare('INSERT INTO mail_signatures(id,name,html,text,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run(signature.id, signature.name, html, templateTextFromHtml(html), timestamp, timestamp)
    }
    for (const mapped of data.assignments) for (const account of accounts.filter((account) => account.provider === mapped.provider && account.email.toLowerCase() === mapped.accountEmail)) {
      this.ensurePrimary(account)
      this.db.prepare('UPDATE mail_sender_identities SET new_signature_id=?,reply_signature_id=?,updated_at=? WHERE account_id=? AND email=? COLLATE NOCASE')
        .run(mapped.newSignatureId ?? null, mapped.replySignatureId ?? null, timestamp, account.id, mapped.identityEmail)
    }
  }

  deleteSignature(id: string) {
    this.db.prepare('UPDATE mail_sender_identities SET new_signature_id=NULL WHERE new_signature_id=?').run(id)
    this.db.prepare('UPDATE mail_sender_identities SET reply_signature_id=NULL WHERE reply_signature_id=?').run(id)
    this.db.prepare('DELETE FROM mail_signatures WHERE id=?').run(id)
  }

  /** Persists the draft's chosen identity and Reply-To next to the draft row. */
  saveDraftSender(draftId: string, input: Pick<MailDraftInput, 'fromIdentityId' | 'replyTo'>) {
    const replyTo = (input.replyTo ?? []).filter((item) => typeof item === 'string')
    if (!input.fromIdentityId && !replyTo.length) {
      this.db.prepare('DELETE FROM mail_draft_senders WHERE draft_id=?').run(draftId)
      return
    }
    this.db.prepare(`INSERT INTO mail_draft_senders(draft_id,identity_id,reply_to_json) VALUES(?,?,?)
      ON CONFLICT(draft_id) DO UPDATE SET identity_id=excluded.identity_id,reply_to_json=excluded.reply_to_json`).run(draftId, input.fromIdentityId ?? null, JSON.stringify(replyTo))
  }

  draftSender(draftId: string): Pick<MailDraftInput, 'fromIdentityId' | 'replyTo'> {
    const row = this.db.prepare('SELECT * FROM mail_draft_senders WHERE draft_id=?').get(draftId) as Row | undefined
    if (!row) return {}
    const replyTo = parseList(row.reply_to_json)
    return { ...(row.identity_id ? { fromIdentityId: String(row.identity_id) } : {}), ...(replyTo.length ? { replyTo } : {}) }
  }
}
