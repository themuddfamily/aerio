import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as openpgp from 'openpgp'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  showSaveDialog: vi.fn(),
  showOpenDialog: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: (...args: any[]) => any) => mocks.handlers.set(channel, handler)) },
  dialog: { showSaveDialog: mocks.showSaveDialog, showOpenDialog: mocks.showOpenDialog },
  BrowserWindow: { fromWebContents: vi.fn(() => undefined), getAllWindows: vi.fn(() => []) },
  shell: {}
}))

import { createMimeBuffer } from './mime-builder'
import { OpenPgpKeyring } from './openpgp-keyring'
import { assertOpenPgpSendable, registerOpenPgp } from './openpgp-ipc'

const folder = mkdtempSync(join(tmpdir(), 'aerio-openpgp-ipc-'))
afterAll(() => rmSync(folder, { recursive: true, force: true }))
const PASS = 'correct horse battery'
const storage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (value: string) => Buffer.from(value).reverse(),
  decryptString: (value: Buffer) => Buffer.from(value).reverse().toString()
}
const ref = { accountId: 'account', threadId: 'thread', messageId: 'message' }

let locked = false
let source = ''
let keyring: OpenPgpKeyring
const worker = {
  request: vi.fn(async (command: any): Promise<any> => {
    if (command.type === 'accounts:list') return [{ id: 'account', email: 'alice@example.test', displayName: 'Alice' }]
    if (command.type === 'identities:list') return [{ id: 'alias', email: 'alias@example.test', name: '' }]
    if (command.type === 'mail:source') return { headers: '', source }
    throw new Error(`unexpected ${command.type}`)
  })
}
const invoke = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({ sender: {} }, ...args)

beforeEach(() => {
  locked = false
  mocks.handlers.clear()
  keyring = new OpenPgpKeyring(join(mkdtempSync(join(folder, 'ring-')), 'openpgp-keyring.dat'), { storage, isLocked: () => locked })
  registerOpenPgp({ keyring, worker: () => worker })
})

async function withKeys() {
  const alice = await invoke('openpgp:generate', { name: 'Alice', email: 'alice@example.test', passphrase: PASS })
  const bob = await openpgp.generateKey({ type: 'ecc', userIDs: [{ email: 'bob@example.test' }], passphrase: PASS, format: 'object' })
  await invoke('openpgp:import-text', bob.publicKey.armor())
  return { alice, bob }
}

const message = (attachmentPaths: string[] = []) => createMimeBuffer({ accountId: 'account', to: ['bob@example.test'], cc: [], bcc: [], subject: 'Hello', text: 'Secret body', html: '<p>Secret <img src="https://tracker.example/p.gif"> body</p>', attachmentPaths }, 'Alice <alice@example.test>').toString('utf8')

describe('OpenPGP IPC', () => {
  it('reports status and checks a draft before it is queued', async () => {
    await expect(invoke('openpgp:status')).resolves.toMatchObject({ secureStorage: true, locked: false, keys: [] })
    const plain = { accountId: 'account', to: ['bob@example.test'], cc: [], bcc: [], subject: '', text: '', attachmentPaths: [] }
    await expect(assertOpenPgpSendable(keyring, worker, plain)).resolves.toBeUndefined()
    await expect(assertOpenPgpSendable(keyring, worker, { ...plain, openPgp: { sign: true, encrypt: true } })).rejects.toThrow(/No usable OpenPGP secret key for Alice <alice@example.test>.*No OpenPGP public key for: bob@example.test.*draft is kept/)
    const { alice } = await withKeys()
    const check = await invoke('openpgp:preflight', { accountId: 'account', recipients: ['Bob <bob@example.test>'], options: { sign: true, encrypt: true } })
    expect(check).toMatchObject({ ready: false, problems: ['Unlock your signing key with its passphrase.'], signer: { fingerprint: alice.fingerprint, unlocked: false }, recipients: [{ address: 'bob@example.test', status: 'ok' }] })
    await invoke('openpgp:unlock', alice.fingerprint, PASS)
    await expect(assertOpenPgpSendable(keyring, worker, { ...plain, openPgp: { sign: true, encrypt: true } })).resolves.toBeUndefined()
    // An alias without a key cannot sign.
    expect((await invoke('openpgp:preflight', { accountId: 'account', fromIdentityId: 'alias', recipients: ['bob@example.test'], options: { sign: true } })).problems[0]).toMatch(/alias@example.test/)
    locked = true
    expect((await invoke('openpgp:preflight', { accountId: 'account', recipients: [], options: { encrypt: true } })).problems).toEqual(expect.arrayContaining(['Unlock Aerio first.', 'Add at least one recipient.']))
    await expect(invoke('openpgp:preflight', { accountId: 'account', recipients: 'x' })).rejects.toThrow(/invalid/)
    await expect(invoke('openpgp:preflight', { accountId: 'missing', recipients: [], options: {} })).rejects.toThrow(/sending account/)
  })

  it('verifies signed mail and lists the keys an encrypted message is for', async () => {
    const { alice } = await withKeys()
    await invoke('openpgp:unlock', alice.fingerprint, PASS)
    source = await keyring.protect(message(), { from: 'alice@example.test', recipients: ['bob@example.test'], options: { sign: true } })
    await expect(invoke('openpgp:inspect', ref)).resolves.toMatchObject({ kind: 'signed', signatures: [{ status: 'valid', fingerprint: alice.fingerprint }] })
    source = await keyring.protect(message(), { from: 'alice@example.test', recipients: ['bob@example.test'], options: { encrypt: true } })
    const inspected = await invoke('openpgp:inspect', ref)
    expect(inspected.kind).toBe('encrypted')
    expect(inspected.encryptedTo).toContainEqual(expect.objectContaining({ fingerprint: alice.fingerprint, available: true }))
    source = 'Subject: plain\r\n\r\nJust text'
    await expect(invoke('openpgp:inspect', ref)).resolves.toEqual({ kind: 'none' })
    source = 'Subject: inline\r\n\r\n-----BEGIN PGP MESSAGE-----\r\n\r\nbroken\r\n-----END PGP MESSAGE-----\r\n'
    await expect(invoke('openpgp:inspect', ref)).resolves.toMatchObject({ kind: 'inline-encrypted', error: expect.stringMatching(/could not be read/) })
    locked = true
    await expect(invoke('openpgp:inspect', ref)).rejects.toThrow(/Unlock Aerio/)
    await expect(invoke('openpgp:inspect', { accountId: '' })).rejects.toThrow(/Invalid message/)
  })

  it('asks for a passphrase, decrypts with sanitized HTML, and saves decrypted attachments', async () => {
    const { alice } = await withKeys()
    const attachment = join(folder, 'plan.txt')
    writeFileSync(attachment, 'attachment secret')
    source = await keyring.protect(message([attachment]), { from: 'alice@example.test', recipients: ['bob@example.test'], options: { encrypt: true } })
    await expect(invoke('openpgp:decrypt', ref)).resolves.toEqual({ status: 'passphrase-required', fingerprint: alice.fingerprint, userId: 'Alice <alice@example.test>' })
    await expect(invoke('openpgp:decrypt', ref, 'wrong passphrase')).resolves.toMatchObject({ status: 'passphrase-required', error: expect.stringMatching(/incorrect/) })
    await expect(invoke('openpgp:save-attachment', ref, 0)).rejects.toThrow(/Decrypt the message again/)
    const decrypted = await invoke('openpgp:decrypt', ref, PASS)
    expect(decrypted).toMatchObject({ status: 'decrypted', text: expect.stringContaining('Secret body'), attachments: [{ index: 0, filename: 'plan.txt', size: 17 }], signatures: [] })
    expect(decrypted.sanitizedHtml).not.toContain('https://tracker.example')
    const target = join(folder, 'saved-plan.txt')
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })
    await expect(invoke('openpgp:save-attachment', ref, 0)).resolves.toEqual({ savedPath: target })
    expect(readFileSync(target, 'utf8')).toBe('attachment secret')
    await expect(invoke('openpgp:save-attachment', ref, 4)).rejects.toThrow(/no longer available/)
    await expect(invoke('openpgp:save-attachment', ref, -1)).rejects.toThrow(/valid attachment/)
    source = 'Subject: plain\r\n\r\nJust text'
    await expect(invoke('openpgp:decrypt', ref)).rejects.toThrow(/not OpenPGP encrypted/)
  })

  it('decrypts inline messages and nested sign-then-encrypt entities', async () => {
    const { alice, bob } = await withKeys()
    const recipient = await openpgp.readKey({ armoredKey: await keyring.exportPublic(alice.fingerprint) })
    const inline = await openpgp.encrypt({ message: await openpgp.createMessage({ text: 'Inline only' }), encryptionKeys: recipient })
    source = `Subject: inline\r\nContent-Type: text/plain\r\n\r\n${inline.replaceAll('\n', '\r\n')}`
    await invoke('openpgp:unlock', alice.fingerprint, PASS)
    await expect(invoke('openpgp:decrypt', ref)).resolves.toMatchObject({ status: 'decrypted', text: 'Inline only', attachments: [] })
    // Another client: a multipart/signed entity from Bob, then encrypted to Alice.
    const bobKey = await openpgp.decryptKey({ privateKey: bob.privateKey, passphrase: PASS })
    const part = 'Content-Type: text/plain\r\n\r\nNested hello'
    const signature = await openpgp.sign({ message: await openpgp.createMessage({ binary: Buffer.from(part) }), signingKeys: bobKey, detached: true })
    const signed = `Content-Type: multipart/signed; micalg=pgp-sha256; protocol="application/pgp-signature"; boundary="b"\r\n\r\n--b\r\n${part}\r\n--b\r\nContent-Type: application/pgp-signature\r\n\r\n${signature}\r\n--b--\r\n`
    const armored = await openpgp.encrypt({ message: await openpgp.createMessage({ binary: Buffer.from(signed) }), encryptionKeys: recipient })
    source = `Subject: nested\r\nContent-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="e"\r\n\r\n--e\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n--e\r\nContent-Type: application/octet-stream\r\n\r\n${armored}\r\n--e--\r\n`
    const decrypted = await invoke('openpgp:decrypt', ref)
    expect(decrypted).toMatchObject({ status: 'decrypted', text: expect.stringContaining('Nested hello'), attachments: [] })
    expect(decrypted.signatures).toEqual([expect.objectContaining({ status: 'valid', userIds: ['<bob@example.test>'] })])
  })

  it('imports and exports key files and manages verification', async () => {
    const { alice } = await withKeys()
    const keyFile = join(folder, 'carol.asc')
    const carol = await openpgp.generateKey({ type: 'ecc', userIDs: [{ email: 'carol@example.test' }], format: 'object' })
    writeFileSync(keyFile, carol.publicKey.armor())
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [keyFile] })
    await expect(invoke('openpgp:import-file')).resolves.toMatchObject({ imported: [{ emails: ['carol@example.test'] }] })
    writeFileSync(keyFile, carol.privateKey.write())
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [keyFile] })
    await expect(invoke('openpgp:import-file')).resolves.toEqual({ imported: [], needsPassphrase: true })
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    await expect(invoke('openpgp:import-file')).resolves.toBeUndefined()
    expect(() => invoke('openpgp:import-text', '  ')).toThrow(/Paste/)

    const publicPath = join(folder, 'alice.asc')
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: publicPath })
    await invoke('openpgp:export-public', alice.fingerprint)
    expect(readFileSync(publicPath, 'utf8')).toContain('PUBLIC KEY BLOCK')
    const secretPath = join(folder, 'alice-secret.asc')
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: secretPath })
    await invoke('openpgp:export-private', alice.fingerprint, PASS)
    expect((await openpgp.readPrivateKey({ armoredKey: readFileSync(secretPath, 'utf8') })).isDecrypted()).toBe(false)
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: true })
    await expect(invoke('openpgp:export-public', alice.fingerprint)).resolves.toEqual({})
    await expect(invoke('openpgp:export-public', 'nope')).rejects.toThrow(/valid OpenPGP key/)

    expect((await invoke('openpgp:verification', alice.fingerprint, 'unverified')).verification).toBe('unverified')
    await invoke('openpgp:unlock', alice.fingerprint, PASS)
    await invoke('openpgp:forget')
    expect((await keyring.summary(alice.fingerprint)).unlocked).toBe(false)
    const after = await invoke('openpgp:delete', alice.fingerprint)
    expect(after.keys.map((key: { fingerprint: string }) => key.fingerprint)).not.toContain(alice.fingerprint)
  })
})
