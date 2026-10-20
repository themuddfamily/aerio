// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ProxySettings from './ProxySettings'
const status = { mode: 'system', server: '', bypass: '', hasCredentials: false, secureStorage: true, restartRequired: false }
describe('proxy settings', () => {
  it('saves credentials only from explicit input, clears fields, and explains the required restart', async () => {
    const configure = vi.fn().mockImplementation(async (input) => ({ ...status, ...input, hasCredentials: true, restartRequired: true }))
    Object.defineProperty(window, 'aerio', { configurable: true, value: { networkProxy: { status: vi.fn().mockResolvedValue(status), configure } } })
    render(<ProxySettings />)
    fireEvent.change(await screen.findByLabelText('Proxy mode'), { target: { value: 'manual' } })
    fireEvent.change(screen.getByLabelText('Proxy server'), { target: { value: 'http://proxy.test:8080' } })
    fireEvent.change(screen.getByLabelText('Proxy username'), { target: { value: 'user' } })
    fireEvent.change(screen.getByLabelText('Proxy password'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save proxy settings' }))
    await waitFor(() => expect(configure).toHaveBeenCalledWith({ mode: 'manual', server: 'http://proxy.test:8080', bypass: '', username: 'user', password: 'secret', clearCredentials: false }))
    expect(await screen.findByText(/Quit and reopen Aerio/)).toBeInTheDocument()
    expect(screen.getByLabelText('Proxy password')).toHaveValue('')
    expect(screen.getByLabelText('Proxy username')).toHaveValue('')
    fireEvent.click(screen.getByLabelText('Remove saved proxy credentials'))
    fireEvent.click(screen.getByRole('button', { name: 'Save proxy settings' }))
    await waitFor(() => expect(configure).toHaveBeenLastCalledWith(expect.objectContaining({ clearCredentials: true })))
  })
  it('keeps password fields disabled without encryption and reports validation errors', async () => {
    Object.defineProperty(window, 'aerio', { configurable: true, value: { networkProxy: { status: vi.fn().mockResolvedValue({ ...status, mode: 'manual', secureStorage: false }), configure: vi.fn().mockRejectedValue(new Error('Enter a valid proxy')) } } })
    render(<ProxySettings />)
    expect(await screen.findByLabelText('Proxy password')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save proxy settings' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid proxy')
  })
})
