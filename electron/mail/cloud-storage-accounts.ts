import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { CloudStorageAccount } from '../../src/cloud-attachment-types'
import { isLoopbackHost } from '../../src/lib/dav-presets'

// Connected Dropbox, ownCloud and Nextcloud accounts. Account details (provider, server,
// user name, discovered capabilities) live in cloud-storage-accounts.json; the secret for each
// account (a Dropbox refresh token or an ownCloud/Nextcloud app password) lives in a separate
// vault encrypted with OS secure storage, the same way DAV app passwords do. Neither file is in
// the profile-backup allowlist, and secrets never cross to the renderer.

/** Secret storage keyed by account id; `DavCredentialVault` satisfies it. */
export interface CloudSecretVault {
  password(accountId: string): string | undefined
  save(accountId: string, secret: string): void
  remove(accountId: string): void
}

export interface StoredStorageAccount extends CloudStorageAccount {
  /**
   * The provider's own id for the user: the OCS user id that names WebDAV paths
   * (it can differ from the login name), or the Dropbox account id.
   */
  remoteUserId: string
  /** Major server version reported by OCS capabilities. */
  serverVersion?: number
  /** True when the server offers Nextcloud chunked upload v2. */
  chunkedUpload?: boolean
}

interface Registry {
  accounts: StoredStorageAccount[]
  dropboxAppKey?: string
}

export class CloudStorageAccountStore {
  private registry: Registry = { accounts: [] }

  constructor(private readonly path: string, private readonly vault: CloudSecretVault) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Registry>
      this.registry = {
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts.filter((item) => item && typeof item.id === 'string') : [],
        ...(typeof parsed.dropboxAppKey === 'string' ? { dropboxAppKey: parsed.dropboxAppKey } : {})
      }
    } catch {
      // A missing or unreadable registry means no storage accounts are connected.
    }
  }

  private save() {
    const temporary = `${this.path}.partial`
    writeFileSync(temporary, JSON.stringify(this.registry), { mode: 0o600 })
    renameSync(temporary, this.path)
  }

  accounts() { return this.registry.accounts }
  account(id: string) { return this.registry.accounts.find((item) => item.id === id) }

  /** Stores the secret first, so an account is never listed without its credential. */
  put(account: StoredStorageAccount, secret?: string) {
    if (secret !== undefined) this.vault.save(account.id, secret)
    this.registry.accounts = [...this.registry.accounts.filter((item) => item.id !== account.id), account]
    this.save()
  }

  update(id: string, patch: Partial<StoredStorageAccount>) {
    const current = this.account(id)
    if (!current) return undefined
    const next = { ...current, ...patch }
    this.registry.accounts = this.registry.accounts.map((item) => item.id === id ? next : item)
    this.save()
    return next
  }

  secret(id: string) { return this.vault.password(id) }
  saveSecret(id: string, secret: string) { this.vault.save(id, secret) }

  /** Forgets the account and deletes its secret from secure storage. */
  remove(id: string) {
    this.vault.remove(id)
    if (!this.account(id)) return
    this.registry.accounts = this.registry.accounts.filter((item) => item.id !== id)
    this.save()
  }

  dropboxAppKey() { return this.registry.dropboxAppKey }
  setDropboxAppKey(value: string) {
    this.registry.dropboxAppKey = value
    this.save()
  }
}

/**
 * Validates an ownCloud or Nextcloud address: HTTPS is required, except plain HTTP on this
 * computer. Credentials in the URL are refused, and a pasted WebDAV or login URL is trimmed
 * back to the server root.
 */
export function normalizeCloudServerUrl(input: unknown): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 2_048) throw new Error('Enter the server address')
  const trimmed = input.trim()
  let url: URL
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`) }
  catch { throw new Error('Enter a valid https:// server address') }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) throw new Error('Storage servers must use https:// (plain http is allowed only on this computer)')
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Enter a valid https:// server address')
  if (url.username || url.password) throw new Error('Remove the user name and password from the server address')
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname.replace(/\/(?:remote\.php|index\.php|ocs|apps|login)(?:\/.*)?$/i, '/')
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.toString()
}
