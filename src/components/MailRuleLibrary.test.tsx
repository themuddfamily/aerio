// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary } from '../mail-types'
import MailRulesModal from './MailRulesModal'

const account: MailAccountSummary = { id: 'a', provider: 'imap', email: 'me@example.test', displayName: 'Me', color: '#123456', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true }

describe('rule library editor', () => {
  it('opens a starter without saving, then saves user-edited conditions, destination, and activation', async () => {
    const save = vi.fn().mockImplementation(async (input) => ({ ...input, id: 'saved', matchCount: 0 }))
    Object.defineProperty(window, 'aerio', { configurable: true, value: { mail: { rules: { list: vi.fn().mockResolvedValue([]), save } } } })
    render(<MailRulesModal accounts={[account]} labels={[
      { id: 'receipts', accountId: 'a', name: 'Receipts', type: 'user' },
      { id: 'foreign', accountId: 'other', name: 'Foreign', type: 'user' }
    ]} onToast={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('No rules yet')
    fireEvent.click(screen.getByRole('button', { name: 'Rule library' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use Organize receipts and invoices' }))
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Enable this rule for new mail')).not.toBeChecked()
    fireEvent.change(screen.getByLabelText('Condition 1 value'), { target: { value: 'payment received' } })
    const destination = screen.getByLabelText('Action 1 destination')
    expect(within(destination).queryByText('Foreign')).not.toBeInTheDocument()
    fireEvent.change(destination, { target: { value: 'receipts' } })
    fireEvent.click(screen.getByLabelText('Enable this rule for new mail'))
    fireEvent.click(screen.getByRole('button', { name: 'Save rule' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'a', enabled: true, match: 'any',
      conditions: [{ field: 'subject', operator: 'contains', value: 'payment received' }, { field: 'subject', operator: 'contains', value: 'invoice' }],
      actions: [{ action: 'label', labelId: 'receipts' }]
    })))
  })

  it('disables the library when every account is archived', async () => {
    Object.defineProperty(window, 'aerio', { configurable: true, value: { mail: { rules: { list: vi.fn().mockResolvedValue([]) } } } })
    render(<MailRulesModal accounts={[{ ...account, archived: true }]} labels={[]} onToast={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('No rules yet')
    expect(screen.getByRole('button', { name: 'Rule library' })).toBeDisabled()
  })
})
