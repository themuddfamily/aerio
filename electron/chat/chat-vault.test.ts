import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatCacheCipher } from './cache-crypto'
import { ChatVault, type ChatSecretCodec } from './chat-vault'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'aerio-chat-vault-')) })
afterEach(() => rmSync(directory, { recursive: true, force: true }))

const codec = (secure = { value: true }): ChatSecretCodec => ({
  assertSecure: () => { if (!secure.value) throw new Error('Secure credential storage is unavailable') },
  encrypt: (value) => Buffer.from(`wrapped:${Buffer.from(value).toString('hex')}`),
  decrypt: (value) => Buffer.from(value.toString().replace(/^wrapped:/, ''), 'hex').toString()
})

describe('ChatCacheCipher', () => {
  const key = ChatCacheCipher.generateKey()
  it('round-trips and binds ciphertext to account, table and record', () => {
    const cipher = new ChatCacheCipher('account-1', key)
    const sealed = cipher.seal('hello', { table: 'events', record: '$e1' })
    expect(sealed).not.toContain('hello')
    expect(cipher.open(sealed, { table: 'events', record: '$e1' })).toBe('hello')
    expect(() => cipher.open(sealed, { table: 'events', record: '$e2' })).toThrow()
    expect(() => cipher.open(sealed, { table: 'drafts', record: '$e1' })).toThrow()
    expect(() => new ChatCacheCipher('account-2', key).open(sealed, { table: 'events', record: '$e1' })).toThrow()
    expect(cipher.openJson(cipher.sealJson({ a: 1 }, { table: 't', record: 'r' }), { table: 't', record: 'r' })).toEqual({ a: 1 })
  })

  it('rejects tampering, foreign formats and wrong key sizes', () => {
    const cipher = new ChatCacheCipher('account-1', key)
    const sealed = cipher.seal('hello', { table: 'events', record: '$e1' })
    const raw = Buffer.from(sealed.slice(3), 'base64'); raw[raw.length - 1] ^= 1
    expect(() => cipher.open(`c1.${raw.toString('base64')}`, { table: 'events', record: '$e1' })).toThrow()
    expect(() => cipher.open('plain', { table: 'events', record: '$e1' })).toThrow('Unsupported')
    expect(() => cipher.open('c1.AAAA', { table: 'events', record: '$e1' })).toThrow('Corrupt')
    expect(() => new ChatCacheCipher('a', Buffer.alloc(16))).toThrow('32 bytes')
  })
})

describe('ChatVault', () => {
  it('stores wrapped secrets and never writes the token in clear text', () => {
    const path = join(directory, 'chat-vault.dat')
    const vault = new ChatVault(path, codec())
    const created = vault.create('acc', 'syt_secret_token', 'DEVICE1')
    expect(created.cacheKey).toHaveLength(32)
    expect(created.cryptoStoreKey).toHaveLength(32)
    expect(readFileSync(path, 'utf8')).not.toContain('syt_secret_token')
    const reopened = new ChatVault(path, codec())
    expect(reopened.get('acc')).toMatchObject({ accessToken: 'syt_secret_token', deviceId: 'DEVICE1' })
    expect(reopened.get('acc')!.cacheKey.equals(created.cacheKey)).toBe(true)
    reopened.updateToken('acc', 'syt_new')
    expect(new ChatVault(path, codec()).get('acc')!.accessToken).toBe('syt_new')
    reopened.clearToken('acc')
    expect(new ChatVault(path, codec()).get('acc')!.accessToken).toBe('')
    reopened.clearToken('missing')
    expect(() => reopened.updateToken('missing', 'x')).toThrow('no stored session')
  })

  it('creates fresh keys when a device is replaced and deletes the file with the last account', () => {
    const path = join(directory, 'chat-vault.dat')
    const vault = new ChatVault(path, codec())
    const first = vault.create('acc', 't1', 'D1')
    vault.create('other', 't2', 'D2')
    const replaced = vault.create('acc', 't3', 'D3')
    expect(replaced.cryptoStoreKey.equals(first.cryptoStoreKey)).toBe(false)
    vault.remove('acc')
    expect(vault.has('acc')).toBe(false)
    expect(existsSync(path)).toBe(true)
    vault.remove('other')
    vault.remove('other')
    expect(existsSync(path)).toBe(false)
  })

  it('refuses to read or write without secure OS storage', () => {
    const secure = { value: false }
    const vault = new ChatVault(join(directory, 'chat-vault.dat'), codec(secure))
    expect(() => vault.create('acc', 't', 'D')).toThrow('Secure credential storage')
    expect(() => vault.get('acc')).toThrow('Secure credential storage')
    secure.value = true
    expect(vault.get('acc')).toBeUndefined()
  })
})
