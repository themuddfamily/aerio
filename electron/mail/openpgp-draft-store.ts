import type { DatabaseSync } from 'node:sqlite'
import type { MailOpenPgpOptions } from '../../src/openpgp-types'

const FINGERPRINT = /^[0-9A-F]{40}$|^[0-9A-F]{64}$/

/** Validates and normalizes a draft's OpenPGP choices; undefined means plain mail. */
export function normalizeOpenPgpOptions(value: unknown): MailOpenPgpOptions | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object') throw new Error('The OpenPGP options are invalid')
  const input = value as MailOpenPgpOptions
  const sign = input.sign === true
  const encrypt = input.encrypt === true
  if (!sign && !encrypt) return undefined
  const recipientKeys: Record<string, string> = {}
  if (input.recipientKeys !== undefined) {
    if (!input.recipientKeys || typeof input.recipientKeys !== 'object' || Object.keys(input.recipientKeys).length > 500) throw new Error('The OpenPGP recipient keys are invalid')
    for (const [address, fingerprint] of Object.entries(input.recipientKeys)) {
      if (address.length > 320 || typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint.toUpperCase())) throw new Error('The OpenPGP recipient keys are invalid')
      recipientKeys[address.trim().toLowerCase()] = fingerprint.toUpperCase()
    }
  }
  return { ...(sign ? { sign } : {}), ...(encrypt ? { encrypt } : {}), ...(Object.keys(recipientKeys).length ? { recipientKeys } : {}) }
}

/**
 * The per-draft Sign/Encrypt choice. It lives beside the draft so queued,
 * undo-window and scheduled deliveries honor it, and is removed with the
 * draft through its foreign key.
 */
export class MailDraftOpenPgpStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mail_draft_openpgp (
        draft_id TEXT PRIMARY KEY REFERENCES gmail_drafts(id) ON DELETE CASCADE,
        options_json TEXT NOT NULL
      )
    `)
  }

  save(draftId: string, options: MailOpenPgpOptions | undefined) {
    const normalized = normalizeOpenPgpOptions(options)
    if (!normalized) {
      this.db.prepare('DELETE FROM mail_draft_openpgp WHERE draft_id=?').run(draftId)
      return
    }
    this.db.prepare('INSERT INTO mail_draft_openpgp(draft_id,options_json) VALUES(?,?) ON CONFLICT(draft_id) DO UPDATE SET options_json=excluded.options_json')
      .run(draftId, JSON.stringify(normalized))
  }

  get(draftId: string): { openPgp?: MailOpenPgpOptions } {
    const row = this.db.prepare('SELECT options_json FROM mail_draft_openpgp WHERE draft_id=?').get(draftId) as { options_json?: string } | undefined
    if (!row?.options_json) return {}
    try {
      const openPgp = normalizeOpenPgpOptions(JSON.parse(row.options_json))
      return openPgp ? { openPgp } : {}
    } catch {
      // A corrupt choice must never silently downgrade to plain mail.
      return { openPgp: { sign: true, encrypt: true } }
    }
  }
}
