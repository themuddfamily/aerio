import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { McpSettings } from '../../src/mcp-types'

export const MCP_TOKEN_PREFIX = 'aerio_mcp_'
const SEND_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000

export const DEFAULT_MCP_SETTINGS: McpSettings = {
  enabled: false,
  capabilities: { write: false, send: false, delete: false },
  accountScope: 'all'
}

export const MCP_SCHEMA = `
  CREATE TABLE IF NOT EXISTS mcp_settings (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS mcp_clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT);
  CREATE TABLE IF NOT EXISTS mcp_sends (
    client_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, draft_id TEXT NOT NULL, status TEXT NOT NULL,
    result_json TEXT, created_at TEXT NOT NULL, PRIMARY KEY (client_id, idempotency_key)
  );
`

export interface McpClientRecord {
  id: string
  name: string
  createdAt: string
  lastUsedAt?: string
}

export type McpSendReservation =
  | { state: 'reserved' }
  | { state: 'completed'; draftId: string; result: unknown }
  | { state: 'in-progress'; draftId: string }

/** Normalizes untrusted settings from the renderer or a restored database. */
export function normalizeMcpSettings(value: unknown): McpSettings {
  if (!value || typeof value !== 'object') throw new Error('The automation settings are invalid')
  const input = value as Partial<McpSettings>
  const capabilities = (input.capabilities ?? {}) as Partial<McpSettings['capabilities']>
  if (typeof input.enabled !== 'boolean' || [capabilities.write, capabilities.send, capabilities.delete].some((flag) => typeof flag !== 'boolean')) {
    throw new Error('The automation settings are invalid')
  }
  let accountScope: McpSettings['accountScope'] = 'all'
  if (input.accountScope !== 'all') {
    if (!Array.isArray(input.accountScope) || input.accountScope.length > 500 ||
        input.accountScope.some((id) => typeof id !== 'string' || !id || id.length > 200)) throw new Error('Choose valid accounts for automation')
    accountScope = [...new Set(input.accountScope)]
  }
  return { enabled: input.enabled, capabilities: { write: capabilities.write!, send: capabilities.send!, delete: capabilities.delete! }, accountScope }
}

export function hashMcpToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * Settings, issued clients, and the send idempotency ledger for external
 * automation. Tokens are never stored: only their SHA-256 hash, so a token is
 * shown once when issued and a lost one is replaced by issuing a new client.
 */
export class McpAutomationStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;')
    this.db.exec(MCP_SCHEMA)
  }

  close() {
    this.db.close()
  }

  settings(): McpSettings {
    const row = this.db.prepare('SELECT payload FROM mcp_settings WHERE id=1').get() as { payload?: string } | undefined
    if (!row?.payload) return structuredClone(DEFAULT_MCP_SETTINGS)
    try { return normalizeMcpSettings(JSON.parse(row.payload)) } catch { return structuredClone(DEFAULT_MCP_SETTINGS) }
  }

  saveSettings(value: unknown) {
    const settings = normalizeMcpSettings(value)
    this.db.prepare(`INSERT INTO mcp_settings(id,payload,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at`)
      .run(JSON.stringify(settings), new Date().toISOString())
    return settings
  }

  listClients(): McpClientRecord[] {
    return (this.db.prepare('SELECT id,name,created_at,last_used_at FROM mcp_clients ORDER BY created_at, id').all() as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      createdAt: String(row.created_at),
      ...(row.last_used_at ? { lastUsedAt: String(row.last_used_at) } : {})
    }))
  }

  createClient(name: unknown): { client: McpClientRecord; token: string } {
    const label = typeof name === 'string' ? name.trim() : ''
    if (!label || label.length > 80) throw new Error('Name the client in 1 to 80 characters')
    if (this.listClients().length >= 50) throw new Error('Revoke an unused client before issuing another')
    const token = `${MCP_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
    const client = { id: `mcp-${randomUUID()}`, name: label, createdAt: new Date().toISOString() }
    this.db.prepare('INSERT INTO mcp_clients(id,name,token_hash,created_at) VALUES(?,?,?,?)').run(client.id, client.name, hashMcpToken(token), client.createdAt)
    return { client, token }
  }

  /** Returns the client a token belongs to, or undefined for unknown or revoked tokens. */
  authenticate(token: unknown): McpClientRecord | undefined {
    if (typeof token !== 'string' || !token.startsWith(MCP_TOKEN_PREFIX) || token.length > 200) return
    const hash = hashMcpToken(token)
    const row = this.db.prepare('SELECT id,name,token_hash,created_at,last_used_at FROM mcp_clients WHERE token_hash=?').get(hash) as Record<string, unknown> | undefined
    if (!row || !timingSafeEqual(Buffer.from(String(row.token_hash), 'hex'), Buffer.from(hash, 'hex'))) return
    return { id: String(row.id), name: String(row.name), createdAt: String(row.created_at), ...(row.last_used_at ? { lastUsedAt: String(row.last_used_at) } : {}) }
  }

  client(id: string) {
    return this.listClients().find((client) => client.id === id)
  }

  touch(id: string, at = new Date().toISOString()) {
    this.db.prepare('UPDATE mcp_clients SET last_used_at=? WHERE id=?').run(at, id)
  }

  revoke(id: unknown) {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('Choose a client to revoke')
    const removed = Number(this.db.prepare('DELETE FROM mcp_clients WHERE id=?').run(id).changes) > 0
    this.db.prepare('DELETE FROM mcp_sends WHERE client_id=?').run(id)
    return removed
  }

  /**
   * Claims an idempotency key before a send. The insert is atomic, so two
   * concurrent calls with the same key cannot both reach the send path.
   */
  reserveSend(clientId: string, key: string, draftId: string): McpSendReservation {
    this.db.prepare('DELETE FROM mcp_sends WHERE created_at<?').run(new Date(Date.now() - SEND_RETENTION_MS).toISOString())
    const inserted = Number(this.db.prepare(`INSERT INTO mcp_sends(client_id,idempotency_key,draft_id,status,created_at) VALUES(?,?,?,'pending',?) ON CONFLICT DO NOTHING`)
      .run(clientId, key, draftId, new Date().toISOString()).changes)
    if (inserted) return { state: 'reserved' }
    const row = this.db.prepare('SELECT draft_id,status,result_json FROM mcp_sends WHERE client_id=? AND idempotency_key=?').get(clientId, key) as Record<string, unknown>
    if (row.status === 'done') return { state: 'completed', draftId: String(row.draft_id), result: JSON.parse(String(row.result_json ?? 'null')) }
    return { state: 'in-progress', draftId: String(row.draft_id) }
  }

  completeSend(clientId: string, key: string, result: unknown) {
    this.db.prepare(`UPDATE mcp_sends SET status='done', result_json=? WHERE client_id=? AND idempotency_key=?`).run(JSON.stringify(result), clientId, key)
  }

  /** Frees a key whose send was refused before anything was queued, so the client may retry. */
  releaseSend(clientId: string, key: string) {
    this.db.prepare(`DELETE FROM mcp_sends WHERE client_id=? AND idempotency_key=? AND status='pending'`).run(clientId, key)
  }
}

/** Client tokens and the send ledger are device credentials and state: never part of a backup copy. */
export function scrubMcpBackup(db: DatabaseSync) {
  db.exec(MCP_SCHEMA)
  db.exec('DELETE FROM mcp_clients; DELETE FROM mcp_sends')
}

/**
 * A restored profile keeps its automation choices (capabilities, account
 * scope) but starts with the bridge off and no issued clients, so restoring
 * never re-opens external access on its own.
 */
export function prepareRestoredMcpDatabase(db: DatabaseSync) {
  scrubMcpBackup(db)
  const row = db.prepare('SELECT payload FROM mcp_settings WHERE id=1').get() as { payload?: string } | undefined
  if (!row?.payload) return
  let settings: McpSettings
  try { settings = normalizeMcpSettings(JSON.parse(row.payload)) } catch { settings = structuredClone(DEFAULT_MCP_SETTINGS) }
  db.prepare('UPDATE mcp_settings SET payload=?, updated_at=? WHERE id=1').run(JSON.stringify({ ...settings, enabled: false }), new Date().toISOString())
}
