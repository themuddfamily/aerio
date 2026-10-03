import { describe, expect, it, vi } from 'vitest'
import { assertSecureCredentialStorage } from './secure-storage'

function storage(available: boolean, backend = 'gnome_libsecret') {
  return { isEncryptionAvailable: vi.fn(() => available), getSelectedStorageBackend: vi.fn(() => backend) }
}

describe('credential storage across desktop platforms', () => {
  it.each(['win32', 'darwin'] as const)('uses the OS availability check on %s without consulting a Linux-only API', (platform) => {
    const provider = storage(true)
    provider.getSelectedStorageBackend.mockImplementation(() => { throw new Error('Linux only') })
    expect(() => assertSecureCredentialStorage(provider, platform)).not.toThrow()
    expect(provider.getSelectedStorageBackend).not.toHaveBeenCalled()
  })

  it.each(['win32', 'darwin', 'linux'] as const)('refuses unavailable storage on %s', (platform) => {
    const provider = storage(false)
    expect(() => assertSecureCredentialStorage(provider, platform)).toThrow(/without OS encryption/)
    expect(provider.getSelectedStorageBackend).not.toHaveBeenCalled()
  })

  it.each(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])('accepts an available Linux %s backend', (backend) => {
    expect(() => assertSecureCredentialStorage(storage(true, backend), 'linux')).not.toThrow()
  })

  it.each(['basic_text', 'unknown', '', 'future_unverified_backend'])('refuses Linux %s even when availability reports true', (backend) => {
    expect(() => assertSecureCredentialStorage(storage(true, backend), 'linux')).toThrow(/Secure credential storage is unavailable/)
  })

  it('refuses a backend that cannot be inspected', () => {
    const provider = storage(true)
    provider.getSelectedStorageBackend.mockImplementation(() => { throw new Error('Secret service disconnected') })
    expect(() => assertSecureCredentialStorage(provider, 'linux')).toThrow(/without OS encryption/)
  })
})
