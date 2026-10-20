// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiAssistantStatus } from '../ai-assistant-types'
import type { MailAccountSummary, MailRuleInput } from '../mail-types'
import { notifyAiSettingsChanged } from '../lib/use-ai-assistant'
import MailRulesModal from './MailRulesModal'

const status: AiAssistantStatus = { enabled: true, provider: 'anthropic', model: 'test', baseUrl: '', hasApiKey: true, secureStorage: true, includeSenderDetails: false, features: { rules: true, compose: true, replies: true, search: true, summarize: true } }
const account: MailAccountSummary = { id: 'a', provider: 'imap', email: 'me@test', displayName: 'Me', color: '#123456', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true }
const generated: MailRuleInput = { accountId: 'a', name: 'AI invoices', enabled: false, execution: 'local', trigger: 'incoming', match: 'all', conditions: [{ field: 'subject', operator: 'contains', value: 'invoice' }], exceptions: [], actions: [{ action: 'label', labelId: 'receipts' }] }
let ai: { status: ReturnType<typeof vi.fn>; generateRule: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }
let save: ReturnType<typeof vi.fn>
beforeEach(() => {
  ai = { status: vi.fn().mockResolvedValue(status), generateRule: vi.fn().mockResolvedValue(generated), cancel: vi.fn().mockResolvedValue(true) }
  save = vi.fn().mockImplementation(async (input) => ({ ...input, id: 'saved', matchCount: 0 }))
  Object.defineProperty(window, 'aerio', { configurable: true, value: { ai, mail: { rules: { list: vi.fn().mockResolvedValue([]), save } } } })
})
async function open(accounts = [account]) {
  render(<MailRulesModal accounts={accounts} labels={[{ accountId: 'a', id: 'receipts', name: 'Receipts', type: 'user' }]} onClose={vi.fn()} onToast={vi.fn()} />)
  await screen.findByText('No rules yet')
  fireEvent.click(screen.getByRole('button', { name: /New rule/ }))
  await screen.findByLabelText('Rule description')
}

describe('AI rule review', () => {
  it('generates an inert preview and requires Use, editing, enable and Save to persist it', async () => {
    await open()
    expect(screen.getByText(/No emails, account details, folder list/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Rule description'), { target: { value: 'Label invoices Receipts' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate rule preview' }))
    const preview = await screen.findByLabelText('AI rule preview')
    expect(within(preview).getByText('label: Receipts')).toBeInTheDocument()
    expect(ai.generateRule).toHaveBeenCalledWith(expect.any(String), { accountId: 'a', description: 'Label invoices Receipts' })
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByPlaceholderText('e.g. Project updates')).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: 'Use this draft' }))
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByPlaceholderText('e.g. Project updates')).toHaveValue('AI invoices')
    expect(screen.getByLabelText('Enable this rule for new mail')).not.toBeChecked()
    fireEvent.change(screen.getByLabelText('Condition 1 value'), { target: { value: 'receipt' } })
    fireEvent.click(screen.getByLabelText('Enable this rule for new mail'))
    fireEvent.click(screen.getByRole('button', { name: 'Save rule' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: 'AI invoices', enabled: true, conditions: [{ field: 'subject', operator: 'contains', value: 'receipt' }], actions: [{ action: 'label', labelId: 'receipts' }] })))
  })

  it('discards previews and surfaces generation failures without changing the editor', async () => {
    await open()
    fireEvent.change(screen.getByLabelText('Rule description'), { target: { value: 'Star invoices' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate rule preview' }))
    await screen.findByLabelText('AI rule preview')
    fireEvent.click(screen.getByRole('button', { name: 'Discard preview' }))
    expect(screen.queryByLabelText('AI rule preview')).not.toBeInTheDocument()
    ai.generateRule.mockRejectedValueOnce(new Error('Unsupported rule action'))
    fireEvent.click(screen.getByRole('button', { name: 'Generate rule preview' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Unsupported rule action')
    expect(screen.getByPlaceholderText('e.g. Project updates')).toHaveValue('')
    expect(save).not.toHaveBeenCalled()
  })

  it('cancels generation and discards late responses, and honors the feature switch', async () => {
    let resolve!: (rule: MailRuleInput) => void
    ai.generateRule.mockImplementationOnce(() => new Promise<MailRuleInput>((done) => { resolve = done }))
    await open()
    fireEvent.change(screen.getByLabelText('Rule description'), { target: { value: 'Star invoices' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate rule preview' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel generation' }))
    expect(ai.cancel).toHaveBeenCalledWith(expect.any(String))
    await act(async () => { resolve(generated) })
    expect(screen.queryByLabelText('AI rule preview')).not.toBeInTheDocument()
    act(() => notifyAiSettingsChanged({ ...status, features: { ...status.features, rules: false } }))
    expect(screen.queryByLabelText('Rule description')).not.toBeInTheDocument()
    expect(save).not.toHaveBeenCalled()
  })

  it('cancels an in-flight preview when the target account changes', async () => {
    let resolve!: (rule: MailRuleInput) => void
    ai.generateRule.mockImplementationOnce(() => new Promise<MailRuleInput>((done) => { resolve = done }))
    await open([account, { ...account, id: 'b', email: 'other@test' }])
    fireEvent.change(screen.getByLabelText('Rule description'), { target: { value: 'Star invoices' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate rule preview' }))
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'b' } })
    expect(ai.cancel).toHaveBeenCalledWith(expect.any(String))
    await act(async () => { resolve(generated) })
    expect(screen.queryByLabelText('AI rule preview')).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('e.g. Project updates')).toHaveValue('')
    expect(save).not.toHaveBeenCalled()
  })
})
