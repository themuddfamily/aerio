// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary, MailDraftResult } from '../mail-types'
import type { OpenPgpPreflight } from '../openpgp-types'
import { messageLooksSmime, type SmimeCertificateSummary, type SmimePreflight } from '../smime-types'
import { certificateStatusLabel, chainStatusLabel, formatCertificateFingerprint, smimeSignatureSummary } from '../lib/smime-display'
import { ContextMenuProvider } from './ContextMenu'
import MailComposeModal from './MailComposeModal'
import MailComposeSmimeControl from './MailComposeSmimeControl'
import SmimeCertificateManager from './SmimeCertificateManager'
import SmimeMessageNotice from './SmimeMessageNotice'

const FP = 'AB'.repeat(32)
const cert = (changes: Partial<SmimeCertificateSummary> = {}): SmimeCertificateSummary => ({
  fingerprint: FP, subject: 'CN=Alice Example, O=Aerio Test', commonName: 'Alice Example', issuer: 'CN=Aerio Test Mail CA', serialNumber: '100001',
  emails: ['alice@example.test'], algorithm: 'RSA 2048', validFrom: '2026-01-01T00:00:00Z', validTo: '2027-01-01T00:00:00Z', expired: false, notYetValid: false, isCa: false,
  keyUsage: { digitalSignature: true, keyEncipherment: true, emailProtection: true }, canSign: true, canEncrypt: true, hasPrivateKey: true, unlocked: false, source: 'own', trusted: false,
  chain: [{ subject: 'Alice Example', issuer: 'CN=Aerio Test Mail CA', fingerprint: FP, validFrom: '2026-01-01T00:00:00Z', validTo: '2027-01-01T00:00:00Z', expired: false, trustAnchor: false }, { subject: 'Aerio Test Root CA', issuer: 'CN=Aerio Test Root CA', fingerprint: 'CD'.repeat(32), validFrom: '2026-01-01T00:00:00Z', validTo: '2036-01-01T00:00:00Z', expired: false, trustAnchor: true }],
  chainStatus: 'trusted', revocation: 'not-checked', ...changes
})
const preflight = (changes: Partial<SmimePreflight> = {}): SmimePreflight => ({ ready: true, problems: [], warnings: [], from: 'Me <me@example.test>', recipients: [], ...changes })
const smime = {
  status: vi.fn(), importFile: vi.fn(), retryImport: vi.fn(), importText: vi.fn(), exportCertificate: vi.fn(), exportPkcs12: vi.fn(), delete: vi.fn(), setTrusted: vi.fn(),
  unlock: vi.fn(), forgetPassphrases: vi.fn(), preflight: vi.fn(), identityDefault: vi.fn(async () => undefined), setIdentityDefault: vi.fn(), inspect: vi.fn(), decrypt: vi.fn(), saveAttachment: vi.fn()
}
const openPgp = { preflight: vi.fn(async (): Promise<OpenPgpPreflight> => ({ ready: true, problems: [], from: 'me@example.test', recipients: [] })), unlock: vi.fn() }
const result = (status: MailDraftResult['status'] = 'synced'): MailDraftResult => ({ id: 'draft', status, updatedAt: '2026-10-17T10:00:00Z' })
const mail = {
  mail: { suggestRecipients: vi.fn(async () => []) },
  drafts: { save: vi.fn(async () => result()), send: vi.fn(async (_input: unknown) => result('send-pending')), schedule: vi.fn(), delete: vi.fn(), stageMessageAttachments: vi.fn() }
}
const account: MailAccountSummary = { id: 'account', provider: 'imap', email: 'me@example.test', displayName: 'Me', color: '#123456', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true }

beforeEach(() => {
  vi.clearAllMocks()
  smime.identityDefault.mockResolvedValue(undefined)
  Object.defineProperty(window, 'aerio', { configurable: true, value: { smime, openPgp, mail } })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => true) })
})

describe('S/MIME display helpers', () => {
  it('describes signatures, chains, certificates and candidate messages', () => {
    expect(formatCertificateFingerprint('ab'.repeat(32))).toBe('AB:AB:AB:AB:AB:AB:AB:AB…')
    expect(formatCertificateFingerprint('ab'.repeat(4), true)).toBe('AB:AB:AB:AB')
    expect(smimeSignatureSummary({ status: 'valid', signer: cert(), harvested: true })).toMatchObject({ tone: 'good', text: expect.stringMatching(/Alice Example \(alice@example.test\).*Revocation was not checked.*saved/) })
    expect(smimeSignatureSummary({ status: 'untrusted', signer: cert(), detail: 'Root unknown' }).text).toMatch(/not trusted. Root unknown/)
    expect(smimeSignatureSummary({ status: 'email-mismatch', signer: cert() }).tone).toBe('warning')
    expect(smimeSignatureSummary({ status: 'expired-certificate', signer: cert() }).text).toMatch(/not valid now/)
    expect(smimeSignatureSummary({ status: 'unknown-certificate' }).text).toMatch(/not included/)
    expect(smimeSignatureSummary({ status: 'unsupported', detail: 'RSA-PSS' }).text).toMatch(/unknown signer could not be checked. RSA-PSS/)
    expect(smimeSignatureSummary({ status: 'invalid', signer: cert() }).tone).toBe('bad')
    expect(['trusted', 'untrusted-root', 'incomplete', 'invalid'].map((status) => chainStatusLabel(status as never))).toEqual(['Chain trusted', 'Root not trusted', 'Issuer unknown', 'Chain invalid'])
    expect(chainStatusLabel('incomplete', true)).toBe('Trusted by you')
    expect(certificateStatusLabel(cert({ expired: true }))).toBe('Expired')
    expect(certificateStatusLabel(cert({ notYetValid: true }))).toBe('Not yet valid')
    expect(certificateStatusLabel(cert({ isCa: true }))).toBe('Certificate authority')
    expect(certificateStatusLabel(cert({ hasPrivateKey: false }))).toBe('Recipient certificate')
    expect(certificateStatusLabel(cert({ hasPrivateKey: false, canEncrypt: false }))).toBe('Not usable for encryption')
    expect(messageLooksSmime({ attachments: [{ filename: 'smime.p7s', mimeType: 'application/pkcs7-signature' }] })).toBe(true)
    expect(messageLooksSmime({ attachments: [{ filename: 'smime.p7m', mimeType: 'application/octet-stream' }] })).toBe(true)
    expect(messageLooksSmime({ attachments: [{ filename: 'notes.txt', mimeType: 'text/plain' }] })).toBe(false)
  })
})

describe('MailComposeSmimeControl', () => {
  it('toggles sign and encrypt, shows certificate problems, chooses certificates, unlocks, and saves a sender default', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    smime.preflight.mockResolvedValue(preflight({
      ready: false, problems: ['Unlock your S/MIME certificate with its passphrase.', 'No S/MIME certificate for: zed@example.test.'], warnings: ['Your certificate’s issuer is not trusted on this device.'],
      signer: { fingerprint: FP, subject: 'Alice Example', unlocked: false },
      recipients: [
        { address: 'ada@example.test', status: 'ok', fingerprint: FP, candidates: [{ fingerprint: FP, subject: 'Ada', validTo: '2027-01-01T00:00:00Z', chainStatus: 'trusted', trusted: false }, { fingerprint: 'B'.repeat(64), subject: 'Ada (new)', validTo: '2028-01-01T00:00:00Z', chainStatus: 'trusted', trusted: false }] },
        { address: 'zed@example.test', status: 'missing', candidates: [] }
      ]
    }))
    const { rerender } = render(<MailComposeSmimeControl accountId="account" recipients={['ada@example.test', 'zed@example.test']} onChange={onChange} />)
    await user.click(screen.getByLabelText('S/MIME sign and encrypt', { selector: 'summary' }))
    await user.click(screen.getByRole('checkbox', { name: 'Encrypt with S/MIME' }))
    expect(onChange).toHaveBeenLastCalledWith({ encrypt: true })
    rerender(<MailComposeSmimeControl accountId="account" recipients={['ada@example.test', 'zed@example.test']} value={{ sign: true, encrypt: true }} onChange={onChange} />)
    expect(await screen.findByText('No S/MIME certificate for: zed@example.test.')).toBeInTheDocument()
    expect(screen.getByText(/issuer is not trusted on this device/)).toBeInTheDocument()
    expect(screen.getByText(/zed@example.test: no certificate/)).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Certificate for ada@example.test' }), 'B'.repeat(64))
    expect(onChange).toHaveBeenLastCalledWith({ sign: true, encrypt: true, recipientCerts: { 'ada@example.test': 'B'.repeat(64) } })
    smime.unlock.mockRejectedValueOnce(new Error("Error invoking remote method 'smime:unlock': Error: The passphrase for this S/MIME certificate is incorrect"))
    await user.type(screen.getByLabelText('Certificate passphrase'), 'bad{Enter}')
    expect(await screen.findByText('The passphrase for this S/MIME certificate is incorrect')).toBeInTheDocument()
    smime.unlock.mockResolvedValueOnce(cert({ unlocked: true }))
    smime.preflight.mockResolvedValue(preflight({ signer: { fingerprint: FP, subject: 'Alice Example', unlocked: true } }))
    await user.clear(screen.getByLabelText('Certificate passphrase'))
    await user.type(screen.getByLabelText('Certificate passphrase'), 'correct horse')
    await user.click(screen.getByRole('button', { name: 'Unlock' }))
    expect(smime.unlock).toHaveBeenLastCalledWith(FP, 'correct horse')
    expect(await screen.findByText(/with S\/MIME. It will not be sent unprotected/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Use for new messages from this sender' }))
    expect(smime.setIdentityDefault).toHaveBeenCalledWith({ accountId: 'account', fromIdentityId: undefined }, { sign: true, encrypt: true })
    expect(await screen.findByText(/start with these S\/MIME settings/)).toBeInTheDocument()
  }, 20_000)

  it('keeps one protection method in the composer, applies a sender default, and shows refusals', async () => {
    const user = userEvent.setup()
    const onToast = vi.fn()
    smime.identityDefault.mockResolvedValueOnce({ sign: true, encrypt: false } as never)
    smime.preflight.mockResolvedValue(preflight())
    mail.drafts.send.mockRejectedValueOnce(new Error("Error invoking remote method 'mail:drafts:send': Error: No S/MIME certificate for: ada@example.test. The message was not sent; your draft is kept."))
    render(<ContextMenuProvider><MailComposeModal accounts={[account]} onClose={vi.fn()} onSent={vi.fn()} onToast={onToast} /></ContextMenuProvider>)
    await waitFor(() => expect(smime.identityDefault).toHaveBeenCalledWith({ accountId: 'account', fromIdentityId: undefined }))
    await user.click(screen.getByLabelText('S/MIME sign and encrypt', { selector: 'summary' }))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Sign with S/MIME' })).toBeChecked())
    // Turning on OpenPGP turns S/MIME off, and back.
    await user.click(screen.getByLabelText('OpenPGP sign and encrypt', { selector: 'summary' }))
    await user.click(screen.getByRole('checkbox', { name: 'Encrypt with OpenPGP' }))
    expect(screen.getByRole('checkbox', { name: 'Sign with S/MIME' })).not.toBeChecked()
    await user.click(screen.getByRole('checkbox', { name: 'Encrypt with S/MIME' }))
    expect(screen.getByRole('checkbox', { name: 'Encrypt with OpenPGP' })).not.toBeChecked()
    await user.type(screen.getByPlaceholderText('name@example.com'), 'ada@example.test')
    await user.click(screen.getByRole('button', { name: /^Send$/ }))
    await waitFor(() => expect(mail.drafts.send).toHaveBeenCalledWith(expect.objectContaining({ smime: { encrypt: true } })))
    expect(mail.drafts.send.mock.calls.at(-1)?.[0]).not.toHaveProperty('openPgp')
    expect(onToast).toHaveBeenCalledWith('No S/MIME certificate for: ada@example.test. The message was not sent; your draft is kept.')
  }, 20_000)

  it('renders nothing without the S/MIME bridge', () => {
    Object.defineProperty(window, 'aerio', { configurable: true, value: {} })
    const { container } = render(<MailComposeSmimeControl accountId="account" recipients={[]} onChange={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('SmimeMessageNotice', () => {
  const base = { accountId: 'account', threadId: 'thread', id: 'message', attachments: [{ id: 'a', messageId: 'message', filename: 'smime.p7m', mimeType: 'application/pkcs7-mime', size: 10 }] }

  it('skips ordinary messages without asking the main process', () => {
    const { container } = render(<SmimeMessageNotice message={{ ...base, attachments: [] }} />)
    expect(container).toBeEmptyDOMElement()
    expect(smime.inspect).not.toHaveBeenCalled()
  })

  it('verifies signed mail with certificate details and reports bad signatures', async () => {
    smime.inspect.mockResolvedValueOnce({ kind: 'signed', signatures: [{ status: 'valid', signer: cert({ hasPrivateKey: false, source: 'harvested' }), signedAt: '2026-10-17T10:00:00Z', harvested: true }] })
    const { unmount } = render(<SmimeMessageNotice message={{ ...base, attachments: [{ ...base.attachments[0], filename: 'smime.p7s', mimeType: 'application/pkcs7-signature' }] }} />)
    expect(await screen.findByText(/Valid S\/MIME signature from Alice Example/)).toBeInTheDocument()
    expect(screen.getByText('S/MIME signed message.')).toBeInTheDocument()
    expect(screen.getByText(/Not checked \(Aerio does not query CRLs or OCSP\)/)).toBeInTheDocument()
    expect(screen.getByText(/Aerio Test Root CA \(trust anchor\)/)).toBeInTheDocument()
    unmount()
    smime.inspect.mockResolvedValueOnce({ kind: 'signed', signatures: [{ status: 'invalid', signer: cert() }] })
    render(<SmimeMessageNotice message={base} />)
    expect(await screen.findByText(/is not valid/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveClass('openpgp-bad')
  })

  it('asks for a passphrase, decrypts in place and saves decrypted attachments', async () => {
    const user = userEvent.setup()
    smime.inspect.mockResolvedValue({ kind: 'encrypted', algorithm: 'AES-256-CBC', encryptedTo: [{ issuer: 'CN=CA', serialNumber: '01', fingerprint: FP, available: true }] })
    smime.decrypt
      .mockResolvedValueOnce({ status: 'passphrase-required', fingerprint: FP, subject: 'Alice Example' })
      .mockResolvedValueOnce({ status: 'passphrase-required', fingerprint: FP, subject: 'Alice Example', error: 'The passphrase for this S/MIME certificate is incorrect' })
      .mockResolvedValueOnce({ status: 'decrypted', encrypted: true, text: 'plain', sanitizedHtml: '<p>The <strong>secret</strong></p>', attachments: [{ index: 0, filename: 'plan.pdf', mimeType: 'application/pdf', size: 2048 }], signatures: [] })
    smime.saveAttachment.mockRejectedValueOnce(new Error('Decrypt the message again before saving its attachments'))
    render(<SmimeMessageNotice message={base} />)
    expect(await screen.findByText(/AES-256-CBC/)).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Decrypt' }))
    expect(smime.decrypt).toHaveBeenLastCalledWith({ accountId: 'account', threadId: 'thread', messageId: 'message' }, undefined)
    await user.type(await screen.findByLabelText('Certificate passphrase'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Unlock and decrypt' }))
    expect(await screen.findByText('The passphrase for this S/MIME certificate is incorrect')).toBeInTheDocument()
    await user.clear(screen.getByLabelText('Certificate passphrase'))
    await user.type(screen.getByLabelText('Certificate passphrase'), 'right{Enter}')
    expect(await screen.findByText('secret')).toBeInTheDocument()
    expect(screen.getByText(/not signed, so its sender cannot be confirmed/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save…' }))
    expect(smime.saveAttachment).toHaveBeenCalledWith({ accountId: 'account', threadId: 'thread', messageId: 'message' }, 0)
    expect(await screen.findByText(/Decrypt the message again/)).toBeInTheDocument()
  }, 20_000)

  it('opens opaque signed mail, explains mail for someone else, and inspection failures', async () => {
    const user = userEvent.setup()
    smime.inspect.mockResolvedValueOnce({ kind: 'signed-opaque', signatures: [{ status: 'untrusted', signer: cert({ chainStatus: 'untrusted-root' }) }] })
    smime.decrypt.mockResolvedValueOnce({ status: 'decrypted', encrypted: false, text: 'signed body', attachments: [], signatures: [{ status: 'untrusted', signer: cert() }] })
    const first = render(<SmimeMessageNotice message={base} />)
    await user.click(await screen.findByRole('button', { name: 'Show signed content' }))
    expect(await screen.findByText('signed body')).toBeInTheDocument()
    first.unmount()
    smime.inspect.mockResolvedValueOnce({ kind: 'encrypted', encryptedTo: [{ issuer: 'CN=Other', serialNumber: '02', available: false }] })
    const second = render(<SmimeMessageNotice message={base} />)
    expect(await screen.findByText(/not encrypted to any of your certificates/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Decrypt' })).not.toBeInTheDocument()
    second.unmount()
    smime.inspect.mockRejectedValueOnce(new Error("Error invoking remote method 'smime:inspect': Error: Unlock Aerio before reading S/MIME mail"))
    render(<SmimeMessageNotice message={base} />)
    expect(await screen.findByText('Unlock Aerio before reading S/MIME mail')).toBeInTheDocument()
  })
})

describe('SmimeCertificateManager', () => {
  it('lists certificates with chain details and runs certificate actions', async () => {
    const user = userEvent.setup()
    const bob = cert({ fingerprint: 'C'.repeat(64), commonName: 'Bob Example', emails: ['bob@example.test'], hasPrivateKey: false, canSign: false, source: 'harvested', chainStatus: 'untrusted-root' })
    const status = { secureStorage: true, locked: false, certificates: [cert({ unlocked: true }), bob] }
    smime.status.mockResolvedValue(status)
    smime.setTrusted.mockResolvedValue(bob)
    smime.exportCertificate.mockResolvedValue({ savedPath: 'C:\\certs\\bob.cer' })
    smime.exportPkcs12.mockResolvedValue({ savedPath: 'C:\\certs\\alice.p12' })
    smime.delete.mockResolvedValue(status)
    render(<SmimeCertificateManager />)
    expect(await screen.findByText('Alice Example', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText(/Recipient certificate · bob@example.test .* from signed mail/)).toBeInTheDocument()
    expect(screen.getAllByText('Root not trusted').length).toBeGreaterThan(0)
    await user.click(screen.getAllByRole('button', { name: 'Trust' })[1])
    expect(smime.setTrusted).toHaveBeenCalledWith('C'.repeat(64), true)
    await user.click(screen.getAllByRole('button', { name: /^Certificate$/ })[1])
    expect(await screen.findByText('Certificate saved to C:\\certs\\bob.cer')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /PKCS#12/ }))
    await user.type(screen.getByLabelText('This certificate’s passphrase'), 'correct horse')
    await user.type(screen.getByLabelText('Export password'), 'export password')
    await user.type(screen.getByLabelText('Confirm export password'), 'different')
    await user.click(screen.getByRole('button', { name: 'Export PKCS#12…' }))
    expect(await screen.findByText('The export passwords do not match')).toBeInTheDocument()
    await user.clear(screen.getByLabelText('Confirm export password'))
    await user.type(screen.getByLabelText('Confirm export password'), 'export password')
    await user.click(screen.getByRole('button', { name: 'Export PKCS#12…' }))
    expect(smime.exportPkcs12).toHaveBeenCalledWith(FP, 'correct horse', 'export password')
    expect(await screen.findByText(/protected by the export password/)).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: /Delete/ })[1])
    await user.click(screen.getByRole('button', { name: 'Delete certificate' }))
    expect(smime.delete).toHaveBeenCalledWith('C'.repeat(64))
    await user.click(screen.getByRole('button', { name: 'Forget passphrases' }))
    expect(smime.forgetPassphrases).toHaveBeenCalled()
  }, 30_000)

  it('imports PKCS#12 with password prompts and pasted certificates', async () => {
    const user = userEvent.setup()
    smime.status.mockResolvedValue({ secureStorage: false, locked: false, certificates: [] })
    smime.importFile.mockResolvedValueOnce({ imported: [], needsPassword: true })
    smime.retryImport
      .mockResolvedValueOnce({ imported: [], needsPassword: true, error: 'The PKCS#12 password is incorrect' })
      .mockResolvedValueOnce({ imported: [], needsPassphrase: true })
      .mockResolvedValueOnce({ imported: [cert()] })
    smime.importText.mockResolvedValueOnce({ imported: [cert({ hasPrivateKey: false })] })
    render(<SmimeCertificateManager />)
    expect(await screen.findByText(/No S\/MIME certificates yet/)).toBeInTheDocument()
    expect(screen.getByText(/Secure credential storage is unavailable/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Import certificate file/ }))
    expect(await screen.findByText('Enter the password for this PKCS#12 file.')).toBeInTheDocument()
    await user.type(screen.getByLabelText('PKCS#12 file password'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Open file' }))
    expect(await screen.findByText('The PKCS#12 password is incorrect')).toBeInTheDocument()
    await user.clear(screen.getByLabelText('PKCS#12 file password'))
    await user.type(screen.getByLabelText('PKCS#12 file password'), 'short')
    await user.click(screen.getByRole('button', { name: 'Open file' }))
    expect(await screen.findByText(/too short to protect the key/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('New passphrase for this private key'), 'protect me now')
    await user.click(screen.getByRole('button', { name: 'Protect and import' }))
    expect(smime.retryImport).toHaveBeenLastCalledWith('short', 'protect me now')
    expect(await screen.findByText(/profile backups do not include private keys/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Paste certificate' }))
    await user.type(screen.getByLabelText('PEM certificate'), 'PEM DATA')
    await user.click(screen.getByRole('button', { name: 'Import' }))
    expect(smime.importText).toHaveBeenCalledWith('PEM DATA')
    expect(await screen.findByText(/Mark a root certificate trusted only after checking/)).toBeInTheDocument()
  }, 30_000)
})
