import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as openpgp from 'openpgp'
import PostalMime from 'postal-mime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMimeBuffer } from './mime-builder'
import { NOT_SENT, OpenPgpKeyring, OpenPgpPassphraseRequired, type OpenPgpKeyStorage } from './openpgp-keyring'
import { detectPgpMime, inlinePgpBlock, parseEntity } from './openpgp-mime'

const directories: string[] = []
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })))

const directory = () => {
  const path = mkdtempSync(join(tmpdir(), 'aerio-openpgp-'))
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

async function keyring(options: { locked?: () => boolean; now?: () => number } = {}) {
  const path = join(directory(), 'openpgp-keyring.dat')
  const store = storage()
  return { path, store, ring: new OpenPgpKeyring(path, { storage: store, isLocked: options.locked, now: options.now }) }
}

async function externalKey(email: string, extra: Partial<Parameters<typeof openpgp.generateKey>[0]> = {}) {
  return openpgp.generateKey({ type: 'ecc', userIDs: [{ name: email.split('@')[0], email }], passphrase: PASS, format: 'object', ...extra } as Parameters<typeof openpgp.generateKey>[0] & { format: 'object' })
}

const draft = (attachmentPaths: string[] = []) => ({
  accountId: 'account', to: ['Bob <bob@example.test>'], cc: [], bcc: [], subject: 'Secret plans',
  text: 'Grüße — the plan is on.\nSecond line', html: '<p>Grüße — <strong>the plan</strong></p>', attachmentPaths
})

describe('OpenPGP keyring storage', () => {
  it('generates keys that are passphrase-protected and wrapped with secure storage', async () => {
    const { ring, path, store } = await keyring()
    const key = await ring.generate({ name: 'Alice', email: 'Alice@Example.test', passphrase: PASS, expiresInDays: 30 })
    expect(key).toMatchObject({ emails: ['alice@example.test'], hasPrivateKey: true, canSign: true, canEncrypt: true, verification: 'verified', unlocked: false, revoked: false, expired: false })
    expect(key.fingerprint).toMatch(/^[0-9A-F]{40}$/)
    expect(key.expiresAt).toBeDefined()
    expect(store.encryptString).toHaveBeenCalled()
    const file = readFileSync(path, 'utf8')
    expect(file).not.toContain('PGP')
    const stored = JSON.parse(store.decryptString(Buffer.from(file, 'base64'))) as { keys: { privateKey: string }[] }
    const secret = await openpgp.readPrivateKey({ armoredKey: stored.keys[0].privateKey })
    expect(secret.isDecrypted()).toBe(false)
    // Reopening the keyring reads the wrapped file back.
    const reopened = new OpenPgpKeyring(path, { storage: store })
    expect((await reopened.list()).map((item) => item.fingerprint)).toEqual([key.fingerprint])
  })

  it('refuses to save without secure storage and never overwrites an unreadable keyring', async () => {
    const path = join(directory(), 'openpgp-keyring.dat')
    const insecure = { ...storage(), isEncryptionAvailable: () => false }
    await expect(new OpenPgpKeyring(path, { storage: insecure }).generate({ name: '', email: 'a@example.test', passphrase: PASS })).rejects.toThrow(/Secure credential storage/)
    writeFileSync(path, 'not-a-keyring')
    const broken = new OpenPgpKeyring(path, { storage: storage() })
    await expect(broken.generate({ name: '', email: 'a@example.test', passphrase: PASS })).rejects.toThrow(/could not be read/)
    expect(readFileSync(path, 'utf8')).toBe('not-a-keyring')
  })

  it('validates generation input', async () => {
    const { ring } = await keyring()
    await expect(ring.generate({ name: 'x', email: 'nope', passphrase: PASS })).rejects.toThrow(/email address/)
    await expect(ring.generate({ name: 'x', email: 'a@example.test', passphrase: 'short' })).rejects.toThrow(/passphrase/)
    await expect(ring.generate({ name: 'x', email: 'a@example.test', passphrase: PASS, expiresInDays: -1 })).rejects.toThrow(/expiry/)
  })

  it('imports, merges, exports and deletes keys and records manual verification', async () => {
    const { ring } = await keyring()
    const bob = await externalKey('bob@example.test')
    const result = await ring.importKeys(bob.publicKey.armor())
    expect(result.imported).toHaveLength(1)
    expect(result.imported[0]).toMatchObject({ hasPrivateKey: false, verification: 'unverified', canEncrypt: true })
    const fingerprint = result.imported[0].fingerprint
    expect((await ring.setVerification(fingerprint, 'verified')).verification).toBe('verified')
    // A later import with the private key keeps the verification state.
    expect((await ring.importKeys(bob.privateKey.armor())).imported[0]).toMatchObject({ hasPrivateKey: true, verification: 'verified' })
    expect(await ring.exportPublic(fingerprint)).toContain('BEGIN PGP PUBLIC KEY BLOCK')
    await expect(ring.exportPrivate(fingerprint, 'wrong passphrase')).rejects.toThrow(/incorrect/)
    const exported = await openpgp.readPrivateKey({ armoredKey: await ring.exportPrivate(fingerprint, PASS) })
    expect(exported.isDecrypted()).toBe(false)
    // Binary imports work too.
    const carol = await externalKey('carol@example.test')
    expect((await ring.importKeys(carol.publicKey.write())).imported[0].emails).toEqual(['carol@example.test'])
    ring.delete(fingerprint)
    expect((await ring.list()).map((item) => item.emails[0])).toEqual(['carol@example.test'])
    await expect(ring.importKeys('hello')).rejects.toThrow(/No OpenPGP keys/)
    await expect(ring.setVerification(carol.publicKey.getFingerprint(), 'maybe' as never)).rejects.toThrow()
  })

  it('requires a passphrase before storing an unprotected private key', async () => {
    const { ring, store, path } = await keyring()
    const { privateKey } = await openpgp.generateKey({ type: 'ecc', userIDs: [{ email: 'open@example.test' }], format: 'object' })
    expect(privateKey.isDecrypted()).toBe(true)
    expect(await ring.importKeys(privateKey.armor())).toEqual({ imported: [], needsPassphrase: true })
    expect((await ring.list())).toHaveLength(0)
    const imported = await ring.importKeys(privateKey.armor(), PASS)
    expect(imported.imported[0].hasPrivateKey).toBe(true)
    const stored = JSON.parse(store.decryptString(Buffer.from(readFileSync(path, 'utf8'), 'base64'))) as { keys: { privateKey: string }[] }
    expect((await openpgp.readPrivateKey({ armoredKey: stored.keys[0].privateKey })).isDecrypted()).toBe(false)
    await ring.unlock(imported.imported[0].fingerprint, PASS)
  })

  it('merges a revocation into an existing key', async () => {
    const { ring } = await keyring()
    const bob = await externalKey('bob@example.test')
    await ring.importKeys(bob.publicKey.armor())
    const revoked = await openpgp.revokeKey({ key: await openpgp.decryptKey({ privateKey: bob.privateKey, passphrase: PASS }), format: 'armored' })
    const merged = await ring.importKeys(revoked.publicKey)
    expect(merged.imported[0].revoked).toBe(true)
  })
})

describe('OpenPGP sending', () => {
  async function setup() {
    const context = await keyring()
    const alice = await context.ring.generate({ name: 'Alice', email: 'alice@example.test', passphrase: PASS })
    const bob = await externalKey('bob@example.test')
    await context.ring.importKeys(bob.publicKey.armor())
    return { ...context, alice, bob }
  }

  it('signs as PGP/MIME with a detached signature that verifies and detects tampering', async () => {
    const { ring, alice } = await setup()
    const mime = createMimeBuffer(draft(), 'Alice <alice@example.test>').toString('utf8')
    await expect(ring.protect(mime, { from: 'Alice <alice@example.test>', recipients: ['bob@example.test'], options: { sign: true } })).rejects.toBeInstanceOf(OpenPgpPassphraseRequired)
    await ring.unlock(alice.fingerprint, PASS)
    const signed = await ring.protect(mime, { from: 'Alice <alice@example.test>', recipients: ['bob@example.test'], options: { sign: true } })
    expect(signed).toMatch(/^Content-Type: multipart\/signed; micalg="pgp-sha\d+"; protocol="application\/pgp-signature"/m)
    expect(signed).toMatch(/^Subject: Secret plans$/m)
    const structure = detectPgpMime(signed)
    expect(structure.kind).toBe('signed')
    if (structure.kind !== 'signed') return
    expect(structure.signedPart).not.toMatch(/[^\x00-\x7f]/)
    const results = await ring.verifyDetached(structure.signedPart, structure.signature)
    expect(results[0]).toMatchObject({ status: 'valid', fingerprint: alice.fingerprint, verification: 'verified' })
    const tampered = await ring.verifyDetached(structure.signedPart.replace('Content-Type', 'Content-type'), structure.signature)
    expect(tampered[0].status).toBe('invalid')
    // The signed message still reads normally in any mail client.
    const parsed = await PostalMime.parse(Buffer.from(signed))
    expect(parsed.text).toContain('Grüße — the plan is on.')
  })

  it('encrypts and signs with attachments, to recipients and to self, and round-trips', async () => {
    const { ring, alice, bob } = await setup()
    const folder = directory()
    const attachment = join(folder, 'report.bin')
    writeFileSync(attachment, Buffer.from([0, 1, 2, 250, 255]))
    const mime = createMimeBuffer(draft([attachment]), 'Alice <alice@example.test>', true).toString('utf8')
    await ring.unlock(alice.fingerprint, PASS)
    const encrypted = await ring.protect(mime, { from: 'alice@example.test', recipients: ['Bob <bob@example.test>'], options: { sign: true, encrypt: true } })
    expect(encrypted).not.toContain('Grüße')
    expect(encrypted).not.toContain('report.bin')
    expect(encrypted).toMatch(/^Content-Type: multipart\/encrypted; protocol="application\/pgp-encrypted"/m)
    const structure = detectPgpMime(encrypted)
    expect(structure.kind).toBe('encrypted')
    if (structure.kind !== 'encrypted') return
    const recipients = await ring.encryptedTo(structure.armored)
    expect(recipients.some((item) => item.fingerprint === alice.fingerprint && item.available)).toBe(true)
    expect(recipients).toHaveLength(2)

    // The recipient (a separate keyring holding Bob's secret key) can read it.
    const bobSide = (await keyring()).ring
    await bobSide.importKeys(bob.privateKey.armor())
    await bobSide.importKeys(await ring.exportPublic(alice.fingerprint))
    await expect(bobSide.decrypt(structure.armored)).rejects.toBeInstanceOf(OpenPgpPassphraseRequired)
    await expect(bobSide.decrypt(structure.armored, 'wrong passphrase')).rejects.toThrow(/incorrect/)
    const decrypted = await bobSide.decrypt(structure.armored, PASS)
    expect(decrypted.signatures[0]).toMatchObject({ status: 'valid', fingerprint: alice.fingerprint, verification: 'unverified' })
    const inner = await PostalMime.parse(decrypted.data)
    expect(inner.text).toContain('Grüße — the plan is on.')
    expect(inner.attachments[0].filename).toBe('report.bin')
    const content = inner.attachments[0].content
    expect([...(typeof content === 'string' ? Buffer.from(content) : new Uint8Array(content))]).toEqual([0, 1, 2, 250, 255])
    // The passphrase stays cached for the next message.
    expect((await bobSide.decrypt(structure.armored)).data.length).toBeGreaterThan(0)
  })

  it('refuses to encrypt when any recipient key is missing, expired or revoked', async () => {
    const { ring, bob } = await setup()
    const mime = createMimeBuffer(draft(), 'alice@example.test').toString('utf8')
    const send = (recipients: string[]) => ring.protect(mime, { from: 'alice@example.test', recipients, options: { encrypt: true } })
    await expect(send(['bob@example.test', 'dave@example.test'])).rejects.toThrow(`No OpenPGP public key for: dave@example.test. ${NOT_SENT}`)
    const expired = await externalKey('erin@example.test', { date: new Date(Date.now() - 86_400_000 * 3), keyExpirationTime: 86_400 })
    await ring.importKeys(expired.publicKey.armor())
    expect((await ring.list()).find((key) => key.emails.includes('erin@example.test'))?.expired).toBe(true)
    await expect(send(['erin@example.test'])).rejects.toThrow(/has expired for: erin@example.test/)
    const revoked = await openpgp.revokeKey({ key: await openpgp.decryptKey({ privateKey: bob.privateKey, passphrase: PASS }), format: 'armored' })
    await ring.importKeys(revoked.publicKey)
    await expect(send(['bob@example.test'])).rejects.toThrow(/revoked for: bob@example.test/)
    // Encrypt-only needs no passphrase; it succeeds once the problems are gone.
    const frank = await externalKey('frank@example.test')
    await ring.importKeys(frank.publicKey.armor())
    expect(await send(['frank@example.test'])).toContain('BEGIN PGP MESSAGE')
  })

  it('selects the verified or chosen recipient key when several match', async () => {
    const { ring } = await setup()
    const older = await externalKey('gina@example.test', { date: new Date(Date.now() - 60_000) })
    const newer = await externalKey('gina@example.test')
    const [first] = (await ring.importKeys(older.publicKey.armor())).imported
    const [second] = (await ring.importKeys(newer.publicKey.armor())).imported
    expect((await ring.recipientKeys(['gina@example.test']))[0]).toMatchObject({ status: 'ok', fingerprint: second.fingerprint })
    expect((await ring.recipientKeys(['gina@example.test']))[0].candidates).toHaveLength(2)
    await ring.setVerification(first.fingerprint, 'verified')
    expect((await ring.recipientKeys(['Gina <GINA@example.test>']))[0].fingerprint).toBe(first.fingerprint)
    expect((await ring.recipientKeys(['gina@example.test'], { 'gina@example.test': second.fingerprint }))[0].fingerprint).toBe(second.fingerprint)
  })

  it('blocks signing and decryption while locked and clears cached passphrases on lock', async () => {
    let locked = false
    const { ring } = await keyring({ locked: () => locked })
    const alice = await ring.generate({ name: 'Alice', email: 'alice@example.test', passphrase: PASS })
    await ring.unlock(alice.fingerprint, PASS)
    expect((await ring.summary(alice.fingerprint)).unlocked).toBe(true)
    const mime = createMimeBuffer(draft(), 'alice@example.test').toString('utf8')
    locked = true
    await expect(ring.protect(mime, { from: 'alice@example.test', recipients: ['alice@example.test'], options: { sign: true } })).rejects.toThrow(/Unlock Aerio/)
    await expect(ring.unlock(alice.fingerprint, PASS)).rejects.toThrow(/Unlock Aerio/)
    await expect(ring.decrypt('x')).rejects.toThrow(/Unlock Aerio/)
    await expect(ring.importKeys('x')).rejects.toThrow(/Unlock Aerio/)
    ring.lock()
    locked = false
    expect((await ring.summary(alice.fingerprint)).unlocked).toBe(false)
    await expect(ring.protect(mime, { from: 'alice@example.test', recipients: ['alice@example.test'], options: { sign: true } })).rejects.toThrow(/Unlock your OpenPGP key/)
  })

  it('expires cached passphrases', async () => {
    let now = Date.now()
    const { ring } = await keyring({ now: () => now })
    const alice = await ring.generate({ name: 'Alice', email: 'alice@example.test', passphrase: PASS })
    await ring.unlock(alice.fingerprint, PASS)
    now += 11 * 60_000
    expect((await ring.summary(alice.fingerprint)).unlocked).toBe(false)
  })

  it('reports a missing signing key and leaves plaintext untouched when nothing is requested', async () => {
    const { ring } = await setup()
    const mime = createMimeBuffer(draft(), 'zed@example.test').toString('utf8')
    await expect(ring.protect(mime, { from: 'zed@example.test', recipients: ['bob@example.test'], options: { sign: true } })).rejects.toThrow(/No usable OpenPGP secret key for zed@example.test/)
    expect(await ring.protect(mime, { from: 'zed@example.test', recipients: [], options: {} })).toBe(mime)
  })
})

describe('OpenPGP interoperability fixtures', () => {
  it('verifies a PGP/MIME message built independently with a text-mode signature', async () => {
    const { ring } = await keyring()
    const signer = await externalKey('sam@example.test')
    await ring.importKeys(signer.publicKey.armor())
    const part = 'Content-Type: text/plain; charset=us-ascii\nContent-Transfer-Encoding: 7bit\n\nHello from another client.\n'
    const key = await openpgp.decryptKey({ privateKey: signer.privateKey, passphrase: PASS })
    const signature = await openpgp.sign({ message: await openpgp.createMessage({ text: part.trimEnd() }), signingKeys: key, detached: true })
    const raw = [
      'From: sam@example.test', 'Subject: Hi', 'MIME-Version: 1.0',
      'Content-Type: multipart/signed; micalg=pgp-sha512;', ' protocol="application/pgp-signature"; boundary="XYZ"', '',
      'Preamble', '--XYZ', part.trimEnd(), '--XYZ', 'Content-Type: application/pgp-signature', '', signature.trim(), '--XYZ--', ''
    ].join('\n')
    const structure = detectPgpMime(raw)
    expect(structure.kind).toBe('signed')
    if (structure.kind !== 'signed') return
    expect((await ring.verifyDetached(structure.signedPart, structure.signature))[0].status).toBe('valid')
    // An unknown signer is reported, not treated as valid.
    const empty = (await keyring()).ring
    expect((await empty.verifyDetached(structure.signedPart, structure.signature))[0].status).toBe('unknown-key')
  })

  it('reads inline cleartext-signed and inline encrypted messages', async () => {
    const { ring } = await keyring()
    const alice = await ring.generate({ name: 'Alice', email: 'alice@example.test', passphrase: PASS })
    const sender = await externalKey('sam@example.test')
    await ring.importKeys(sender.publicKey.armor())
    const signingKey = await openpgp.decryptKey({ privateKey: sender.privateKey, passphrase: PASS })
    const cleartext = await openpgp.sign({ message: await openpgp.createCleartextMessage({ text: 'Signed inline\n- dashed line' }), signingKeys: signingKey })
    const signedBlock = inlinePgpBlock(`Hi\n\n${cleartext}\nfooter`)
    expect(signedBlock?.kind).toBe('inline-signed')
    const verified = await ring.verifyCleartext(signedBlock!.block)
    expect(verified.text).toBe('Signed inline\n- dashed line')
    expect(verified.signatures[0].status).toBe('valid')
    const encrypted = await openpgp.encrypt({ message: await openpgp.createMessage({ text: 'Inline secret' }), encryptionKeys: await openpgp.readKey({ armoredKey: await ring.exportPublic(alice.fingerprint) }) })
    const block = inlinePgpBlock(`> quoted\n${encrypted}`)
    expect(block?.kind).toBe('inline-encrypted')
    await ring.unlock(alice.fingerprint, PASS)
    expect(Buffer.from((await ring.decrypt(block!.block)).data).toString()).toBe('Inline secret')
    expect(inlinePgpBlock('nothing here')).toBeUndefined()
  })

  it('rejects messages encrypted to someone else', async () => {
    const { ring } = await keyring()
    const other = await externalKey('other@example.test')
    const encrypted = await openpgp.encrypt({ message: await openpgp.createMessage({ text: 'Not yours' }), encryptionKeys: other.publicKey })
    await expect(ring.decrypt(encrypted)).rejects.toThrow(/not encrypted to any private key/)
    expect((await ring.encryptedTo(encrypted))[0].available).toBe(false)
  })

  it('splits entities without disturbing their headers', () => {
    expect(parseEntity('A: 1\r\n folded\r\nB: 2\r\n\r\nbody').headers).toEqual(['A: 1 folded', 'B: 2'])
  })
})
