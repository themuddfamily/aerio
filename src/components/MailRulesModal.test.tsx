// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary, MailLabel, MailRule } from '../mail-types'
import MailRulesModal from './MailRulesModal'

const account = (overrides: Partial<MailAccountSummary> = {}): MailAccountSummary => ({
  id: 'account-1', provider: 'gmail', email: 'person@example.test', displayName: 'Personal', color: '#123456',
  status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true,
  lastSyncAt: '2026-08-08T10:00:00Z', ...overrides
})

const rule = (overrides: Partial<MailRule> = {}): MailRule => ({
  id: 'rule-1', accountId: 'account-1', name: 'Newsletters', enabled: true, match: 'all',
  conditions: [{ field: 'from', operator: 'contains', value: 'news@example.test' }],
  actions: [{ action: 'archive' }], matchCount: 0, createdAt: '2026-08-08T10:00:00Z', updatedAt: '2026-08-08T10:00:00Z',
  ...overrides
})

describe('MailRulesModal', () => {
  let api: {
    list: ReturnType<typeof vi.fn>
    save: ReturnType<typeof vi.fn>
    delete: ReturnType<typeof vi.fn>
    run: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    api = {
      list: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      run: vi.fn().mockResolvedValue({ matched: 0, actionsQueued: 0 })
    }
    Object.defineProperty(window, 'aerio', { configurable: true, value: { mail: { rules: api } } })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  const labels: MailLabel[] = [
    { accountId: 'account-1', id: 'projects', name: 'Projects', type: 'user' },
    { accountId: 'account-1', id: 'sent', name: 'Sent items', type: 'system' },
    { accountId: 'other', id: 'other-label', name: 'Other', type: 'user' }
  ]

  it('loads the empty state, closes, and disables creation without writable accounts', async () => {
    const onClose = vi.fn()
    const { rerender } = render(<MailRulesModal accounts={[account()]} labels={labels} onToast={vi.fn()} onClose={onClose} />)
    expect(screen.getByText('Loading rules…')).toBeInTheDocument()
    expect(await screen.findByText('No rules yet')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)
    expect(onClose).toHaveBeenCalledOnce()

    rerender(<MailRulesModal accounts={[account({ archived: true })]} labels={labels} onToast={vi.fn()} onClose={onClose} />)
    expect(screen.getByRole('button', { name: /New rule/ })).toBeDisabled()
  })

  it('reports both Error and non-Error loading failures', async () => {
    const onToast = vi.fn()
    api.list.mockRejectedValueOnce(new Error('Database locked'))
    const first = render(<MailRulesModal accounts={[account()]} labels={labels} onToast={onToast} onClose={vi.fn()} />)
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Database locked'))
    first.unmount()
    api.list.mockRejectedValueOnce('failed')
    render(<MailRulesModal accounts={[account()]} labels={labels} onToast={onToast} onClose={vi.fn()} />)
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Rules could not be loaded'))
  })

  it('creates a multi-condition, multi-action rule and filters destinations', async () => {
    const onToast = vi.fn()
    api.save.mockImplementation(async (input: any) => rule({ ...input, id: 'saved-rule' }))
    render(<MailRulesModal accounts={[account()]} labels={labels} onToast={onToast} onClose={vi.fn()} />)
    await screen.findByText('No rules yet')
    fireEvent.click(screen.getByRole('button', { name: /New rule/ }))
    fireEvent.change(screen.getByPlaceholderText('e.g. Project updates'), { target: { value: '  Project mail  ' } })
    fireEvent.change(screen.getByLabelText('Condition 1 field'), { target: { value: 'subject' } })
    fireEvent.change(screen.getByLabelText('Condition 1 comparison'), { target: { value: 'starts-with' } })
    fireEvent.change(screen.getByLabelText('Condition 1 value'), { target: { value: '[Project]' } })
    fireEvent.change(screen.getByDisplayValue('All conditions'), { target: { value: 'any' } })

    fireEvent.click(screen.getByRole('button', { name: /Add condition/ }))
    fireEvent.change(screen.getByLabelText('Condition 2 field'), { target: { value: 'body' } })
    fireEvent.change(screen.getByLabelText('Condition 2 comparison'), { target: { value: 'ends-with' } })
    fireEvent.change(screen.getByLabelText('Condition 2 value'), { target: { value: 'deadline' } })
    expect(screen.getByRole('button', { name: 'Remove condition 1' })).toBeEnabled()

    fireEvent.change(screen.getByLabelText('Action 1'), { target: { value: 'label' } })
    const destination = screen.getByLabelText('Action 1 destination')
    expect(within(destination).getByRole('option', { name: 'Projects' })).toBeInTheDocument()
    expect(within(destination).queryByRole('option', { name: 'Sent items' })).not.toBeInTheDocument()
    fireEvent.change(destination, { target: { value: 'projects' } })
    fireEvent.click(screen.getByRole('button', { name: /Add action/ }))
    fireEvent.change(screen.getByLabelText('Action 2'), { target: { value: 'important' } })
    fireEvent.click(screen.getByLabelText('Enable this rule for new mail'))

    fireEvent.click(screen.getByRole('button', { name: /Save rule/ }))
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'account-1', name: '  Project mail  ', enabled: false, match: 'any',
      conditions: [
        { field: 'subject', operator: 'starts-with', value: '[Project]' },
        { field: 'body', operator: 'ends-with', value: 'deadline' }
      ],
      actions: [{ action: 'label', labelId: 'projects' }, { action: 'important' }]
    })))
    expect(onToast).toHaveBeenCalledWith('Rule saved')
    expect(await screen.findByText('Project mail')).toBeInTheDocument()
  })

  it('adds and removes editor rows, resets action destinations, and cancels editing', async () => {
    render(<MailRulesModal accounts={[account()]} labels={labels} onToast={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('No rules yet')
    fireEvent.click(screen.getByRole('button', { name: /New rule/ }))
    expect(screen.getByRole('button', { name: 'Remove condition 1' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove action 1' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /Add condition/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove condition 1' }))
    expect(screen.queryByLabelText('Condition 2 value')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Action 1'), { target: { value: 'move' } })
    fireEvent.change(screen.getByLabelText('Action 1 destination'), { target: { value: 'projects' } })
    fireEvent.change(screen.getByLabelText('Action 1'), { target: { value: 'read' } })
    expect(screen.queryByLabelText('Action 1 destination')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Add action/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove action 1' }))
    expect(screen.queryByLabelText('Action 2')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('No rules yet')).toBeInTheDocument()
  })

  it('edits, toggles, runs, and deletes existing rules', async () => {
    const existing = rule({
      name: 'Existing', matchCount: 2,
      conditions: [
        { field: 'from', operator: 'contains', value: 'one' },
        { field: 'subject', operator: 'equals', value: 'two' }
      ],
      actions: [{ action: 'archive' }, { action: 'star' }]
    })
    api.list.mockResolvedValue([existing])
    api.save.mockImplementation(async (input: any) => ({ ...existing, ...input }))
    api.run.mockResolvedValueOnce({ matched: 1, actionsQueued: 2 }).mockResolvedValueOnce({ matched: 0, actionsQueued: 0 })
    const onToast = vi.fn()
    render(<MailRulesModal accounts={[account()]} labels={labels} onToast={onToast} onClose={vi.fn()} />)
    expect(await screen.findByText('Existing')).toBeInTheDocument()
    expect(screen.getByText(/2 conditions · 2 actions/)).toBeInTheDocument()
    expect(screen.getByText('Matched 2 times')).toBeInTheDocument()

    fireEvent.click(screen.getByTitle('Run on existing Inbox'))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Rule applied to 1 conversation'))
    fireEvent.click(screen.getByTitle('Run on existing Inbox'))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('No existing Inbox conversations matched'))

    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ enabled: false })))

    fireEvent.click(screen.getByTitle('Edit rule'))
    expect(screen.getByDisplayValue('Existing')).toBeInTheDocument()
    expect(screen.getAllByRole('combobox')[0]).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    vi.mocked(window.confirm).mockReturnValueOnce(false)
    fireEvent.click(screen.getByTitle('Delete rule'))
    expect(api.delete).not.toHaveBeenCalled()
    vi.mocked(window.confirm).mockReturnValueOnce(true)
    fireEvent.click(screen.getByTitle('Delete rule'))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('rule-1'))
    expect(onToast).toHaveBeenCalledWith('Rule deleted')
    expect(await screen.findByText('No rules yet')).toBeInTheDocument()
  })

  it('contains save, toggle, run, and delete failures with useful fallback messages', async () => {
    const existing = rule()
    api.list.mockResolvedValue([existing])
    const onToast = vi.fn()
    render(<MailRulesModal accounts={[account()]} labels={labels} onToast={onToast} onClose={vi.fn()} />)
    await screen.findByText('Newsletters')

    api.save.mockRejectedValueOnce(new Error('Toggle failed'))
    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Toggle failed'))

    api.run.mockRejectedValueOnce('failed')
    fireEvent.click(screen.getByTitle('Run on existing Inbox'))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Rule could not be run'))

    api.delete.mockRejectedValueOnce(new Error('Delete failed'))
    fireEvent.click(screen.getByTitle('Delete rule'))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Delete failed'))

    fireEvent.click(screen.getByTitle('Edit rule'))
    api.save.mockRejectedValueOnce('failed')
    fireEvent.click(screen.getByRole('button', { name: /Save rule/ }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Rule could not be saved'))
    expect(screen.getByRole('button', { name: /Save rule/ })).toBeEnabled()
  })

  it('handles missing accounts, singular matches, plural runs, and remaining fallbacks', async () => {
    const first = rule({ accountId: 'missing', matchCount: 1 })
    const second = rule({ id: 'rule-2', name: 'Receipts', enabled: false })
    api.list.mockResolvedValue([first, second])
    api.save.mockImplementation(async (input: any) => ({ ...input }))
    api.run.mockResolvedValueOnce({ matched: 3, actionsQueued: 3 }).mockRejectedValueOnce(new Error('Run failed'))
    const onToast = vi.fn()
    render(<MailRulesModal accounts={[account()]} labels={labels} onToast={onToast} onClose={vi.fn()} />)
    expect(await screen.findByText('Missing account', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('Matched 1 time')).toBeInTheDocument()

    fireEvent.click(screen.getAllByTitle('Run on existing Inbox')[0])
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Rule applied to 3 conversations'))
    api.save.mockRejectedValueOnce('failed')
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Rule could not be updated'))
    api.delete.mockRejectedValueOnce('failed')
    fireEvent.click(screen.getAllByTitle('Delete rule')[0])
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Rule could not be deleted'))
    fireEvent.click(screen.getAllByTitle('Run on existing Inbox')[0])
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Run failed'))

    fireEvent.click(screen.getAllByTitle('Edit rule')[0])
    fireEvent.change(screen.getByPlaceholderText('e.g. Project updates'), { target: { value: 'Updated rule' } })
    fireEvent.click(screen.getByRole('button', { name: /Save rule/ }))
    expect(await screen.findByText('Updated rule')).toBeInTheDocument()
    expect(screen.getByText('Receipts')).toBeInTheDocument()
  })
})
