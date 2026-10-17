import type { DatabaseSync } from 'node:sqlite'
import type { MailDraftInput } from '../../src/mail-types'
import type { MailSmimeOptions } from '../../src/smime-types'

const FINGERPRINT = /^[0-9A-F]{64}$/
// Same wording as the OpenPGP refusals, so every protected-send error ends alike.
const NOT_SENT = 'The message was not sent; your draft is kept.'

/** Validates and normalizes a draft's S/MIME choices; undefined means no S/MIME. */
export function normalizeSmimeOptions(value: unknown): MailSmimeOptions | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object') throw new Error('The S/MIME options are invalid')
  const input = value as MailSmimeOptions
  const sign = input.sign === true
  const encrypt = input.encrypt === true
  if (!sign && !encrypt) return undefined
  const recipientCerts: Record<string, string> = {}
  if (input.recipientCerts !== undefined) {
    if (!input.recipientCerts || typeof input.recipientCerts !== 'object' || Object.keys(input.recipientCerts).length > 500) throw new Error('The S/MIME recipient certificates are invalid')
    for (const [address, fingerprint] of Object.entries(input.recipientCerts)) {
      if (address.length > 320 || typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint.toUpperCase())) throw new Error('The S/MIME recipient certificates are invalid')
      recipientCerts[address.trim().toLowerCase()] = fingerprint.toUpperCase()
    }
  }
  return { ...(sign ? { sign } : {}), ...(encrypt ? { encrypt } : {}), ...(Object.keys(recipientCerts).length ? { recipientCerts } : {}) }
}

/** A message is protected with S/MIME or OpenPGP, never both. */
export function assertSingleProtection(input: Pick<MailDraftInput, 'openPgp' | 'smime'>) {
  const pgp = Boolean(input.openPgp?.sign || input.openPgp?.encrypt)
  const smime = Boolean(input.smime?.sign || input.smime?.encrypt)
  if (pgp && smime) throw new Error(`Choose either OpenPGP or S/MIME for this message, not both. ${NOT_SENT}`)
}

/**
 * The per-draft S/MIME choice, beside the draft so queued, undo-window and
 * scheduled deliveries honor it. Removed with the draft through its foreign key.
 */
export class MailDraftSmimeStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mail_draft_smime (
        draft_id TEXT PRIMARY KEY REFERENCES gmail_drafts(id) ON DELETE CASCADE,
        options_json TEXT NOT NULL
      )
    `)
  }

  save(draftId: string, options: MailSmimeOptions | undefined) {
    const normalized = normalizeSmimeOptions(options)
    if (!normalized) {
      this.db.prepare('DELETE FROM mail_draft_smime WHERE draft_id=?').run(draftId)
      return
    }
    this.db.prepare('INSERT INTO mail_draft_smime(draft_id,options_json) VALUES(?,?) ON CONFLICT(draft_id) DO UPDATE SET options_json=excluded.options_json')
      .run(draftId, JSON.stringify(normalized))
  }

  get(draftId: string): { smime?: MailSmimeOptions } {
    const row = this.db.prepare('SELECT options_json FROM mail_draft_smime WHERE draft_id=?').get(draftId) as { options_json?: string } | undefined
    if (!row?.options_json) return {}
    try {
      const smime = normalizeSmimeOptions(JSON.parse(row.options_json))
      return smime ? { smime } : {}
    } catch {
      // A corrupt choice must never silently downgrade to plain mail.
      return { smime: { sign: true, encrypt: true } }
    }
  }
}
