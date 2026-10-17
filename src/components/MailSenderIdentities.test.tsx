// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary } from '../mail-types'
import type { MailSenderIdentity, MailSignature } from '../mail-identity-types'
import MailSenderIdentities from './MailSenderIdentities'

const account = (provider: MailAccountSummary['provider'] = 'gmail'): MailAccountSummary => ({
  id: 'account', provider, email: 'me@example.test', displayName: 'Me', color: '#123456', status: 'ready', archived: false, signature: 'Plain', notifications: true, syncEnabled: true
})
const primary: MailSenderIdentity = {
  id: 'account:primary', accountId: 'account', email: 'me@example.test', name: 'Me', replyTo: [], source: 'primary', status: 'verified', isDefault: true, createdAt: '', updatedAt: ''
}
const alias: MailSenderIdentity = { ...primary, id: 'alias', email: 'alias@example.test', name: 'Alias', source: 'manual', status: 'unverified', isDefault: false }
const work: MailSignature = { id: 'work', name: 'Work', html: '<b>Work</b>', text: 'Work\nPhone', createdAt: '', updatedAt: '' }
const api = {
  list: vi.fn(async () => [primary, alias]),
  save: vi.fn(async (input: unknown) => input),
  delete: vi.fn(async () => undefined),
  refresh: vi.fn(async () => [primary]),
  signatures: {
    list: vi.fn(async () => [work]),
    save: vi.fn(async (input: unknown) => input),
    delete: vi.fn(async () => undefined)
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'aerio', { configurable: true, value: { mail: { identities: api } } })
  window.confirm = vi.fn(() => true)
})

describe('MailSenderIdentities', () => {
  it('edits Reply-To and signature defaults, changes the default, and removes manual aliases', async () => {
    const user = userEvent.setup(), onToast = vi.fn()
    render(<MailSenderIdentities account={account()} onToast={onToast} />)
    await screen.findByText('alias@example.test')
    expect(screen.getByText('Added in Aerio · Not verified by provider')).toBeInTheDocument()
    expect(screen.getByLabelText('Sender name for me@example.test')).toHaveAttribute('readonly')
    expect(screen.queryByRole('button', { name: /^Save$/ })).toBeNull()
    await user.type(screen.getByLabelText('Reply-To for alias@example.test'), 'desk@example.test; team@example.test')
    await user.selectOptions(screen.getByLabelText('New-message signature for alias@example.test'), 'work')
    await user.selectOptions(screen.getByLabelText('Reply signature for alias@example.test'), 'work')
    await user.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(api.save).toHaveBeenCalledWith({
      id: 'alias', accountId: 'account', email: 'alias@example.test', name: 'Alias', replyTo: ['desk@example.test', 'team@example.test'], newSignatureId: 'work', replySignatureId: 'work'
    }))
    expect(onToast).toHaveBeenCalledWith('Sender address saved')

    fireEvent.click(screen.getAllByRole('radio')[1])
    await waitFor(() => expect(api.save).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'alias', isDefault: true })))
    expect(onToast).toHaveBeenCalledWith('alias@example.test is now the default From address')

    await user.click(screen.getByRole('button', { name: /Remove/ }))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('alias'))
    api.delete.mockRejectedValueOnce(new Error("Error invoking remote method 'mail:identities:delete': Error: in use"))
    await user.click(screen.getByRole('button', { name: /Remove/ }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('in use'))
  })

  it('adds aliases and refreshes provider addresses', async () => {
    const user = userEvent.setup(), onToast = vi.fn()
    render(<MailSenderIdentities account={account('microsoft')} onToast={onToast} />)
    await screen.findByText('alias@example.test')
    expect(screen.getByText(/shared or send-as mailboxes manually/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Alias email address'), 'shared@example.test')
    await user.click(screen.getByRole('button', { name: /Add address/ }))
    await waitFor(() => expect(api.save).toHaveBeenCalledWith({ accountId: 'account', email: 'shared@example.test', name: 'Me' }))
    expect(screen.getByLabelText('Alias email address')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: /Refresh from provider/ }))
    await waitFor(() => expect(api.refresh).toHaveBeenCalledWith('account'))
    expect(onToast).toHaveBeenCalledWith('Sender addresses refreshed')
  })

  it('creates, edits, and deletes HTML signatures', async () => {
    const user = userEvent.setup(), onToast = vi.fn()
    render(<MailSenderIdentities account={account('imap')} onToast={onToast} />)
    await screen.findByRole('button', { name: 'Edit Work' })
    expect(screen.queryByRole('button', { name: /Refresh from provider/ })).toBeNull()
    expect(screen.queryByText(/Phone/)).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Edit Work' }))
    expect(screen.getByLabelText('Signature content').innerHTML).toBe('<b>Work</b>')
    screen.getByLabelText('Signature content').innerHTML = '<i>Updated</i>'
    await user.clear(screen.getByLabelText('Signature name')); await user.type(screen.getByLabelText('Signature name'), 'Work 2')
    await user.click(screen.getByRole('button', { name: /Save signature/ }))
    await waitFor(() => expect(api.signatures.save).toHaveBeenCalledWith({ id: 'work', name: 'Work 2', html: '<i>Updated</i>' }))
    expect(screen.queryByLabelText('Signature content')).toBeNull()

    await user.click(screen.getByRole('button', { name: /New signature/ }))
    expect(screen.getByRole('button', { name: /Save signature/ })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: /Cancel/ }))

    await user.click(screen.getByRole('button', { name: 'Delete Work' }))
    await waitFor(() => expect(api.signatures.delete).toHaveBeenCalledWith('work'))
    expect(onToast).toHaveBeenCalledWith('Signature deleted')
  })

  it('reports load failures', async () => {
    const onToast = vi.fn()
    api.list.mockRejectedValueOnce(new Error('worker offline'))
    render(<MailSenderIdentities account={account()} onToast={onToast} />)
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('worker offline'))
  })
})
