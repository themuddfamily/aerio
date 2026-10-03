import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { parseConfig, readCredential, sanitizeHealth, runAccounts, evidenceRows } from './live-provider-core.mjs'

const config = () => parseConfig({ schemaVersion: 1, timeoutMs: 1_000, accounts: [{ alias: 'gmail-a', provider: 'gmail', accountClass: 'gmail', credentialEnv: 'AERIO_LIVE_GMAIL_A' }] })
const health = () => ({ integrity: 'ok', integrityMessage: 'secret token and body', orphanedMessages: 0, orphanedAttachments: 0, missingRawFiles: 0, accounts: [{ accountId: 'live-test-account', email: 'private@example.test', messages: 2, threads: 2, pendingDownloads: 0, failedDownloads: 0, queuedOperations: 0, failedOperations: 0, editableDrafts: 0, failedDrafts: 0 }] })
const metadata = { version: '0.5.0', commit: 'abcdef1234567890', dirty: false }

function fakeFactory(options = {}) {
  const commands = []
  let opened = 0
  const factory = vi.fn(async () => {
    opened += 1
    const number = opened
    let listener
    return {
      close: vi.fn(async () => undefined),
      onEvent(callback) { listener = callback; return () => { listener = undefined } },
      async request(command) {
        commands.push(command)
        if (command.type === 'accounts:verify' && options.authError) throw new Error('Bearer SECRET_TOKEN private@example.test https://secret.test/payload')
        if (command.type === 'sync:start') listener({ type: 'sync-progress', payload: { accountId: 'live-test-account', phase: options.syncError ? 'error' : 'complete', message: 'Secret body SECRET_TOKEN' } })
        if (command.type === 'diagnostics:health') return { ...health(), ...(options.healthError ? { missingRawFiles: 1 } : {}) }
        if (command.type === 'mail:list') {
          if (options.restartMismatch && number === 2) return { total: 1, items: [{ id: 'different' }] }
          if (!command.payload.cursor) return { total: 2, items: [{ id: 'first', subject: 'SECRET_SUBJECT' }], nextCursor: 'cursor' }
          return { total: 2, items: [{ id: options.duplicate ? 'first' : 'second' }] }
        }
      }
    }
  })
  return { factory, commands }
}

describe('opt-in live provider runner core', () => {
  it('validates account classes and aliases without accepting embedded credentials', () => {
    expect(config().accounts[0].alias).toBe('gmail-a')
    for (const change of [{ alias: '../gmail-a' }, { alias: 'private@example.test' }, { accountClass: 'microsoft-365' }, { provider: '__proto__' }, { password: 'secret' }, { credentialEnv: 'HOME' }]) {
      expect(() => parseConfig({ schemaVersion: 1, accounts: [{ ...config().accounts[0], ...change }] })).toThrow()
    }
    expect(() => parseConfig({ schemaVersion: 1, accounts: [config().accounts[0], config().accounts[0]] })).toThrow()
    expect(() => parseConfig({ schemaVersion: 1, accounts: [], token: 'secret' })).toThrow()
  })
  it('loads OAuth credentials only from the selected environment variable', () => {
    expect(readCredential(config().accounts[0], { AERIO_LIVE_GMAIL_A: JSON.stringify({ type: 'oauth', email: 'private@example.test', accessToken: 'secret' }) })).toEqual({ email: 'private@example.test', credential: { type: 'oauth', accessToken: 'secret' } })
    expect(() => readCredential(config().accounts[0], {})).toThrow(/unavailable/)
  })
  it('exports only finite numeric counters from health diagnostics', () => {
    expect(JSON.stringify(sanitizeHealth(health(), 'live-test-account'))).not.toMatch(/secret|private|example|token|body/i)
    expect(() => sanitizeHealth({ ...health(), missingRawFiles: NaN }, 'live-test-account')).toThrow()
  })
  it('runs verification, sync, diagnostics, offline pagination, and restart without provider mutations', async () => {
    const { factory, commands } = fakeFactory()
    const report = await runAccounts(config(), factory, metadata)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(report.runs[0].checks).toEqual(['credential-verification', 'sync-completion', 'diagnostics', 'offline-pagination-restart'].map((name) => ({ name, result: 'Pass' })))
    expect(report.runs[0].cachedThreads).toBe(2)
    expect(commands.every((command) => ['network', 'accounts:verify', 'sync:start', 'diagnostics:health', 'mail:list'].includes(command.type))).toBe(true)
    expect(JSON.stringify(report)).not.toMatch(/SECRET|private@example|Bearer|https:/)
    const rows = evidenceRows(report, 'diagnostics.json')
    expect(rows).toContain('| HEALTH-01 | Pass |')
    expect(rows).toContain('| AUTH-01 | Partial |')
    expect(rows).toContain('| SYNC-01 | Partial |')
    expect(rows).toContain('| MAIL-02 | Partial |')
  })
  it.each(['authError', 'syncError', 'healthError', 'duplicate', 'restartMismatch'])('reports %s without leaking provider errors or data', async (name) => {
    const { factory } = fakeFactory({ [name]: true })
    const report = await runAccounts(config(), factory, metadata)
    expect(report.runs[0].checks.some((check) => check.result === 'Fail')).toBe(true)
    expect(JSON.stringify(report)).not.toMatch(/SECRET|private@example|Bearer|https:/)
    expect(evidenceRows(report, 'diagnostics.json')).toContain('| Fail |')
  })
  it('does not label an uncommitted candidate as passing release evidence', async () => {
    const report = await runAccounts(config(), fakeFactory().factory, { ...metadata, dirty: true })
    expect(evidenceRows(report, 'diagnostics.json')).not.toContain('| Pass |')
  })
  it.each(['no-environment-opt-in', 'no-run-flag', 'embedded-secret'])('refuses %s before creating evidence or contacting accounts', (mode) => {
    const directory = mkdtempSync(join(tmpdir(), 'aerio-live-cli-test-'))
    try {
      const file = join(directory, 'config.json'), output = join(directory, 'evidence')
      writeFileSync(file, JSON.stringify(mode === 'embedded-secret' ? { schemaVersion: 1, accounts: [{ ...config().accounts[0], password: 'DO_NOT_PRINT_SECRET' }] } : config()))
      const result = spawnSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('scripts/live-provider-runner.mjs'), ...(mode === 'no-run-flag' ? [] : ['--run']), '--config', file, '--output', output], { env: { ...process.env, AERIO_LIVE_TESTS: mode === 'no-environment-opt-in' ? '0' : '1', AERIO_LIVE_GMAIL_A: 'DO_NOT_PRINT_SECRET' }, encoding: 'utf8', timeout: 10_000 })
      expect(result.status).toBe(1)
      expect(result.stdout + result.stderr).not.toContain('DO_NOT_PRINT_SECRET')
      expect(existsSync(output)).toBe(false)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
