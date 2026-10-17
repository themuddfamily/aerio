import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseCertificate, readCertificates, readPkcs12 } from './smime-certificate'
import { SmimeStore } from './smime-store'
import { caPem, ecSignedEml, encryptedEml, gcmEml, leafP12, opaqueEml, PKCS12_PASSWORD, signedEml } from './smime-openssl.fixtures'

// Messages and a PKCS#12 file made by OpenSSL, read by Aerio's S/MIME code.

const folder = mkdtempSync(join(tmpdir(), 'aerio-smime-interop-'))
afterAll(() => rmSync(folder, { recursive: true, force: true }))
const storage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (value: string) => Buffer.from(value).reverse(),
  decryptString: (value: Buffer) => Buffer.from(value).reverse().toString()
}
let count = 0
async function store(options: { trustRoot?: boolean; identity?: boolean } = {}) {
  const smime = new SmimeStore(join(folder, `store-${count++}.dat`), { storage, systemRoots: () => [] })
  if (options.identity) await smime.importPkcs12(leafP12, PKCS12_PASSWORD)
  if (options.trustRoot !== false) {
    const [root] = (await smime.importCertificates(caPem.toString('latin1'))).imported
    smime.setTrusted(root.fingerprint, true)
  }
  return smime
}
const text = (value: Buffer) => value.toString('utf8')

describe('S/MIME interoperability with OpenSSL', () => {
  it('reads a modern OpenSSL PKCS#12 (PBES2, AES-256, SHA-256 MAC) with its chain', () => {
    const contents = readPkcs12(leafP12, PKCS12_PASSWORD)
    expect(contents.certificate).toMatchObject({ commonName: 'Interop Person', emails: expect.arrayContaining(['interop@example.test']), keyType: 'rsa' })
    expect(contents.chain.map((cert) => cert.commonName)).toEqual(['OpenSSL Interop Root'])
    expect(() => readPkcs12(leafP12, 'wrong')).toThrow(/incorrect/)
  })

  it('verifies detached and opaque RSA signatures and an ECDSA signature', async () => {
    const smime = await store()
    expect(await smime.inspect(text(signedEml))).toMatchObject({ kind: 'signed', signatures: [{ status: 'valid', harvested: true, signer: { commonName: 'Interop Person', chainStatus: 'trusted' } }] })
    expect(await smime.inspect(text(opaqueEml))).toMatchObject({ kind: 'signed-opaque', signatures: [{ status: 'valid' }] })
    expect((await smime.open(text(opaqueEml))).text).toContain('Hello from OpenSSL.')
    // The EC certificate verifies, but it cannot be used to encrypt and so is not harvested.
    expect(await smime.inspect(text(ecSignedEml))).toMatchObject({ kind: 'signed', signatures: [{ status: 'valid', signer: { algorithm: 'ECDSA (prime256v1)', canEncrypt: false } }] })
    expect((await smime.list()).map((item) => item.commonName)).not.toContain('EC Person')
  })

  it('reports an OpenSSL signature as untrusted until its root is trusted, and as invalid when changed', async () => {
    const smime = await store({ trustRoot: false })
    expect(await smime.inspect(text(signedEml))).toMatchObject({ signatures: [{ status: 'untrusted', signer: { chainStatus: 'untrusted-root' } }] })
    const tampered = text(signedEml).replace('Hello from OpenSSL.', 'Hello from Mallory.')
    expect(await smime.inspect(tampered)).toMatchObject({ signatures: [{ status: 'invalid' }] })
  })

  it('decrypts OpenSSL AES-256-CBC enveloped data and refuses AES-GCM with a clear message', async () => {
    const smime = await store({ identity: true })
    const fingerprint = parseCertificate(readPkcs12(leafP12, PKCS12_PASSWORD).certificate.der).fingerprint
    expect(await smime.inspect(text(encryptedEml))).toMatchObject({ kind: 'encrypted', algorithm: 'AES-256-CBC', encryptedTo: [{ available: true, fingerprint }] })
    await expect(smime.open(text(encryptedEml), PKCS12_PASSWORD)).resolves.toMatchObject({ encrypted: true, text: expect.stringContaining('Hello from OpenSSL.'), signatures: [] })
    expect(await smime.inspect(text(gcmEml))).toMatchObject({ kind: 'encrypted', algorithm: 'AES-256-GCM' })
    await expect(smime.open(text(gcmEml))).rejects.toThrow(/AuthEnvelopedData/)
  })

  it('reads PEM bundles with several certificates', () => {
    expect(readCertificates(caPem.toString('latin1') + caPem.toString('latin1'))).toHaveLength(2)
  })
})
