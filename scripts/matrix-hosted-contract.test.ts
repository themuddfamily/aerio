import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { HOSTED_CHECKS, publicAddress, validateHostedConfig, validateReport } from './matrix-hosted-contract.mjs'
const config = { homeserver: 'https://matrix.example.org', userA: '@a:example.org', passwordA: 'private-password-a', userB: '@b:example.org', passwordB: 'private-password-b', disposableAccounts: true, acceptServerMutations: true }
const report = () => ({ sdk: 'matrix-js-sdk 43.0.0', electron: '43.7.7', homeserver: config.homeserver, checkedAt: new Date().toISOString(), versions: ['r0.6.1', 'v1.11'], capabilities: { password: true, names: ['m.room_versions'] }, checks: HOSTED_CHECKS.map((id: string) => ({ id, passed: true })) })
describe('hosted Matrix acceptance contract (no network or evidence writes)', () => {
  it('fails closed on missing credentials, consent, duplicate users, private origins or unsafe URLs', () => {
    for (const value of [undefined, {}, { ...config, passwordB: '' }, { ...config, disposableAccounts: false }, { ...config, acceptServerMutations: false }, { ...config, userB: config.userA }, ...['http://matrix.example.org', 'https://127.0.0.1', 'https://10.0.0.1', 'https://server.local', 'https://u:p@matrix.example.org', 'https://matrix.example.org?token=secret'].map((homeserver) => ({ ...config, homeserver }))]) expect(() => validateHostedConfig(value)).toThrow()
    expect(validateHostedConfig(config).homeserver).toBe(config.homeserver)
  })
  it('requires all resolved IP addresses to be public', () => {
    for (const value of ['127.0.0.1', '10.0.0.1', '172.20.1.1', '192.168.1.1', '169.254.1.1', '100.64.1.1', '203.0.113.1', '::1', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', '2001:db8::1']) expect(publicAddress(value)).toBe(false)
    expect(publicAddress('8.8.8.8')).toBe(true)
    expect(publicAddress('2606:4700:4700::1111')).toBe(true)
  })
  it('refuses partial, failed, duplicate or version-mismatched reports', () => {
    const expected = report()
    for (const value of [{ ...report(), checks: [] }, { ...report(), checks: report().checks.map((check: any, index: number) => index ? check : { ...check, passed: false }) }, { ...report(), sdk: 'other' }, { ...report(), electron: 'other' }, { ...report(), homeserver: 'https://elsewhere.org' }, { ...report(), versions: [] }]) expect(() => validateReport(value, expected)).toThrow()
  })
  it('emits only sanitized fields after a complete real-run report, never credentials or unrecognized details', () => {
    const result = validateReport({ ...report(), token: 'private-token', recoveryKey: 'private-recovery', users: ['@private:example.org'], message: 'private-message' }, report())
    expect(Object.keys(result).sort()).toEqual(['capabilities', 'checkedAt', 'checks', 'electron', 'homeserver', 'passwordLogin', 'schema', 'sdk', 'versions'])
    expect(JSON.stringify(result)).not.toMatch(/private|recoveryKey|token/)
    expect(result.checks).toHaveLength(HOSTED_CHECKS.length)
  })
  it('the executable fails closed without credentials and validation mode never emits interoperability evidence', () => {
    const directory = resolve('live-test-evidence')
    const files = () => existsSync(directory) ? readdirSync(directory).filter((name) => name.startsWith('matrix-hosted-')).sort() : []
    const before = files()
    const env = { ...process.env, AERIO_MATRIX_INTEROP_CONFIG: join(tmpdir(), 'aerio-definitely-missing-hosted-config.json'), AERIO_MATRIX_HOMESERVER: config.homeserver, AERIO_MATRIX_USER_A: config.userA, AERIO_MATRIX_PASSWORD_A: config.passwordA, AERIO_MATRIX_USER_B: '', AERIO_MATRIX_PASSWORD_B: '', AERIO_MATRIX_DISPOSABLE_USERS: '1', AERIO_MATRIX_ACCEPT_SERVER_MUTATIONS: '1' }
    const missing = spawnSync(process.execPath, ['scripts/matrix-hosted-interop.mjs', '--run'], { env, encoding: 'utf8', timeout: 30_000 })
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('failed closed at configuration')
    expect(missing.stderr + missing.stdout).not.toContain(config.passwordA)
    const valid = spawnSync(process.execPath, ['scripts/matrix-hosted-interop.mjs', '--validate'], { env: { ...env, AERIO_MATRIX_USER_B: config.userB, AERIO_MATRIX_PASSWORD_B: config.passwordB }, encoding: 'utf8', timeout: 30_000 })
    expect(valid.status).toBe(0)
    expect(valid.stdout).toContain('No network, Electron acceptance or evidence output')
    expect(files()).toEqual(before)
  })
})
