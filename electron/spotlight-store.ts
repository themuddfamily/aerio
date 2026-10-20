import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { SpotlightSettings } from '../src/spotlight-types'
export const DEFAULT_SPOTLIGHT: SpotlightSettings = { enabled: false, accountIds: [], includePreview: false }
export const spotlightDomain = (profile: string) => `com.aerio.spotlight.${createHash('sha256').update(profile).digest('hex').slice(0, 24)}`
export function spotlightSettings(value: unknown): SpotlightSettings {
  if (!value || typeof value !== 'object') throw new Error('Choose valid Spotlight settings')
  const input = value as SpotlightSettings
  if (typeof input.enabled !== 'boolean' || typeof input.includePreview !== 'boolean' || !Array.isArray(input.accountIds) || input.accountIds.length > 500 || input.accountIds.some((id) => typeof id !== 'string' || !id || id.length > 200)) throw new Error('Choose valid Spotlight settings')
  return { enabled: input.enabled, accountIds: [...new Set(input.accountIds)], includePreview: input.includePreview }
}
export class SpotlightStore {
  private readonly db: DatabaseSync
  readonly domain: string
  constructor(path: string, profile: string) {
    this.domain = spotlightDomain(profile)
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
    this.db.exec('CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS links(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,thread_id TEXT NOT NULL,generation TEXT NOT NULL,UNIQUE(account_id,thread_id)); CREATE TABLE IF NOT EXISTS native_state(id INTEGER PRIMARY KEY,cleanup_pending INTEGER NOT NULL); INSERT OR IGNORE INTO native_state SELECT 1, CASE WHEN EXISTS(SELECT 1 FROM links) THEN 1 ELSE 0 END;')
  }
  settings() { const row = this.db.prepare('SELECT payload FROM settings WHERE id=1').get() as { payload: string } | undefined; try { return row ? spotlightSettings(JSON.parse(row.payload)) : structuredClone(DEFAULT_SPOTLIGHT) } catch { return structuredClone(DEFAULT_SPOTLIGHT) } }
  save(value: unknown) { const settings = spotlightSettings(value); this.db.prepare('INSERT INTO settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(settings)); return settings }
  link(accountId: string, threadId: string, generation: string) {
    const existing = this.db.prepare('SELECT id FROM links WHERE account_id=? AND thread_id=?').get(accountId, threadId) as { id: string } | undefined
    const id = existing?.id ?? randomUUID()
    this.db.prepare('INSERT INTO links VALUES(?,?,?,?) ON CONFLICT(account_id,thread_id) DO UPDATE SET generation=excluded.generation').run(id, accountId, threadId, generation)
    return id
  }
  resolve(id: string) { return this.db.prepare('SELECT account_id AS accountId,thread_id AS threadId FROM links WHERE id=?').get(id) as { accountId: string; threadId: string } | undefined }
  prune(generation: string) { this.db.prepare('DELETE FROM links WHERE generation<>?').run(generation) }
  clear() { this.db.exec('DELETE FROM links') }
  cleanupPending() { return Boolean((this.db.prepare('SELECT cleanup_pending AS pending FROM native_state WHERE id=1').get() as { pending: number }).pending) }
  markCleanupPending(value: boolean) { this.db.prepare('UPDATE native_state SET cleanup_pending=? WHERE id=1').run(value ? 1 : 0) }
  count() { return Number((this.db.prepare('SELECT COUNT(*) AS total FROM links').get() as { total: number }).total) }
  close() { this.db.close() }
}
