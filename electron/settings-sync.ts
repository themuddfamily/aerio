import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SettingsSyncBundle, SettingsSyncConfiguration, SettingsSyncReview, SettingsSyncStatus } from '../src/settings-sync-types'
import { DavCredentialVault, type DavSecretStorage } from './productivity/dav-credentials'
import { decryptSyncData, encryptSyncData, syncDigest } from './settings-sync-crypto'
import { settingsSyncUrl, WebDavSettingsRemote, type SettingsSyncRemote } from './settings-sync-webdav'

export interface SettingsSyncAdapter { capture(): Promise<SettingsSyncBundle>; validate(value: unknown): SettingsSyncBundle; apply(bundle: SettingsSyncBundle, guard?: { assert(): void; available(): boolean }, expected?: SettingsSyncBundle): Promise<SettingsSyncBundle> }
interface RemoteDocument { format: 'aerio-settings-sync-document'; version: 1; revision: string; deviceName: string; updatedAt: string; bundle: SettingsSyncBundle }
interface Checkpoint { local: SettingsSyncBundle; remote: SettingsSyncBundle; remoteRevision?: string; remoteUpdatedAt?: string }
interface SavedState extends Omit<SettingsSyncStatus, 'configured' | 'phase'> { version: 1; phase: 'disabled' | 'idle' | 'review' | 'error' }
const defaults = (): SavedState => ({ version: 1, enabled: false, url: '', username: '', deviceName: 'This device', intervalMinutes: 15, phase: 'disabled' })
const summary = (bundle?: SettingsSyncBundle) => ({ signatures: bundle?.signatures.definitions.length ?? 0, templates: bundle?.templates.templates.filter((item) => item.kind === 'template').length ?? 0, snippets: bundle?.templates.templates.filter((item) => item.kind === 'snippet').length ?? 0 })
function differences(local: SettingsSyncBundle, remote?: SettingsSyncBundle): string[] {
  if (!remote) return ['The shared settings file is missing. Publishing will create a new encrypted file.']
  const changes: string[] = []
  for (const field of Object.keys(local.preferences) as (keyof SettingsSyncBundle['preferences'])[]) if (syncDigest(local.preferences[field]) !== syncDigest(remote.preferences[field])) changes.push(`Preference: ${field}`)
  const compare = (kind: string, left: { id: string; name: string }[], right: { id: string; name: string }[]) => {
    for (const item of left) { const other = right.find((entry) => entry.id === item.id); if (!other) changes.push(`${kind}: ${item.name} (this device only)`); else if (syncDigest(item) !== syncDigest(other)) changes.push(`${kind}: ${item.name} (different)`); if (changes.length >= 100) return }
    for (const item of right) { if (!left.some((entry) => entry.id === item.id)) changes.push(`${kind}: ${item.name} (shared only)`); if (changes.length >= 100) return }
  }
  compare('Signature', local.signatures.definitions, remote.signatures.definitions)
  compare('Template / QuickText', local.templates.templates, remote.templates.templates)
  if (syncDigest(local.signatures.accounts) !== syncDigest(remote.signatures.accounts) || syncDigest(local.signatures.assignments) !== syncDigest(remote.signatures.assignments)) changes.push('Account signature text or sender assignments differ.')
  return changes.slice(0, 100)
}
const key = (item: { provider: string; email?: string; accountEmail?: string; identityEmail?: string }) => `${item.provider}:${item.email ?? item.accountEmail}:${item.identityEmail ?? ''}`
/** Preserve mappings for accounts absent on this device, without reintroducing deleted signature definitions. */
function uploadBundle(local: SettingsSyncBundle, previous?: SettingsSyncBundle): SettingsSyncBundle {
  if (!previous) return local
  const ids = new Set(local.signatures.definitions.map((item) => item.id))
  const accounts = [...local.signatures.accounts, ...previous.signatures.accounts.filter((item) => !local.signatures.accounts.some((current) => key(current) === key(item)))]
  const assignments = [...local.signatures.assignments, ...previous.signatures.assignments.filter((item) => !local.signatures.assignments.some((current) => key(current) === key(item))).map(({ newSignatureId, replySignatureId, ...item }) => ({ ...item, ...(newSignatureId && ids.has(newSignatureId) ? { newSignatureId } : {}), ...(replySignatureId && ids.has(replySignatureId) ? { replySignatureId } : {}) }))]
  return { ...local, signatures: { ...local.signatures, accounts, assignments } }
}
export class SettingsSyncService {
  private state: SavedState
  private readonly vault: DavCredentialVault
  private busy = false
  private closed = false
  private abort?: AbortController
  private readonly guard = { assert: () => this.assertReady(), available: () => !this.closed }
  private timer?: ReturnType<typeof setInterval>
  private lastAttempt = 0
  constructor(private readonly options: { directory: string; storage: DavSecretStorage; adapter: SettingsSyncAdapter; locked(): boolean; remote?(configuration: SettingsSyncConfiguration, password: string, signal?: AbortSignal): SettingsSyncRemote; now?(): number }) {
    this.vault = new DavCredentialVault(join(options.directory, 'settings-sync-secrets.dat'), options.storage)
    const path = this.path('state.json')
    this.state = defaults()
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as SavedState
        if (parsed.version !== 1 || typeof parsed.enabled !== 'boolean' || !Number.isInteger(parsed.intervalMinutes) || parsed.intervalMinutes < 5 || parsed.intervalMinutes > 1440 || typeof parsed.username !== 'string' || typeof parsed.deviceName !== 'string' || typeof parsed.url !== 'string' || !['disabled', 'idle', 'review', 'error'].includes(parsed.phase)) throw new Error('Invalid configuration.')
        if (parsed.url) settingsSyncUrl(parsed.url)
        this.state = parsed
      } catch { this.state = { ...defaults(), phase: 'error', message: 'The local sync configuration is invalid. Save the connection again to reset it.' } }
    }
  }
  private path(name: string) { return join(this.options.directory, `settings-sync-${name}`) }
  private atomic(path: string, text: string) { writeFileSync(`${path}.tmp`, text, { mode: 0o600 }); renameSync(`${path}.tmp`, path) }
  private persist() { this.atomic(this.path('state.json'), JSON.stringify(this.state, null, 2)) }
  private secrets(): { password: string; passphrase: string } | undefined {
    const secret = this.vault.password('credentials'); if (!secret) return
    try { const value = JSON.parse(secret); if (typeof value.password === 'string' && typeof value.passphrase === 'string' && value.url === this.state.url && value.username === this.state.username) return value } catch { /* A copied vault may not be decryptable on this OS user. */ }
  }
  private assertReady() { if (this.closed) throw new Error('Settings synchronization has stopped.'); this.assertUnlocked() }
  private assertUnlocked() { if (this.options.locked()) throw new Error('Unlock Aerio before synchronizing settings.') }
  status(): SettingsSyncStatus {
    const { version: _version, ...status } = this.state
    return { ...status, recoveryPending: existsSync(this.path('recovery.enc.json')), configured: !!this.state.url && !!this.secrets(), phase: this.busy ? 'syncing' : this.state.phase }
  }
  private result(): SettingsSyncStatus { return { ...this.status(), phase: this.state.phase } }
  configure(input: SettingsSyncConfiguration): SettingsSyncStatus {
    this.assertReady(); if (this.busy) throw new Error('Wait for settings synchronization to finish.')
    if (existsSync(this.path('recovery.enc.json'))) throw new Error('Sync once to recover an interrupted import before changing the connection.')
    if (!input || typeof input.enabled !== 'boolean' || typeof input.username !== 'string' || !input.username.trim() || /[:\r\n]/.test(input.username) || input.username.length > 320 || !Number.isInteger(input.intervalMinutes) || input.intervalMinutes < 5 || input.intervalMinutes > 1440 || typeof input.deviceName !== 'string' || !input.deviceName.trim() || input.deviceName.length > 80) throw new Error('Enter a user name, device name and a sync interval from 5–1440 minutes.')
    const url = settingsSyncUrl(input.url), previous = this.secrets()
    if (previous && (url !== this.state.url || input.username.trim() !== this.state.username) && !input.password) throw new Error('Re-enter the WebDAV app password for a different endpoint or user name.')
    const password = input.password || previous?.password, passphrase = input.passphrase || previous?.passphrase
    if (!password || password.length > 8192 || !passphrase || passphrase.length < 12 || passphrase.length > 1024) throw new Error('Enter the WebDAV app password and a sync passphrase of at least 12 characters.')
    const reset = url !== this.state.url || input.username.trim() !== this.state.username || input.passphrase && input.passphrase !== previous?.passphrase
    const previousState = this.state
    this.vault.save('credentials', JSON.stringify({ url, username: input.username.trim(), password, passphrase }))
    try {
      if (reset && existsSync(this.path('checkpoint.enc.json'))) unlinkSync(this.path('checkpoint.enc.json'))
      this.state = { version: 1, enabled: input.enabled, url, username: input.username.trim(), deviceName: input.deviceName.trim(), intervalMinutes: input.intervalMinutes, phase: input.enabled ? 'idle' : 'disabled', ...(!reset && this.state.lastSyncedAt ? { lastSyncedAt: this.state.lastSyncedAt } : {}) }
      this.persist()
    } catch (error) {
      this.state = previousState
      try { if (previous) this.vault.save('credentials', JSON.stringify(previous)); else this.vault.remove('credentials') } catch { /* Surface the disk failure; never fall back to plaintext. */ }
      throw error
    }
    this.lastAttempt = 0
    return this.status()
  }
  disconnect(): SettingsSyncStatus {
    this.assertReady(); if (this.busy) throw new Error('Wait for settings synchronization to finish.')
    if (existsSync(this.path('recovery.enc.json'))) throw new Error('Sync once to recover an interrupted import before disconnecting.')
    this.state = defaults(); this.persist(); this.vault.remove('credentials')
    if (existsSync(this.path('checkpoint.enc.json'))) unlinkSync(this.path('checkpoint.enc.json'))
    return this.status()
  }
  start() {
    if (this.closed || this.timer) return
    this.timer = setInterval(() => {
      const now = this.options.now?.() ?? Date.now()
      if (!this.state.enabled || this.busy || this.state.phase === 'review' || this.options.locked() || now - this.lastAttempt < this.state.intervalMinutes * 60_000) return
      void this.sync().catch(() => {})
    }, 30_000)
    this.timer.unref?.()
  }
  close() { this.closed = true; this.abort?.abort(); if (this.timer) clearInterval(this.timer); this.timer = undefined }
  private document(value: unknown): RemoteDocument {
    if (!value || typeof value !== 'object') throw new Error('Invalid synchronized document.')
    const document = value as RemoteDocument
    if (document.format !== 'aerio-settings-sync-document' || document.version !== 1 || typeof document.revision !== 'string' || !/^[\w-]{1,100}$/.test(document.revision) || typeof document.deviceName !== 'string' || document.deviceName.length > 80 || typeof document.updatedAt !== 'string' || document.updatedAt.length > 100 || !Number.isFinite(Date.parse(document.updatedAt))) throw new Error('Unsupported synchronized document version.')
    return { ...document, bundle: this.options.adapter.validate(document.bundle) }
  }
  private async checkpoint(passphrase: string): Promise<Checkpoint | undefined> {
    if (!existsSync(this.path('checkpoint.enc.json'))) return
    const data = await decryptSyncData(readFileSync(this.path('checkpoint.enc.json'), 'utf8'), passphrase) as Checkpoint
    return { local: this.options.adapter.validate(data.local), remote: this.options.adapter.validate(data.remote), ...(typeof data.remoteRevision === 'string' ? { remoteRevision: data.remoteRevision } : {}), ...(typeof data.remoteUpdatedAt === 'string' ? { remoteUpdatedAt: data.remoteUpdatedAt } : {}) }
  }
  private async saveCheckpoint(local: SettingsSyncBundle, remote: SettingsSyncBundle, passphrase: string, document?: RemoteDocument) { const encrypted = await encryptSyncData({ local, remote, ...(document ? { remoteRevision: document.revision, remoteUpdatedAt: document.updatedAt } : {}) }, passphrase); this.assertReady(); this.atomic(this.path('checkpoint.enc.json'), encrypted) }
  private review(local: SettingsSyncBundle, remote: RemoteDocument | undefined, etag: string, message: string): SettingsSyncStatus {
    const review: SettingsSyncReview = { localDigest: syncDigest(local), remoteDigest: remote ? syncDigest(remote.bundle) : 'missing', etag, remoteDevice: remote?.deviceName ?? 'No remote file', updatedAt: remote?.updatedAt ?? new Date().toISOString(), differences: differences(local, remote?.bundle), local: summary(local), remote: summary(remote?.bundle) }
    this.state = { ...this.state, phase: 'review', review, message }; this.persist()
    return this.result()
  }
  async sync(choice?: 'local' | 'remote'): Promise<SettingsSyncStatus> {
    this.assertReady(); if (this.busy) throw new Error('Settings synchronization is already running.')
    const secrets = this.secrets(); if (!secrets || !this.state.url) throw new Error('Configure settings synchronization first.')
    const review = this.state.review
    if (choice && (!review || !['local', 'remote'].includes(choice))) throw new Error('Sync first to review the current versions.')
    this.busy = true; this.abort = new AbortController(); this.lastAttempt = this.options.now?.() ?? Date.now()
    try {
      const recovery = this.path('recovery.enc.json')
      const interrupted = existsSync(recovery)
      // A journal is evidence of an interrupted import, never permission to replace newer edits.
      if (interrupted) { await decryptSyncData(readFileSync(recovery, 'utf8'), secrets.passphrase); this.assertReady() }
      if (!this.state.enabled) return this.result()
      const local = this.options.adapter.validate(await this.options.adapter.capture()), checkpoint = await this.checkpoint(secrets.passphrase)
      this.assertReady()
      const client = this.options.remote?.(this.state, secrets.password, this.abort.signal) ?? new WebDavSettingsRemote(this.state.url, this.state.username, secrets.password, undefined, this.abort.signal)
      const file = await client.get(), remote = file ? this.document(await decryptSyncData(file.text, secrets.passphrase)) : undefined
      this.assertReady()
      const latest = this.options.adapter.validate(await this.options.adapter.capture()); this.assertReady()
      if (syncDigest(latest) !== syncDigest(local)) return this.review(latest, remote, file?.etag ?? 'missing', 'Local settings changed during synchronization. Review the latest local and shared versions before continuing.')
      const localHash = syncDigest(local), remoteHash = remote ? syncDigest(remote.bundle) : 'missing'
      if (interrupted && !choice) return this.review(latest, remote, file?.etag ?? 'missing', 'An import was interrupted. Current local edits were preserved. Review both snapshots before continuing.')
      if (choice && (review!.localDigest !== localHash || review!.remoteDigest !== remoteHash || review!.etag !== (file?.etag ?? 'missing'))) return this.review(local, remote, file?.etag ?? 'missing', 'A version changed after review. Review the latest versions before choosing again.')
      if (remote && checkpoint?.remoteUpdatedAt && checkpoint.remoteRevision !== remote.revision && Date.parse(remote.updatedAt) < Date.parse(checkpoint.remoteUpdatedAt) && !choice) return this.review(local, remote, file!.etag, 'The shared file is an older revision or its device clock is behind. Review before applying it.')
      if (!remote && checkpoint && !choice) return this.review(local, undefined, 'missing', 'The shared settings file was removed. Review before publishing it again.')
      if (choice === 'remote' && !remote) throw new Error('The shared settings file no longer exists.')
      let action: 'local' | 'remote' | 'none' | 'review' = choice ?? 'none'
      if (!choice) {
        if (!remote) action = 'local'
        else if (localHash === remoteHash) action = 'none'
        else if (!checkpoint) action = 'review'
        else {
          const localChanged = localHash !== syncDigest(checkpoint.local), remoteChanged = remoteHash !== syncDigest(checkpoint.remote)
          action = localChanged && remoteChanged ? 'review' : localChanged ? 'local' : remoteChanged ? 'remote' : 'none'
          if (action === 'local' && local.signatures.assignments.some((item) => !checkpoint.local.signatures.assignments.some((before) => key(before) === key(item)) && remote.bundle.signatures.assignments.some((other) => key(other) === key(item) && syncDigest(other) !== syncDigest(item)))) action = 'review'
          if (action === 'local' && local.signatures.accounts.some((item) => !checkpoint.local.signatures.accounts.some((before) => key(before) === key(item)) && remote.bundle.signatures.accounts.some((other) => key(other) === key(item) && other.html !== item.html))) action = 'review'
        }
      }
      if (action === 'review') return this.review(local, remote, file?.etag ?? 'missing', checkpoint ? 'Local and remote settings differ. Choose which complete snapshot to keep.' : 'This device has not synchronized this shared file. Review both snapshots before replacing either one.')
      if (action === 'local') {
        const bundle = this.options.adapter.validate(uploadBundle(local, remote?.bundle ?? checkpoint?.remote))
        const document: RemoteDocument = { format: 'aerio-settings-sync-document', version: 1, revision: randomUUID(), deviceName: this.state.deviceName, updatedAt: new Date().toISOString(), bundle }
        const encrypted = await encryptSyncData(document, secrets.passphrase); this.assertReady()
        const current = this.options.adapter.validate(await this.options.adapter.capture()); this.assertReady()
        if (syncDigest(current) !== localHash) return this.review(current, remote, file?.etag ?? 'missing', 'Local settings changed before upload. Review the latest versions before continuing.')
        await client.put(encrypted, file?.etag); this.assertReady()
        await this.saveCheckpoint(local, bundle, secrets.passphrase, document)
      } else if (action === 'remote' && remote) {
        const journal = await encryptSyncData(local, secrets.passphrase); this.assertReady()
        const current = this.options.adapter.validate(await this.options.adapter.capture()); this.assertReady()
        if (syncDigest(current) !== localHash) return this.review(current, remote, file!.etag, 'Local settings changed before import. Review the latest versions before continuing.')
        this.atomic(recovery, journal)
        try {
          const applied = await this.options.adapter.apply(remote.bundle, this.guard, local)
          this.assertReady()
          await this.saveCheckpoint(applied, remote.bundle, secrets.passphrase, remote)
          unlinkSync(recovery)
        } catch (error) {
          if (this.closed || this.options.locked()) throw error
          const newest = this.options.adapter.validate(await this.options.adapter.capture()); this.assertReady()
          if (syncDigest(newest) === localHash) unlinkSync(recovery)
          if (error instanceof Error && error.message.includes('Local synchronized settings changed')) return this.review(newest, remote, file!.etag, 'Local settings changed during import. Newer edits were preserved; review before continuing.')
          throw error
        }
      } else if (remote) await this.saveCheckpoint(local, remote.bundle, secrets.passphrase, remote)
      this.assertReady()
      if (existsSync(recovery)) unlinkSync(recovery)
      this.state = { ...this.state, phase: 'idle', lastSyncedAt: new Date().toISOString(), review: undefined, message: action === 'remote' ? 'Shared settings applied to this device.' : action === 'local' ? 'Local settings synchronized to WebDAV.' : 'Settings are up to date.' }; this.persist()
      return this.result()
    } catch (error) { if (!this.closed) { this.state = { ...this.state, phase: 'error', message: error instanceof Error ? error.message : 'Settings synchronization failed.' }; this.persist() } throw error }
    finally { this.busy = false; this.abort = undefined }
  }
}
