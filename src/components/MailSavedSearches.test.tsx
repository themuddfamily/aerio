// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary } from '../mail-types'
import { MailSaveSearchModal, savedSearchFromView } from './MailSavedSearches'

const account: MailAccountSummary = {
  id: 'account', provider: 'gmail', email: 'me@example.test', displayName: 'Me', color: '#6558e8', status: 'ready', archived: false,
  signature: '', notifications: true, syncEnabled: true
}

describe('savedSearchFromView', () => {
  it('captures account, label, query, and filters while omitting all-account scope', () => {
    expect(savedSearchFromView({ accountId: 'all', folder: 'inbox', labelId: 'ignored', query: ' a ', filters: {} }, 'A'))
      .toEqual({ name: 'A', query: 'a', folder: 'inbox', filters: {} })
    expect(savedSearchFromView({ accountId: 'account', folder: 'all', labelId: 'label', query: '', filters: { starred: true } }, 'B', 'id'))
      .toEqual({ id: 'id', name: 'B', query: '', folder: 'all', accountId: 'account', labelId: 'label', filters: { starred: true } })
  })
})

describe('MailSaveSearchModal', () => {
  it('validates the query live and saves the edited scope', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => undefined)
    const onClose = vi.fn()
    render(<MailSaveSearchModal accounts={[account]} labels={[{ accountId: 'account', id: 'label', name: 'Projects', type: 'user' }]} initial={{ name: '', query: 'invoice', folder: 'all', accountId: 'account', labelId: 'label', filters: { unread: true } }} onSave={onSave} onClose={onClose} />)
    expect(screen.getByText('Label: Projects · 1 advanced filter')).toBeInTheDocument()
    const save = screen.getByRole('button', { name: 'Save search' })
    expect(save).toBeDisabled()
    await user.type(screen.getByLabelText('Name'), 'Invoices')
    expect(save).toBeEnabled()
    await user.type(screen.getByLabelText('Search'), ' OR')
    expect(screen.getByRole('alert')).toHaveTextContent('Add a search term after OR')
    expect(screen.getByLabelText('Search')).toHaveAttribute('aria-invalid', 'true')
    expect(save).toBeDisabled()
    await user.type(screen.getByLabelText('Search'), ' receipt')
    await user.selectOptions(screen.getByLabelText('Mailbox'), 'inbox')
    await user.selectOptions(screen.getByLabelText('Account'), '')
    expect(screen.queryByText(/Label: Projects/)).not.toBeInTheDocument()
    await user.click(save)
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ name: 'Invoices', query: 'invoice OR receipt', folder: 'inbox', accountId: undefined, labelId: undefined, filters: { unread: true } }))
    expect(onClose).toHaveBeenCalled()
  })

  it('shows save failures without closing', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<MailSaveSearchModal accounts={[account]} labels={[]} initial={{ id: 'saved', name: 'Old', query: 'a', folder: 'all', filters: {} }} onSave={vi.fn(async () => { throw new Error('Account not found') })} onClose={onClose} />)
    expect(screen.getByRole('heading', { name: 'Edit saved search' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save search' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Account not found')
    expect(onClose).not.toHaveBeenCalled()
  })
})
