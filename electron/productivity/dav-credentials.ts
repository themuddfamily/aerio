import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { assertSecureCredentialStorage } from '../mail/secure-storage'

// DAV app passwords, encrypted as one blob with OS secure storage (DPAPI, Keychain, or libsecret)
// in dav-credentials.dat. The file is deliberately absent from the profile-backup allowlist, and
// passwords never cross to the renderer.

export interface DavSecretStorage {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export class DavCredentialVault {
  private cache?: Record<string, string>

  constructor(private readonly path: string, private readonly storage: DavSecretStorage) {}

  private read(): Record<string, string> {
    if (this.cache) return this.cache
    if (!existsSync(this.path)) return (this.cache = {})
    assertSecureCredentialStorage(this.storage)
    try {
      const parsed = JSON.parse(this.storage.decryptString(Buffer.from(readFileSync(this.path, 'utf8'), 'base64'))) as unknown
      this.cache = parsed && typeof parsed === 'object' ? Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string')) as Record<string, string> : {}
    } catch {
      // Undecryptable (for example copied from another computer): treat as no saved passwords.
      this.cache = {}
    }
    return this.cache
  }

  private write(next: Record<string, string>) {
    assertSecureCredentialStorage(this.storage)
    const temporary = `${this.path}.partial`
    writeFileSync(temporary, this.storage.encryptString(JSON.stringify(next)).toString('base64'), { mode: 0o600 })
    renameSync(temporary, this.path)
    this.cache = next
  }

  password(accountId: string) {
    return this.read()[accountId]
  }

  has(accountId: string) {
    return Boolean(this.password(accountId))
  }

  save(accountId: string, password: string) {
    // Refuse before anything is written when the OS cannot encrypt.
    assertSecureCredentialStorage(this.storage)
    this.write({ ...this.read(), [accountId]: password })
  }

  remove(accountId: string) {
    const current = { ...this.read() }
    if (!(accountId in current)) return
    delete current[accountId]
    if (Object.keys(current).length) this.write(current)
    else {
      rmSync(this.path, { force: true })
      this.cache = {}
    }
  }
}
