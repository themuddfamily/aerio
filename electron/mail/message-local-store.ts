import { DatabaseSync } from 'node:sqlite'
import type { MailMessageLocalData, MailMessageRef } from '../../src/mail-types'

export const defaultMessageLocalData = (): MailMessageLocalData => ({ categories: [], format: 'auto', fontSize: 14, noteIds: [], taskIds: [] })

export class MessageLocalStore {
  private readonly db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('CREATE TABLE IF NOT EXISTS message_local (account_id TEXT NOT NULL, message_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(account_id,message_id))')
  }
  get(ref: Pick<MailMessageRef, 'accountId' | 'messageId'>): MailMessageLocalData {
    const row = this.db.prepare('SELECT data FROM message_local WHERE account_id=? AND message_id=?').get(ref.accountId, ref.messageId) as { data: string } | undefined
    return row ? { ...defaultMessageLocalData(), ...JSON.parse(row.data) } : defaultMessageLocalData()
  }
  update(ref: MailMessageRef, updates: Partial<MailMessageLocalData>) {
    const current = this.get(ref)
    if (updates.categories !== undefined) {
      if (!Array.isArray(updates.categories) || updates.categories.length > 50 || updates.categories.some((item) => typeof item !== 'string' || item.length > 100)) throw new Error('Use up to 50 categories of at most 100 characters')
      current.categories = [...new Set(updates.categories.map((item) => item.trim()).filter(Boolean))]
    }
    if (updates.format !== undefined) {
      if (!['auto', 'plain', 'html'].includes(updates.format)) throw new Error('Unknown message format')
      current.format = updates.format
    }
    if (updates.fontSize !== undefined) {
      if (!Number.isInteger(updates.fontSize) || updates.fontSize < 10 || updates.fontSize > 28) throw new Error('Choose a font size between 10 and 28')
      current.fontSize = updates.fontSize
    }
    if (updates.noteIds) current.noteIds = [...new Set([...current.noteIds, ...updates.noteIds])]
    if (updates.taskIds) current.taskIds = [...new Set([...current.taskIds, ...updates.taskIds])]
    this.db.prepare('INSERT INTO message_local(account_id,message_id,data) VALUES(?,?,?) ON CONFLICT(account_id,message_id) DO UPDATE SET data=excluded.data').run(ref.accountId, ref.messageId, JSON.stringify(current))
    return current
  }
  close() { this.db.close() }
}
