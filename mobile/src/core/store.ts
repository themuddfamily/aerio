import type { Account, Draft, MailAction, Message, PendingAction } from './types';
export type SqlValue = string | number | null;
export interface SqlDatabase {
  execSync(sql: string): void;
  runSync(sql: string, ...values: SqlValue[]): unknown;
  getFirstSync<T>(sql: string, ...values: SqlValue[]): T | null;
  getAllSync<T>(sql: string, ...values: SqlValue[]): T[];
  closeSync(): void;
}
export class MailStore {
  private closed = false;
  constructor(private readonly db: SqlDatabase) {
    db.execSync(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(account_id TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,inbox INTEGER NOT NULL,received TEXT NOT NULL,PRIMARY KEY(account_id,id));
      CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,payload TEXT NOT NULL);`);
    // A crash/background cancellation after submission is never permission to replay a send.
    for (const draft of this.drafts()) if (draft.status === 'sending') this.saveDraft({ ...draft, status: 'uncertain', error: 'Aerio closed before delivery was confirmed. Check Sent mail before sending again.' });
    for (const action of this.actions()) if (action.state === 'running') this.saveAction({ ...action, state: 'review', error: 'This change was interrupted. Refresh mail and check its result.' });
  }
  assertOpen() { if (this.closed) throw new Error('Unlock Aerio to use your mail.'); }
  close() { if (!this.closed) { this.closed = true; this.db.closeSync(); } }
  private atomic(work: () => void) { this.assertOpen(); this.db.execSync('BEGIN IMMEDIATE'); try { work(); this.db.execSync('COMMIT'); } catch (error) { this.db.execSync('ROLLBACK'); throw error; } }
  private rows<T>(sql: string, ...values: SqlValue[]): T[] { this.assertOpen(); return this.db.getAllSync<{ payload: string }>(sql, ...values).map((row) => JSON.parse(row.payload)); }
  accounts() { return this.rows<Account>('SELECT payload FROM accounts ORDER BY id'); }
  account(id: string) { return this.accounts().find((item) => item.id === id); }
  saveAccount(account: Account) { this.assertOpen(); this.db.runSync('INSERT INTO accounts(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', account.id, JSON.stringify(account)); }
  removeAccount(id: string) { this.atomic(() => { for (const table of ['messages', 'drafts', 'actions']) this.db.runSync(`DELETE FROM ${table} WHERE account_id=?`, id); this.db.runSync('DELETE FROM accounts WHERE id=?', id); }); }
  messages(accountId?: string) { return this.rows<Message>(`SELECT payload FROM messages WHERE inbox=1${accountId ? ' AND account_id=?' : ''} ORDER BY received DESC`, ...(accountId ? [accountId] : [])); }
  message(accountId: string, id: string) { return this.rows<Message>('SELECT payload FROM messages WHERE account_id=? AND id=?', accountId, id)[0]; }
  private writeMessage(message: Message) { this.db.runSync('INSERT INTO messages(account_id,id,payload,inbox,received) VALUES(?,?,?,?,?) ON CONFLICT(account_id,id) DO UPDATE SET payload=excluded.payload,inbox=excluded.inbox,received=excluded.received', message.accountId, message.id, JSON.stringify(message), Number(message.inbox), message.receivedAt); }
  saveInbox(account: Account, messages: Message[], append: boolean) {
    this.atomic(() => {
      if (!append) for (const old of this.messages(account.id)) this.writeMessage({ ...old, inbox: false });
      for (const message of messages) { if (message.accountId !== account.id) throw new Error('Account mismatch in provider response.'); this.writeMessage(message); }
      this.saveAccount(account);
      this.db.runSync('DELETE FROM messages WHERE account_id=? AND id NOT IN (SELECT id FROM messages WHERE account_id=? ORDER BY received DESC LIMIT 200)', account.id, account.id);
    });
  }
  drafts(accountId?: string) { return this.rows<Draft>(`SELECT payload FROM drafts${accountId ? ' WHERE account_id=?' : ''} ORDER BY updated DESC`, ...(accountId ? [accountId] : [])); }
  draft(id: string) { return this.rows<Draft>('SELECT payload FROM drafts WHERE id=?', id)[0]; }
  saveDraft(draft: Draft) { this.assertOpen(); if (!this.account(draft.accountId)) throw new Error('Connect this account before writing a draft.'); this.db.runSync('INSERT INTO drafts(id,account_id,payload,status,updated) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,status=excluded.status,updated=excluded.updated', draft.id, draft.accountId, JSON.stringify(draft), draft.status, draft.updatedAt); }
  deleteDraft(id: string) { this.assertOpen(); if (this.draft(id)?.status === 'sending') throw new Error('Wait for this send to finish.'); this.db.runSync('DELETE FROM drafts WHERE id=?', id); }
  actions(accountId?: string) { return this.rows<PendingAction>(`SELECT payload FROM actions${accountId ? ' WHERE account_id=?' : ''} ORDER BY rowid`, ...(accountId ? [accountId] : [])); }
  saveAction(action: PendingAction) { this.assertOpen(); this.db.runSync('INSERT INTO actions(id,account_id,payload,state) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,state=excluded.state', action.id, action.accountId, JSON.stringify(action), action.state); }
  completeAction(operation: PendingAction) {
    this.atomic(() => {
      const message = this.message(operation.accountId, operation.messageId);
      if (message) { const action: MailAction = operation.action; this.writeMessage({ ...message, ...(action.kind === 'read' ? { read: action.value } : action.kind === 'star' ? { starred: action.value } : { inbox: false }) }); }
      this.saveAction({ ...operation, state: 'applied', error: undefined });
    });
  }
  setting<T>(key: string): T | undefined { return this.rows<T>('SELECT payload FROM settings WHERE key=?', key)[0]; }
  setSetting(key: string, value: unknown) { this.assertOpen(); this.db.runSync('INSERT INTO settings(key,payload) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload', key, JSON.stringify(value)); }
}
