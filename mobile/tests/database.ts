import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { MailStore, type SqlDatabase } from '../src/core/store';
export function databaseFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-mobile-test-'));
  const connections: MailStore[] = [];
  const open = () => {
    const db = new DatabaseSync(join(directory, 'cache.db'));
    const adapter: SqlDatabase = { execSync: (sql) => db.exec(sql), runSync: (sql, ...values) => db.prepare(sql).run(...values), getAllSync: (sql, ...values) => db.prepare(sql).all(...values) as never, getFirstSync: (sql, ...values) => (db.prepare(sql).get(...values) ?? null) as never, closeSync: () => db.close() };
    const store = new MailStore(adapter); connections.push(store); return store;
  };
  return { open, close: () => { connections.forEach((store) => store.close()); if (!/^aerio-mobile-test-[^\\/]+$/.test(relative(tmpdir(), directory))) throw new Error('Unsafe test directory'); rmSync(directory, { recursive: true, force: true }); } };
}
