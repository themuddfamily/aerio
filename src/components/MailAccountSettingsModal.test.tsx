// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImapServerSettings, MailAccountSummary } from '../mail-types'
import MailAccountSettingsModal from './MailAccountSettingsModal'

const account = (overrides: Partial<MailAccountSummary> = {}): MailAccountSummary => ({
  id: 'account', provider: 'gmail', email: 'person@example.test', displayName: 'Person', color: '#1d7a62', status: 'ready',
  archived: false, lastSyncAt: '2026-08-08T10:00:00Z', signature: 'Regards', notifications: true, syncEnabled: true, ...overrides
})
const server: ImapServerSettings = {
  username: 'person@example.test', imapHost: 'imap.example.test', imapPort: 993, imapSecurity: 'tls',
  smtpHost: 'smtp.example.test', smtpPort: 465, smtpSecurity: 'tls', allowInvalidCertificates: false, passwordConfigured: true
}
const api = {
  mail: {
    accounts: {
      update: vi.fn(async (input: any) => ({ ...account(), ...input })), verify: vi.fn(async () => undefined), reconnect: vi.fn(async () => undefined),
      imapSettings: vi.fn(async () => server), updateImap: vi.fn(async () => server)
    },
    sync: { rebuild: vi.fn(async () => undefined) }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'aerio', { configurable: true, value: api })
  window.confirm = vi.fn(() => true)
  api.mail.accounts.update.mockImplementation(async (input: any) => ({ ...account(), ...input }))
  api.mail.accounts.verify.mockResolvedValue(undefined)
  api.mail.accounts.reconnect.mockResolvedValue(undefined)
  api.mail.accounts.imapSettings.mockResolvedValue(server)
  api.mail.accounts.updateImap.mockResolvedValue(server)
  api.mail.sync.rebuild.mockResolvedValue(undefined)
})

describe('MailAccountSettingsModal', () => {
  it('edits and saves account identity, colour, signature, synchronization, and alerts', async () => {
    const user = userEvent.setup()
    const onSaved = vi.fn(), onClose = vi.fn(), onToast = vi.fn()
    render(<MailAccountSettingsModal account={account()} onSaved={onSaved} onClose={onClose} onToast={onToast} />)
    await user.clear(screen.getByLabelText('Display name')); await user.type(screen.getByLabelText('Display name'), 'Renamed')
    await user.click(screen.getByRole('button', { name: 'Use #3b6fd8' }))
    await user.clear(screen.getByPlaceholderText('Your name and contact details')); await user.type(screen.getByPlaceholderText('Your name and contact details'), 'New signature')
    const toggles = screen.getAllByRole('checkbox'); await user.click(toggles[0]); await user.click(toggles[1])
    await user.click(screen.getByRole('button', { name: /Save changes/ }))
    await waitFor(() => expect(api.mail.accounts.update).toHaveBeenCalledWith(expect.objectContaining({ displayName: 'Renamed', color: '#3b6fd8', signature: 'New signature', notifications: false, syncEnabled: false })))
    expect(onSaved).toHaveBeenCalled(); expect(onToast).toHaveBeenCalledWith('Account settings saved'); expect(onClose).toHaveBeenCalled()
  })

  it('tests, reconnects, and rebuilds an OAuth account', async () => {
    const user = userEvent.setup()
    const onSaved = vi.fn(), onClose = vi.fn(), onToast = vi.fn()
    render(<MailAccountSettingsModal account={account({ status: 'needs-auth', error: 'Expired' })} onSaved={onSaved} onClose={onClose} onToast={onToast} />)
    await user.click(screen.getByRole('button', { name: /Test connection/ }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Connection succeeded'))
    await user.click(screen.getByRole('button', { name: /Reconnect/ }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ status: 'syncing', error: undefined })))
    await user.click(screen.getByRole('button', { name: /Rebuild local mailbox/ }))
    expect(window.confirm).toHaveBeenCalled(); await waitFor(() => expect(api.mail.sync.rebuild).toHaveBeenCalledWith('account'))
    expect(onClose).toHaveBeenCalled()
  })

  it('loads, edits, verifies, and saves IMAP and SMTP server settings', async () => {
    const user = userEvent.setup()
    const onToast = vi.fn()
    render(<MailAccountSettingsModal account={account({ provider: 'imap' })} onSaved={vi.fn()} onClose={vi.fn()} onToast={onToast} />)
    await screen.findByText('IMAP and SMTP servers')
    await user.clear(screen.getByLabelText('Username')); await user.type(screen.getByLabelText('Username'), 'changed@example.test')
    await user.clear(screen.getByLabelText('IMAP server')); await user.type(screen.getByLabelText('IMAP server'), 'imap.changed.test')
    await user.selectOptions(screen.getAllByLabelText('Security')[0], 'starttls')
    await user.type(screen.getByLabelText('New password or app password'), 'secret')
    const toggles = screen.getAllByRole('checkbox'); await user.click(toggles.at(-1)!)
    await user.click(screen.getByRole('button', { name: /Verify and save servers/ }))
    await waitFor(() => expect(api.mail.accounts.updateImap).toHaveBeenCalledWith('account', expect.objectContaining({ username: 'changed@example.test', imapHost: 'imap.changed.test', imapSecurity: 'starttls', password: 'secret', allowInvalidCertificates: true })))
    expect(onToast).toHaveBeenCalledWith('Server settings verified and saved')
  })

  it('reports connection, reconnect, save, server, and rebuild failures', async () => {
    const onToast = vi.fn()
    api.mail.accounts.update.mockRejectedValueOnce(new Error('save failed'))
    api.mail.accounts.verify.mockRejectedValueOnce(new Error('verify failed'))
    api.mail.accounts.reconnect.mockRejectedValueOnce(new Error('reconnect failed'))
    api.mail.sync.rebuild.mockRejectedValueOnce(new Error('rebuild failed'))
    const user = userEvent.setup()
    render(<MailAccountSettingsModal account={account()} onSaved={vi.fn()} onClose={vi.fn()} onToast={onToast} />)
    await user.click(screen.getByRole('button', { name: /Save changes/ }))
    await user.click(screen.getByRole('button', { name: /Test connection/ }))
    await user.click(screen.getByRole('button', { name: /Reconnect/ }))
    await user.click(screen.getByRole('button', { name: /Rebuild local mailbox/ }))
    await waitFor(() => expect(onToast.mock.calls.flat()).toEqual(expect.arrayContaining(['save failed', 'verify failed', 'reconnect failed', 'rebuild failed'])))
  })

  it('keeps the modal open when a rebuild is declined and reports IMAP load failure', async () => {
    window.confirm = vi.fn(() => false)
    api.mail.accounts.imapSettings.mockRejectedValueOnce(new Error('server unavailable'))
    const onToast = vi.fn(), onClose = vi.fn()
    const { rerender } = render(<MailAccountSettingsModal account={account({ provider: 'imap' })} onSaved={vi.fn()} onClose={onClose} onToast={onToast} />)
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('server unavailable'))
    rerender(<MailAccountSettingsModal account={account()} onSaved={vi.fn()} onClose={onClose} onToast={onToast} />)
    fireEvent.click(screen.getByRole('button', { name: /Rebuild local mailbox/ }))
    expect(api.mail.sync.rebuild).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled()
  })

  it('uses friendly fallback messages for non-Error account failures', async () => {
    api.mail.accounts.update.mockRejectedValueOnce('bad')
    api.mail.accounts.verify.mockRejectedValueOnce('bad')
    api.mail.accounts.reconnect.mockRejectedValueOnce('bad')
    api.mail.sync.rebuild.mockRejectedValueOnce('bad')
    const user = userEvent.setup(), onToast = vi.fn()
    render(<MailAccountSettingsModal account={account({ lastSyncAt: undefined })} onSaved={vi.fn()} onClose={vi.fn()} onToast={onToast} />)
    expect(screen.getByText('Status:', { exact: false })).not.toHaveTextContent('Last synchronized')
    await user.click(screen.getByRole('button', { name: /Save changes/ }))
    await user.click(screen.getByRole('button', { name: /Test connection/ }))
    await user.click(screen.getByRole('button', { name: /Reconnect/ }))
    await user.click(screen.getByRole('button', { name: /Rebuild local mailbox/ }))
    await waitFor(() => expect(onToast.mock.calls.flat()).toEqual(expect.arrayContaining([
      'Account settings could not be saved', 'Connection test failed', 'Account could not be reconnected', 'Mailbox rebuild could not start'
    ])))
  })

  it('handles missing IMAP passwords and friendly server fallbacks', async () => {
    api.mail.accounts.imapSettings.mockResolvedValueOnce({ ...server, passwordConfigured: false })
    api.mail.accounts.updateImap.mockRejectedValueOnce('bad')
    const user = userEvent.setup(), onToast = vi.fn()
    const view = render(<MailAccountSettingsModal account={account({ provider: 'imap' })} onSaved={vi.fn()} onClose={vi.fn()} onToast={onToast} />)
    expect(await screen.findByPlaceholderText('Password required')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Verify and save servers/ }))
    await waitFor(() => expect(api.mail.accounts.updateImap).toHaveBeenCalledWith('account', expect.objectContaining({ password: undefined })))
    expect(onToast).toHaveBeenCalledWith('Server settings could not be verified')
    view.unmount()

    api.mail.accounts.imapSettings.mockRejectedValueOnce('bad')
    render(<MailAccountSettingsModal account={account({ provider: 'imap' })} onSaved={vi.fn()} onClose={vi.fn()} onToast={onToast} />)
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Server settings could not be loaded'))
  })
})
