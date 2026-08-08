// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailProviderPreset } from '../mail-types'
import MailAccountSetupModal from './MailAccountSetupModal'

const presets: MailProviderPreset[] = [
  { id: 'gmail', name: 'Gmail', description: 'Google mail', auth: 'google-oauth' },
  { id: 'microsoft', name: 'Microsoft', description: 'Microsoft mail', auth: 'microsoft-oauth' },
  { id: 'icloud', name: 'iCloud', description: 'Apple mail', auth: 'app-password', imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpSecurity: 'starttls', passwordHint: 'App-specific password' },
  { id: 'proton-bridge', name: 'Proton Mail', description: 'Local bridge', auth: 'bridge', imapHost: '127.0.0.1', imapPort: 1143, imapSecurity: 'starttls', smtpHost: '127.0.0.1', smtpPort: 1025, smtpSecurity: 'starttls' },
  { id: 'imap', name: 'Other', description: 'Custom mail', auth: 'password' }
]

const api = {
  mail: {
    presets: vi.fn(async () => presets),
    credentials: {
      status: vi.fn(async () => ({ configured: true, source: 'built-in', clientIdHint: 'google…apps' })),
      import: vi.fn(async () => ({ configured: true, source: 'user' })),
      microsoftStatus: vi.fn(async () => ({ configured: true, source: 'built-in', clientIdHint: '4369…' })),
      configureMicrosoft: vi.fn(async () => ({ configured: true, source: 'user' }))
    },
    accounts: {
      connect: vi.fn(async () => ({})), connectMicrosoft: vi.fn(async () => ({})), connectImap: vi.fn(async () => ({}))
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'aerio', { configurable: true, value: api })
  api.mail.presets.mockResolvedValue(presets)
  api.mail.credentials.status.mockResolvedValue({ configured: true, source: 'built-in', clientIdHint: 'google…apps' })
  api.mail.credentials.microsoftStatus.mockResolvedValue({ configured: true, source: 'built-in', clientIdHint: '4369…' })
  api.mail.credentials.import.mockResolvedValue({ configured: true, source: 'user' })
  api.mail.credentials.configureMicrosoft.mockResolvedValue({ configured: true, source: 'user' })
  api.mail.accounts.connect.mockResolvedValue({})
  api.mail.accounts.connectMicrosoft.mockResolvedValue({})
  api.mail.accounts.connectImap.mockResolvedValue({})
})

const callbacks = () => ({ onClose: vi.fn(), onConnected: vi.fn(async () => undefined), onToast: vi.fn() })

describe('MailAccountSetupModal', () => {
  it('shows all provider groups and connects with Aerio’s built-in Google registration', async () => {
    const user = userEvent.setup()
    const props = callbacks()
    render(<MailAccountSetupModal {...props} />)
    await user.click(await screen.findByRole('button', { name: /Continue with Google\. Gmail/ }))
    expect(screen.getByText('Aerio Google registration')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Continue with Google$/ }))
    await waitFor(() => expect(api.mail.accounts.connect).toHaveBeenCalled())
    expect(props.onConnected).toHaveBeenCalled(); expect(props.onToast).toHaveBeenCalledWith('Google account connected — sync has started'); expect(props.onClose).toHaveBeenCalled()
  })

  it('imports a development Google credential before connecting', async () => {
    api.mail.credentials.status.mockResolvedValueOnce({ configured: false, source: 'user' } as any)
    const user = userEvent.setup(), props = callbacks()
    render(<MailAccountSetupModal {...props} />)
    await user.click(await screen.findByRole('button', { name: /Continue with Google\. Gmail/ }))
    expect(screen.getByRole('button', { name: /Continue with Google$/ })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Import JSON' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Continue with Google$/ })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /Continue with Google$/ }))
    expect(api.mail.credentials.import).toHaveBeenCalled()
  })

  it('configures a Microsoft public client and connects the account', async () => {
    api.mail.credentials.microsoftStatus.mockResolvedValueOnce({ configured: false } as any)
    const user = userEvent.setup(), props = callbacks()
    render(<MailAccountSetupModal {...props} />)
    await user.click(await screen.findByRole('button', { name: /Continue with Microsoft\. Microsoft/ }))
    const connect = screen.getByRole('button', { name: /Continue with Microsoft$/ })
    expect(connect).toBeDisabled()
    await user.type(screen.getByLabelText('Microsoft Application (client) ID'), '12345678-1234-4234-9234-123456789abc')
    await user.click(connect)
    await waitFor(() => expect(api.mail.credentials.configureMicrosoft).toHaveBeenCalledWith('12345678-1234-4234-9234-123456789abc'))
    expect(api.mail.accounts.connectMicrosoft).toHaveBeenCalled()
    expect(props.onToast).toHaveBeenCalledWith('Microsoft account connected — sync has started')
  })

  it('prefills and submits app-password IMAP settings while keeping the username in sync', async () => {
    const user = userEvent.setup(), props = callbacks()
    render(<MailAccountSetupModal {...props} />)
    await user.click(await screen.findByRole('button', { name: /Continue with iCloud\. iCloud/ }))
    expect(screen.getByText(/Use an app-specific password/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Email address'), 'person@icloud.test')
    expect(screen.getByLabelText('Username')).toHaveValue('person@icloud.test')
    await user.type(screen.getByLabelText('Display name'), 'Person')
    await user.type(screen.getByLabelText('App-specific password'), 'secret')
    await user.selectOptions(screen.getAllByLabelText('Security')[0], 'starttls')
    fireEvent.submit(screen.getByRole('button', { name: 'Continue with iCloud' }).closest('form')!)
    await waitFor(() => expect(api.mail.accounts.connectImap).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'icloud', email: 'person@icloud.test', username: 'person@icloud.test', displayName: 'Person', password: 'secret',
      imapHost: 'imap.mail.me.com', smtpHost: 'smtp.mail.me.com', smtpSecurity: 'starttls'
    })))
  })

  it('prefills bridge security, navigates back, and reports startup and connection failures', async () => {
    const user = userEvent.setup(), props = callbacks()
    const { unmount } = render(<MailAccountSetupModal {...props} />)
    await user.click(await screen.findByRole('button', { name: /Continue with Proton Mail/ }))
    expect(screen.getByText(/Keep Proton Mail Bridge running/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back to providers' }))
    expect(screen.getByText('Other email providers')).toBeInTheDocument()
    unmount()

    api.mail.presets.mockRejectedValueOnce(new Error('setup offline'))
    const failed = callbacks()
    const view = render(<MailAccountSetupModal {...failed} />)
    await waitFor(() => expect(failed.onToast).toHaveBeenCalledWith('setup offline'))
    view.unmount()

    api.mail.accounts.connect.mockRejectedValueOnce(new Error('sign-in denied'))
    const rejected = callbacks()
    render(<MailAccountSetupModal {...rejected} />)
    await user.click(await screen.findByRole('button', { name: /Continue with Google\. Gmail/ }))
    await user.click(screen.getByRole('button', { name: /Continue with Google$/ }))
    await waitFor(() => expect(rejected.onToast).toHaveBeenCalledWith('sign-in denied'))
    expect(rejected.onClose).not.toHaveBeenCalled()
  })

  it('reports credential import and Microsoft configuration failures', async () => {
    api.mail.credentials.status.mockResolvedValueOnce({ configured: false, source: 'user' } as any)
    api.mail.credentials.import.mockRejectedValueOnce(new Error('bad JSON'))
    const user = userEvent.setup(), googleProps = callbacks()
    const view = render(<MailAccountSetupModal {...googleProps} />)
    await user.click(await screen.findByRole('button', { name: /Continue with Google\. Gmail/ }))
    await user.click(screen.getByRole('button', { name: 'Import JSON' }))
    await waitFor(() => expect(googleProps.onToast).toHaveBeenCalledWith('bad JSON'))
    view.unmount()

    api.mail.credentials.microsoftStatus.mockResolvedValueOnce({ configured: false } as any)
    api.mail.credentials.configureMicrosoft.mockRejectedValueOnce(new Error('invalid app id'))
    const msProps = callbacks()
    render(<MailAccountSetupModal {...msProps} />)
    await user.click(await screen.findByRole('button', { name: /Continue with Microsoft\. Microsoft/ }))
    await user.type(screen.getByLabelText('Microsoft Application (client) ID'), 'invalid')
    await user.click(screen.getByRole('button', { name: /Continue with Microsoft$/ }))
    await waitFor(() => expect(msProps.onToast).toHaveBeenCalledWith('invalid app id'))
    expect(api.mail.accounts.connectMicrosoft).not.toHaveBeenCalled()
  })

  it('uses provider defaults and built-in registrations without credential hints', async () => {
    api.mail.credentials.status.mockResolvedValueOnce({ configured: true, source: 'built-in' } as any)
    api.mail.credentials.microsoftStatus.mockResolvedValueOnce({ configured: true, source: 'built-in' } as any)
    const user = userEvent.setup(), props = callbacks()
    render(<MailAccountSetupModal {...props} />)
    await user.click(await screen.findByRole('button', { name: /Continue with Google\. Gmail/ }))
    expect(screen.getByText('Included in this Aerio build. No credential file is required.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back to providers' }))
    await user.click(screen.getByRole('button', { name: /Continue with Microsoft\. Microsoft/ }))
    expect(screen.getByText('Included in this Aerio build. No application ID is required.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Continue with Microsoft$/ }))
    await waitFor(() => expect(api.mail.accounts.connectMicrosoft).toHaveBeenCalled())
  })

  it('fills missing custom-provider settings with secure defaults', async () => {
    const user = userEvent.setup()
    render(<MailAccountSetupModal {...callbacks()} />)
    await user.click(await screen.findByRole('button', { name: /Set up another provider\. Other/ }))
    expect(screen.getAllByLabelText('Server')).toHaveLength(2)
    expect(screen.getAllByLabelText('Port').map((input) => (input as HTMLInputElement).value)).toEqual(['993', '465'])
    expect(screen.getAllByLabelText('Security').map((input) => (input as HTMLSelectElement).value)).toEqual(['tls', 'tls'])
  })

  it('uses friendly fallback messages for non-Error setup failures', async () => {
    const user = userEvent.setup()
    api.mail.presets.mockRejectedValueOnce('offline')
    const startup = callbacks(), first = render(<MailAccountSetupModal {...startup} />)
    await waitFor(() => expect(startup.onToast).toHaveBeenCalledWith('Account setup could not start'))
    first.unmount()

    api.mail.accounts.connect.mockRejectedValueOnce('denied')
    const connect = callbacks(), second = render(<MailAccountSetupModal {...connect} />)
    await user.click(await screen.findByRole('button', { name: /Continue with Google\. Gmail/ }))
    await user.click(screen.getByRole('button', { name: /Continue with Google$/ }))
    await waitFor(() => expect(connect.onToast).toHaveBeenCalledWith('The account could not be connected'))
    second.unmount()

    api.mail.credentials.status.mockResolvedValueOnce({ configured: false, source: 'user' } as any)
    api.mail.credentials.import.mockRejectedValueOnce('invalid')
    const google = callbacks(), third = render(<MailAccountSetupModal {...google} />)
    await user.click(await screen.findByRole('button', { name: /Continue with Google\. Gmail/ }))
    await user.click(screen.getByRole('button', { name: 'Import JSON' }))
    await waitFor(() => expect(google.onToast).toHaveBeenCalledWith('Google credentials could not be imported'))
    third.unmount()

    api.mail.credentials.microsoftStatus.mockResolvedValueOnce({ configured: false, source: 'user' } as any)
    api.mail.credentials.configureMicrosoft.mockRejectedValueOnce('invalid')
    const microsoft = callbacks()
    render(<MailAccountSetupModal {...microsoft} />)
    await user.click(await screen.findByRole('button', { name: /Continue with Microsoft\. Microsoft/ }))
    await user.type(screen.getByLabelText('Microsoft Application (client) ID'), 'client-id')
    await user.click(screen.getByRole('button', { name: /Continue with Microsoft$/ }))
    await waitFor(() => expect(microsoft.onToast).toHaveBeenCalledWith('Microsoft app configuration could not be saved'))
  })
})
