import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import forge from 'node-forge'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMimeBuffer } from './mime-builder'
import { NOT_SENT, type OpenPgpKeyStorage } from './openpgp-keyring'
import { parseEntity, splitForProtection } from './openpgp-mime'
import { parseCertificate, readPkcs12, systemRootCertificates } from './smime-certificate'
import { contentInfo, envelopedInfo, parseSignedData, signDetached } from './smime-cms'
import { assembleSmimeMessage, buildSignedEntity, detectSmime } from './smime-mime'
import { OID } from './smime-der'
import { SmimePassphraseRequired, SmimeStore } from './smime-store'
import { issue, pkcs12, testPki, type TestIdentity } from './smime-test-fixtures'

const directories: string[] = []
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })))
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), 'aerio-smime-'))
  directories.push(path)
  return path
}

// A reversible stand-in for safeStorage that marks what it wrapped.
const storage = (): OpenPgpKeyStorage & { encryptString: ReturnType<typeof vi.fn> } => ({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: vi.fn((value: string) => Buffer.from(`wrapped:${Buffer.from(value).toString('hex')}`)),
  decryptString: (value: Buffer) => Buffer.from(value.toString().replace(/^wrapped:/, ''), 'hex').toString()
})

const PASS = 'correct horse battery'
let pki: ReturnType<typeof testPki>
beforeAll(() => { pki = testPki() })

function store(options: { locked?: () => boolean; now?: () => number; path?: string } = {}) {
  const path = options.path ?? join(directory(), 'smime-certificates.dat')
  const wrap = storage()
  return { path, wrap, smime: new SmimeStore(path, { storage: wrap, isLocked: options.locked, now: options.now, systemRoots: () => [] }) }
}

/** A store holding the identity's key (with the intermediate) and trusting the test root. */
async function person(identity: TestIdentity, options: Parameters<typeof store>[0] = {}) {
  const result = store(options)
  await result.smime.importPkcs12(pkcs12(identity, PASS, [pki.intermediate]), PASS)
  const [root] = (await result.smime.importCertificates(pki.root.pem)).imported
  result.smime.setTrusted(root.fingerprint, true)
  return result
}

const fingerprintOf = (identity: TestIdentity) => parseCertificate(identity.der).fingerprint

const draft = (attachmentPaths: string[] = []) => ({
  accountId: 'account', to: ['Bob <bob@example.test>'], cc: [], bcc: [], subject: 'Quarterly numbers',
  text: 'Grüße — the numbers are in.\nSecond line', html: '<p>Grüße — <strong>the numbers</strong></p>', attachmentPaths
})
const outgoing = (from = 'Alice <alice@example.test>', attachmentPaths: string[] = []) => createMimeBuffer(draft(attachmentPaths), from, true).toString('utf8')

/** Signs a message with any identity, bypassing the store's own signer checks. */
function signedBy(identity: TestIdentity, from: string, chain: TestIdentity[] = [pki.intermediate]) {
  const { outer, inner } = splitForProtection(outgoing(from))
  const signature = signDetached(Buffer.from(inner, 'utf8'), identity.privateKey, parseCertificate(identity.der), chain.map((item) => parseCertificate(item.der)), new Date())
  return assembleSmimeMessage(outer, buildSignedEntity(inner, signature))
}

describe('S/MIME certificate store', () => {
  it('imports a PKCS#12 identity with its key passphrase-encrypted and the store wrapped with secure storage', async () => {
    const { smime, path, wrap } = store()
    const result = await smime.importPkcs12(pkcs12(pki.alice, PASS, [pki.intermediate]), PASS)
    expect(result.imported[0]).toMatchObject({
      emails: ['alice@example.test'], commonName: 'Alice Example', hasPrivateKey: true, canSign: true, canEncrypt: true, source: 'own',
      keyUsage: { digitalSignature: true, keyEncipherment: true, emailProtection: true }, revocation: 'not-checked', chainStatus: 'incomplete', unlocked: false, expired: false
    })
    expect(result.imported[0].chain.map((entry) => entry.subject)).toEqual(['Alice Example', 'Aerio Test Mail CA'])
    expect(wrap.encryptString).toHaveBeenCalled()
    const file = readFileSync(path, 'utf8')
    expect(file).not.toMatch(/PRIVATE KEY|CERTIFICATE/)
    const stored = JSON.parse(wrap.decryptString(Buffer.from(file, 'base64'))) as { certificates: { privateKey?: string }[] }
    expect(stored.certificates[0].privateKey).toMatch(/^-----BEGIN ENCRYPTED PRIVATE KEY-----/)
    // Reopening reads the wrapped file back.
    const reopened = new SmimeStore(path, { storage: wrap, systemRoots: () => [] })
    expect((await reopened.list()).map((item) => item.fingerprint)).toEqual([fingerprintOf(pki.alice)])
  })

  it('asks again for a wrong or missing PKCS#12 password and for a stronger passphrase', async () => {
    const { smime } = store()
    const file = pkcs12(pki.alice, 'short')
    await expect(smime.importPkcs12(file, undefined)).resolves.toEqual({ imported: [], needsPassword: true })
    await expect(smime.importPkcs12(file, 'wrong password')).resolves.toMatchObject({ imported: [], needsPassword: true, error: expect.stringMatching(/incorrect/) })
    await expect(smime.importPkcs12(file, 'short')).resolves.toEqual({ imported: [], needsPassphrase: true })
    expect((await smime.list())).toHaveLength(0)
    const imported = await smime.importPkcs12(file, 'short', PASS)
    expect(imported.imported).toHaveLength(1)
    expect(() => smime.unlock(imported.imported[0].fingerprint, 'short')).toThrow(/incorrect/)
    expect(smime.unlock(imported.imported[0].fingerprint, PASS)).toMatchObject({ unlocked: true })
    await expect(smime.importFile(Buffer.from('not a p12'), 'x.p12', PASS)).rejects.toThrow(/PKCS#12/)
    await expect(smime.importPkcs12(pkcs12(pki.root, PASS), PASS)).resolves.toMatchObject({ imported: [expect.objectContaining({ isCa: true })] })
  })

  it('imports recipient certificates from PEM and DER files and evaluates the chain', async () => {
    const { smime } = store()
    const [bob] = (await smime.importFile(pki.bob.der, 'bob.cer')).imported
    expect(bob).toMatchObject({ source: 'imported', hasPrivateKey: false, canSign: false, canEncrypt: true, chainStatus: 'incomplete' })
    await smime.importFile(Buffer.from(pki.intermediate.pem + pki.root.pem), 'chain.pem')
    expect(smime.summary(bob.fingerprint).chainStatus).toBe('untrusted-root')
    smime.setTrusted(fingerprintOf(pki.root), true)
    const trusted = smime.summary(bob.fingerprint)
    expect(trusted.chainStatus).toBe('trusted')
    expect(trusted.chain.map((entry) => [entry.subject, entry.trustAnchor])).toEqual([['Bob Example', false], ['Aerio Test Mail CA', false], ['Aerio Test Root CA', true]])
    await expect(smime.importCertificates('nonsense')).rejects.toThrow(/PEM certificate/)
    expect(smime.exportCertificate(bob.fingerprint)).toContain('-----BEGIN CERTIFICATE-----')
    smime.delete(bob.fingerprint)
    expect(() => smime.summary(bob.fingerprint)).toThrow(/not in your store/)
  })

  it('flags expired, not-yet-valid and wrong-usage certificates', async () => {
    const { smime } = store()
    const later = issue({ commonName: 'Future', email: 'future@example.test', notBefore: new Date(Date.now() + 86_400_000), notAfter: new Date(Date.now() + 9e10) })
    const signOnly = issue({ commonName: 'Signer', email: 'signer@example.test', keyUsage: { digitalSignature: true } })
    const serverCert = issue({ commonName: 'Server', email: 'server@example.test', extKeyUsage: { serverAuth: true } })
    await smime.importCertificates([pki.expired.pem, later.pem, signOnly.pem, serverCert.pem].join(''))
    const byEmail = Object.fromEntries((await smime.list()).map((item) => [item.emails[0], item]))
    expect(byEmail['old@example.test']).toMatchObject({ expired: true })
    expect(byEmail['future@example.test']).toMatchObject({ notYetValid: true })
    expect(byEmail['signer@example.test']).toMatchObject({ canEncrypt: false, keyUsage: { digitalSignature: true, keyEncipherment: false } })
    expect(byEmail['server@example.test']).toMatchObject({ canEncrypt: false, keyUsage: { emailProtection: false } })
  })

  it('never overwrites a store it cannot read and refuses to save without secure storage', async () => {
    const path = join(directory(), 'smime-certificates.dat')
    writeFileSync(path, 'garbage')
    const broken = new SmimeStore(path, { storage: storage(), systemRoots: () => [] })
    await expect(broken.importCertificates(pki.bob.pem)).rejects.toThrow(/could not be read/)
    expect(readFileSync(path, 'utf8')).toBe('garbage')
    const insecure = new SmimeStore(join(directory(), 'x.dat'), { storage: { ...storage(), isEncryptionAvailable: () => false }, systemRoots: () => [] })
    expect(insecure.secureStorage()).toBe(false)
    await expect(insecure.importCertificates(pki.bob.pem)).rejects.toThrow(/Secure credential storage/)
  })

  it('remembers a per-address default and validates it', async () => {
    const { smime, path, wrap } = store()
    smime.setIdentityDefault('Alice <Alice@example.test>', { sign: true, encrypt: false })
    expect(new SmimeStore(path, { storage: wrap, systemRoots: () => [] }).identityDefault('alice@example.test')).toEqual({ sign: true, encrypt: false })
    smime.setIdentityDefault('alice@example.test', undefined)
    expect(smime.identityDefault('alice@example.test')).toBeUndefined()
    expect(() => smime.setIdentityDefault('nobody', { sign: true, encrypt: true })).toThrow(/valid sender/)
  })

  it('finds the bundled system roots', () => {
    expect(systemRootCertificates().length).toBeGreaterThan(50)
    expect(systemRootCertificates().every((cert) => cert.isCa || cert.subject === cert.issuer)).toBe(true)
  })
})

describe('S/MIME signing and verification', () => {
  it('round-trips a signed-only message and harvests the verified sender certificate', async () => {
    const alice = await person(pki.alice)
    const mime = outgoing()
    await expect(alice.smime.protect(mime, { from: 'Alice <alice@example.test>', recipients: ['bob@example.test'], options: { sign: true } })).rejects.toBeInstanceOf(SmimePassphraseRequired)
    alice.smime.unlock(fingerprintOf(pki.alice), PASS)
    const signed = await alice.smime.protect(mime, { from: 'Alice <alice@example.test>', recipients: ['bob@example.test'], options: { sign: true } })
    const top = parseEntity(signed)
    expect(top.headers).toEqual(expect.arrayContaining([expect.stringMatching(/^Content-Type: multipart\/signed; protocol="application\/pkcs7-signature"; micalg=sha-256; boundary=/), 'Subject: Quarterly numbers']))
    expect(signed).toContain('Content-Type: application/pkcs7-signature; name="smime.p7s"')
    expect(signed).not.toMatch(/[^\x00-\x7f]/)
    const structure = detectSmime(signed)
    expect(structure.kind).toBe('signed')
    const cms = parseSignedData((structure as Extract<typeof structure, { kind: 'signed' }>).signature)
    expect(cms.content).toBeUndefined()
    expect(cms.certificates.map((cert) => cert.commonName)).toEqual(['Alice Example', 'Aerio Test Mail CA'])
    expect(cms.signers[0]).toMatchObject({ digest: 'sha256', signedAt: expect.any(Date) })

    const bob = await person(pki.bob)
    const status = await bob.smime.inspect(signed)
    expect(status).toMatchObject({ kind: 'signed', signatures: [{ status: 'valid', harvested: true, signer: { emails: ['alice@example.test'], source: 'harvested', chainStatus: 'trusted' } }] })
    // Bob can now encrypt to Alice with the harvested certificate.
    expect(await bob.smime.recipientCertificates(['alice@example.test'])).toMatchObject([{ status: 'ok', fingerprint: fingerprintOf(pki.alice) }])
    expect((await bob.smime.inspect(signed)).signatures?.[0]).toMatchObject({ status: 'valid' })
    expect((await bob.smime.inspect(signed)).signatures?.[0].harvested).toBeUndefined()

    // Any change to the signed part breaks the signature.
    const tampered = signed.replace('Quarterly', 'Quarterly').replace(/(Content-Transfer-Encoding: base64\r\n\r\n)([A-Za-z])/, (_match, head: string, first: string) => `${head}${first === 'A' ? 'B' : 'A'}`)
    expect((await bob.smime.inspect(tampered)).signatures?.[0]).toMatchObject({ status: 'invalid', detail: expect.stringMatching(/does not match/) })
  })

  it('reports untrusted chains, unknown signers, sender mismatches and expired certificates', async () => {
    const bob = await person(pki.bob)
    expect((await bob.smime.inspect(signedBy(pki.stranger, 'mallory@example.test', [])))).toMatchObject({ signatures: [{ status: 'untrusted', detail: expect.stringMatching(/issuer is unknown/) }] })
    expect((await bob.smime.inspect(signedBy(pki.selfSigned, 'self@example.test', [])))).toMatchObject({ signatures: [{ status: 'untrusted', signer: { chainStatus: 'untrusted-root' } }] })
    expect((await bob.smime.inspect(signedBy(pki.carol, 'Alice <alice@example.test>')))).toMatchObject({ signatures: [{ status: 'email-mismatch', detail: expect.stringMatching(/carol@example.test/) }] })
    expect((await bob.smime.inspect(signedBy(pki.expired, 'old@example.test')))).toMatchObject({ signatures: [{ status: 'expired-certificate' }] })
    // Nothing that failed is harvested.
    expect((await bob.smime.list()).map((item) => item.emails[0]).filter(Boolean)).toEqual(['bob@example.test'])

    // A signature whose certificate was left out cannot be matched.
    const { outer, inner } = splitForProtection(outgoing('carol@example.test'))
    const message = forge.pkcs7.createSignedData()
    message.content = forge.util.createBuffer(Buffer.from(inner).toString('binary'))
    message.addSigner({ key: forge.pki.privateKeyFromPem(pki.carol.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string) as unknown as string, certificate: pki.carol.cert, digestAlgorithm: forge.pki.oids.sha256, authenticatedAttributes: [{ type: forge.pki.oids.contentType, value: forge.pki.oids.data }, { type: forge.pki.oids.messageDigest }] })
    message.sign({ detached: true })
    const bare = assembleSmimeMessage(outer, buildSignedEntity(inner, Buffer.from(forge.asn1.toDer(message.toAsn1()).getBytes(), 'binary')))
    expect(await bob.smime.inspect(bare)).toMatchObject({ signatures: [{ status: 'unknown-certificate' }] })
    // A certificate you accepted directly counts as trusted.
    await bob.smime.importCertificates(pki.stranger.pem)
    bob.smime.setTrusted(fingerprintOf(pki.stranger), true)
    expect((await bob.smime.inspect(signedBy(pki.stranger, 'mallory@example.test', [])))).toMatchObject({ signatures: [{ status: 'valid', signer: { trusted: true } }] })
  })

  it('verifies opaque signed-data (application/pkcs7-mime) and shows its content', async () => {
    const bob = await person(pki.bob)
    const { outer, inner } = splitForProtection(outgoing())
    const message = forge.pkcs7.createSignedData()
    message.content = forge.util.createBuffer(Buffer.from(inner).toString('binary'))
    message.addCertificate(pki.alice.cert)
    message.addCertificate(pki.intermediate.cert)
    message.addSigner({ key: forge.pki.privateKeyFromPem(pki.alice.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string) as unknown as string, certificate: pki.alice.cert, digestAlgorithm: forge.pki.oids.sha256, authenticatedAttributes: [{ type: forge.pki.oids.contentType, value: forge.pki.oids.data }, { type: forge.pki.oids.messageDigest }, { type: forge.pki.oids.signingTime }] })
    message.sign()
    const der = Buffer.from(forge.asn1.toDer(message.toAsn1()).getBytes(), 'binary')
    const opaque = assembleSmimeMessage(outer, { headers: ['Content-Type: application/pkcs7-mime; smime-type=signed-data; name="smime.p7m"', 'Content-Transfer-Encoding: base64'], body: der.toString('base64') })
    expect(await bob.smime.inspect(opaque)).toMatchObject({ kind: 'signed-opaque', signatures: [{ status: 'valid' }] })
    const opened = await bob.smime.open(opaque)
    expect(opened).toMatchObject({ encrypted: false, signatures: [{ status: 'valid' }] })
    expect(opened.text).toContain('Grüße — the numbers are in.')
  })
})

describe('S/MIME encryption', () => {
  it('encrypts to every recipient and the sender, decrypts with the passphrase, and verifies the inner signature', async () => {
    const alice = await person(pki.alice)
    await alice.smime.importCertificates(pki.bob.pem)
    alice.smime.unlock(fingerprintOf(pki.alice), PASS)
    const folder = directory()
    const attachment = join(folder, 'figures.bin')
    writeFileSync(attachment, Buffer.from([0, 1, 2, 250, 251, 252]))
    const mime = outgoing('Alice <alice@example.test>', [attachment])
    const encrypted = await alice.smime.protect(mime, { from: 'Alice <alice@example.test>', recipients: ['Bob <bob@example.test>'], options: { sign: true, encrypt: true } })
    expect(encrypted).toContain('Content-Type: application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"')
    expect(encrypted).toContain('Subject: Quarterly numbers')
    expect(encrypted).not.toMatch(/numbers are in|Grüße|R3LDvMOfZQ/)
    const structure = detectSmime(encrypted) as Extract<ReturnType<typeof detectSmime>, { kind: 'pkcs7' }>
    expect(contentInfo(structure.der).type).toBe(OID.envelopedData)
    const info = envelopedInfo(structure.der)
    expect(info.algorithm).toBe('AES-256-CBC')
    expect(info.recipients).toHaveLength(2)

    const bob = await person(pki.bob)
    expect(await bob.smime.inspect(encrypted)).toMatchObject({ kind: 'encrypted', algorithm: 'AES-256-CBC', encryptedTo: expect.arrayContaining([expect.objectContaining({ available: true, fingerprint: fingerprintOf(pki.bob) }), expect.objectContaining({ available: false })]) })
    await expect(bob.smime.open(encrypted)).rejects.toBeInstanceOf(SmimePassphraseRequired)
    await expect(bob.smime.open(encrypted, 'wrong passphrase')).rejects.toMatchObject({ message: expect.stringMatching(/incorrect/) })
    const opened = await bob.smime.open(encrypted, PASS)
    expect(opened.encrypted).toBe(true)
    expect(opened.text).toContain('Grüße — the numbers are in.')
    expect(opened.html).toContain('<strong>the numbers</strong>')
    expect(opened.attachments).toEqual([expect.objectContaining({ filename: 'figures.bin', content: expect.any(Uint8Array) })])
    expect(Buffer.from(opened.attachments[0].content)).toEqual(Buffer.from([0, 1, 2, 250, 251, 252]))
    expect(opened.signatures).toMatchObject([{ status: 'valid', harvested: true }])
    // The key stays unlocked for a while, so a second open needs no passphrase.
    await expect(bob.smime.open(encrypted)).resolves.toMatchObject({ encrypted: true })
    // The sender's own copy is readable too.
    await expect(alice.smime.open(encrypted)).resolves.toMatchObject({ encrypted: true })

    // A third party cannot read it.
    const carol = await person(pki.carol)
    expect((await carol.smime.inspect(encrypted)).encryptedTo?.every((item) => !item.available)).toBe(true)
    await expect(carol.smime.open(encrypted, PASS)).rejects.toThrow(/not encrypted to any of your S\/MIME certificates/)
  })

  it('refuses to send when a recipient certificate is missing, expired, untrusted or not for encryption', async () => {
    const alice = await person(pki.alice)
    const signOnly = issue({ commonName: 'Signer', email: 'signer@example.test', issuer: pki.intermediate, keyUsage: { digitalSignature: true } })
    await alice.smime.importCertificates([pki.expired.pem, pki.stranger.pem, signOnly.pem, pki.bob.pem].join(''))
    const mime = outgoing()
    const send = (recipients: string[], options: { encrypt: true; recipientCerts?: Record<string, string> } = { encrypt: true }) => alice.smime.protect(mime, { from: 'alice@example.test', recipients, options })
    await expect(send(['nobody@example.test'])).rejects.toThrow(`No S/MIME certificate for: nobody@example.test. ${NOT_SENT}`)
    await expect(send(['old@example.test'])).rejects.toThrow(/has expired for: old@example.test/)
    await expect(send(['mallory@example.test'])).rejects.toThrow(/not trusted for: mallory@example.test/)
    await expect(send(['signer@example.test'])).rejects.toThrow(/allows encryption for: signer@example.test/)
    await expect(send([])).rejects.toThrow(/Add at least one recipient/)
    alice.smime.setTrusted(fingerprintOf(pki.stranger), true)
    await expect(send(['mallory@example.test'])).resolves.toContain('application/pkcs7-mime')
    // A newer certificate for the same address is preferred unless one is chosen.
    const newerBob = issue({ commonName: 'Bob Example 2', email: 'bob@example.test', issuer: pki.intermediate, notAfter: new Date(Date.now() + 700 * 86_400_000) })
    await alice.smime.importCertificates(newerBob.pem)
    const [choice] = await alice.smime.recipientCertificates(['bob@example.test'])
    expect(choice).toMatchObject({ status: 'ok', fingerprint: fingerprintOf(newerBob) })
    expect(choice.candidates).toHaveLength(2)
    const [chosen] = await alice.smime.recipientCertificates(['bob@example.test'], { 'bob@example.test': fingerprintOf(pki.bob) })
    expect(chosen.fingerprint).toBe(fingerprintOf(pki.bob))
  })

  it('refuses decryption of unsupported or authenticated envelopes with a clear message', async () => {
    const bob = await person(pki.bob)
    const message = forge.pkcs7.createEnvelopedData()
    message.addRecipient(pki.bob.cert)
    message.content = forge.util.createBuffer('Content-Type: text/plain\r\n\r\nold cipher')
    message.encrypt(undefined, forge.pki.oids['des-EDE3-CBC'])
    const der = Buffer.from(forge.asn1.toDer(message.toAsn1()).getBytes(), 'binary')
    const legacy = `From: alice@example.test\r\nContent-Type: application/x-pkcs7-mime; name="smime.p7m"\r\nContent-Transfer-Encoding: base64\r\n\r\n${der.toString('base64')}\r\n`
    expect(await bob.smime.inspect(legacy)).toMatchObject({ kind: 'encrypted', algorithm: '3DES-CBC' })
    await expect(bob.smime.open(legacy, PASS)).resolves.toMatchObject({ text: expect.stringContaining('old cipher'), signatures: [] })
    await expect(bob.smime.open('From: a@example.test\r\nContent-Type: text/plain\r\n\r\nhello')).rejects.toThrow(/not S\/MIME encrypted/)
    expect(await bob.smime.inspect('Content-Type: application/pkcs7-mime\r\nContent-Transfer-Encoding: base64\r\n\r\nAAAA')).toMatchObject({ error: expect.stringMatching(/could not be read/) })
  })
})

describe('S/MIME app lock, passphrase cache, and recovery', () => {
  it('blocks private-key operations while Aerio is locked and forgets unlocked keys', async () => {
    let locked = false
    let now = Date.now()
    const alice = await person(pki.alice, { locked: () => locked, now: () => now })
    alice.smime.unlock(fingerprintOf(pki.alice), PASS)
    expect(alice.smime.summary(fingerprintOf(pki.alice)).unlocked).toBe(true)
    alice.smime.lock()
    expect(alice.smime.summary(fingerprintOf(pki.alice)).unlocked).toBe(false)
    alice.smime.unlock(fingerprintOf(pki.alice), PASS)
    now += 11 * 60_000
    expect(alice.smime.summary(fingerprintOf(pki.alice)).unlocked).toBe(false)
    alice.smime.unlock(fingerprintOf(pki.alice), PASS)
    locked = true
    expect(alice.smime.summary(fingerprintOf(pki.alice)).unlocked).toBe(false)
    expect(() => alice.smime.unlock(fingerprintOf(pki.alice), PASS)).toThrow(/Unlock Aerio/)
    await expect(alice.smime.protect(outgoing(), { from: 'alice@example.test', recipients: ['bob@example.test'], options: { sign: true } })).rejects.toThrow(/Unlock Aerio.*not sent/)
    await expect(alice.smime.inspect(signedBy(pki.bob, 'bob@example.test'))).rejects.toThrow(/Unlock Aerio/)
    await expect(alice.smime.importCertificates(pki.bob.pem)).rejects.toThrow(/Unlock Aerio/)
    expect(() => alice.smime.exportPkcs12(fingerprintOf(pki.alice), PASS, PASS)).toThrow(/Unlock Aerio/)
  })

  it('moves an identity to a fresh device only through a password-protected PKCS#12 export', async () => {
    const bob = await person(pki.bob)
    const alice = await person(pki.alice)
    await alice.smime.importCertificates(pki.bob.pem)
    const encrypted = await alice.smime.protect(outgoing(), { from: 'alice@example.test', recipients: ['bob@example.test'], options: { encrypt: true } })
    expect(() => bob.smime.exportPkcs12(fingerprintOf(pki.bob), 'wrong passphrase', 'new export password')).toThrow(/incorrect/)
    expect(() => bob.smime.exportPkcs12(fingerprintOf(pki.bob), PASS, 'short')).toThrow(/at least 8/)
    expect(() => bob.smime.exportPkcs12(fingerprintOf(pki.root), PASS, 'new export password')).toThrow(/no private key/)
    const exported = bob.smime.exportPkcs12(fingerprintOf(pki.bob), PASS, 'new export password')
    expect(() => readPkcs12(exported, PASS)).toThrow(/incorrect/)
    expect(readPkcs12(exported, 'new export password').chain.map((cert) => cert.commonName)).toEqual(['Aerio Test Mail CA'])
    // A new device has neither keys nor trust until they are imported.
    const restored = store()
    await expect(restored.smime.open(encrypted, PASS)).rejects.toThrow(/not encrypted to any/)
    await restored.smime.importFile(exported, 'bob.p12', 'new export password')
    await expect(restored.smime.open(encrypted, 'new export password')).resolves.toMatchObject({ text: expect.stringContaining('numbers are in') })
  })
})
