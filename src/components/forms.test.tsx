// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary, MailLabel, MailThreadSummary } from '../mail-types'
import MailOrganizeModal from './MailOrganizeModal'
import MailSearchFiltersPanel from './MailSearchFiltersPanel'
import MailSnoozeModal from './MailSnoozeModal'
import ProfileModal from './ProfileModal'

const account = (overrides: Partial<MailAccountSummary> = {}): MailAccountSummary => ({
  id: 'gmail-1', provider: 'gmail', email: 'person@example.test', displayName: 'Personal',
  color: '#123456', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true,
  lastSyncAt: '2026-08-08T10:00:00Z', ...overrides
})

const thread = (overrides: Partial<MailThreadSummary> = {}): MailThreadSummary => ({
  accountId: 'gmail-1', id: 'thread-1', subject: 'Subject', snippet: 'Preview',
  participants: ['Sender'], senderEmail: 'sender@example.test', lastDate: '2026-08-08T10:00:00Z',
  unread: false, starred: false, important: false, trashed: false, draft: false,
  hasAttachments: false, labelIds: ['INBOX'], messageCount: 1,
  ...overrides
})

describe('MailSearchFiltersPanel', () => {
  it('edits, normalizes, and submits every advanced-search field', async () => {
    const user = userEvent.setup()
    const onApply = vi.fn()
    const onClose = vi.fn()
    render(<MailSearchFiltersPanel value={{ from: ' initial ', unread: true }} onApply={onApply} onClose={onClose} />)
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Advanced mail search')
    const inputs = screen.getAllByRole('textbox')
    await user.clear(inputs[0]); await user.type(inputs[0], '  ada@example.com  ')
    await user.type(inputs[1], ' recipient@example.com ')
    await user.type(inputs[2], ' Engines ')
    await user.type(inputs[3], ' report.pdf ')
    const dates = document.querySelectorAll<HTMLInputElement>('input[type="date"]')
    fireEvent.change(dates[0], { target: { value: '2026-08-01' } })
    fireEvent.change(dates[1], { target: { value: '2026-08-08' } })
    const selects = screen.getAllByRole('combobox')
    await user.selectOptions(selects[0], 'false')
    await user.selectOptions(selects[1], 'true')
    await user.selectOptions(selects[2], 'false')
    await user.selectOptions(selects[3], 'true')
    await user.click(screen.getByRole('button', { name: 'Apply filters' }))
    expect(onApply).toHaveBeenCalledWith({
      from: 'ada@example.com', to: 'recipient@example.com', subject: 'Engines', attachmentName: 'report.pdf',
      dateFrom: '2026-08-01', dateTo: '2026-08-08', unread: false, hasAttachments: true, starred: false, important: true
    })
    expect(dates[0]).toHaveAttribute('max', '2026-08-08')
    expect(dates[1]).toHaveAttribute('min', '2026-08-01')
  })

  it('resets optional values and closes from header or footer', async () => {
    const user = userEvent.setup()
    const onApply = vi.fn()
    const onClose = vi.fn()
    render(<MailSearchFiltersPanel value={{ from: 'Ada', unread: false }} onApply={onApply} onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    await user.click(screen.getByRole('button', { name: 'Apply filters' }))
    expect(onApply).toHaveBeenCalledWith({})
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: 'Close advanced search' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('MailSnoozeModal', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-08T10:00:00'))
  })

  afterEach(() => vi.useRealTimers())

  it('applies a preset future time and closes after success', async () => {
    const onApply = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    render(<MailSnoozeModal count={1} onApply={onApply} onClose={onClose} />)
    expect(screen.getByText('1 conversation will return to Inbox')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Later today/ }))
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(new Date('2026-08-08T18:00:00').toISOString()))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('uses a three-hour fallback after 18:00 and remains open after failure', async () => {
    vi.setSystemTime(new Date('2026-08-08T20:00:00'))
    const onApply = vi.fn().mockRejectedValue(new Error('offline'))
    const onClose = vi.fn()
    render(<MailSnoozeModal count={2} onApply={onApply} onClose={onClose} />)
    expect(screen.getByText('2 conversations will return to Inbox')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Later today/ }))
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(new Date('2026-08-08T23:00:00').toISOString()))
    expect(onClose).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('button', { name: /Later today/ })).toBeEnabled())
  })

  it('validates and submits a custom time and supports cancel', async () => {
    const onApply = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    render(<MailSnoozeModal count={3} onApply={onApply} onClose={onClose} />)
    const input = document.querySelector<HTMLInputElement>('input[type="datetime-local"]')!
    fireEvent.change(input, { target: { value: '2026-08-08T09:00' } })
    expect(screen.getByRole('button', { name: 'Snooze' })).toBeDisabled()
    fireEvent.change(input, { target: { value: 'invalid' } })
    fireEvent.click(screen.getByRole('button', { name: 'Snooze' }))
    expect(onApply).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '2026-08-09T12:30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Snooze' }))
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(new Date('2026-08-09T12:30').toISOString()))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('MailOrganizeModal', () => {
  const accounts = [account(), account({ id: 'imap-1', provider: 'imap', displayName: '', email: 'imap@example.test' })]
  const labels: MailLabel[] = [
    { accountId: 'gmail-1', id: 'user-1', name: 'Projects', type: 'user' },
    { accountId: 'gmail-1', id: 'SENT', name: 'Sent', type: 'system' },
    { accountId: 'imap-1', id: 'folder:Archive', name: 'Archive', type: 'user' },
    { accountId: 'imap-1', id: 'folder:Sent', name: 'Sent items', type: 'system' }
  ]

  it('builds per-account move destinations and applies grouped thread IDs', async () => {
    const onApply = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    render(<MailOrganizeModal
      mode="move" items={[thread(), thread({ id: 'thread-2' }), thread({ id: 'thread-3', accountId: 'imap-1' })]}
      accounts={accounts} labels={labels} onApply={onApply} onClose={onClose}
    />)
    expect(screen.getByText('3 selected conversations')).toBeInTheDocument()
    const selects = screen.getAllByRole('combobox')
    expect(within(selects[0]).getByRole('option', { name: 'Inbox' })).toBeInTheDocument()
    expect(within(selects[0]).getByRole('option', { name: 'Spam' })).toBeInTheDocument()
    expect(within(selects[1]).queryByRole('option', { name: 'Sent items' })).not.toBeInTheDocument()
    fireEvent.change(selects[0], { target: { value: 'user-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    await waitFor(() => expect(onApply).toHaveBeenCalledWith([
      { accountId: 'gmail-1', threadIds: ['thread-1', 'thread-2'], action: 'move', labelId: 'user-1' },
      { accountId: 'imap-1', threadIds: ['thread-3'], action: 'move', labelId: 'folder:Archive' }
    ]))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('applies and removes Gmail labels while explaining folder-only providers', async () => {
    const onApply = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    const { rerender } = render(<MailOrganizeModal mode="label" items={[thread()]} accounts={accounts} labels={labels} onApply={onApply} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Apply label' }))
    await waitFor(() => expect(onApply).toHaveBeenLastCalledWith([
      { accountId: 'gmail-1', threadIds: ['thread-1'], action: 'label', labelId: 'user-1' }
    ]))

    rerender(<MailOrganizeModal mode="label" items={[thread({ accountId: 'imap-1' })]} accounts={accounts} labels={labels} onApply={onApply} onClose={onClose} />)
    expect(screen.getByText('This provider uses folders instead of independent labels.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply label' })).toBeDisabled()

    rerender(<MailOrganizeModal mode="label" items={[thread()]} accounts={accounts} labels={labels} onApply={onApply} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove label' }))
    await waitFor(() => expect(onApply).toHaveBeenLastCalledWith([
      { accountId: 'gmail-1', threadIds: ['thread-1'], action: 'unlabel', labelId: 'user-1' }
    ]))
  })

  it('restores busy controls when applying rejects and supports an unknown account', async () => {
    const onApply = vi.fn().mockRejectedValue(new Error('failed'))
    render(<MailOrganizeModal mode="move" items={[thread({ accountId: 'missing' })]} accounts={[]} labels={[]} onApply={onApply} onClose={vi.fn()} />)
    expect(screen.getByText('Mail account')).toBeInTheDocument()
    expect(screen.getByText('No destination folders are available.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled()
  })
})

describe('ProfileModal', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'aerio', {
      configurable: true,
      value: { chooseProfileImage: vi.fn().mockResolvedValue('data:image/png;base64,image') }
    })
  })

  it('chooses, removes, and saves a normalized profile', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const onClose = vi.fn()
    const onToast = vi.fn()
    render(<ProfileModal profile={{ displayName: 'Ada Lovelace' }} onSave={onSave} onClose={onClose} onToast={onToast} />)
    expect(screen.getByText('AL')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Add picture/ }))
    expect(await screen.findByRole('img', { name: 'Profile' })).toHaveAttribute('src', 'data:image/png;base64,image')
    await user.click(screen.getByRole('button', { name: /Remove/ }))
    expect(screen.queryByRole('img', { name: 'Profile' })).not.toBeInTheDocument()
    const fields = screen.getAllByRole('textbox')
    await user.clear(fields[0]); await user.type(fields[0], '  Grace Hopper  ')
    await user.type(fields[1], '  grace@example.test  ')
    await user.click(screen.getByRole('button', { name: 'Save profile' }))
    expect(onSave).toHaveBeenCalledWith({ displayName: 'Grace Hopper', email: 'grace@example.test', avatarDataUrl: undefined })
    expect(onToast).toHaveBeenCalledWith('Profile updated')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('handles image cancellation and both error forms', async () => {
    const onToast = vi.fn()
    const choose = vi.mocked(window.aerio.chooseProfileImage)
    choose.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Image too large')).mockRejectedValueOnce('failed')
    render(<ProfileModal profile={{ displayName: '' }} onSave={vi.fn()} onClose={vi.fn()} onToast={onToast} />)
    expect(screen.getByText('A')).toBeInTheDocument()
    const button = screen.getByRole('button', { name: /Add picture/ })
    fireEvent.click(button)
    await waitFor(() => expect(choose).toHaveBeenCalledTimes(1))
    fireEvent.click(button)
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Image too large'))
    fireEvent.click(button)
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('The profile picture could not be opened'))
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeDisabled()
  })
})
