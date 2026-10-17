import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_MCP_SETTINGS, MCP_TOKEN_PREFIX, McpAutomationStore, hashMcpToken, normalizeMcpSettings, prepareRestoredMcpDatabase } from './store'
import { temporaryDirectory } from './test-fixtures'

const cleanup: (() => void)[] = []
afterEach(() => { for (const step of cleanup.splice(0).reverse()) step() })
function open() {
  const temporary = temporaryDirectory('store')
  const path = join(temporary.directory, 'mcp-automation.sqlite')
  const store = new McpAutomationStore(path)
  cleanup.push(() => { try { store.close() } catch { /* already closed */ } temporary.remove() })
  return { store, path }
}

describe('MCP automation store', () => {
  it('is off by default with every capability disabled', () => {
    const { store } = open()
    expect(store.settings()).toEqual(DEFAULT_MCP_SETTINGS)
    expect(DEFAULT_MCP_SETTINGS).toEqual({ enabled: false, capabilities: { write: false, send: false, delete: false }, accountScope: 'all' })
  })

  it('normalizes and persists settings, rejecting malformed input', () => {
    const { store } = open()
    expect(store.saveSettings({ enabled: true, capabilities: { write: true, send: false, delete: false }, accountScope: ['a', 'a', 'b'], extra: 1 }))
      .toEqual({ enabled: true, capabilities: { write: true, send: false, delete: false }, accountScope: ['a', 'b'] })
    expect(store.settings().accountScope).toEqual(['a', 'b'])
    for (const bad of [null, {}, { enabled: 'yes', capabilities: { write: false, send: false, delete: false } }, { enabled: true, capabilities: { write: 1, send: false, delete: false } },
      { enabled: true, capabilities: { write: false, send: false, delete: false }, accountScope: [''] }, { enabled: true, capabilities: { write: false, send: false, delete: false }, accountScope: 'some' }]) {
      expect(() => normalizeMcpSettings(bad)).toThrow()
    }
  })

  it('stores only token hashes, authenticates issued tokens, and revokes immediately', () => {
    const { store, path } = open()
    const { client, token } = store.createClient('  Claude Desktop  ')
    expect(client.name).toBe('Claude Desktop')
    expect(token.startsWith(MCP_TOKEN_PREFIX)).toBe(true)
    expect(token.length).toBeGreaterThan(40)
    store.close()
    const raw = readFileSync(path)
    expect(raw.includes(token)).toBe(false)
    const reopened = new McpAutomationStore(path)
    cleanup.push(() => reopened.close())
    expect(reopened.authenticate(token)).toMatchObject({ id: client.id, name: 'Claude Desktop' })
    expect(reopened.authenticate(`${token}x`)).toBeUndefined()
    expect(reopened.authenticate('not-a-token')).toBeUndefined()
    expect(reopened.authenticate(42)).toBeUndefined()
    reopened.touch(client.id, '2026-10-01T10:00:00.000Z')
    expect(reopened.listClients()).toEqual([{ id: client.id, name: 'Claude Desktop', createdAt: client.createdAt, lastUsedAt: '2026-10-01T10:00:00.000Z' }])
    expect(reopened.revoke(client.id)).toBe(true)
    expect(reopened.authenticate(token)).toBeUndefined()
    expect(reopened.revoke(client.id)).toBe(false)
    expect(() => reopened.revoke('')).toThrow(/Choose a client/)
    expect(() => reopened.createClient('')).toThrow(/1 to 80/)
    expect(() => reopened.createClient('x'.repeat(81))).toThrow(/1 to 80/)
    expect(hashMcpToken(token)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('records send idempotency keys atomically per client', () => {
    const { store } = open()
    expect(store.reserveSend('c1', 'key-1', 'draft-1')).toEqual({ state: 'reserved' })
    expect(store.reserveSend('c1', 'key-1', 'draft-1')).toEqual({ state: 'in-progress', draftId: 'draft-1' })
    expect(store.reserveSend('c2', 'key-1', 'draft-9')).toEqual({ state: 'reserved' })
    store.completeSend('c1', 'key-1', { draftId: 'draft-1', status: 'send-pending' })
    expect(store.reserveSend('c1', 'key-1', 'draft-1')).toEqual({ state: 'completed', draftId: 'draft-1', result: { draftId: 'draft-1', status: 'send-pending' } })
    store.releaseSend('c1', 'key-1')
    // A completed send is never released.
    expect(store.reserveSend('c1', 'key-1', 'draft-1').state).toBe('completed')
    store.releaseSend('c2', 'key-1')
    expect(store.reserveSend('c2', 'key-1', 'draft-9')).toEqual({ state: 'reserved' })
  })

  it('prepares a restored copy with the bridge off and no clients or send records', () => {
    const { store, path } = open()
    store.saveSettings({ enabled: true, capabilities: { write: true, send: true, delete: true }, accountScope: 'all' })
    store.createClient('Old client')
    store.reserveSend('c', 'k', 'd')
    store.close()
    const db = new DatabaseSync(path)
    prepareRestoredMcpDatabase(db)
    expect(db.prepare('SELECT COUNT(*) count FROM mcp_clients').get()).toMatchObject({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) count FROM mcp_sends').get()).toMatchObject({ count: 0 })
    db.close()
    const restored = new McpAutomationStore(path)
    cleanup.push(() => restored.close())
    expect(restored.settings()).toEqual({ enabled: false, capabilities: { write: true, send: true, delete: true }, accountScope: 'all' })
  })
})
