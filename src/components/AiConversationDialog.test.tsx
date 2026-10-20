// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AiConversationDialog from './AiConversationDialog'
import type { AiAssistantStatus } from '../ai-assistant-types'
import type { AiConversationState } from '../ai-conversation-types'
import type { MailAccountSummary } from '../mail-types'

const status: AiAssistantStatus = { enabled: true, provider: 'anthropic', model: 'test', baseUrl: '', hasApiKey: true, hasWebSearchKey: true, secureStorage: true, includeSenderDetails: false, features: { conversation: true, rules: true, planning: true, summarize: true, replies: true, compose: true, search: true } }
const account = { id: 'a', email: 'me@example.test', archived: false } as MailAccountSummary
const initial = (): AiConversationState => ({ id: 'c', scope: { allowMail: false, accountIds: [], allowWeb: false }, messages: [] })
const proposed = (): AiConversationState => ({ ...initial(), messages: [{ id: 'p', role: 'assistant', text: 'Please review', sources: [{ id: 's', title: 'Source', url: 'https://example.com' }], proposal: { id: 'proposal', action: 'archive', targets: [{ ref: 'mail:0', accountId: 'a', accountName: account.email, threadId: 't', subject: 'Invoice' }], folders: [], expiresAt: new Date(Date.now() + 600_000).toISOString() } }] })
let api: { state: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn>; turn: ReturnType<typeof vi.fn>; apply: ReturnType<typeof vi.fn> }
let cancel: ReturnType<typeof vi.fn>
beforeEach(() => {
  api = { state: vi.fn().mockResolvedValue(initial()), clear: vi.fn().mockResolvedValue(initial()), turn: vi.fn().mockResolvedValue(proposed()), apply: vi.fn().mockResolvedValue({ appliedCount: 1, errors: [], state: { ...proposed(), messages: [] } }) }
  cancel = vi.fn().mockResolvedValue(true)
  Object.defineProperty(window, 'aerio', { configurable: true, value: { ai: { conversation: api, cancel } } })
})
async function open() { render(<AiConversationDialog accounts={[account]} status={status} onClose={vi.fn()} />); await waitFor(() => expect(screen.getByLabelText('Message to AI assistant')).toBeEnabled()) }
async function send() { fireEvent.change(screen.getByLabelText('Message to AI assistant'), { target: { value: 'Organize invoices' } }); fireEvent.click(screen.getByRole('button', { name: 'Send message' })) }
describe('conversation review UI', () => {
  it('discloses scopes, defaults both tools off and requires edited action review before applying', async () => {
    await open()
    expect(screen.getByLabelText('Allow mail search and reading')).not.toBeChecked()
    expect(screen.getByLabelText(/Allow public-web research/)).not.toBeChecked()
    expect(screen.getByText(/Only the exact public search query you enter/)).toBeInTheDocument()
    await send()
    await screen.findByText('Please review')
    expect(api.apply).not.toHaveBeenCalled()
    expect(screen.getByRole('link', { name: 'Source' })).toHaveAttribute('href', 'https://example.com')
    const apply = screen.getByRole('button', { name: 'Apply reviewed changes' })
    expect(apply).toBeDisabled()
    fireEvent.click(screen.getByLabelText('I reviewed this action and these conversations'))
    expect(apply).toBeEnabled()
    fireEvent.change(screen.getByLabelText('Reviewed mail action'), { target: { value: 'star' } })
    expect(apply).toBeDisabled()
    fireEvent.click(screen.getByLabelText('I reviewed this action and these conversations'))
    fireEvent.click(apply)
    await waitFor(() => expect(api.apply).toHaveBeenCalledWith({ proposalId: 'proposal', action: 'star', targetRefs: ['mail:0'] }))
  })
  it('sends only selected account scope and clears the conversation explicitly', async () => {
    api.turn.mockResolvedValueOnce({ ...proposed(), scope: { allowMail: true, accountIds: ['a'], allowWeb: true } })
    await open()
    fireEvent.click(screen.getByLabelText('Allow mail search and reading'))
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    fireEvent.click(screen.getByLabelText('Assistant may read me@example.test'))
    fireEvent.click(screen.getByLabelText(/Allow public-web research/))
    fireEvent.change(screen.getByLabelText('Public search query for this message'), { target: { value: 'Public invoice filing guidance' } })
    await send()
    await waitFor(() => expect(api.turn).toHaveBeenCalledWith(expect.any(String), { conversationId: 'c', message: 'Organize invoices', allowMail: true, accountIds: ['a'], allowWeb: true, publicSearchQuery: 'Public invoice filing guidance' }))
    expect(screen.getByLabelText('Public search query for this message')).toHaveValue('')
    fireEvent.change(screen.getByLabelText('Message to AI assistant'), { target: { value: 'Follow up' } })
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    await screen.findByText('Please review')
    fireEvent.click(screen.getByRole('button', { name: 'Clear conversation' }))
    await waitFor(() => expect(api.clear).toHaveBeenCalled())
  })
  it('cancels the provider and discards a late proposal', async () => {
    let resolve!: (state: AiConversationState) => void
    api.turn.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    await open(); await send()
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel request' }))
    await act(async () => resolve(proposed()))
    expect(cancel).toHaveBeenCalledWith(expect.any(String))
    expect(screen.queryByText('Please review')).not.toBeInTheDocument()
    expect(api.apply).not.toHaveBeenCalled()
  })
})
