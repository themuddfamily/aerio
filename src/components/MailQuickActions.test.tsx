// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary, MailQuickAction } from '../mail-types'
import { MailQuickActionButtons, MailQuickActionsModal } from './MailQuickActions'

const account: MailAccountSummary = {
  id: 'account', provider: 'gmail', email: 'me@example.test', displayName: 'Me', color: '#6558e8', status: 'ready', archived: false,
  signature: '', notifications: true, syncEnabled: true
}
const stale: MailQuickAction = {
  id: 'quick-1', name: 'File receipt', accountId: 'account', steps: [{ action: 'read' }, { action: 'label', labelId: 'Label_gone' }],
  shortcut: 1, showInToolbar: true, createdAt: '2026-08-08T10:00:00Z', updatedAt: '2026-08-08T10:00:00Z'
}

describe('MailQuickActionsModal', () => {
  it('lists quick actions, flags a missing destination while editing, surfaces save errors, and confirms deletion', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => { throw new Error('Shortcut 1 is already used by “Other”') })
    const onDelete = vi.fn(async () => undefined)
    window.confirm = vi.fn(() => true)
    render(<MailQuickActionsModal accounts={[account]} labels={[{ accountId: 'account', id: 'Label_1', name: 'Receipts', type: 'user' }]} quickActions={[stale]} onSave={onSave} onDelete={onDelete} onClose={vi.fn()} />)
    expect(screen.getByText('Mark as read → Apply label: Label_gone')).toBeInTheDocument()
    expect(screen.getByText(/me@example.test · Ctrl\+Shift\+1 · On toolbar/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Edit File receipt' }))
    expect(screen.getByLabelText('Step 2 destination')).toHaveDisplayValue('Missing: Label_gone')
    await user.selectOptions(screen.getByLabelText('Step 2 destination'), 'Label_1')
    await user.click(screen.getByRole('button', { name: 'Save quick action' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already used by “Other”')
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: 'quick-1', steps: [{ action: 'read' }, { action: 'label', labelId: 'Label_1' }] }))

    await user.selectOptions(screen.getByLabelText('Account'), '')
    expect(screen.getByText('Choose an account to pick a destination')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: 'Delete File receipt' }))
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(stale))
  })
})

describe('MailQuickActionButtons', () => {
  it('renders only toolbar quick actions and respects read-only state', async () => {
    const user = userEvent.setup()
    const onRun = vi.fn()
    const { rerender } = render(<MailQuickActionButtons quickActions={[stale, { ...stale, id: 'hidden', name: 'Hidden', showInToolbar: false }]} className="button" onRun={onRun} />)
    expect(screen.queryByText('Hidden')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'File receipt' }))
    expect(onRun).toHaveBeenCalledWith(stale)
    rerender(<MailQuickActionButtons quickActions={[stale]} disabled className="button" onRun={onRun} />)
    expect(screen.getByRole('button', { name: 'File receipt' })).toBeDisabled()
  })
})
