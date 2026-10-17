import { closeSync, fsyncSync, openSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { SyncProgress } from '../../src/mail-types'
import type { Pop3AccountSettings, Pop3AccountStatus, Pop3ConnectionConfig, Pop3Destination } from '../../src/pop3-types'
import { DEFAULT_POP3_RETENTION } from '../../src/pop3-types'
import { isSystemMailFolder } from '../../src/lib/mail-folders'
import type { MailDatabase, ParsedMailMessage } from './database'
import { importMetadata, importThreadId, sha256 } from './import-headers'
import { Pop3Error, Pop3Session, type Pop3ClientOptions } from './pop3-client'
import { pop3ClientOptions } from './pop3-settings'
import type { Pop3StoredSettings } from './pop3-store'

// The POP3 download model. Each session lists the maildrop by UIDL, downloads
// every message whose UIDL has no checkpoint row, and stores the message and
// its checkpoint row in one database transaction. A crash or dropped
// connection therefore loses at most the message in flight, which is
// downloaded again next time; nothing is stored twice. Messages are removed
// from the server only by the retention policy, only after their checkpoint
// is committed and flushed to disk, and only when the server confirms QUIT.

export const POP3_MAX_MESSAGE_BYTES = 64 * 1024 * 1024

export interface Pop3StoreInput {
  id: string
  threadId: string
  historyId: string
  raw: Buffer
  labelIds: string[]
  internalDate?: string
  sizeEstimate?: number
}

export interface Pop3ServiceDeps {
  database: MailDatabase
  credential(accountId: string): Promise<Pop3ConnectionConfig>
  /** Parses and stores a message; `commit` runs inside the transaction that stores it. */
  store(accountId: string, message: Pop3StoreInput, commit: (record: ParsedMailMessage) => void): Promise<{ record: ParsedMailMessage; isNew: boolean }>
  assertCanSync(accountId: string): Promise<void>
  emitProgress(progress: SyncProgress): void
  changed(accountId: string): void
  /** Test hook: trust a disposable certificate or shorten timeouts. */
  clientOptions?: Pick<Pop3ClientOptions, 'tls' | 'timeoutMs'>
  maxMessageBytes?: number
  now?(): number
}

export type Pop3WorkerCommand =
  | { action: 'settings:get'; accountId: string }
  | { action: 'settings:save'; accountId: string; settings: Pop3StoredSettings }
  | { action: 'status'; accountId: string }

export interface Pop3SyncResult {
  newMessages: ParsedMailMessage[]
  downloaded: number
  removed: number
  skipped: number
  failed: number
  /** Accounts whose mail changed (the POP3 account and, for that destination, Local Folders). */
  changedAccounts: string[]
}

/** Stable per account and UIDL, so a message downloaded twice maps to the same stored message. */
export const pop3MessageId = (accountId: string, uidl: string) => createHash('sha256').update(`pop3:${accountId}\0${uidl}`).digest('hex').slice(0, 32)

function fsyncFile(path: string) {
  const descriptor = openSync(path, 'r+')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

export class Pop3Service {
  constructor(private readonly deps: Pop3ServiceDeps) {}

  private get database() {
    return this.deps.database
  }

  private settingsFor(accountId: string): Pop3StoredSettings {
    const settings = this.database.pop3.settings(accountId)
    if (!settings) throw new Error('This POP3 account has no saved settings. Open its account settings and save them again.')
    return settings
  }

  /** The account and labels that receive downloaded mail. */
  private target(accountId: string, destination: Pop3Destination) {
    if (destination.kind === 'account') return { accountId, labels: ['INBOX', 'UNREAD'] }
    const local = this.database.localMail.account()
    const folder = local ? this.database.listLabels([local.id]).find((label) => label.id === destination.labelId) : undefined
    if (!local || !folder || isSystemMailFolder(folder)) throw new Error('The Local Folders folder chosen for downloaded mail no longer exists. Choose another destination in the account settings; nothing was downloaded.')
    return { accountId: local.id, labels: [folder.id, 'UNREAD'] }
  }

  async open(accountId: string) {
    return Pop3Session.open(pop3ClientOptions(await this.deps.credential(accountId), this.deps.clientOptions))
  }

  async verify(accountId: string) {
    const session = await this.open(accountId)
    try {
      await session.stat()
      await session.quit()
    } finally {
      session.close()
    }
  }

  private progress(accountId: string, phase: SyncProgress['phase'], message: string, completed: number, total: number, transferredBytes: number) {
    const value: SyncProgress = { accountId, phase, completed, total, transferredBytes, message, updatedAt: new Date().toISOString() }
    this.database.updateSyncProgress(value)
    this.deps.emitProgress(value)
  }

  async sync(accountId: string): Promise<Pop3SyncResult> {
    const settings = this.settingsFor(accountId)
    const target = this.target(accountId, settings.destination)
    const store = this.database.pop3
    const maxBytes = this.deps.maxMessageBytes ?? POP3_MAX_MESSAGE_BYTES
    const result: Pop3SyncResult = { newMessages: [], downloaded: 0, removed: 0, skipped: 0, failed: 0, changedAccounts: [...new Set([accountId, target.accountId])] }
    this.progress(accountId, 'inventory', 'Connecting to the POP3 server', 0, 0, 0)
    let session: Pop3Session | undefined
    try {
      session = await this.open(accountId)
      const uidls = await session.uidl()
      const sizes = await session.list()
      store.markSeen(accountId, new Set(uidls.values()))
      const known = store.rows(accountId)
      const pending = [...uidls].sort(([left], [right]) => left - right).filter(([, uidl]) => !known.has(uidl))
      let transferred = 0
      let lastError: string | undefined
      this.progress(accountId, 'downloading', pending.length ? `Downloading ${pending.length.toLocaleString()} new message${pending.length === 1 ? '' : 's'}` : 'Checking for new mail', 0, pending.length, 0)
      for (const [index, [number, uidl]] of pending.entries()) {
        await this.deps.assertCanSync(accountId)
        const size = sizes.get(number) ?? 0
        if (size > maxBytes) {
          store.recordSkipped(accountId, uidl, size, `Larger than ${Math.round(maxBytes / (1024 * 1024))} MB; left on the server`)
          result.skipped += 1
          continue
        }
        const messageId = pop3MessageId(accountId, uidl)
        let raw: Buffer
        try {
          raw = await session.retr(number, maxBytes)
        } catch (error) {
          if (error instanceof Pop3Error && error.kind === 'too-large') {
            store.recordSkipped(accountId, uidl, size, error.message)
            result.skipped += 1
            continue
          }
          // -ERR for one message: try the others; it is retried next session.
          if (error instanceof Pop3Error && error.kind === 'command') {
            result.failed += 1
            lastError = `A message could not be downloaded and will be retried: ${error.message}`
            continue
          }
          throw error
        }
        const metadata = importMetadata(raw)
        const hash = sha256(raw)
        const stored = await this.deps.store(target.accountId, {
          id: messageId,
          threadId: importThreadId(metadata.threadRoot ?? `pop3:${messageId}`),
          historyId: `pop3:${uidl}`,
          raw,
          labelIds: target.labels,
          internalDate: metadata.date,
          sizeEstimate: raw.length
        }, (record) => {
          // The message file reaches the disk before its checkpoint is committed.
          fsyncFile(record.rawPath)
          store.recordStored(accountId, uidl, { messageAccountId: target.accountId, messageId, size: raw.length })
          if (target.accountId !== accountId) this.database.localMail.addFingerprint(target.accountId, messageId, hash, metadata.messageId)
        })
        if (stored.isNew) result.newMessages.push(stored.record)
        result.downloaded += 1
        transferred += raw.length
        this.progress(accountId, 'downloading', `Downloaded ${(index + 1).toLocaleString()} of ${pending.length.toLocaleString()} new messages`, index + 1, pending.length, transferred)
        if (result.downloaded % 20 === 0) for (const id of result.changedAccounts) this.deps.changed(id)
      }
      result.removed = await this.applyRetention(accountId, settings, session, uidls)
      if (session.isOpen) await session.quit().catch(() => false)
      store.recordCheck(accountId, lastError)
      const notes = [
        result.downloaded ? `${result.downloaded.toLocaleString()} downloaded` : '',
        result.removed ? `${result.removed.toLocaleString()} removed from the server` : '',
        result.skipped ? `${result.skipped.toLocaleString()} too large to download` : '',
        result.failed ? `${result.failed.toLocaleString()} will be retried` : ''
      ].filter(Boolean)
      this.progress(accountId, 'complete', notes.length ? `Up to date · ${notes.join(' · ')}` : 'Up to date', pending.length, pending.length, transferred)
      return result
    } catch (error) {
      store.recordCheck(accountId, error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      session?.close()
    }
  }

  /**
   * Removes messages from the server as the retention policy says. The
   * removals are recorded and flushed to disk first; DELE only takes effect
   * when the server confirms QUIT, and only then are they marked removed.
   * Returns the number of messages the server removed.
   */
  private async applyRetention(accountId: string, settings: Pop3StoredSettings, session: Pop3Session, uidls: Map<number, string>) {
    const store = this.database.pop3
    const candidates = store.removalCandidates(accountId, settings.retention ?? DEFAULT_POP3_RETENTION, this.deps.now?.() ?? Date.now())
    store.markRemovalPending(accountId, candidates)
    if (!candidates.length) return 0
    if (!store.flushToDisk()) return 0
    const numbers = new Map([...uidls].map(([number, uidl]) => [uidl, number]))
    const marked: string[] = []
    for (const candidate of candidates) {
      const number = numbers.get(candidate.uidl)
      if (number === undefined) continue
      try {
        await session.dele(number)
        marked.push(candidate.uidl)
      } catch (error) {
        if (!(error instanceof Pop3Error) || error.kind !== 'command') throw error
      }
    }
    if (!marked.length) return 0
    // Without a confirmed QUIT the server rolls the DELEs back; they stay pending and are retried.
    if (!await session.quit().catch(() => false)) return 0
    store.markRemoved(accountId, marked)
    return marked.length
  }

  /** Keeps a copy of a message sent through SMTP in the account's local Sent folder. */
  async recordSent(accountId: string, raw: Buffer) {
    const metadata = importMetadata(raw)
    const id = `sent-${createHash('sha256').update(raw).digest('hex').slice(0, 27)}`
    if (this.database.hasMessage(accountId, id)) return
    await this.deps.store(accountId, {
      id,
      threadId: importThreadId(metadata.threadRoot ?? `pop3:${id}`),
      historyId: 'pop3:sent',
      raw,
      labelIds: ['SENT'],
      internalDate: metadata.date ?? new Date().toISOString(),
      sizeEstimate: raw.length
    }, () => undefined)
  }

  settings(accountId: string, passwordConfigured: boolean): Pop3AccountSettings {
    const settings = this.settingsFor(accountId)
    return { ...settings.server, retention: settings.retention, destination: settings.destination, passwordConfigured }
  }

  saveSettings(accountId: string, settings: Pop3StoredSettings) {
    const account = this.database.getAccount(accountId)
    if (!account || account.provider !== 'pop3') throw new Error('POP3 account not found')
    // Validates a Local Folders destination before it is saved.
    this.target(accountId, settings.destination)
    this.database.pop3.saveSettings(accountId, settings)
  }

  status(accountId: string): Pop3AccountStatus {
    return this.database.pop3.status(accountId)
  }

  command(command: Pop3WorkerCommand) {
    if (command.action === 'settings:get') {
      const settings = this.settingsFor(command.accountId)
      return { server: settings.server, retention: settings.retention, destination: settings.destination }
    }
    if (command.action === 'settings:save') {
      this.saveSettings(command.accountId, command.settings)
      return this.database.pop3.settings(command.accountId)
    }
    return this.status(command.accountId)
  }
}
