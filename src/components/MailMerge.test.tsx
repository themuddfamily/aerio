// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary, MailWorkerEvent } from '../mail-types'
import type { MailMergeJob, MailMergeJobInput } from '../mail-merge-types'
import { ContextMenuProvider } from './ContextMenu'
import MailComposeModal from './MailComposeModal'
import MailMergeModal, { MailMergeJobsModal } from './MailMerge'

const accounts: MailAccountSummary[] = [{
  id: 'account', provider: 'gmail', email: 'me@gmail.com', displayName: 'Me', color: '#123456', status: 'ready', archived: false,
  signature: '', notifications: true, syncEnabled: true
}]
const counts = { pending: 0, sending: 0, sent: 0, failed: 0, ambiguous: 0, skipped: 0, cancelled: 0 }
const job = (overrides: Partial<MailMergeJob> = {}): MailMergeJob => ({
  id: 'job-1', accountId: 'account', name: 'Hello', subject: 'Hello {{firstName}}', text: 'Hi', attachmentPaths: [], status: 'running',
  limits: { perMinute: 20, dailyCap: 400 }, counts: { ...counts, sent: 1, ambiguous: 1, pending: 1 }, total: 3,
  createdAt: '2026-10-17T09:00:00Z', updatedAt: '2026-10-17T09:00:00Z',
  recipients: [
    { position: 0, email: 'ada@example.com', name: 'Ada', status: 'sent', attempts: 1, updatedAt: '' },
    { position: 1, email: 'grace@example.com', status: 'ambiguous', attempts: 1, error: 'The send outcome is unknown', updatedAt: '' },
    { position: 2, email: 'linus@example.com', status: 'pending', attempts: 0, updatedAt: '' }
  ],
  ...overrides
})
let listener: ((event: MailWorkerEvent) => void) | undefined
const merge = {
  list: vi.fn(async () => [job()]),
  get: vi.fn(async () => job()),
  create: vi.fn(async (input: MailMergeJobInput) => job({ total: input.recipients.length })),
  pause: vi.fn(async () => job({ status: 'paused' })),
  resume: vi.fn(async () => job()),
  cancel: vi.fn(async () => job({ status: 'cancelled' })),
  resolve: vi.fn(async () => job()),
  delete: vi.fn(async () => undefined)
}
const api = {
  productivity: {
    snapshot: vi.fn(async () => ({ calendars: [], events: [], sync: [], contacts: [
      { id: 'c1', name: 'Ada Lovelace', email: 'ada@example.com', company: 'Analytical', group: 'Friends', favorite: false, color: '#000', nameParts: ['Lovelace', 'Ada', '', '', ''], remoteId: 'r', accountId: 'account', provider: 'google', readOnly: false },
      { id: 'c2', name: 'No Address', email: '', group: 'Friends', favorite: false, color: '#000', remoteId: 'r2', accountId: 'account', provider: 'google', readOnly: false }
    ] })),
    localSnapshot: vi.fn(async () => ({ tasks: [], notes: [], contacts: [{ id: 'c3', name: 'Grace Hopper', email: 'grace@example.com', group: 'Work', favorite: false, color: '#000' }] }))
  },
  mail: {
    mail: { suggestRecipients: vi.fn(async () => []) },
    drafts: { save: vi.fn(async () => ({ id: 'draft', status: 'synced', updatedAt: '2026-10-17T09:00:00Z' })) },
    identities: { list: vi.fn(async () => []), signatures: { list: vi.fn(async () => []) } },
    merge,
    onEvent: vi.fn((callback: (event: MailWorkerEvent) => void) => { listener = callback; return () => { listener = undefined } })
  }
}
const message = { accountId: 'account', subject: 'Hello {{firstName|there}}', text: 'Hi {{firstName|there}} from {{company}}', html: '<p>Hi {{firstName|there}} from {{company}}</p>', attachmentPaths: [] }

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'aerio', { configurable: true, value: api })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => true) })
})

describe('MailMergeModal', () => {
  it('selects contacts, previews each recipient, confirms limits and privacy, then shows progress', async () => {
    const user = userEvent.setup()
    const onToast = vi.fn()
    render(<MailMergeModal accounts={accounts} message={message} ignoredCopies={2} onClose={vi.fn()} onToast={onToast} />)
    await screen.findByText('Ada Lovelace')
    expect(screen.queryByText('No Address')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Select shown' }))
    expect(screen.getByText('2 recipients')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Preview/ }))

    // Contacts are sorted by name: Ada, then Grace.
    expect(screen.getByText('"Ada Lovelace" <ada@example.com>')).toBeInTheDocument()
    expect(screen.getByText('Hello Ada')).toBeInTheDocument()
    expect(screen.getByText('Hi Ada from Analytical')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next recipient' }))
    expect(screen.getByText('Hello Grace')).toBeInTheDocument()
    expect(screen.getByText(/No value for \{\{company\}\}/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Continue/ }))

    expect(screen.getByText(/exactly one recipient in To/)).toHaveTextContent('the 2 Cc/Bcc addresses in the composer will not be sent')
    expect(screen.getByText(/1 recipient has no \{\{company\}\}/)).toBeInTheDocument()
    expect(screen.getByText(/Gmail \(personal\) allows about 500/)).toBeInTheDocument()
    const daily = screen.getByLabelText('Daily limit for this account')
    expect(daily).toHaveValue(400)
    fireEvent.change(daily, { target: { value: '9000' } })
    expect(daily).toHaveValue(500)
    fireEvent.change(screen.getByLabelText('Messages per minute'), { target: { value: '5' } })
    await user.click(screen.getByRole('button', { name: 'Send 2 messages' }))

    await waitFor(() => expect(merge.create).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'account', subject: message.subject, limits: { perMinute: 5, dailyCap: 500 },
      recipients: [expect.objectContaining({ email: 'ada@example.com', firstName: 'Ada', company: 'Analytical' }), expect.objectContaining({ email: 'grace@example.com' })]
    })))
    expect(merge.create.mock.calls[0][0]).not.toHaveProperty('cc')
    expect(onToast).toHaveBeenCalledWith('Mail merge started for 2 recipients')
    expect(await screen.findByText('1 of 3 sent')).toBeInTheDocument()
    expect(screen.getByText(/Sending continues in the background/)).toBeInTheDocument()
  })

  it('parses a pasted CSV with custom columns and reports invalid and duplicate rows', async () => {
    const user = userEvent.setup()
    render(<MailMergeModal accounts={accounts} message={{ ...message, text: 'Your plan: {{plan}}', html: undefined }} initialList={''} onClose={vi.fn()} onToast={vi.fn()} />)
    await user.click(screen.getByRole('tab', { name: /Paste or CSV/ }))
    fireEvent.change(screen.getByLabelText('Recipient list'), { target: { value: 'email,first name,plan\nada@example.com,Ada,Pro\nADA@example.com,Dup,Free\nnope,,' } })
    expect(screen.getByText('1 recipient')).toBeInTheDocument()
    expect(screen.getByText(/1 invalid address left out/)).toBeInTheDocument()
    expect(screen.getByText(/1 duplicate removed/)).toBeInTheDocument()
    expect(screen.getByText(/columns: \{\{plan\}\}/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Preview/ }))
    expect(screen.getByText('Your plan: Pro')).toBeInTheDocument()
  })

  it('starts from addresses typed into To and blocks an empty list', async () => {
    render(<MailMergeModal accounts={accounts} message={message} initialList="bad-address" onClose={vi.fn()} onToast={vi.fn()} />)
    expect(screen.getByLabelText('Recipient list')).toHaveValue('bad-address')
    expect(screen.getByRole('button', { name: /Preview/ })).toBeDisabled()
  })
})

describe('MailMergeProgress and jobs', () => {
  it('lists jobs, opens one, and resolves ambiguous sends explicitly', async () => {
    const user = userEvent.setup()
    render(<MailMergeJobsModal accounts={accounts} onClose={vi.fn()} onToast={vi.fn()} />)
    expect(await screen.findByText(/1 send to review/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open' }))
    const review = await screen.findByRole('region', { name: 'Sends that need review' })
    expect(review).toHaveTextContent('1 message may or may not have been sent')
    await user.click(screen.getByRole('button', { name: 'Resend to grace@example.com' }))
    expect(merge.resolve).toHaveBeenLastCalledWith('job-1', [1], 'resend')
    await user.click(within(review).getByRole('button', { name: /Skip all/ }))
    expect(merge.resolve).toHaveBeenLastCalledWith('job-1', [1], 'skip')
    await user.click(screen.getByRole('button', { name: 'Skip linus@example.com' }))
    expect(merge.resolve).toHaveBeenLastCalledWith('job-1', [2], 'skip')
    // A sent recipient offers neither resend nor skip.
    expect(screen.queryByRole('button', { name: 'Resend to ada@example.com' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Pause/ }))
    expect(merge.pause).toHaveBeenCalledWith('job-1')
    await user.click(screen.getByRole('button', { name: /Cancel remaining/ }))
    expect(merge.cancel).toHaveBeenCalledWith('job-1')
    merge.get.mockResolvedValueOnce(job({ status: 'completed', counts: { ...counts, sent: 3 } }))
    listener?.({ type: 'mail-merge', payload: job({ status: 'completed' }) })
    expect(await screen.findByText('Finished')).toBeInTheDocument()
  })
})

describe('composer entry point', () => {
  it('opens a mail merge with the composed message and the typed recipients', async () => {
    const user = userEvent.setup()
    render(<ContextMenuProvider><MailComposeModal accounts={accounts} onClose={vi.fn()} onSent={vi.fn()} onToast={vi.fn()} /></ContextMenuProvider>)
    await user.type(screen.getByPlaceholderText('name@example.com'), 'ada@example.com, grace@example.com')
    await user.click(screen.getByRole('button', { name: /Mail merge/ }))
    expect(await screen.findByLabelText('Recipient list')).toHaveValue('ada@example.com, grace@example.com')
    expect(screen.getByText('2 recipients')).toBeInTheDocument()
  })
})
