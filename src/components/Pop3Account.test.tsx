// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary, MailProviderPreset } from '../mail-types'
import MailAccountSetupModal from './MailAccountSetupModal'
import { Pop3AccountSettingsSection } from './Pop3Account'

const presets: MailProviderPreset[] = [
  { id: 'gmail', name: 'Gmail', description: 'Google mail', auth: 'google-oauth' },
  { id: 'pop3', name: 'POP3 and SMTP', description: 'Download mail over POP3', auth: 'password', smtpPort: 465, smtpSecurity: 'tls' }
]

const localFolder = { accountId: 'local-folders', id: 'folder:local-archive', name: 'Archive from Thunderbird', type: 'user' as const }
const settings = {
  username: 'me', pop3Host: 'pop.example.test', pop3Port: 995, pop3Security: 'tls' as const, auth: 'auto' as const,
  smtpHost: 'smtp.example.test', smtpPort: 465, smtpSecurity: 'tls' as const,
  retention: { leaveOnServer: true, removeWhenDeleted: false }, destination: { kind: 'account' as const }, passwordConfigured: true
}
const pop3 = {
  test: vi.fn(async () => ({ capabilities: ['UIDL'], authMethod: 'plain' as const, encrypted: true, messages: 12, bytes: 1000, smtpVerified: true })),
  connect: vi.fn(async () => ({})),
  settings: vi.fn(async () => settings),
  update: vi.fn(async (_id: string, input: any) => ({ ...settings, ...input, passwordConfigured: true })),
  status: vi.fn(async () => ({ accountId: 'pop-1', downloaded: 40, onServer: 30, pendingRemoval: 1, removedFromServer: 10, skipped: 0, lastCheckAt: '2026-10-17T10:00:00Z' }))
}
const api = {
  mail: {
    presets: vi.fn(async () => presets),
    credentials: { status: vi.fn(async () => ({ configured: true })), microsoftStatus: vi.fn(async () => ({ configured: true })) },
    accounts: {},
    mail: { labels: vi.fn(async () => [localFolder, { ...localFolder, id: 'INBOX', name: 'Inbox', type: 'system' as const }]) },
    pop3
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'aerio', { configurable: true, value: api })
})

async function openPop3Form() {
  const user = userEvent.setup()
  const props = { onClose: vi.fn(), onConnected: vi.fn(async () => undefined), onToast: vi.fn() }
  render(<MailAccountSetupModal {...props} />)
  await user.click(await screen.findByRole('button', { name: /Set up a POP3 account/ }))
  return { user, props }
}

describe('POP3 account setup', () => {
  it('tests and connects a POP3 account with the chosen destination and retention policy', async () => {
    const { user, props } = await openPop3Form()
    await user.type(screen.getByLabelText('Email address'), 'me@example.test')
    expect(screen.getByLabelText('Username')).toHaveValue('me@example.test')
    await user.type(screen.getByLabelText('Password'), 'secret')
    const [popServer, smtpServer] = screen.getAllByLabelText('Server')
    await user.type(popServer, 'pop.example.test')
    await user.type(smtpServer, 'smtp.example.test')
    expect(screen.getByText(/Aerio never removes anything from the server/)).toBeInTheDocument()

    await user.click(await screen.findByRole('radio', { name: /A Local Folders folder/ }))
    expect(screen.getByLabelText('Local Folders folder')).toHaveValue('folder:local-archive')
    await user.click(screen.getByRole('checkbox', { name: /Remove from the server when I delete/ }))
    expect(screen.getByText(/moved to Trash in Aerio/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    expect(await screen.findByText(/Connected with encryption using AUTH PLAIN\. The server holds 12 messages/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Connect POP3 account' }))
    await waitFor(() => expect(pop3.connect).toHaveBeenCalled())
    const expected = expect.objectContaining({
      email: 'me@example.test', username: 'me@example.test', password: 'secret', pop3Host: 'pop.example.test', pop3Port: 995, pop3Security: 'tls',
      smtpHost: 'smtp.example.test', smtpPort: 465, destination: { kind: 'local-folder', labelId: 'folder:local-archive' },
      retention: { leaveOnServer: true, removeWhenDeleted: true }
    })
    expect(pop3.test).toHaveBeenCalledWith(expected)
    expect(pop3.connect).toHaveBeenCalledWith(expected)
    expect(props.onConnected).toHaveBeenCalled()
    expect(props.onClose).toHaveBeenCalled()
    expect(props.onToast).toHaveBeenCalledWith('POP3 account connected — downloading mail')
  })

  it('switches to the STARTTLS port and asks for explicit consent before an unencrypted connection', async () => {
    const { user } = await openPop3Form()
    const [security] = screen.getAllByLabelText('Security')
    await user.selectOptions(security, 'starttls')
    expect(screen.getAllByLabelText('Port')[0]).toHaveValue(110)
    await user.selectOptions(security, 'none')
    expect(screen.getByRole('alert')).toHaveTextContent(/travel unprotected/)
    const consent = screen.getByRole('checkbox', { name: /Allow an unencrypted connection/ })
    expect(consent).not.toBeChecked()
    await user.click(consent)
    expect(consent).toBeChecked()
  })

  it('explains removal after download and after N days', async () => {
    const { user } = await openPop3Form()
    await user.click(screen.getByRole('checkbox', { name: /days after download/ }))
    expect(screen.getByText(/14 days after Aerio downloaded them/)).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: /Remove from the server after download/ }))
    expect(screen.getByText(/This computer then holds the only copy/)).toBeInTheDocument()
  })

  it('reports a failed connection test', async () => {
    pop3.test.mockRejectedValueOnce(new Error('Authentication failed: Invalid credentials'))
    const { user, props } = await openPop3Form()
    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(props.onToast).toHaveBeenCalledWith('Authentication failed: Invalid credentials'))
  })
})

describe('POP3 account settings', () => {
  const account: MailAccountSummary = { id: 'pop-1', provider: 'pop3', email: 'me@example.test', displayName: 'Me', color: '#123456', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true }

  it('shows download state and saves a new retention policy without resending the password', async () => {
    const user = userEvent.setup()
    const onToast = vi.fn()
    render(<Pop3AccountSettingsSection account={account} onToast={onToast} />)
    expect(await screen.findByText(/40 downloaded · 30 still on the server · 10 removed from the server · 1 waiting to be removed/)).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: /Remove from the server after download/ }))
    await user.click(screen.getByRole('button', { name: 'Save POP3 settings' }))
    await waitFor(() => expect(pop3.update).toHaveBeenCalledWith('pop-1', expect.objectContaining({ retention: { leaveOnServer: false, removeWhenDeleted: false }, pop3Host: 'pop.example.test' })))
    expect(pop3.update.mock.calls[0][1]).not.toHaveProperty('password')
    expect(pop3.update.mock.calls[0][1]).not.toHaveProperty('passwordConfigured')
    expect(onToast).toHaveBeenCalledWith('POP3 settings saved')
  })
})
