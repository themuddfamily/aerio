// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary, MailDraftResult } from '../mail-types'
import { messageLooksOpenPgp, type OpenPgpKeySummary, type OpenPgpPreflight } from '../openpgp-types'
import { formatFingerprint, keyStatusLabel, signatureSummary } from '../lib/openpgp-display'
import { ContextMenuProvider } from './ContextMenu'
import MailComposeModal from './MailComposeModal'
import MailComposeOpenPgpControl from './MailComposeOpenPgpControl'
import OpenPgpKeyManager from './OpenPgpKeyManager'
import OpenPgpMessageNotice from './OpenPgpMessageNotice'

const FP = 'ABCD'.repeat(10)
const key = (changes: Partial<OpenPgpKeySummary> = {}): OpenPgpKeySummary => ({
  fingerprint: FP, keyId: FP.slice(-16), userIds: ['Alice <alice@example.test>'], emails: ['alice@example.test'], algorithm: 'eddsaLegacy (ed25519Legacy)',
  createdAt: '2026-10-01T00:00:00Z', expired: false, revoked: false, hasPrivateKey: true, canEncrypt: true, canSign: true, verification: 'verified', unlocked: false, ...changes
})
const preflight = (changes: Partial<OpenPgpPreflight> = {}): OpenPgpPreflight => ({ ready: true, problems: [], from: 'Me <me@example.test>', recipients: [], ...changes })
const openPgp = {
  status: vi.fn(), generate: vi.fn(), importText: vi.fn(), importFile: vi.fn(), exportPublic: vi.fn(), exportPrivate: vi.fn(), delete: vi.fn(),
  setVerification: vi.fn(), unlock: vi.fn(), forgetPassphrases: vi.fn(), preflight: vi.fn(), inspect: vi.fn(), decrypt: vi.fn(), saveAttachment: vi.fn()
}
const result = (status: MailDraftResult['status'] = 'synced'): MailDraftResult => ({ id: 'draft', status, updatedAt: '2026-10-17T10:00:00Z' })
const mail = {
  mail: { suggestRecipients: vi.fn(async () => []) },
  drafts: { save: vi.fn(async () => result()), send: vi.fn(async () => result('send-pending')), schedule: vi.fn(), delete: vi.fn(), stageMessageAttachments: vi.fn() }
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'aerio', { configurable: true, value: { openPgp, mail } })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => true) })
})

describe('OpenPGP display helpers', () => {
  it('describes signatures, fingerprints, key states and candidate messages', () => {
    expect(formatFingerprint('abcd1234')).toBe('ABCD 1234')
    expect(signatureSummary({ status: 'valid', keyId: 'K', userIds: ['Al'], verification: 'verified' })).toMatchObject({ tone: 'good' })
    expect(signatureSummary({ status: 'valid', keyId: 'K', userIds: ['Al'] }).text).toMatch(/not verified/)
    expect(signatureSummary({ status: 'unknown-key', keyId: 'K' }).text).toMatch(/not in your keyring/)
    expect(signatureSummary({ status: 'expired-key', keyId: 'K', detail: 'Key expired' }).tone).toBe('warning')
    expect(signatureSummary({ status: 'revoked-key', keyId: 'K' }).tone).toBe('bad')
    expect(signatureSummary({ status: 'invalid', keyId: 'K' }).text).toMatch(/may have been changed/)
    expect(keyStatusLabel(key({ revoked: true }))).toBe('Revoked')
    expect(keyStatusLabel(key({ expired: true }))).toBe('Expired')
    expect(keyStatusLabel(key({ canEncrypt: false, canSign: false }))).toBe('Unusable')
    expect(keyStatusLabel(key({ hasPrivateKey: false }))).toBe('Public key')
    expect(messageLooksOpenPgp({ text: 'hi', attachments: [{ filename: 'encrypted.asc', mimeType: 'application/octet-stream' }] })).toBe(true)
    expect(messageLooksOpenPgp({ text: 'hi', attachments: [{ filename: 'signature.asc', mimeType: 'application/pgp-signature' }] })).toBe(true)
    expect(messageLooksOpenPgp({ text: '-----BEGIN PGP SIGNED MESSAGE-----', attachments: [] })).toBe(true)
    expect(messageLooksOpenPgp({ text: 'hi', attachments: [{ filename: 'notes.txt', mimeType: 'text/plain' }] })).toBe(false)
  })
})

describe('MailComposeOpenPgpControl', () => {
  it('toggles sign and encrypt, shows key problems, chooses keys and unlocks the signer', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    openPgp.preflight.mockResolvedValue(preflight({
      ready: false, problems: ['Unlock your signing key with its passphrase.', 'No OpenPGP public key for: zed@example.test.'],
      signer: { fingerprint: FP, userId: 'Me <me@example.test>', unlocked: false },
      recipients: [
        { address: 'ada@example.test', status: 'ok', fingerprint: FP, verification: 'unverified', candidates: [{ fingerprint: FP, userId: 'Ada', verification: 'unverified' }, { fingerprint: 'B'.repeat(40), userId: 'Ada (work)', verification: 'verified' }] },
        { address: 'zed@example.test', status: 'missing', candidates: [] }
      ]
    }))
    const { rerender } = render(<MailComposeOpenPgpControl accountId="account" recipients={['ada@example.test', 'zed@example.test']} onChange={onChange} />)
    await user.click(screen.getByLabelText('OpenPGP sign and encrypt', { selector: 'summary' }))
    await user.click(screen.getByRole('checkbox', { name: 'Encrypt with OpenPGP' }))
    expect(onChange).toHaveBeenLastCalledWith({ encrypt: true })
    rerender(<MailComposeOpenPgpControl accountId="account" recipients={['ada@example.test', 'zed@example.test']} value={{ sign: true, encrypt: true }} onChange={onChange} />)
    expect(await screen.findByText('No OpenPGP public key for: zed@example.test.')).toBeInTheDocument()
    expect(openPgp.preflight).toHaveBeenCalledWith({ accountId: 'account', fromIdentityId: undefined, recipients: ['ada@example.test', 'zed@example.test'], options: { sign: true, encrypt: true } })
    expect(screen.getByText(/zed@example.test: no public key/)).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Key for ada@example.test' }), 'B'.repeat(40))
    expect(onChange).toHaveBeenLastCalledWith({ sign: true, encrypt: true, recipientKeys: { 'ada@example.test': 'B'.repeat(40) } })
    openPgp.unlock.mockRejectedValueOnce(new Error("Error invoking remote method 'openpgp:unlock': Error: The passphrase for this OpenPGP key is incorrect"))
    await user.type(screen.getByLabelText('Signing key passphrase'), 'bad{Enter}')
    expect(await screen.findByText('The passphrase for this OpenPGP key is incorrect')).toBeInTheDocument()
    openPgp.unlock.mockResolvedValueOnce(key({ unlocked: true }))
    openPgp.preflight.mockResolvedValue(preflight({ signer: { fingerprint: FP, userId: 'Me', unlocked: true } }))
    await user.clear(screen.getByLabelText('Signing key passphrase'))
    await user.type(screen.getByLabelText('Signing key passphrase'), 'correct horse')
    await user.click(screen.getByRole('button', { name: 'Unlock' }))
    expect(openPgp.unlock).toHaveBeenLastCalledWith(FP, 'correct horse')
    expect(await screen.findByText(/It will not be sent unprotected/)).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'Sign with OpenPGP' }))
    expect(onChange).toHaveBeenLastCalledWith({ encrypt: true })
  }, 20_000) // Many typed interactions run slowly under coverage and on CI hosts.

  it('carries the choice through the composer and shows the refusal when sending fails', async () => {
    const user = userEvent.setup()
    const onToast = vi.fn()
    openPgp.preflight.mockResolvedValue(preflight())
    mail.drafts.send.mockRejectedValueOnce(new Error("Error invoking remote method 'mail:drafts:send': Error: No OpenPGP public key for: ada@example.test. The message was not sent; your draft is kept."))
    const account: MailAccountSummary = { id: 'account', provider: 'imap', email: 'me@example.test', displayName: 'Me', color: '#123456', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true }
    const onClose = vi.fn()
    render(<ContextMenuProvider><MailComposeModal accounts={[account]} onClose={onClose} onSent={vi.fn()} onToast={onToast} /></ContextMenuProvider>)
    await user.type(screen.getByPlaceholderText('name@example.com'), 'ada@example.test')
    await user.click(screen.getByLabelText('OpenPGP sign and encrypt', { selector: 'summary' }))
    await user.click(screen.getByRole('checkbox', { name: 'Encrypt with OpenPGP' }))
    await user.click(screen.getByRole('button', { name: /^Send$/ }))
    await waitFor(() => expect(mail.drafts.send).toHaveBeenCalledWith(expect.objectContaining({ openPgp: { encrypt: true } })))
    expect(onToast).toHaveBeenCalledWith('No OpenPGP public key for: ada@example.test. The message was not sent; your draft is kept.')
    expect(onClose).not.toHaveBeenCalled()
  }, 20_000)

  it('renders nothing without the OpenPGP bridge', () => {
    Object.defineProperty(window, 'aerio', { configurable: true, value: {} })
    const { container } = render(<MailComposeOpenPgpControl accountId="account" recipients={[]} onChange={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('OpenPgpMessageNotice', () => {
  const base = { accountId: 'account', threadId: 'thread', id: 'message', text: '', attachments: [{ id: 'a', messageId: 'message', filename: 'encrypted.asc', mimeType: 'application/octet-stream', size: 10 }] }

  it('skips ordinary messages without asking the main process', () => {
    const { container } = render(<OpenPgpMessageNotice message={{ ...base, attachments: [] }} />)
    expect(container).toBeEmptyDOMElement()
    expect(openPgp.inspect).not.toHaveBeenCalled()
  })

  it('verifies signed mail and reports bad signatures', async () => {
    openPgp.inspect.mockResolvedValueOnce({ kind: 'signed', signatures: [{ status: 'valid', keyId: 'K', fingerprint: FP, userIds: ['Alice'], verification: 'verified', signedAt: '2026-10-17T10:00:00Z' }] })
    const { unmount } = render(<OpenPgpMessageNotice message={{ ...base, attachments: [{ ...base.attachments[0], filename: 'signature.asc', mimeType: 'application/pgp-signature' }] }} />)
    expect(await screen.findByText(/Valid signature from Alice. You verified/)).toBeInTheDocument()
    expect(screen.getByText(/OpenPGP signed message/)).toBeInTheDocument()
    unmount()
    openPgp.inspect.mockResolvedValueOnce({ kind: 'inline-signed', signatures: [{ status: 'invalid', keyId: 'K', userIds: ['Alice'] }] })
    render(<OpenPgpMessageNotice message={{ ...base, text: '-----BEGIN PGP SIGNED MESSAGE-----', attachments: [] }} />)
    expect(await screen.findByText(/not valid/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveClass('openpgp-bad')
  })

  it('asks for a passphrase, decrypts in place and saves decrypted attachments', async () => {
    const user = userEvent.setup()
    openPgp.inspect.mockResolvedValue({ kind: 'encrypted', encryptedTo: [{ keyId: 'K', fingerprint: FP, available: true }] })
    openPgp.decrypt
      .mockResolvedValueOnce({ status: 'passphrase-required', fingerprint: FP, userId: 'Alice' })
      .mockResolvedValueOnce({ status: 'passphrase-required', fingerprint: FP, userId: 'Alice', error: 'The passphrase for this OpenPGP key is incorrect' })
      .mockResolvedValueOnce({ status: 'decrypted', text: 'plain', sanitizedHtml: '<p>The <strong>secret</strong></p>', attachments: [{ index: 0, filename: 'plan.pdf', mimeType: 'application/pdf', size: 2048 }], signatures: [] })
    openPgp.saveAttachment.mockRejectedValueOnce(new Error('Decrypt the message again before saving its attachments'))
    render(<OpenPgpMessageNotice message={base} />)
    await user.click(await screen.findByRole('button', { name: 'Decrypt' }))
    expect(openPgp.decrypt).toHaveBeenLastCalledWith({ accountId: 'account', threadId: 'thread', messageId: 'message' }, undefined)
    await user.type(await screen.findByLabelText('Key passphrase'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Unlock and decrypt' }))
    expect(await screen.findByText('The passphrase for this OpenPGP key is incorrect')).toBeInTheDocument()
    await user.clear(screen.getByLabelText('Key passphrase'))
    await user.type(screen.getByLabelText('Key passphrase'), 'right{Enter}')
    expect(await screen.findByText('secret')).toBeInTheDocument()
    expect(screen.getByText(/not signed, so its sender cannot be confirmed/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save…' }))
    expect(openPgp.saveAttachment).toHaveBeenCalledWith({ accountId: 'account', threadId: 'thread', messageId: 'message' }, 0)
    expect(await screen.findByText(/Decrypt the message again/)).toBeInTheDocument()
  }, 20_000)

  it('explains messages encrypted to someone else and inspection failures', async () => {
    openPgp.inspect.mockResolvedValueOnce({ kind: 'encrypted', encryptedTo: [{ keyId: 'K', available: false }] })
    const { unmount } = render(<OpenPgpMessageNotice message={base} />)
    expect(await screen.findByText(/not encrypted to any private key/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Decrypt' })).not.toBeInTheDocument()
    unmount()
    openPgp.inspect.mockRejectedValueOnce(new Error("Error invoking remote method 'openpgp:inspect': Error: Unlock Aerio before reading OpenPGP mail"))
    render(<OpenPgpMessageNotice message={base} />)
    expect(await screen.findByText('Unlock Aerio before reading OpenPGP mail')).toBeInTheDocument()
  })
})

describe('OpenPgpKeyManager', () => {
  it('lists keys with trust details and runs key actions', async () => {
    const user = userEvent.setup()
    const status = { secureStorage: true, locked: false, keys: [key({ unlocked: true }), key({ fingerprint: 'C'.repeat(40), userIds: ['Bob <bob@example.test>'], hasPrivateKey: false, verification: 'unverified', expiresAt: '2027-01-01T00:00:00Z' })] }
    openPgp.status.mockResolvedValue(status)
    openPgp.setVerification.mockResolvedValue(key())
    openPgp.exportPublic.mockResolvedValue({ savedPath: 'C:\\keys\\bob.asc' })
    openPgp.exportPrivate.mockResolvedValue({ savedPath: 'C:\\keys\\alice-secret.asc' })
    openPgp.delete.mockResolvedValue(status)
    render(<OpenPgpKeyManager />)
    expect(await screen.findByText('Alice <alice@example.test>')).toBeInTheDocument()
    expect(screen.getByText(formatFingerprint(FP))).toBeInTheDocument()
    expect(screen.getByText(/Public key · .* expires/)).toBeInTheDocument()
    expect(screen.getByText('Fingerprint not verified')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Mark verified' }))
    expect(openPgp.setVerification).toHaveBeenCalledWith('C'.repeat(40), 'verified')
    await user.click(screen.getAllByRole('button', { name: /Public key/ })[1])
    expect(await screen.findByText('Public key saved to C:\\keys\\bob.asc')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Private key/ }))
    await user.type(screen.getByLabelText(/Confirm this key’s passphrase/), 'correct horse')
    await user.click(screen.getByRole('button', { name: 'Export private key…' }))
    expect(openPgp.exportPrivate).toHaveBeenCalledWith(FP, 'correct horse')
    expect(await screen.findByText(/still protected by its passphrase/)).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: /Delete/ })[1])
    await user.click(screen.getByRole('button', { name: 'Delete key' }))
    expect(openPgp.delete).toHaveBeenCalledWith('C'.repeat(40))
    await user.click(screen.getByRole('button', { name: 'Forget passphrases' }))
    expect(openPgp.forgetPassphrases).toHaveBeenCalled()
  }, 20_000)

  it('generates keys, imports pasted keys, and protects unprotected private keys', async () => {
    const user = userEvent.setup()
    openPgp.status.mockResolvedValue({ secureStorage: false, locked: false, keys: [] })
    openPgp.generate.mockResolvedValue(key())
    openPgp.importText.mockResolvedValueOnce({ imported: [], needsPassphrase: true }).mockResolvedValueOnce({ imported: [key()] })
    openPgp.importFile.mockResolvedValueOnce(undefined)
    render(<OpenPgpKeyManager />)
    expect(await screen.findByText(/No OpenPGP keys yet/)).toBeInTheDocument()
    expect(screen.getByText(/Secure credential storage is unavailable/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /New key/ }))
    await user.type(screen.getByLabelText('Email'), 'alice@example.test')
    await user.type(screen.getByLabelText('Passphrase'), 'correct horse')
    await user.type(screen.getByLabelText('Confirm passphrase'), 'different one')
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    expect(await screen.findByText('The passphrases do not match')).toBeInTheDocument()
    await user.clear(screen.getByLabelText('Confirm passphrase'))
    await user.type(screen.getByLabelText('Confirm passphrase'), 'correct horse')
    await user.selectOptions(screen.getByLabelText('Expires'), '365')
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    expect(openPgp.generate).toHaveBeenCalledWith({ name: '', email: 'alice@example.test', passphrase: 'correct horse', expiresInDays: 365 })
    expect(await screen.findByText(/profile backups do not include keys/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Paste key' }))
    await user.type(screen.getByLabelText('Armored key'), 'SECRET KEY')
    await user.click(screen.getByRole('button', { name: 'Import' }))
    expect(await screen.findByText(/This private key is not protected/)).toBeInTheDocument()
    await user.type(screen.getByLabelText(/New passphrase/), 'protect me now')
    await user.click(screen.getByRole('button', { name: 'Protect and import' }))
    expect(openPgp.importText).toHaveBeenLastCalledWith('SECRET KEY', 'protect me now')
    expect(await screen.findByText(/Imported 1 key/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Import key file/ }))
    expect(openPgp.importFile).toHaveBeenCalled()
  }, 20_000)
})
