// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MailAutomaticReplies from './MailAutomaticReplies'
import { notifyAiSettingsChanged } from '../lib/use-ai-assistant'
import type { AiAssistantStatus } from '../ai-assistant-types'
import type { MailMessageDetail } from '../mail-types'

const status: AiAssistantStatus = { enabled: true, automaticReplies: false, provider: 'anthropic', model: 'test', baseUrl: '', hasApiKey: true, secureStorage: true, features: { replies: true, summarize: true, compose: true, search: true }, includeSenderDetails: false }
const message = { accountId: 'a', threadId: 't', id: 'one', text: 'Would Friday work?' } as MailMessageDetail
const ai = { status: vi.fn(), suggestReplies: vi.fn(), cancel: vi.fn() }
beforeEach(() => {
  vi.clearAllMocks()
  ai.status.mockResolvedValue(status)
  ai.cancel.mockResolvedValue(true)
  ai.suggestReplies.mockResolvedValue(['Yes, Friday works.'])
  Object.defineProperty(window, 'aerio', { configurable: true, value: { ai } })
})
describe('automatic reply suggestions', () => {
  it('does not send anything by default, then offers an editable reply after explicit settings opt-in', async () => {
    const user = userEvent.setup()
    const reply = vi.fn()
    render(<MailAutomaticReplies message={message} onReply={reply} />)
    await act(async () => { await Promise.resolve() })
    expect(ai.suggestReplies).not.toHaveBeenCalled()
    act(() => notifyAiSettingsChanged({ ...status, automaticReplies: true }))
    await screen.findByText('Yes, Friday works.')
    expect(ai.suggestReplies).toHaveBeenCalledWith(expect.any(String), { accountId: 'a', threadId: 't', messageId: 'one' }, true)
    expect(reply).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Reply with this' }))
    expect(reply).toHaveBeenCalledWith('Yes, Friday works.')
  })
  it('cancels on navigation and drops a late result from the previous message', async () => {
    ai.status.mockResolvedValue({ ...status, automaticReplies: true })
    let resolve!: (value: string[]) => void
    ai.suggestReplies.mockImplementationOnce(() => new Promise<string[]>((done) => { resolve = done }))
    const view = render(<MailAutomaticReplies message={message} />)
    await waitFor(() => expect(ai.suggestReplies).toHaveBeenCalledTimes(1))
    const requestId = ai.suggestReplies.mock.calls[0][0]
    view.rerender(<MailAutomaticReplies message={{ ...message, id: 'two' }} />)
    expect(ai.cancel).toHaveBeenCalledWith(requestId)
    await act(async () => resolve(['Stale reply']))
    expect(screen.queryByText('Stale reply')).toBeNull()
    act(() => notifyAiSettingsChanged({ ...status, automaticReplies: true, features: { ...status.features, replies: false } }))
    expect(screen.queryByRole('region', { name: 'Automatic reply suggestions' })).toBeNull()
    await new Promise((done) => setTimeout(done, 450))
    expect(ai.suggestReplies).toHaveBeenCalledTimes(1)
  })
})
