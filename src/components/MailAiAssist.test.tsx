// @vitest-environment jsdom
import { createRef } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiAssistantStatus } from '../ai-assistant-types'
import type { MailMessageDetail } from '../mail-types'
import MailAiAssistDialog from './MailAiAssistDialog'
import MailAiSearchDialog from './MailAiSearchDialog'
import AiAssistantSettings from './AiAssistantSettings'
import { MailAiComposeAssist, plainTextToEditorHtml } from './MailAiComposeAssist'

vi.mock('./Modal', () => ({ default: ({ title, children, onClose }: any) => <div role="dialog" aria-label={title}>{children}<button onClick={onClose}>Close dialog</button></div> }))

const status: AiAssistantStatus = { enabled: true, provider: 'anthropic', model: 'claude-sonnet-5-5', baseUrl: '', hasApiKey: true, features: { summarize: true, compose: true, replies: true, search: true, rules: true, planning: true, conversation: true }, includeSenderDetails: false, secureStorage: true }
const message = { accountId: 'a', threadId: 't', id: 'm', subject: 'Invoice', fromName: 'Ada', fromEmail: 'ada@example.test', to: [], cc: [], date: '2026-10-01T09:00:00Z', text: 'Please pay', html: '', sanitizedHtml: '', labelIds: [], attachments: [] } as MailMessageDetail
const ref = { accountId: 'a', threadId: 't', messageId: 'm' }
const ai = { status: vi.fn(), configure: vi.fn(), summarize: vi.fn(), suggestReplies: vi.fn(), compose: vi.fn(), search: vi.fn(), cancel: vi.fn() }
const drafts = { send: vi.fn(), save: vi.fn() }
const actions = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  ai.status.mockResolvedValue(status)
  ai.cancel.mockResolvedValue(true)
  Object.defineProperty(window, 'aerio', { configurable: true, value: { ai, mail: { drafts, mail: { action: actions } } } })
})

describe('AI message assistance', () => {
  it('lets the user request a whole conversation and discloses its wider scope before sending', async () => {
    const user = userEvent.setup()
    ai.summarize.mockResolvedValue('The final decision changed.')
    render(<MailAiAssistDialog mode="summarize" message={message} messageRef={ref} status={status} onToast={vi.fn()} onClose={vi.fn()} />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Summary scope' }), 'conversation')
    expect(screen.getByText(/newest 100 cached messages/)).toBeTruthy()
    expect(ai.summarize).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Summarize' }))
    await screen.findByText('The final decision changed.')
    expect(ai.summarize).toHaveBeenCalledWith(expect.any(String), ref, 'conversation')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Summary scope' }), 'message')
    expect(screen.queryByText('The final decision changed.')).toBeNull()
  })
  it('discloses what is sent and contacts the provider only after an explicit click', async () => {
    const user = userEvent.setup()
    ai.summarize.mockResolvedValue('<img src=x onerror="window.pwned=1">Pay by Friday')
    render(<MailAiAssistDialog mode="summarize" message={message} messageRef={ref} status={status} onToast={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText(/Sends to Anthropic \(claude-sonnet-5-5\)/)).toBeTruthy()
    expect(ai.summarize).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Summarize' }))
    const preview = await screen.findByRole('region', { name: 'AI summary' })
    // Model output is rendered as text, never as markup.
    expect(preview.textContent).toContain('<img src=x onerror="window.pwned=1">Pay by Friday')
    expect(preview.querySelector('img')).toBeNull()
    expect(ai.summarize).toHaveBeenCalledWith(expect.any(String), ref)
    expect(drafts.send).not.toHaveBeenCalled()
    expect(actions).not.toHaveBeenCalled()
  })

  it('opens an editable reply only when the user picks a suggestion, and never sends', async () => {
    const user = userEvent.setup()
    const onReply = vi.fn()
    const onClose = vi.fn()
    ai.suggestReplies.mockResolvedValue(['Paid already.', 'Which invoice?'])
    render(<MailAiAssistDialog mode="replies" message={message} messageRef={ref} status={status} onReplyWithText={onReply} onToast={vi.fn()} onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: 'Suggest replies' }))
    await screen.findByText('Which invoice?')
    expect(onReply).not.toHaveBeenCalled()
    await user.click(screen.getAllByRole('button', { name: 'Reply with this' })[1])
    expect(onReply).toHaveBeenCalledWith('Which invoice?')
    expect(onClose).toHaveBeenCalled()
    expect(drafts.send).not.toHaveBeenCalled()
  })

  it('cancels an in-flight request and shows provider errors', async () => {
    const user = userEvent.setup()
    let resolve!: (value: string) => void
    ai.summarize.mockReturnValueOnce(new Promise((done) => { resolve = done }))
    render(<MailAiAssistDialog mode="summarize" message={message} messageRef={ref} status={status} onToast={vi.fn()} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Summarize' }))
    expect(screen.getByText('Waiting for Anthropic…')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Cancel request' }))
    expect(ai.cancel).toHaveBeenCalledWith(ai.summarize.mock.calls[0][0])
    expect(screen.getByText(/Request cancelled/)).toBeTruthy()
    resolve('Late result')
    await waitFor(() => expect(screen.queryByText('Late result')).toBeNull())
    ai.summarize.mockRejectedValueOnce(new Error("Error invoking remote method 'ai:summarize': Error: The AI provider rejected the API key (401)."))
    await user.click(screen.getByRole('button', { name: 'Summarize' }))
    expect((await screen.findByRole('alert')).textContent).toBe('The AI provider rejected the API key (401).')
  })
})

describe('AI search', () => {
  it('shows the proposed query, validates edits, and runs only on click', async () => {
    const user = userEvent.setup()
    const onRun = vi.fn()
    ai.search.mockResolvedValue({ query: 'from:ada invoice' })
    render(<MailAiSearchDialog status={status} onRun={onRun} onClose={vi.fn()} />)
    await user.type(screen.getByRole('textbox', { name: /What are you looking for/ }), 'invoices from ada')
    await user.click(screen.getByRole('button', { name: 'Suggest search' }))
    const proposed = await screen.findByRole('textbox', { name: 'Proposed search' }) as HTMLInputElement
    expect(proposed.value).toBe('from:ada invoice')
    expect(onRun).not.toHaveBeenCalled()
    await user.type(proposed, ' (')
    expect(screen.getByRole('alert').textContent).toMatch(/parenthes/i)
    expect((screen.getByRole('button', { name: 'Run search' }) as HTMLButtonElement).disabled).toBe(true)
    await user.type(proposed, 'x)')
    await user.click(screen.getByRole('button', { name: 'Run search' }))
    expect(onRun).toHaveBeenCalledWith('from:ada invoice (x)')
  })
})

describe('AI composer assistance', () => {
  it('previews generated text and inserts it as escaped plain text only when asked', async () => {
    const user = userEvent.setup()
    const editor = document.createElement('div')
    editor.innerHTML = '<div>old draft</div>'
    const editorRef = createRef<HTMLDivElement>() as { current: HTMLDivElement | null }
    editorRef.current = editor
    const onEditorChange = vi.fn()
    ai.compose.mockResolvedValue('Dear Ada,\n<script>alert(1)</script>')
    render(<MailAiComposeAssist status={status} editorRef={editorRef} text="old draft" replyTo={ref} onEditorChange={onEditorChange} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Make it more formal' }))
    await user.click(screen.getByRole('checkbox', { name: /Include the email I’m replying to/ }))
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(ai.compose).toHaveBeenCalledWith(expect.any(String), { instruction: 'Make it more formal', draft: 'old draft', replyTo: ref })
    await screen.findByRole('region', { name: 'AI draft preview' })
    expect(editor.innerHTML).toBe('<div>old draft</div>')
    await user.click(screen.getByRole('button', { name: 'Replace message text' }))
    expect(editor.querySelector('script')).toBeNull()
    expect(editor.textContent).toBe('Dear Ada,<script>alert(1)</script>')
    expect(onEditorChange).toHaveBeenCalled()
    expect(drafts.send).not.toHaveBeenCalled()
    expect(plainTextToEditorHtml('a\n\n"b"')).toBe('<div>a</div><div><br></div><div>&quot;b&quot;</div>')
  })
})

describe('AI settings', () => {
  it('starts off, shows per-feature data sharing, and sends the key only to the main process', async () => {
    const user = userEvent.setup()
    ai.status.mockResolvedValue({ ...status, enabled: false, hasApiKey: false })
    ai.configure.mockImplementation(async (input) => ({ ...status, ...input, apiKey: undefined, hasApiKey: true }))
    render(<AiAssistantSettings />)
    const toggle = await screen.findByRole('checkbox', { name: /Turn on AI assistance/ }) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    expect(screen.queryByLabelText(/API key/)).toBeNull()
    await user.click(toggle)
    expect(screen.getByText(/Only the words you type into the Ask AI search box/)).toBeTruthy()
    await user.type(screen.getByLabelText(/API key/), 'sk-ant-secret')
    await user.click(screen.getByRole('button', { name: 'Save AI settings' }))
    expect(ai.configure).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, provider: 'anthropic', apiKey: 'sk-ant-secret' }))
    await screen.findByText('AI assistance settings saved.')
    expect((screen.getByLabelText(/API key/) as HTMLInputElement).value).toBe('')
    expect(screen.getByRole('button', { name: /Remove saved key/ })).toBeTruthy()
  })
})
