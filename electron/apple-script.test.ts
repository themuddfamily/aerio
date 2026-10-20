import { expect, it, vi } from 'vitest'
import { initializeAppleScript, type AppleScriptNative } from './apple-script'
import { McpToolError } from './mcp/service'
function fixture() {
  let callback!: (id: number, request: string, token: string) => void
  let locked = false, enabled = true, valid = true
  const native: AppleScriptNative = { start: (value) => { callback = value }, complete: vi.fn(), close: vi.fn() }
  const store = { authenticate: vi.fn((token: unknown) => token === 'issued-token' && valid ? { id: 'client', name: 'Script', createdAt: '' } : undefined), settings: () => ({ enabled, capabilities: { write: false, send: false, delete: false }, accountScope: ['allowed'] }), touch: vi.fn() }
  const service = { call: vi.fn(async () => ({ result: { accounts: [] } })) }
  const load = vi.fn(() => native)
  const app = initializeAppleScript({ platform: 'darwin', addonPath: 'fixture.node', load, runtime: () => ({ store, service }), locked: () => locked })
  return { app, native, service, store, load, setLocked: () => { locked = true }, disable: () => { enabled = false }, revoke: () => { valid = false }, invoke: (request = '{"name":"list_accounts","arguments":{}}', token = 'issued-token') => callback(1, request, token) }
}
it('does not load native Apple APIs on other platforms', () => {
  const load = vi.fn(); expect(initializeAppleScript({ platform: 'win32', addonPath: '', load, runtime: () => null, locked: () => false }).available).toBe(false); expect(load).not.toHaveBeenCalled()
})
it('authenticates issued clients and routes structured inbound commands through the existing service', async () => {
  const f = fixture(); f.invoke(); await vi.waitFor(() => expect(f.native.complete).toHaveBeenCalled())
  expect(f.service.call).toHaveBeenCalledWith('client', 'list_accounts', {})
  expect(JSON.parse(vi.mocked(f.native.complete).mock.calls[0][1])).toMatchObject({ ok: true, result: { result: { accounts: [] } } })
  expect(f.store.touch).toHaveBeenCalledWith('client'); f.app.close(); expect(f.native.close).toHaveBeenCalled()
})
it.each(['unauthorized', 'locked', 'disabled', 'malformed'])('refuses %s requests before any service call', async (kind) => {
  const f = fixture(); if (kind === 'locked') f.setLocked(); if (kind === 'disabled') f.disable()
  f.invoke(kind === 'malformed' ? 'not JSON' : undefined, kind === 'unauthorized' ? 'bad-token' : undefined)
  await vi.waitFor(() => expect(f.native.complete).toHaveBeenCalled())
  expect(f.service.call).not.toHaveBeenCalled(); expect(JSON.parse(vi.mocked(f.native.complete).mock.calls[0][1]).ok).toBe(false)
})
it('preserves capability refusals from MCP without exposing unexpected errors', async () => {
  const f = fixture(); f.service.call.mockRejectedValue(new McpToolError('capability-disabled', 'Sending is disabled.'))
  f.invoke('{"name":"send_draft","arguments":{}}'); await vi.waitFor(() => expect(f.native.complete).toHaveBeenCalled())
  expect(JSON.parse(vi.mocked(f.native.complete).mock.calls[0][1])).toMatchObject({ error: { code: 'capability-disabled' } })
})
it.each(['lock', 'revoke', 'disable'])('withholds an async result after %s', async (condition) => {
  const f = fixture(); let finish!: (value: { result: { accounts: [] } }) => void
  f.service.call.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  f.invoke(); await vi.waitFor(() => expect(f.service.call).toHaveBeenCalled())
  if (condition === 'lock') f.setLocked(); if (condition === 'revoke') f.revoke(); if (condition === 'disable') f.disable()
  finish({ result: { accounts: [] } }); await vi.waitFor(() => expect(f.native.complete).toHaveBeenCalled())
  expect(JSON.parse(vi.mocked(f.native.complete).mock.calls[0][1]).ok).toBe(false)
})
