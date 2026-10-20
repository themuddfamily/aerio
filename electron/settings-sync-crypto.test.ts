import { describe, expect, it } from 'vitest'
import { decryptSyncData, encryptSyncData, syncDigest } from './settings-sync-crypto'
describe('settings sync encryption', () => {
  it('authenticates encrypted payloads and rejects incorrect passphrases or modified data', async () => {
    const encrypted = await encryptSyncData({ private: 'Signature content' }, 'a unique shared sync passphrase')
    expect(encrypted).not.toContain('Signature content')
    expect(await decryptSyncData(encrypted, 'a unique shared sync passphrase')).toEqual({ private: 'Signature content' })
    await expect(decryptSyncData(encrypted, 'incorrect passphrase')).rejects.toThrow(/incorrect/)
    const tampered = JSON.parse(encrypted); tampered.tag = Buffer.alloc(16).toString('base64')
    await expect(decryptSyncData(JSON.stringify(tampered), 'a unique shared sync passphrase')).rejects.toThrow(/modified/)
    await expect(encryptSyncData({}, 'short')).rejects.toThrow(/12/)
  })
  it('hashes semantic settings independently of metadata timestamps and object key order', () => {
    expect(syncDigest({ theme: 'dark', exportedAt: 'one' })).toBe(syncDigest({ exportedAt: 'two', theme: 'dark' }))
    expect(syncDigest({ theme: 'dark' })).not.toBe(syncDigest({ theme: 'light' }))
  })
})
