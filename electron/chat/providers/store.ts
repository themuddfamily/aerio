import { DatabaseSync } from 'node:sqlite'
import type { ProviderChatAccount, ProviderChatMessage, ProviderChatPage, ProviderChatRoom } from '../../../src/provider-chat-types'
import type { ChatCacheCipher } from '../cache-crypto'

export class ProviderChatStore {
  private readonly db: DatabaseSync
  constructor(path: string, private readonly cipher: (accountId: string) => ChatCacheCipher) {
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS provider_chat_accounts(id TEXT PRIMARY KEY,provider TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_chat_rooms(account_id TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(account_id,id));
      CREATE TABLE IF NOT EXISTS provider_chat_pages(account_id TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(account_id,id));
      CREATE TABLE IF NOT EXISTS provider_chat_sends(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,room_id TEXT NOT NULL,thread_id TEXT,payload TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);
      UPDATE provider_chat_sends SET state='review' WHERE state='sending';`)
    const cutoff = Date.now() - 30 * 86_400_000
    this.db.prepare('DELETE FROM provider_chat_pages WHERE updated_at<?').run(cutoff)
    this.db.prepare('DELETE FROM provider_chat_sends WHERE created_at<?').run(cutoff)
  }
  private seal(accountId: string, table: string, record: string, value: unknown) { return this.cipher(accountId).sealJson(value, { table, record }) }
  private unseal<T>(accountId: string, table: string, record: string, value: string) { return this.cipher(accountId).openJson<T>(value, { table, record }) }
  accounts() {
    return (this.db.prepare('SELECT id,payload FROM provider_chat_accounts').all() as { id: string; payload: string }[]).map((row) => this.unseal<ProviderChatAccount>(row.id, 'provider-accounts', row.id, row.payload))
  }
  account(id: string) { return this.accounts().find((account) => account.id === id) }
  saveAccount(account: ProviderChatAccount) { this.db.prepare('INSERT INTO provider_chat_accounts(id,provider,payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(account.id, account.provider, this.seal(account.id, 'provider-accounts', account.id, account)) }
  rooms(accountId?: string) {
    const rows = (accountId ? this.db.prepare('SELECT account_id,id,payload FROM provider_chat_rooms WHERE account_id=?').all(accountId) : this.db.prepare('SELECT account_id,id,payload FROM provider_chat_rooms').all()) as { account_id: string; id: string; payload: string }[]
    return rows.map((row) => this.unseal<ProviderChatRoom>(row.account_id, 'provider-rooms', row.id, row.payload))
  }
  saveRooms(accountId: string, rooms: ProviderChatRoom[]) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM provider_chat_rooms WHERE account_id=?').run(accountId)
      const insert = this.db.prepare('INSERT INTO provider_chat_rooms(account_id,id,payload) VALUES(?,?,?)')
      for (const room of rooms) insert.run(accountId, room.id, this.seal(accountId, 'provider-rooms', room.id, { ...room, accountId }))
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private pageId(roomId: string, threadId?: string) { return JSON.stringify([roomId, threadId ?? '']) }
  page(accountId: string, roomId: string, threadId?: string): ProviderChatPage | undefined {
    const id = this.pageId(roomId, threadId)
    const row = this.db.prepare('SELECT payload FROM provider_chat_pages WHERE account_id=? AND id=?').get(accountId, id) as { payload: string } | undefined
    return row ? this.unseal(accountId, 'provider-pages', id, row.payload) : undefined
  }
  savePage(accountId: string, roomId: string, page: ProviderChatPage, threadId?: string) {
    const id = this.pageId(roomId, threadId)
    this.db.prepare('INSERT INTO provider_chat_pages(account_id,id,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(account_id,id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').run(accountId, id, this.seal(accountId, 'provider-pages', id, page), Date.now())
  }
  saveSend(accountId: string, roomId: string, message: ProviderChatMessage, threadId?: string) {
    this.db.prepare('INSERT INTO provider_chat_sends(id,account_id,room_id,thread_id,payload,state,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,state=excluded.state').run(message.id, accountId, roomId, threadId ?? null, this.seal(accountId, 'provider-sends', message.id, message), message.delivery ?? 'sending', Date.parse(message.timestamp))
  }
  pending(accountId: string, roomId: string, threadId?: string) {
    const rows = this.db.prepare("SELECT id,payload,state FROM provider_chat_sends WHERE account_id=? AND room_id=? AND COALESCE(thread_id,'')=? AND state<>'sent'").all(accountId, roomId, threadId ?? '') as { id: string; payload: string; state: ProviderChatMessage['delivery'] }[]
    return rows.map((row) => ({ ...this.unseal<ProviderChatMessage>(accountId, 'provider-sends', row.id, row.payload), delivery: row.state, ...(row.state === 'review' ? { error: 'Delivery is uncertain. Check the provider before sending again.' } : {}) }))
  }
  remove(accountId: string) { for (const table of ['provider_chat_rooms', 'provider_chat_pages', 'provider_chat_sends']) this.db.prepare(`DELETE FROM ${table} WHERE account_id=?`).run(accountId); this.db.prepare('DELETE FROM provider_chat_accounts WHERE id=?').run(accountId) }
  close() { this.db.close() }
}
