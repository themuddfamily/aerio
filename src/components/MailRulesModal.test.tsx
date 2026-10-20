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

  it('saves an Archive trigger and offers manual evaluation of the Archive folder', async () => {
    api.save.mockImplementation(async (input: any) => rule({ ...input, id: 'archive-rule' }))
    render(<MailRulesModal accounts={[account()]} labels={labels} onToast={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('No rules yet')
    fireEvent.click(screen.getByRole('button', { name: /New rule/ }))
    fireEvent.change(screen.getByLabelText('Apply to'), { target: { value: 'archive' } })
    expect(screen.getByText(/Automatic archiving, snoozing/)).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('e.g. Project updates'), { target: { value: 'Archived projects' } })
    fireEvent.change(screen.getByLabelText('Condition 1 value'), { target: { value: 'sender@example.test' } })
    fireEvent.click(screen.getByRole('button', { name: /Save rule/ }))
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'archive' })))
    expect(await screen.findByText('Archived projects')).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Run on existing Archive'))
    await waitFor(() => expect(api.run).toHaveBeenCalledWith('archive-rule'))
  })

  it('edits a periodic interval and scope and exposes a manual run for that scope', async () => {
    api.save.mockImplementation(async (input: any) => rule({ ...input, id: 'periodic-rule', nextRunAt: '2026-10-21T12:00:00Z' }))
    render(<MailRulesModal accounts={[account()]} labels={labels} onToast={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('No rules yet')
    fireEvent.click(screen.getByRole('button', { name: /New rule/ }))
    fireEvent.change(screen.getByLabelText('Apply to'), { target: { value: 'periodic' } })
    expect(screen.getByLabelText('Rule interval in minutes')).toHaveValue(60)
    fireEvent.change(screen.getByLabelText('Rule interval in minutes'), { target: { value: '15' } })
    fireEvent.change(screen.getByLabelText('Scheduled rule folder'), { target: { value: 'archive' } })
    fireEvent.change(screen.getByPlaceholderText('e.g. Project updates'), { target: { value: 'Review archive' } })
    fireEvent.change(screen.getByLabelText('Condition 1 value'), { target: { value: 'team@example.test' } })
    fireEvent.click(screen.getByRole('button', { name: /Save rule/ }))
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'periodic', schedule: { intervalMinutes: 15, folder: 'archive' } })))
    expect(await screen.findByText('Review archive')).toBeInTheDocument()
    expect(screen.getByText(/Every 15 minutes/)).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Run on existing Archive'))
    await waitFor(() => expect(api.run).toHaveBeenCalledWith('periodic-rule'))
  })

  it('offers the inbox category condition and the set-category action with the configured tabs', async () => {
    api.save.mockImplementation(async (input: any) => rule({ ...input, id: 'saved-rule' }))
    const tabs = vi.fn().mockResolvedValue({ tabs: [{ id: 'primary', name: 'Primary', enabled: true, builtIn: true }, { id: 'custom:receipts', name: 'Receipts', enabled: true, builtIn: false }] })
    Object.defineProperty(window, 'aerio', { configurable: true, value: { mail: { rules: api, categories: { tabs } } } })
    render(<MailRulesModal accounts={[account()]} labels={labels} onToast={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('No rules yet')
    fireEvent.click(screen.getByRole('button', { name: /New rule/ }))
    fireEvent.change(screen.getByPlaceholderText('e.g. Project updates'), { target: { value: 'Receipts' } })
    fireEvent.change(screen.getByLabelText('Condition 1 field'), { target: { value: 'category' } })
    await waitFor(() => expect(within(screen.getByLabelText('Condition 1 value')).getByRole('option', { name: 'Receipts' })).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Condition 1 value'), { target: { value: 'primary' } })
    fireEvent.change(screen.getByLabelText('Action 1'), { target: { value: 'set-category' } })
    fireEvent.change(screen.getByLabelText('Action 1 inbox category'), { target: { value: 'custom:receipts' } })
    fireEvent.click(screen.getByRole('button', { name: /Save rule/ }))
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({
      conditions: [{ field: 'category', operator: 'is', value: 'primary' }],
      actions: [{ action: 'set-category', category: 'custom:receipts' }]
    })))
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

  it('edits advanced conditions, exceptions, and the outgoing trigger', async () => {
    api.save.mockImplementation(async (input: any) => rule({ ...input, id: 'saved' }))
    render(<MailRulesModal accounts={[account()]} labels={labels} onToast={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('No rules yet')
    fireEvent.click(screen.getByRole('button', { name: /New rule/ }))
    fireEvent.change(screen.getByPlaceholderText('e.g. Project updates'), { target: { value: 'Sent proposals' } })
    fireEvent.change(screen.getByLabelText('Apply to'), { target: { value: 'outgoing' } })
    fireEvent.change(screen.getByLabelText('Condition 1 field'), { target: { value: 'header' } })
    fireEvent.change(screen.getByLabelText('Condition 1 header name'), { target: { value: 'List-Id' } })
    fireEvent.change(screen.getByLabelText('Condition 1 value'), { target: { value: 'projects' } })
    fireEvent.click(screen.getByRole('button', { name: /Add condition/ }))
    fireEvent.change(screen.getByLabelText('Condition 2 field'), { target: { value: 'size' } })
    expect(within(screen.getByLabelText('Condition 2 comparison')).getAllByRole('option').map((option) => option.textContent)).toEqual(['more than', 'less than'])
    fireEvent.change(screen.getByLabelText('Condition 2 value'), { target: { value: '500' } })
    fireEvent.click(screen.getByRole('button', { name: /Add condition/ }))
    fireEvent.change(screen.getByLabelText('Condition 3 field'), { target: { value: 'age' } })
    expect(within(screen.getByLabelText('Condition 3 comparison')).getByRole('option', { name: 'older than' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Condition 3 field'), { target: { value: 'label' } })
    fireEvent.change(screen.getByLabelText('Condition 3 value'), { target: { value: 'projects' } })
    fireEvent.click(screen.getByRole('button', { name: /Add exception/ }))
    fireEvent.change(screen.getByLabelText('Exception 1 field'), { target: { value: 'has-attachment' } })
    fireEvent.change(screen.getByLabelText('Exception 1 value'), { target: { value: 'no' } })
    fireEvent.click(screen.getByRole('button', { name: /Add exception/ }))
    fireEvent.change(screen.getByLabelText('Exception 2 field'), { target: { value: 'importance' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove exception 2' }))
    fireEvent.click(screen.getByRole('button', { name: /Save rule/ }))
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({
      trigger: 'outgoing',
      conditions: [
        { field: 'header', operator: 'contains', value: 'projects', headerName: 'List-Id' },
        { field: 'size', operator: 'greater-than', value: '500' },
        { field: 'label', operator: 'is', value: 'projects' }
      ],
      exceptions: [{ field: 'has-attachment', operator: 'is', value: 'no' }]
    })))
  })

  describe('server rules', () => {
    let server: Record<string, ReturnType<typeof vi.fn>>
    let reconnect: ReturnType<typeof vi.fn>
    const capabilities = (overrides: Record<string, unknown> = {}) => ({
      accountId: 'account-1', provider: 'gmail', supported: true, permission: 'granted', missingScopes: [], conditions: [], actions: [], matchModes: ['all', 'any'],
      exceptions: true, outgoing: false, updateInPlace: false, canDisable: false, ...overrides
    })

    beforeEach(() => {
      server = {
        capabilities: vi.fn().mockResolvedValue(capabilities()),
        list: vi.fn().mockResolvedValue([]),
        upload: vi.fn(async (id: string) => ({ rule: rule({ id, execution: 'server', serverRuleId: 'filter-1' }), serverRule: {}, mapping: { supported: true, issues: [] } })),
        delete: vi.fn().mockResolvedValue(undefined),
        setEnabled: vi.fn()
      }
      reconnect = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(window, 'aerio', { configurable: true, value: { mail: { rules: api, serverRules: server, accounts: { reconnect } } } })
    })

    it('uploads a compatible rule after confirmation and marks it server-executed', async () => {
      api.list.mockResolvedValue([rule()])
      const onToast = vi.fn()
      render(<MailRulesModal accounts={[account()]} labels={labels} onToast={onToast} onClose={vi.fn()} />)
      fireEvent.click(await screen.findByTitle('Run on the server'))
      await waitFor(() => expect(server.upload).toHaveBeenCalledWith('rule-1'))
      expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('stop running it on this computer'))
      expect(await screen.findByText(/Runs on server/)).toBeInTheDocument()
      expect(onToast).toHaveBeenCalledWith('Rule now runs on the server')
      expect(screen.getByTitle('Update the server copy')).toBeInTheDocument()
    })

    it('explains unsupported mappings instead of uploading', async () => {
      api.list.mockResolvedValue([rule({ conditions: [{ field: 'age', operator: 'greater-than', value: '3' }] })])
      const onToast = vi.fn()
      render(<MailRulesModal accounts={[account()]} labels={labels} onToast={onToast} onClose={vi.fn()} />)
      fireEvent.click(await screen.findByTitle('Run on the server'))
      expect(onToast).toHaveBeenCalledWith(expect.stringContaining('can’t check a message’s age'))
      expect(server.upload).not.toHaveBeenCalled()
    })

    it('offers a reconnect when the settings permission is missing', async () => {
      server.capabilities.mockResolvedValue(capabilities({ permission: 'missing', reason: 'Reconnect to allow gmail.settings.basic' }))
      api.list.mockResolvedValue([rule()])
      const onToast = vi.fn()
      render(<MailRulesModal accounts={[account()]} labels={labels} onToast={onToast} onClose={vi.fn()} />)
      fireEvent.click(await screen.findByTitle('Run on the server'))
      await waitFor(() => expect(reconnect).toHaveBeenCalledWith('account-1'))
      expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('gmail.settings.basic'))
      await waitFor(() => expect(onToast).toHaveBeenCalledWith('Account reconnected'))
      expect(server.upload).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: /Server rules/ }))
      expect(await screen.findByText('Server rules aren’t available')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: /Reconnect account/ }))
      await waitFor(() => expect(reconnect).toHaveBeenCalledTimes(2))
    })

    it('shows server compatibility while editing and re-uploads server-executed rules on save', async () => {
      const existing = rule({ execution: 'server', serverRuleId: 'filter-1', conditions: [{ field: 'from', operator: 'contains', value: 'news' }] })
      api.list.mockResolvedValue([existing])
      api.save.mockImplementation(async (input: any) => ({ ...existing, ...input }))
      const onToast = vi.fn()
      render(<MailRulesModal accounts={[account()]} labels={labels} onToast={onToast} onClose={vi.fn()} />)
      await screen.findByTitle('Update the server copy')
      fireEvent.click(screen.getByTitle('Edit rule'))
      const section = screen.getByRole('region', { name: 'Server compatibility' })
      expect(within(section).getByText('Runs on the server')).toBeInTheDocument()
      expect(within(section).getByText(/whole words/)).toBeInTheDocument()
      expect(screen.getByLabelText('Apply to')).toBeDisabled()
      fireEvent.change(screen.getByLabelText('Condition 1 field'), { target: { value: 'age' } })
      expect(within(section).getByText(/Condition 1: Server rules run when mail arrives/)).toBeInTheDocument()
      fireEvent.change(screen.getByLabelText('Condition 1 field'), { target: { value: 'subject' } })
      server.upload.mockRejectedValueOnce(new Error('Gmail unavailable'))
      fireEvent.click(screen.getByRole('button', { name: /Save rule/ }))
      await waitFor(() => expect(onToast).toHaveBeenCalledWith('Rule saved, but the server copy was not updated: Gmail unavailable'))
      fireEvent.click(screen.getByTitle('Edit rule'))
      fireEvent.click(screen.getByRole('button', { name: /Save rule/ }))
      await waitFor(() => expect(onToast).toHaveBeenCalledWith('Rule saved and updated on the server'))
    })

    it('keeps Gmail server rules on and switches Outlook rules on the server', async () => {
      api.list.mockResolvedValue([rule({ execution: 'server', serverRuleId: 'filter-1' }), rule({ id: 'rule-2', name: 'Outlook', accountId: 'account-2', execution: 'server', serverRuleId: 'outlook-1' })])
      server.capabilities.mockImplementation(async (accountId: string) => capabilities(accountId === 'account-2' ? { accountId, provider: 'microsoft', canDisable: true } : {}))
      server.setEnabled.mockResolvedValue({ id: 'outlook-1', enabled: false })
      const onToast = vi.fn()
      render(<MailRulesModal accounts={[account(), account({ id: 'account-2', provider: 'microsoft', email: 'work@example.test' })]} labels={labels} onToast={onToast} onClose={vi.fn()} />)
      await screen.findByText('Outlook')
      const toggles = screen.getAllByRole('checkbox')
      fireEvent.click(toggles[0])
      expect(onToast).toHaveBeenCalledWith(expect.stringContaining('Gmail filters can’t be turned off'))
      fireEvent.click(toggles[1])
      await waitFor(() => expect(server.setEnabled).toHaveBeenCalledWith('account-2', 'outlook-1', false))
      expect(api.save).not.toHaveBeenCalled()
    })

    it('lists, switches, and removes server rules per account', async () => {
      server.capabilities.mockImplementation(async (accountId: string) => capabilities(accountId === 'account-2' ? { accountId, provider: 'microsoft', canDisable: true } : {}))
      server.list.mockImplementation(async (accountId: string) => accountId === 'account-2'
        ? [{ id: 'outlook-1', accountId, provider: 'microsoft', name: 'Receipts', enabled: true, conditions: ['Subject contains receipt'], exceptions: ['Sender contains boss'], actions: ['Move to Receipts'], linkedRuleId: 'rule-1' }]
        : [])
      server.setEnabled.mockResolvedValue({ id: 'outlook-1', enabled: false })
      const onToast = vi.fn()
      render(<MailRulesModal accounts={[account(), account({ id: 'account-2', provider: 'microsoft', email: 'work@example.test' })]} labels={labels} onToast={onToast} onClose={vi.fn()} />)
      await screen.findByText('No rules yet')
      fireEvent.click(screen.getByRole('button', { name: /Server rules/ }))
      expect(await screen.findByText('No server rules')).toBeInTheDocument()
      fireEvent.change(screen.getByLabelText('Server rules account'), { target: { value: 'account-2' } })
      expect(await screen.findByText('Receipts · from Aerio')).toBeInTheDocument()
      expect(screen.getByText('Except: Sender contains boss')).toBeInTheDocument()
      fireEvent.click(screen.getByLabelText('Server rule Receipts on'))
      await waitFor(() => expect(server.setEnabled).toHaveBeenCalledWith('account-2', 'outlook-1', false))
      fireEvent.click(screen.getByTitle('Remove from server'))
      await waitFor(() => expect(server.delete).toHaveBeenCalledWith('account-2', 'outlook-1'))
      expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('kept, turned off'))
      await waitFor(() => expect(onToast).toHaveBeenCalledWith('Server rule removed'))
      server.list.mockRejectedValueOnce(new Error('Graph unavailable'))
      fireEvent.change(screen.getByLabelText('Server rules account'), { target: { value: 'account-1' } })
      expect(await screen.findByText('Graph unavailable')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: /Back to rules/ }))
      expect(await screen.findByText('No rules yet')).toBeInTheDocument()
    })
  })
})
