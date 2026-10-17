// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExchangeSnapshot } from '../exchange-types'
import type { MailAccountSummary, MailProviderPreset } from '../mail-types'
import ExchangeAccountSection from './ExchangeAccountSection'
import ExchangeAccountSetup from './ExchangeAccountSetup'
import MailAccountSetupModal from './MailAccountSetupModal'

const account: MailAccountSummary = { id: 'ex-1', provider: 'exchange', email: 'ada@contoso.test', displayName: 'Ada', color: '#0f6cbd', status: 'needs-auth', archived: false, signature: '', notifications: true, syncEnabled: true }

const snapshot = (): ExchangeSnapshot => ({
  accounts: [{
    accountId: 'ex-1', email: 'ada@contoso.test', username: 'CONTOSO\\ada', ewsUrl: 'https://mail.contoso.test/EWS/Exchange.asmx', auth: 'ntlm', serverVersion: '15.2.1118.7 (Exchange 2019)',
    status: 'needs-auth', error: 'Exchange rejected the saved credentials.', pendingWrites: 1,
    capabilities: { mail: { read: true, write: true, detail: 'Mail through EWS.' }, calendar: { read: true, write: true, detail: '1 writable calendar' }, contacts: { read: true, write: false, detail: 'No writable contacts folder' }, folderManagement: true, notes: ['Free/busy lookup is not available.'] }
  }],
  review: [{ id: 'op-1', accountId: 'ex-1', kind: 'event', action: 'update', status: 'conflict', title: 'Budget (mine)', serverTitle: 'Budget (server)', error: 'Changed on the server since you edited it', serverDeleted: false, updatedAt: '2026-10-17T10:00:00Z' }]
})

const exchange = {
  discover: vi.fn(),
  connect: vi.fn(async () => account),
  snapshot: vi.fn(async () => snapshot()),
  updateCredentials: vi.fn(async () => ({ ...snapshot(), review: [] })),
  sync: vi.fn(async () => snapshot()),
  resolve: vi.fn(async () => ({ ...snapshot(), review: [] })),
  onChanged: vi.fn(() => () => undefined)
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'aerio', { configurable: true, value: { exchange } })
})

describe('ExchangeAccountSetup', () => {
  it('asks before trusting a cross-domain Autodiscover redirect, then connects with the discovered EWS URL', async () => {
    const user = userEvent.setup()
    exchange.discover
      .mockResolvedValueOnce({ status: 'confirm-redirect', email: 'ada@contoso.test', fromUrl: 'http://autodiscover.contoso.test/autodiscover/autodiscover.xml', toUrl: 'https://autodiscover.hoster.example/autodiscover/autodiscover.xml', host: 'autodiscover.hoster.example', reason: 'http-redirect', attempts: [] })
      .mockResolvedValueOnce({ status: 'found', email: 'ada@contoso.test', ewsUrl: 'https://ews.hoster.example/EWS/Exchange.asmx', autodiscoverUrl: 'https://autodiscover.hoster.example/autodiscover/autodiscover.xml', source: 'http-redirect', serverVersion: '15.2.1118', attempts: [] })
    const onConnect = vi.fn(async (task: () => Promise<unknown>) => { await task() })
    render(<ExchangeAccountSetup busy={false} onConnect={onConnect} onToast={vi.fn()} />)
    await user.type(screen.getByLabelText('Email address'), 'ada@contoso.test')
    await user.type(screen.getByLabelText('Password'), 'Pa55w0rd!')
    await user.click(screen.getByRole('button', { name: /Find my server/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('autodiscover.hoster.example')
    await user.click(screen.getByRole('button', { name: 'Trust autodiscover.hoster.example and continue' }))
    expect(exchange.discover).toHaveBeenLastCalledWith({ email: 'ada@contoso.test', password: 'Pa55w0rd!', trustedHosts: ['autodiscover.hoster.example'] })
    expect(await screen.findByLabelText('EWS URL')).toHaveValue('https://ews.hoster.example/EWS/Exchange.asmx')
    await user.click(screen.getByRole('button', { name: 'Connect Exchange account' }))
    expect(exchange.connect).toHaveBeenCalledWith({ email: 'ada@contoso.test', ewsUrl: 'https://ews.hoster.example/EWS/Exchange.asmx', auth: 'auto', password: 'Pa55w0rd!' })
  })

  it('lets the user enter the EWS URL and an OAuth token for hybrid deployments', async () => {
    const user = userEvent.setup()
    const onConnect = vi.fn(async (task: () => Promise<unknown>) => { await task() })
    render(<ExchangeAccountSetup busy={false} onConnect={onConnect} onToast={vi.fn()} />)
    await user.type(screen.getByLabelText('Email address'), 'ada@contoso.test')
    await user.selectOptions(screen.getByLabelText('Authentication'), 'bearer')
    await user.type(screen.getByLabelText('OAuth access token'), 'eyJ0eXAi')
    await user.click(screen.getByRole('button', { name: 'Enter the EWS URL instead' }))
    await user.type(screen.getByLabelText('EWS URL'), 'https://mail.contoso.test/EWS/Exchange.asmx')
    await user.click(screen.getByRole('button', { name: 'Connect Exchange account' }))
    expect(exchange.connect).toHaveBeenCalledWith({ email: 'ada@contoso.test', ewsUrl: 'https://mail.contoso.test/EWS/Exchange.asmx', auth: 'bearer', bearerToken: 'eyJ0eXAi' })
  })

  it('is offered in the add-account dialog next to Microsoft 365', async () => {
    const user = userEvent.setup()
    const presets: MailProviderPreset[] = [
      { id: 'microsoft', name: 'Outlook & Microsoft 365', description: 'Graph', auth: 'microsoft-oauth' },
      { id: 'exchange', name: 'Microsoft Exchange Server', description: 'On-premises Exchange through EWS.', auth: 'exchange' }
    ]
    Object.defineProperty(window, 'aerio', { configurable: true, value: { exchange, mail: { presets: vi.fn(async () => presets), credentials: { status: vi.fn(async () => ({ configured: true })), microsoftStatus: vi.fn(async () => ({ configured: true })) } } } })
    render(<MailAccountSetupModal onClose={vi.fn()} onConnected={vi.fn()} onToast={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: /Connect Exchange Server/ }))
    expect(screen.getByRole('button', { name: /Find my server/ })).toBeInTheDocument()
    expect(screen.getByText(/Use “Outlook & Microsoft 365” for Exchange Online/)).toBeInTheDocument()
  })
})

describe('ExchangeAccountSection', () => {
  it('shows capabilities and prompts for new credentials after a 401', async () => {
    const user = userEvent.setup()
    const onToast = vi.fn()
    render(<ExchangeAccountSection account={account} onToast={onToast} />)
    expect(await screen.findByText(/15.2.1118.7 \(Exchange 2019\)/)).toBeInTheDocument()
    expect(screen.getByText(/Read-only. No writable contacts folder/)).toBeInTheDocument()
    expect(screen.getByText(/rejected the saved sign-in/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('New password'), 'N3w!')
    await user.click(screen.getByRole('button', { name: /Verify and save/ }))
    expect(exchange.updateCredentials).toHaveBeenCalledWith('ex-1', { password: 'N3w!' })
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Exchange sign-in verified and saved'))
  })

  it('resolves a ChangeKey conflict from the review list', async () => {
    const user = userEvent.setup()
    render(<ExchangeAccountSection account={{ ...account, status: 'ready' }} onToast={vi.fn()} />)
    expect(await screen.findByText(/The server now has “Budget \(server\)”/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Keep server version' }))
    expect(exchange.resolve).toHaveBeenCalledWith('op-1', 'keep-server')
  })
})
