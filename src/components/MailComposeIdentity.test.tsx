// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailAccountSummary, MailDraftRecord, MailDraftResult, MailThreadDetail } from '../mail-types'
import type { MailSenderIdentity, MailSignature } from '../mail-identity-types'
import { ContextMenuProvider } from './ContextMenu'
import MailComposeModal from './MailComposeModal'

const accounts: MailAccountSummary[] = [
  { id: 'account', provider: 'gmail', email: 'me@example.test', displayName: 'Me', color: '#123456', status: 'ready', archived: false, signature: 'Plain me', notifications: true, syncEnabled: true },
  { id: 'other', provider: 'imap', email: 'other@example.test', displayName: 'Other', color: '#654321', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true }
]
const identity = (overrides: Partial<MailSenderIdentity>): MailSenderIdentity => ({
  id: 'account:primary', accountId: 'account', email: 'me@example.test', name: 'Me', replyTo: [], source: 'primary', status: 'verified', isDefault: true,
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...overrides
})
const signature = (id: string, html: string): MailSignature => ({ id, name: `${id} signature`, html, text: html, createdAt: '', updatedAt: '' })
const identities = [
  identity({ newSignatureId: 'personal', replySignatureId: 'short' }),
  identity({ id: 'sales', email: 'sales@example.test', name: 'Sales', source: 'gmail', isDefault: false, replyTo: ['desk@example.test'], newSignatureId: 'sales', replySignatureId: 'sales' }),
  identity({ id: 'other:primary', accountId: 'other', email: 'other@example.test', name: 'Other' })
]
const signatures = [signature('personal', '<b>Personal</b>'), signature('sales', '<i>Sales team</i>'), signature('short', 'Short')]
const result: MailDraftResult = { id: 'draft', status: 'synced', updatedAt: '2026-10-01T10:00:00Z' }
const api = {
  chooseAttachments: vi.fn(async () => []),
  mail: {
    mail: { suggestRecipients: vi.fn(async () => []) },
    drafts: { save: vi.fn(async () => result), send: vi.fn(async () => ({ ...result, status: 'send-pending' })), stageMessageAttachments: vi.fn(async () => []) },
    identities: {
      list: vi.fn(async () => identities),
      signatures: { list: vi.fn(async () => signatures) }
    }
  }
}

const editor = () => document.querySelector<HTMLDivElement>('.compose-rich-body')!
const fromSelect = () => document.querySelector<HTMLSelectElement>('.compose-row select')!
const rowInput = (label: string) => Array.from(document.querySelectorAll<HTMLElement>('.compose-row')).find((row) => row.querySelector('label')?.textContent === label)?.querySelector('input') as HTMLInputElement
const renderCompose = (props: Partial<React.ComponentProps<typeof MailComposeModal>> = {}) => {
  const callbacks = { onClose: vi.fn(), onSent: vi.fn(), onToast: vi.fn() }
  render(<ContextMenuProvider><MailComposeModal accounts={accounts} {...callbacks} {...props} /></ContextMenuProvider>)
  return callbacks
}
const thread = (to: string[]): MailThreadDetail => ({
  accountId: 'account', id: 'thread', subject: 'Order', messages: [{
    accountId: 'account', id: 'message', threadId: 'thread', fromName: 'Ada', fromEmail: 'ada@example.test', to, cc: [], subject: 'Order',
    date: '2026-10-01T10:00:00Z', text: 'Original text', html: '', sanitizedHtml: '', labelIds: [], attachments: []
  }]
} as MailThreadDetail)

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'aerio', { configurable: true, value: api })
  Object.defineProperty(HTMLElement.prototype, 'innerText', { configurable: true, get() { return (this as HTMLElement).textContent ?? '' } })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) })
  api.mail.identities.list.mockResolvedValue(identities)
})

describe('MailComposeModal sender identities', () => {
  it('applies the default identity signature to a new message without creating a draft', async () => {
    const callbacks = renderCompose()
    await waitFor(() => expect(editor().innerHTML).toContain('<b>Personal</b>'))
    expect(editor().querySelectorAll('[data-aerio-signature]')).toHaveLength(1)
    expect(editor().innerHTML).not.toContain('Plain me')
    expect(api.mail.identities.list).toHaveBeenCalledWith(['account', 'other'])
    expect(screen.getByLabelText('Signature')).toHaveValue('personal')
    fireEvent.click(screen.getByTitle('Save draft and close'))
    await waitFor(() => expect(callbacks.onClose).toHaveBeenCalled())
    expect(api.mail.drafts.save).not.toHaveBeenCalled()
  })

  it('swaps only the signature block and default Reply-To when the From identity changes', async () => {
    const user = userEvent.setup()
    renderCompose({ initialTo: 'reader@example.test' })
    await waitFor(() => expect(editor().innerHTML).toContain('<b>Personal</b>'))
    editor().insertAdjacentHTML('afterbegin', '<div>My message body</div>')
    fireEvent.input(editor())
    await user.selectOptions(fromSelect(), 'sales')
    expect(editor().innerHTML).toContain('<div>My message body</div>')
    expect(editor().innerHTML).toContain('<i>Sales team</i>')
    expect(editor().innerHTML).not.toContain('Personal')
    expect(rowInput('Reply-To')).toHaveValue('desk@example.test')
    await user.click(screen.getByRole('button', { name: /Save draft/ }))
    await waitFor(() => expect(api.mail.drafts.save).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account', fromIdentityId: 'sales', replyTo: ['desk@example.test'], text: expect.stringContaining('Sales team') })))

    // A Reply-To the user typed survives an identity change; the other account has no signature.
    await user.clear(rowInput('Reply-To')); await user.type(rowInput('Reply-To'), 'mine@example.test')
    await user.selectOptions(fromSelect(), 'other:primary')
    expect(rowInput('Reply-To')).toHaveValue('mine@example.test')
    expect(editor().querySelector('[data-aerio-signature]')).toBeNull()
    expect(editor().innerHTML).toContain('My message body')
    await user.click(screen.getByRole('button', { name: /Save draft/ }))
    await waitFor(() => expect(api.mail.drafts.save).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: 'other', fromIdentityId: undefined, replyTo: ['mine@example.test'] })))
  })

  it('answers replies from the alias the message was sent to, with its reply signature', async () => {
    renderCompose({ replyTo: thread(['Sales <sales@example.test>']) })
    await waitFor(() => expect(fromSelect()).toHaveValue('sales'))
    expect(editor().innerHTML).toContain('<i>Sales team</i>')
    expect(rowInput('Reply-To')).toHaveValue('desk@example.test')
  })

  it('uses the reply signature above forwarded content and lets the user pick or remove signatures', async () => {
    const user = userEvent.setup()
    renderCompose({ replyTo: thread(['me@example.test']), forward: true })
    await waitFor(() => expect(editor().innerHTML).toContain('Short'))
    const block = editor().querySelector('[data-aerio-signature]')!
    expect(block.nextElementSibling?.getAttribute('data-aerio-quote')).toBe('forward')
    await user.selectOptions(screen.getByLabelText('Signature'), 'account')
    expect(editor().querySelector('[data-aerio-signature]')?.textContent).toBe('-- Plain me')
    await user.selectOptions(screen.getByLabelText('Signature'), '')
    expect(editor().querySelector('[data-aerio-signature]')).toBeNull()
    expect(editor().textContent).toContain('Original text')
    await user.selectOptions(screen.getByLabelText('Signature'), 'personal')
    expect(editor().querySelector('[data-aerio-signature]')?.nextElementSibling?.getAttribute('data-aerio-quote')).toBe('forward')
  })

  it('does not overwrite a signature the user already edited when identities arrive late', async () => {
    let resolve!: (value: MailSenderIdentity[]) => void
    api.mail.identities.list.mockReturnValueOnce(new Promise((done) => { resolve = done }))
    renderCompose()
    const block = editor().querySelector('[data-aerio-signature]')!
    expect(block.textContent).toBe('-- Plain me')
    block.append(' (edited)')
    fireEvent.input(editor())
    resolve(identities)
    await waitFor(() => expect(fromSelect().options).toHaveLength(3))
    expect(editor().textContent).toContain('Plain me (edited)')
    expect(editor().innerHTML).not.toContain('Personal')
  })

  it('reopens a draft with its identity and Reply-To and validates Reply-To before sending', async () => {
    const user = userEvent.setup()
    const draft: MailDraftRecord = {
      id: 'existing', accountId: 'account', to: ['reader@example.test'], cc: [], bcc: [], subject: 'Draft', text: 'Body', html: '<div>Body</div>', attachmentPaths: [],
      fromIdentityId: 'sales', replyTo: ['desk@example'], status: 'synced', updatedAt: '2026-10-01T10:00:00Z'
    }
    const callbacks = renderCompose({ draft })
    await waitFor(() => expect(fromSelect()).toHaveValue('sales'))
    expect(Array.from(fromSelect().options).map((option) => option.value)).toEqual(['account:primary', 'sales'])
    expect(rowInput('Reply-To')).toHaveValue('desk@example')
    expect(editor().innerHTML).toBe('<div>Body</div>')
    await user.click(screen.getByRole('button', { name: /^Send$/ }))
    expect(callbacks.onToast).toHaveBeenCalledWith('Finish or correct the Reply-To email addresses before sending')
    expect(api.mail.drafts.send).not.toHaveBeenCalled()
    await user.type(rowInput('Reply-To'), '.test')
    await user.click(screen.getByRole('button', { name: /^Send$/ }))
    await waitFor(() => expect(api.mail.drafts.send).toHaveBeenCalledWith(expect.objectContaining({ fromIdentityId: 'sales', replyTo: ['desk@example.test'] })))
  })

  it('keeps working with account-only senders when identities cannot load', async () => {
    const user = userEvent.setup()
    api.mail.identities.list.mockRejectedValueOnce(new Error('worker busy'))
    renderCompose()
    await new Promise((done) => setTimeout(done, 20))
    expect(Array.from(fromSelect().options).map((option) => option.textContent)).toEqual(['Me · me@example.test', 'Other · other@example.test'])
    expect(rowInput('Reply-To')).toBeUndefined()
    await user.click(screen.getByRole('button', { name: 'Reply-To' }))
    expect(rowInput('Reply-To')).toBeDefined()
  })
})
