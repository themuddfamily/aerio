import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { MailLabel } from '../../src/mail-types'
import type { MailArchiveItem, MailArchiveJob, MailArchivePolicyInput, MailArchivePreview, MailArchiveStatus } from '../../src/mail-archive-types'
import { isFinishedMailArchiveJob, mailArchiveDeleteUnavailable, mailArchiveSupported, validateMailArchivePolicy } from '../../src/lib/mail-archive'
import { isSystemMailFolder } from '../../src/lib/mail-folders'
import type { MailDatabase } from './database'
import { importMetadata, importThreadId, sha256 } from './import-headers'
import type { ImportedMessageInput } from './mail-import'
import type { StoredArchiveItem } from './mail-archive-store'

/** Space kept free on the mail disk beyond the message being written. */
export const MAIL_ARCHIVE_DISK_RESERVE_BYTES = 64 * 1024 * 1024
/** Verified copies are handed to the server-removal queue in groups of this size. */
const REMOVAL_BATCH = 50
const PREVIEW_SAMPLE = 50

export interface MailArchiveDeps {
  database: MailDatabase
  store(accountId: string, message: ImportedMessageInput): Promise<unknown>
  /** Free bytes on the disk holding the mail store. */
  freeBytes(): number
  readRaw?(path: string): Buffer
  emit?(job: MailArchiveJob): void
  changed?(accountId: string, threadIds?: string[]): void
  /** Called after a removal operation is queued so the provider queue runs promptly. */
  operationQueued?(operation: { id: string; accountId: string; threadIds: string[] }): void
  now?(): Date
}

export class ArchiveDiskError extends Error {
  constructor(message: string) { super(message); this.name = 'ArchiveDiskError' }
}

const DISK_CODES = new Set(['ENOSPC', 'EDQUOT', 'EFBIG'])
const diskMessage = 'There is not enough free disk space to save archived mail. The job is paused and no server copies were removed. Free some space, then choose Resume.'
const isDiskError = (error: unknown) => error instanceof ArchiveDiskError
  || DISK_CODES.has(String((error as NodeJS.ErrnoException | undefined)?.code ?? ''))
  // SQLite reports SQLITE_FULL this way when the mail database cannot grow.
  || (error instanceof Error && /database or disk is full/i.test(error.message))

/** Deterministic Local Folders id, so a resumed copy finds the one it already wrote. */
export function archiveLocalMessageId(accountId: string, messageId: string, destinationLabelId: string, hash: string) {
  return createHash('sha256').update(`archive:${accountId}:${messageId}:${destinationLabelId}:${hash}`).digest('hex').slice(0, 32)
}

/**
 * Runs automatic-archive policies (E31). Each run copies eligible messages
 * byte for byte into Local Folders, verifies each copy by re-reading it
 * (size and SHA-256 of the raw MIME plus the attachment count), and only then
 * queues a message-level server removal through the provider operation queue.
 * All progress is durable, so a run interrupted by a crash, a quit or a full
 * disk resumes without copying anything twice.
 */
export class MailArchiveService {
  private readonly pumping = new Map<string, Promise<void>>()
  private halted = false

  constructor(private readonly deps: MailArchiveDeps) {}

  private get db() { return this.deps.database }
  private get store() { return this.deps.database.archive }
  private now() { return this.deps.now?.() ?? new Date() }
  private read(path: string) { return (this.deps.readRaw ?? ((value: string) => readFileSync(value)))(path) }

  private emit(job: MailArchiveJob | undefined) {
    if (job) this.deps.emit?.(job)
    return job
  }

  private account(accountId: string) {
    const account = this.db.getAccount(accountId)
    if (!account) throw new Error('Account not found')
    if (!mailArchiveSupported(account.provider, account.archived)) throw new Error(account.provider === 'local' ? 'Local Folders are already stored on this computer' : 'Reconnect this account before archiving its mail')
    return account
  }

  private validate(input: MailArchivePolicyInput) {
    const account = this.account(input.accountId)
    return validateMailArchivePolicy(input, account.provider)
  }

  private destination(labelId: string) {
    const local = this.db.localMail.account()
    if (!local) throw new Error('Create Local Folders before archiving mail into them')
    const labels = this.db.listLabels([local.id])
    const label = labels.find((item) => item.id === labelId)
    if (!label || isSystemMailFolder(label)) throw new Error('The archive destination folder no longer exists in Local Folders. Choose another folder.')
    return { local, label, labels }
  }

  status(accountId: string): MailArchiveStatus {
    const account = this.db.getAccount(accountId)
    if (!account) throw new Error('Account not found')
    const policy = this.store.policy(accountId)
    const deleteUnavailable = mailArchiveDeleteUnavailable(account.provider)
    return { accountId, ...(policy ? { policy } : {}), jobs: this.store.jobs(accountId), ...(deleteUnavailable ? { deleteUnavailable } : {}) }
  }

  savePolicy(input: MailArchivePolicyInput) {
    const policy = this.validate(input)
    if (policy.enabled) this.destination(policy.destinationLabelId)
    this.store.savePolicy(policy, this.now())
    return this.status(policy.accountId)
  }

  preview(input: MailArchivePolicyInput): MailArchivePreview {
    const policy = this.validate(input)
    const selection = this.store.select(policy, this.now())
    const local = this.db.localMail.account()
    const base = local && policy.destinationLabelId ? this.db.listLabels([local.id]).find((label) => label.id === policy.destinationLabelId) : undefined
    const baseName = base ? `Local Folders/${base.name}` : 'Local Folders/(choose a folder)'
    return {
      accountId: policy.accountId,
      cutoff: selection.cutoff.toISOString(),
      count: selection.eligible.length,
      bytes: selection.eligible.reduce((sum, item) => sum + item.size, 0),
      sample: selection.eligible.slice(0, PREVIEW_SAMPLE).map((item) => ({
        messageId: item.messageId,
        threadId: item.threadId,
        subject: item.subject,
        from: item.from,
        receivedAt: item.receivedAt,
        size: item.size,
        folder: item.folder,
        destination: [baseName, ...item.segments].join('/')
      })),
      excluded: selection.excluded
    }
  }

  /** Starts a run now, whether or not the policy is enabled; resumes the account's unfinished run instead of starting another. */
  runNow(accountId: string) {
    const active = this.store.activeJob(accountId)
    if (active) return active.status === 'paused' ? this.resume(active.id) : active
    const policy = this.store.policy(accountId)
    if (!policy) throw new Error('Save an archive policy for this account first')
    return this.start(policy, 'manual')
  }

  private start(stored: MailArchivePolicyInput, trigger: MailArchiveJob['trigger']) {
    const policy = this.validate(stored)
    this.destination(policy.destinationLabelId)
    const now = this.now()
    const selection = this.store.select(policy, now)
    this.store.recordRunStart(policy.accountId, policy.frequency, now)
    const job = this.store.createJob({ accountId: policy.accountId, trigger, policy, candidates: selection.eligible, cutoff: selection.cutoff, now })
    this.store.pruneHistory(policy.accountId)
    this.emit(job)
    void this.pump(job.id)
    return job
  }

  resume(jobId: string) {
    const job = this.store.job(jobId)
    if (!job) throw new Error('Archive run not found')
    if (job.status !== 'paused') return job
    const resumed = this.emit(this.store.setJobStatus(jobId, 'running'))!
    void this.pump(jobId)
    return resumed
  }

  cancel(jobId: string) {
    const job = this.store.job(jobId)
    if (!job) throw new Error('Archive run not found')
    if (isFinishedMailArchiveJob(job)) return job
    // Removals already queued finish normally; everything else keeps its server copy.
    this.store.settleUnqueued(jobId, 'The archive run was cancelled before this message was removed from the server. The server copy was kept.')
    return this.emit(this.store.setJobStatus(jobId, 'cancelled'))!
  }

  items(jobId: string): MailArchiveItem[] {
    return this.store.items(jobId).map(({ segments: _segments, sha256: _sha, localMessageId: _local, operationId: _operation, ...item }) => item)
  }

  /**
   * Scheduler pass: resumes runs that were interrupted by a restart, starts
   * due policies (including runs missed while Aerio was closed, which happen
   * once on the next pass), and settles finished server removals. Paused runs
   * retry when their policy is next due.
   */
  tick() {
    if (this.halted) return
    this.reconcile()
    for (const jobId of this.store.runningJobIds()) void this.pump(jobId)
    for (const policy of this.store.duePolicies(this.now())) {
      const active = this.store.activeJob(policy.accountId)
      try {
        if (active?.status === 'paused') {
          this.store.recordRunStart(policy.accountId, policy.frequency, this.now())
          this.resume(active.id)
        } else if (!active) this.start(policy, 'schedule')
      } catch (error) {
        // A broken policy (missing destination, disconnected account) waits for the next period.
        this.store.recordRunStart(policy.accountId, policy.frequency, this.now())
        this.store.recordRunOutcome(policy.accountId, 'failed', error instanceof Error ? error.message : String(error))
      }
    }
  }

  halt() {
    this.halted = true
  }

  /** Settles removal-queued items from their operation's outcome. */
  reconcile() {
    const { changed, deleted } = this.store.reconcileRemovals()
    const accounts = new Set<string>()
    for (const { accountId, messageId } of deleted) {
      // The server copy is gone for good; drop the cached copy too.
      this.db.deleteMessage(accountId, messageId)
      accounts.add(accountId)
    }
    for (const jobId of changed) {
      const job = this.store.completeIfSettled(jobId) ?? this.store.job(jobId)
      this.emit(job)
    }
    for (const accountId of accounts) this.deps.changed?.(accountId)
  }

  /** Copies a running job's pending messages; concurrent calls share the pass already in progress. */
  pump(jobId: string): Promise<void> {
    if (this.halted) return Promise.resolve()
    const existing = this.pumping.get(jobId)
    if (existing) return existing
    const current = this.copyPending(jobId).catch((error) => {
      // After shutdown the database is closed under an in-flight copy; the run resumes on the next start.
      if (this.halted) return
      try {
        this.emit(this.store.setJobStatus(jobId, 'paused', `Archiving stopped: ${error instanceof Error ? error.message : String(error)}. No server copies were removed for unfinished messages. Choose Resume to retry.`))
      } catch { /* The database is unavailable; the job stays running and resumes on the next start. */ }
    }).finally(() => this.pumping.delete(jobId))
    this.pumping.set(jobId, current)
    return current
  }

  private async copyPending(jobId: string) {
    const job = this.store.job(jobId)
    const policy = this.store.jobPolicy(jobId)
    if (!job || !policy || job.status !== 'running') return
    let destination: ReturnType<MailArchiveService['destination']>
    try {
      destination = this.destination(policy.destinationLabelId)
    } catch (error) {
      this.store.settleUnqueued(jobId, 'The archive destination folder is missing. The server copy was kept.')
      this.emit(this.store.setJobStatus(jobId, 'failed', error instanceof Error ? error.message : String(error)))
      return
    }
    // Copies left verified but not yet queued (a crash between the two steps) go first.
    this.queueCopied(jobId, job.accountId, job.removal)
    const folders = new Map<string, string>()
    let lastEmit = 0
    for (;;) {
      const batch = this.store.items(jobId, ['pending'], REMOVAL_BATCH)
      if (!batch.length) break
      for (const item of batch) {
        if (this.halted || this.store.job(jobId)?.status !== 'running') return
        const reason = this.store.stillEligible(policy, item.messageId, job.cutoff)
        if (reason) {
          this.store.setItemState(jobId, item.messageId, 'skipped', reason)
          continue
        }
        try {
          await this.copy(item, job.accountId, destination.local.id, this.folderFor(destination.local.id, destination.label, item.segments, folders))
        } catch (error) {
          if (this.halted) return
          if (isDiskError(error)) {
            this.emit(this.store.setJobStatus(jobId, 'paused', diskMessage))
            return
          }
          this.store.setItemState(jobId, item.messageId, 'failed', `${error instanceof Error ? error.message : String(error)}. The server copy was kept.`)
        }
        if (Date.now() - lastEmit > 1_000) {
          lastEmit = Date.now()
          this.emit(this.store.job(jobId))
        }
      }
      this.queueCopied(jobId, job.accountId, job.removal)
    }
    this.deps.changed?.(destination.local.id)
    this.reconcile()
    this.emit(this.store.completeIfSettled(jobId) ?? this.store.job(jobId))
  }

  private folderFor(localId: string, base: MailLabel, segments: string[], cache: Map<string, string>) {
    if (!segments.length) return base.id
    const key = JSON.stringify(segments)
    let id = cache.get(key)
    if (!id) {
      id = this.db.localMail.ensureFolderPath(localId, base.id, segments)
      cache.set(key, id)
    }
    return id
  }

  private queueCopied(jobId: string, accountId: string, removal: MailArchiveJob['removal']) {
    for (;;) {
      const copied = this.store.items(jobId, ['copied'], REMOVAL_BATCH)
      if (!copied.length) return
      const operation = this.store.queueRemoval(jobId, accountId, removal, copied)
      if (operation) {
        this.deps.operationQueued?.(operation)
        this.deps.changed?.(accountId, operation.threadIds)
      }
    }
  }

  /** Copies one message (or adopts an earlier identical copy) and verifies it before marking it copied. */
  private async copy(item: StoredArchiveItem, accountId: string, localId: string, destinationLabelId: string) {
    const sourcePath = this.db.getMessageRaw(accountId, item.messageId)
    if (!sourcePath || !this.db.rawExists(sourcePath)) throw new Error('The original message is not stored offline')
    const raw = this.read(sourcePath)
    const hash = sha256(raw)
    const free = this.deps.freeBytes()
    let localMessageId = archiveLocalMessageId(accountId, item.messageId, destinationLabelId, hash)
    // Same account+message identity and content: a copy this or an earlier run already wrote.
    let existing = this.db.hasMessage(localId, localMessageId)
    if (!existing) {
      // An identical message (same Message-ID and SHA-256) already in the destination counts as archived.
      const metadata = importMetadata(raw)
      const twin = this.db.localMail.messagesWithHash(localId, hash).find((candidate) => candidate.labelIds.includes(destinationLabelId))
      if (twin) {
        localMessageId = twin.messageId
        existing = true
      } else {
        if (free < raw.length + MAIL_ARCHIVE_DISK_RESERVE_BYTES) throw new ArchiveDiskError(diskMessage)
        const labels = this.db.remoteMessagesForThreads(accountId, [item.threadId]).find((message) => message.id === item.messageId)?.labelIds ?? []
        await this.deps.store(localId, {
          id: localMessageId,
          threadId: importThreadId(metadata.threadRoot ?? `local:${localMessageId}`),
          historyId: `archive:${accountId}`,
          raw,
          labelIds: [destinationLabelId, ...labels.filter((label) => label === 'UNREAD' || label === 'STARRED')],
          internalDate: this.db.localMail.internalDate(accountId, item.messageId) ?? metadata.date,
          sizeEstimate: raw.length
        })
        this.db.localMail.addFingerprint(localId, localMessageId, hash, metadata.messageId)
      }
    }
    this.verify(raw, hash, accountId, item.messageId, localId, localMessageId, !existing)
    this.store.markCopied(item.jobId, item.messageId, { sha256: hash, destinationLabelId, localMessageId })
  }

  private verify(raw: Buffer, hash: string, accountId: string, messageId: string, localId: string, localMessageId: string, discardOnFailure: boolean) {
    const fail = (reason: string) => {
      if (discardOnFailure) this.db.deleteMessage(localId, localMessageId)
      throw new Error(`The Local Folders copy could not be verified (${reason})`)
    }
    const path = this.db.getMessageRaw(localId, localMessageId)
    if (!path) return fail('the copy was not recorded')
    let copy: Buffer
    try {
      copy = this.read(path)
    } catch (error) {
      if (isDiskError(error)) throw error
      return fail('the copy could not be read back')
    }
    if (copy.length !== raw.length) return fail(`size ${copy.length} instead of ${raw.length} bytes`)
    if (sha256(copy) !== hash) return fail('the SHA-256 checksum differs')
    const expected = this.store.attachmentCount(accountId, messageId)
    const actual = this.store.attachmentCount(localId, localMessageId)
    if (actual < expected) return fail(`${actual} of ${expected} attachments`)
  }
}
