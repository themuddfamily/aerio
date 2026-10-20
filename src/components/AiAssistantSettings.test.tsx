// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import AiAssistantSettings from './AiAssistantSettings'
const status = { enabled: true, provider: 'anthropic', model: 'test', baseUrl: '', hasApiKey: true, hasWebSearchKey: true, secureStorage: true, includeSenderDetails: false, features: { conversation: true } }
let configure: ReturnType<typeof vi.fn>
beforeEach(() => {
  configure = vi.fn().mockResolvedValue(status)
  Object.defineProperty(window, 'aerio', { configurable: true, value: { ai: { status: vi.fn().mockResolvedValue(status), configure } } })
})
it('saves a newly entered web token through the main credential API', async () => {
  render(<AiAssistantSettings />)
  fireEvent.change(await screen.findByLabelText('Brave Search token'), { target: { value: 'new-brave-token' } })
  fireEvent.click(screen.getByRole('button', { name: /Save AI settings/ }))
  await waitFor(() => expect(configure).toHaveBeenCalledWith(expect.objectContaining({ webSearchApiKey: 'new-brave-token' })))
  await waitFor(() => expect(screen.getByLabelText('Brave Search token')).toHaveValue(''))
})
it('removes a saved token even when an unsaved replacement was typed', async () => {
  render(<AiAssistantSettings />)
  fireEvent.change(await screen.findByLabelText('Brave Search token'), { target: { value: 'unsaved-token' } })
  fireEvent.click(screen.getByRole('button', { name: 'Remove Brave Search token' }))
  await waitFor(() => expect(configure).toHaveBeenCalledWith(expect.objectContaining({ clearWebSearchApiKey: true })))
  expect(configure.mock.calls[0][0]).not.toHaveProperty('webSearchApiKey')
})
