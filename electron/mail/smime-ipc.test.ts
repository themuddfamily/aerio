import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
import { parseCertificate } from './smime-certificate'
import { assertSmimeSendable, protectOutgoingMessage, registerSmime } from './smime-ipc'
import { SmimeStore } from './smime-store'
import { pkcs12, testPki } from './smime-test-fixtures'

const folder = mkdtempSync(join(tmpdir(), 'aerio-smime-ipc-'))
afterAll(() => rmSync(folder, { recursive: true, force: true }))
const PASS = 'correct horse battery'
const storage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (value: string) => Buffer.from(value).reverse(),
  decryptString: (value: Buffer) => Buffer.from(value).reverse().toString()
}
const ref = { accountId: 'account', threadId: 'thread', messageId: 'message' }

let pki: ReturnType<typeof testPki>
beforeAll(() => { pki = testPki() })
let locked = false
let source = ''
let store: SmimeStore
const worker = {
  request: vi.fn(async (command: any): Promise<any> => {
    if (command.type === 'accounts:list') return [{ id: 'account', email: 'alice@example.test', displayName: 'Alice' }]
    if (command.type === 'identities:list') return [{ id: 'alias', email: 'alias@example.test', name: '' }]
    if (command.type === 'mail:source') return { headers: '', source }
    throw new Error(`unexpected ${command.type}`)
  })
}
const invoke = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({ sender: {} }, ...args)
const fingerprintOf = (der: Buffer) => parseCertificate(der).fingerprint

beforeEach(() => {
  locked = false
  mocks.handlers.clear()
  mocks.showOpenDialog.mockReset()
  mocks.showSaveDialog.mockReset()
  store = new SmimeStore(join(mkdtempSync(join(folder, 'store-')), 'smime-certificates.dat'), { storage, isLocked: () => locked, systemRoots: () => [] })
  registerSmime({ store, worker: () => worker })
})

/** Imports Alice's PKCS#12 through the file dialog, Bob's certificate, and trusts the root. */
async function withCertificates() {
  const p12 = join(folder, 'alice.p12')
  writeFileSync(p12, pkcs12(pki.alice, PASS, [pki.intermediate]))
  mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [p12] })
  await expect(invoke('smime:import-file')).resolves.toEqual({ imported: [], needsPassword: true })
  await expect(invoke('smime:retry-import', 'wrong password')).resolves.toMatchObject({ needsPassword: true, error: expect.stringMatching(/incorrect/) })
  const imported = await invoke('smime:retry-import', PASS)
  expect(imported.imported[0]).toMatchObject({ emails: ['alice@example.test'], hasPrivateKey: true })
  await expect(invoke('smime:retry-import', PASS)).rejects.toThrow(/Choose the certificate file again/)
  await invoke('smime:import-text', pki.bob.pem + pki.root.pem)
  await invoke('smime:trust', fingerprintOf(pki.root.der), true)
  return imported.imported[0].fingerprint as string
}

const message = (attachmentPaths: string[] = []) => createMimeBuffer({ accountId: 'account', to: ['bob@example.test'], cc: [], bcc: [], subject: 'Hello', text: 'Secret body', html: '<p>Secret <img src="https://tracker.example/p.gif"> body</p>', attachmentPaths }, 'Alice <alice@example.test>').toString('utf8')

describe('S/MIME IPC', () => {
  it('checks a draft before it is queued and refuses OpenPGP plus S/MIME', async () => {
    await expect(invoke('smime:status')).resolves.toMatchObject({ secureStorage: true, locked: false, certificates: [] })
    const plain = { accountId: 'account', to: ['bob@example.test'], cc: [], bcc: [], subject: '', text: '', attachmentPaths: [] }
    await expect(assertSmimeSendable(store, worker, plain)).resolves.toBeUndefined()
    await expect(assertSmimeSendable(store, worker, { ...plain, smime: { sign: true, encrypt: true } })).rejects.toThrow(/No usable S\/MIME certificate for Alice <alice@example.test>.*No S\/MIME certificate for: bob@example.test.*draft is kept/)
    await expect(assertSmimeSendable(store, worker, { ...plain, smime: { sign: true }, openPgp: { encrypt: true } })).rejects.toThrow(/either OpenPGP or S\/MIME/)
    const alice = await withCertificates()
    const check = await invoke('smime:preflight', { accountId: 'account', recipients: ['Bob <bob@example.test>'], options: { sign: true, encrypt: true } })
    expect(check).toMatchObject({ ready: false, problems: ['Unlock your S/MIME certificate with its passphrase.'], warnings: [], signer: { fingerprint: alice, unlocked: false }, recipients: [{ address: 'bob@example.test', status: 'ok' }] })
    await invoke('smime:unlock', alice, PASS)
    await expect(assertSmimeSendable(store, worker, { ...plain, smime: { sign: true, encrypt: true } })).resolves.toBeUndefined()
    expect((await invoke('smime:preflight', { accountId: 'account', fromIdentityId: 'alias', recipients: ['bob@example.test'], options: { sign: true, encrypt: true } }))).toMatchObject({
      problems: [expect.stringMatching(/alias@example.test/)], warnings: [expect.stringMatching(/Sent copy/)]
    })
    await invoke('smime:trust', fingerprintOf(pki.root.der), false)
    expect((await invoke('smime:preflight', { accountId: 'account', recipients: ['bob@example.test'], options: { sign: true } })).warnings[0]).toMatch(/not trusted/)
    locked = true
    expect((await invoke('smime:preflight', { accountId: 'account', recipients: [], options: { encrypt: true } })).problems).toEqual(expect.arrayContaining(['Unlock Aerio first.', 'Add at least one recipient.']))
    await expect(invoke('smime:preflight', { accountId: 'account', recipients: 'x' })).rejects.toThrow(/invalid/)
  })

  it('routes delivery to S/MIME or OpenPGP and never both', async () => {
    const openPgp = { protect: vi.fn(async () => 'PGP') }
    const smime = { protect: vi.fn(async () => 'SMIME') }
    const base = { message: 'm', from: 'a@example.test', recipients: ['b@example.test'] }
    await expect(protectOutgoingMessage(() => openPgp, () => smime, { ...base, options: {}, smime: { encrypt: true } })).resolves.toBe('SMIME')
    expect(smime.protect).toHaveBeenCalledWith('m', { from: 'a@example.test', recipients: ['b@example.test'], options: { encrypt: true } })
    await expect(protectOutgoingMessage(() => openPgp, () => smime, { ...base, options: { sign: true } })).resolves.toBe('PGP')
    expect(() => protectOutgoingMessage(() => openPgp, () => smime, { ...base, options: { sign: true }, smime: { sign: true } })).toThrow(/not both/)
  })

  it('inspects, decrypts with a passphrase prompt, sanitizes HTML, and saves attachments', async () => {
    const alice = await withCertificates()
    await invoke('smime:unlock', alice, PASS)
    const attachment = join(folder, 'notes.txt')
    writeFileSync(attachment, 'attachment body')
    const encrypted = await store.protect(message([attachment]), { from: 'alice@example.test', recipients: ['bob@example.test'], options: { sign: true, encrypt: true } })
    await invoke('smime:forget')
    source = encrypted
    await expect(invoke('smime:inspect', ref)).resolves.toMatchObject({ kind: 'encrypted', encryptedTo: expect.arrayContaining([expect.objectContaining({ available: true })]) })
    await expect(invoke('smime:decrypt', ref)).resolves.toMatchObject({ status: 'passphrase-required', fingerprint: alice })
    await expect(invoke('smime:decrypt', ref, 'wrong passphrase')).resolves.toMatchObject({ status: 'passphrase-required', error: expect.stringMatching(/incorrect/) })
    await expect(invoke('smime:save-attachment', ref, 0)).rejects.toThrow(/Decrypt the message again/)
    const decrypted = await invoke('smime:decrypt', ref, PASS)
    expect(decrypted).toMatchObject({ status: 'decrypted', encrypted: true, text: expect.stringContaining('Secret body'), attachments: [{ index: 0, filename: 'notes.txt', size: 15 }], signatures: [{ status: 'valid' }] })
    expect(decrypted.sanitizedHtml).not.toContain('tracker.example')
    const target = join(folder, 'saved.txt')
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })
    await expect(invoke('smime:save-attachment', ref, 0)).resolves.toEqual({ savedPath: target })
    expect(readFileSync(target, 'utf8')).toBe('attachment body')
    await expect(invoke('smime:save-attachment', ref, 4)).rejects.toThrow(/no longer available/)
    await expect(invoke('smime:save-attachment', ref, -1)).rejects.toThrow(/valid attachment/)
    await expect(invoke('smime:inspect', { accountId: '', threadId: 't', messageId: 'm' })).rejects.toThrow(/Invalid message reference/)
    locked = true
    await expect(invoke('smime:inspect', ref)).rejects.toThrow(/Unlock Aerio/)
  })

  it('exports certificates and password-protected PKCS#12, and manages trust and defaults', async () => {
    const alice = await withCertificates()
    const cer = join(folder, 'alice.cer')
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: cer })
    await expect(invoke('smime:export-certificate', alice)).resolves.toEqual({ savedPath: cer })
    expect(readFileSync(cer, 'utf8')).toContain('BEGIN CERTIFICATE')
    const p12 = join(folder, 'backup.p12')
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: p12 })
    await expect(invoke('smime:export-pkcs12', alice, PASS, 'backup password')).resolves.toEqual({ savedPath: p12 })
    expect(readFileSync(p12).length).toBeGreaterThan(1000)
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: true })
    await expect(invoke('smime:export-pkcs12', alice, PASS, 'backup password')).resolves.toEqual({})
    await expect(invoke('smime:export-certificate', 'nope')).rejects.toThrow(/valid S\/MIME certificate/)
    await invoke('smime:set-identity-default', { accountId: 'account' }, { sign: true, encrypt: true })
    expect(await invoke('smime:identity-default', { accountId: 'account' })).toEqual({ sign: true, encrypt: true })
    expect(store.identityDefault('alice@example.test')).toEqual({ sign: true, encrypt: true })
    expect(await invoke('smime:identity-default', { accountId: 'account', fromIdentityId: 'alias' })).toBeUndefined()
    await invoke('smime:set-identity-default', { accountId: 'account' }, null)
    expect(await invoke('smime:identity-default', { accountId: 'account' })).toBeUndefined()
    await expect(invoke('smime:identity-default', null)).rejects.toThrow(/sending account/)
    const after = await invoke('smime:delete', fingerprintOf(pki.bob.der))
    expect(after.certificates.map((item: { emails: string[] }) => item.emails[0])).not.toContain('bob@example.test')
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    await expect(invoke('smime:import-file')).resolves.toBeUndefined()
    await expect(invoke('smime:import-text', '')).rejects.toThrow(/Paste a PEM/)
  })
})
