// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary, MailAutomaticRepliesState } from '../mail-types'
import { automaticReplyCapabilities } from '../../electron/mail/automatic-replies'
import { isoToLocalInput, localInputToIso } from '../lib/automatic-replies'
import MailAutomaticRepliesSection from './MailAutomaticRepliesSection'

const account = (overrides: Partial<MailAccountSummary> = {}): MailAccountSummary => ({
  id: 'account', provider: 'gmail', email: 'person@gmail.com', displayName: 'Person', color: '#1d7a62', status: 'ready',
  archived: false, signature: '', notifications: true, syncEnabled: true, ...overrides
})
const state = (overrides: Partial<MailAutomaticRepliesState> = {}): MailAutomaticRepliesState => ({
  accountId: 'account', provider: 'gmail', supported: true, canRead: true, canWrite: true, needsReconnect: false, missingScopes: [], warnings: [],
  capabilities: automaticReplyCapabilities('gmail', 'person@gmail.com'), phase: 'off', readAt: '2026-10-17T12:00:00Z',
  settings: { enabled: false, subject: '', internalMessage: '', externalMessage: '', externalAudience: 'all' },
  ...overrides
})
const api = {
  mail: {
    automaticReplies: { get: vi.fn(), update: vi.fn(), disable: vi.fn() },
    accounts: { reconnect: vi.fn(async () => undefined) }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'aerio', { configurable: true, value: api })
  api.mail.automaticReplies.get.mockResolvedValue(state())
  api.mail.accounts.reconnect.mockResolvedValue(undefined)
})

describe('MailAutomaticRepliesSection', () => {
  it('converts datetime-local values through local time', () => {
    const iso = localInputToIso('2026-10-20T09:30')!
    expect(new Date(iso).getHours()).toBe(9)
    expect(isoToLocalInput(iso)).toBe('2026-10-20T09:30')
    expect(localInputToIso('not a date')).toBeUndefined()
    expect(isoToLocalInput(undefined)).toBe('')
    expect(isoToLocalInput('garbage')).toBe('')
  })

  it('explains unsupported accounts without offering a form', async () => {
    api.mail.automaticReplies.get.mockResolvedValue({ ...state({ provider: 'imap', supported: false, canRead: false, canWrite: false, capabilities: undefined, settings: undefined }), message: 'IMAP and SMTP have no standard way to manage out-of-office replies.' })
    render(<MailAutomaticRepliesSection account={account({ provider: 'imap' })} onToast={vi.fn()} />)
    expect(await screen.findByText(/IMAP and SMTP have no standard way/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Save automatic replies/ })).not.toBeInTheDocument()
  })

  it('saves a scheduled Gmail reply converted from local time and shows the read-back status', async () => {
    const user = userEvent.setup(), onToast = vi.fn()
    api.mail.automaticReplies.update.mockImplementation(async (_id: string, settings: any) => state({ settings, phase: 'scheduled' }))
    render(<MailAutomaticRepliesSection account={account()} onToast={onToast} />)
    await screen.findByText('Off')
    expect(screen.queryByRole('option', { name: 'Only people in my organization' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: /Send automatic replies/ }))
    await user.click(screen.getByRole('checkbox', { name: /Only during a time range/ }))
    const start = screen.getByLabelText('Starts'), end = screen.getByLabelText('Ends')
    await user.clear(start); await user.type(start, '2030-01-02T09:00')
    await user.clear(end); await user.type(end, '2030-01-09T17:30')
    await user.type(screen.getByLabelText('Subject'), 'Away')
    await user.type(screen.getByLabelText('Reply message'), 'Back next week')
    await user.selectOptions(screen.getByLabelText('Who receives replies'), 'contacts')
    await user.click(screen.getByRole('button', { name: /Save automatic replies/ }))
    await waitFor(() => expect(api.mail.automaticReplies.update).toHaveBeenCalled())
    expect(api.mail.automaticReplies.update).toHaveBeenCalledWith('account', {
      enabled: true, subject: 'Away', internalMessage: 'Back next week', externalMessage: '', externalAudience: 'contacts',
      startAt: new Date(2030, 0, 2, 9, 0).toISOString(), endAt: new Date(2030, 0, 9, 17, 30).toISOString()
    })
    expect(onToast).toHaveBeenCalledWith('Automatic replies saved to Gmail')
    expect(await screen.findByText(/Scheduled · starts Wed 2 Jan 2030, 09:00/)).toBeInTheDocument()
  })

  it('shows Outlook internal and external replies and turns an active reply off', async () => {
    const user = userEvent.setup(), onToast = vi.fn()
    const active = state({
      provider: 'microsoft', capabilities: automaticReplyCapabilities('microsoft', 'me@company.test'), phase: 'active', serverTimeZone: 'Pacific Standard Time',
      settings: { enabled: true, subject: '', internalMessage: 'Inside', externalMessage: 'Outside', externalAudience: 'all', startAt: '2026-10-16T00:00:00Z', endAt: '2026-10-30T00:00:00Z' }
    })
    api.mail.automaticReplies.get.mockResolvedValue(active)
    api.mail.automaticReplies.disable.mockResolvedValue(state({ ...active, phase: 'off', settings: { ...active.settings!, enabled: false } }))
    render(<MailAutomaticRepliesSection account={account({ provider: 'microsoft' })} onToast={onToast} />)
    expect(await screen.findByText(/On now · ends/)).toBeInTheDocument()
    expect(screen.getByText(/the mailbox uses Pacific Standard Time/)).toBeInTheDocument()
    expect(screen.getByLabelText('Reply to people in my organization')).toHaveValue('Inside')
    expect(screen.getByLabelText('Reply to people outside my organization')).toHaveValue('Outside')
    expect(screen.queryByLabelText('Subject')).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Reply outside my organization'), 'none')
    expect(screen.queryByLabelText('Reply to people outside my organization')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Turn off now/ }))
    await waitFor(() => expect(api.mail.automaticReplies.disable).toHaveBeenCalledWith('account'))
    expect(onToast).toHaveBeenCalledWith('Automatic replies turned off')
    expect(await screen.findByText('Off')).toBeInTheDocument()
  })

  it('explains a missing permission, locks editing, and reconnects before reloading', async () => {
    const user = userEvent.setup(), onToast = vi.fn()
    api.mail.automaticReplies.get
      .mockResolvedValueOnce(state({ canWrite: false, needsReconnect: true, missingScopes: ['https://www.googleapis.com/auth/gmail.settings.basic'], message: 'Reconnect to allow gmail.settings.basic.' }))
      .mockResolvedValueOnce(state())
    render(<MailAutomaticRepliesSection account={account()} onToast={onToast} />)
    expect(await screen.findByText('Reconnect to allow gmail.settings.basic.')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Send automatic replies/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Save automatic replies/ })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: /Reconnect to grant permission/ }))
    await waitFor(() => expect(api.mail.automaticReplies.get).toHaveBeenCalledTimes(2))
    expect(api.mail.accounts.reconnect).toHaveBeenCalledWith('account')
    expect(onToast).toHaveBeenCalledWith('Account reconnected')
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Send automatic replies/ })).toBeEnabled())
  })

  it('reports a permission failure returned by a save and other failures', async () => {
    const user = userEvent.setup(), onToast = vi.fn()
    api.mail.automaticReplies.update.mockResolvedValueOnce(state({ canWrite: false, needsReconnect: true, message: 'Permission needed' }))
    render(<MailAutomaticRepliesSection account={account()} onToast={onToast} />)
    await screen.findByText('Off')
    await user.click(screen.getByRole('button', { name: /Save automatic replies/ }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Permission needed'))
    api.mail.automaticReplies.get.mockRejectedValueOnce(new Error('Gmail is unreachable'))
    await user.click(screen.getByRole('button', { name: /Reload from server/ }))
    expect(await screen.findByText('Gmail is unreachable')).toBeInTheDocument()
  })

  it('shows provider warnings and a friendly load fallback', async () => {
    api.mail.automaticReplies.get.mockResolvedValueOnce(state({ warnings: ['Formatting will be replaced.'] }))
    const view = render(<MailAutomaticRepliesSection account={account()} onToast={vi.fn()} />)
    expect(await screen.findByText('Formatting will be replaced.')).toBeInTheDocument()
    view.unmount()
    api.mail.automaticReplies.get.mockRejectedValueOnce('bad')
    render(<MailAutomaticRepliesSection account={account()} onToast={vi.fn()} />)
    expect(await screen.findByText('Automatic replies could not be loaded')).toBeInTheDocument()
  })
})
