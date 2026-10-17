import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DavCredentialVault } from './dav-credentials'
import { fakeSecureStorage } from './dav-test-harness'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const vaultPath = () => { const directory = mkdtempSync(join(tmpdir(), 'aerio-dav-vault-')); directories.push(directory); return join(directory, 'dav-credentials.dat') }

describe('DAV credential vault', () => {
  it('encrypts passwords, survives reopening, and deletes the file when empty', () => {
    const path = vaultPath()
    const vault = new DavCredentialVault(path, fakeSecureStorage())
    vault.save('a', 'secret-a')
    vault.save('b', 'secret-b')
    expect(readFileSync(path, 'utf8')).not.toContain('secret')
    const reopened = new DavCredentialVault(path, fakeSecureStorage())
    expect([reopened.password('a'), reopened.has('b'), reopened.has('c')]).toEqual(['secret-a', true, false])
    reopened.remove('a')
    reopened.remove('missing')
    expect(new DavCredentialVault(path, fakeSecureStorage()).password('a')).toBeUndefined()
    reopened.remove('b')
    expect(existsSync(path)).toBe(false)
  })

  it('refuses to save without OS encryption and treats an unreadable file as empty', () => {
    const path = vaultPath()
    const insecure = { ...fakeSecureStorage(), isEncryptionAvailable: () => false }
    expect(() => new DavCredentialVault(path, insecure).save('a', 'secret')).toThrow(/Secure credential storage is unavailable/)
    expect(existsSync(path)).toBe(false)
    writeFileSync(path, 'not-base64-ciphertext')
    expect(new DavCredentialVault(path, { ...fakeSecureStorage(), decryptString: () => { throw new Error('bad') } }).password('a')).toBeUndefined()
  })
})
