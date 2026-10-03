interface CredentialStorage {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend(): string
}

const secureLinuxBackends = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])

export function assertSecureCredentialStorage(storage: CredentialStorage, platform: NodeJS.Platform = process.platform) {
  let secure = false
  try {
    secure = storage.isEncryptionAvailable() &&
      (platform !== 'linux' || secureLinuxBackends.has(storage.getSelectedStorageBackend()))
  } catch {
    // An unavailable or unrecognized secret service must never permit a weak fallback.
  }
  if (!secure) throw new Error('Secure credential storage is unavailable. Aerio will not save mail credentials without OS encryption.')
}
