import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import type { MailImportItem, MailImportJob, MailImportStartInput } from '../../src/mail-types'
import { mailImportExtension, mailImportSourceKind, unsupportedMailImportReason } from '../../src/lib/local-folders'
import type { MailDatabase } from './database'
import { importMetadata, importThreadId, sha256, type ImportFlags } from './import-headers'
import type { MailImportCursor, MailImportPlanEntry, StoredImportJob } from './local-mail-store'
import { mboxSeparatorDate, readMbox, readMboxRange } from './mbox'
import { PstArchive } from './pst'
import { looksLikePst } from './pst-header'
import { PstMessageTooLargeError, pstMessageToMime } from './pst-mime'

export const MAIL_IMPORT_LIMITS = {
  /** Largest single message accepted; bigger ones are reported as failed. */
  maxMessageBytes: 64 * 1024 * 1024,
  /** Most files one import job may contain. */
  maxEntries: 50_000,
  maxDepth: 24,
  /** Imports pause before the disk holding the mail store is this full. */
  minFreeBytes: 512 * 1024 * 1024
}

export interface ImportedMessageInput {
  id: string
  threadId: string
  historyId: string
  raw: Buffer
  labelIds: string[]
  internalDate?: string
  sizeEstimate: number
}

export interface MailImportDeps {
  database: MailDatabase
  /** Parses and stores one raw message (the worker's normal message store path). */
  store(accountId: string, message: ImportedMessageInput): Promise<unknown>
  freeBytes(): number
  emit(job: MailImportJob): void
  /** Folders or messages in Local Folders changed. */
  changed(accountId: string, final?: boolean): void
  limits?: Partial<typeof MAIL_IMPORT_LIMITS>
}

export interface MailImportPlan {
  label: string
  entries: MailImportPlanEntry[]
  unsupported: { path: string; reason: string }[]
}

const startsWithFromLine = (path: string) => {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, 'r')
    const buffer = Buffer.alloc(5)
    return readSync(descriptor, buffer, 0, 5, 0) === 5 && buffer.toString('latin1') === 'From '
  } catch {
    return false
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

const stripMailboxSuffix = (name: string) => name.replace(/\.(mbox|mbx|sbd)$/i, '') || name
// Thunderbird index files and similar mailbox metadata never hold messages.
const IGNORED_FILES = /^(\..*|.*\.(msf|dat|json|plist|toc|db|sqlite|log|html?)|table_of_contents|info\.plist|msgfilterrules\.dat)$/i

/**
 * Turns the chosen files and folders into an ordered list of sources, each
 * mapped to the Local Folders path it is imported into. Folder structure is
 * kept: directories become folders, mbox and Outlook data files become
 * folders named after the file, Thunderbird `.sbd` and Apple Mail `.mbox`
 * directories nest their children under the matching mailbox, and EML files
 * land in the folder for the directory that contains them.
 */
export function planMailImport(paths: string[], limits = MAIL_IMPORT_LIMITS): MailImportPlan {
  const entries: MailImportPlanEntry[] = []
  const unsupported: MailImportPlan['unsupported'] = []
  const add = (entry: MailImportPlanEntry) => {
    if (entries.length >= limits.maxEntries) throw new Error(`An import can contain at most ${limits.maxEntries.toLocaleString('en-US')} files. Import the folders in smaller groups.`)
    entries.push(entry)
  }
  const visitFile = (path: string, size: number, folder: string[], explicit: boolean) => {
    const reason = unsupportedMailImportReason(path)
    if (reason) {
      unsupported.push({ path, reason })
      return
    }
    const name = basename(path)
    const extension = mailImportExtension(path)
    const kind = mailImportSourceKind(path)
    if (kind === 'eml') return add({ kind: 'eml', path, folder: folder.length ? folder : ['Imported messages'], size })
    // An Outlook data file becomes a folder named after the file, holding
    // the folder tree from inside the file. Unreadable files are reported
    // when the job reaches them, like a damaged mbox.
    if (kind === 'pst' || (explicit && !extension && looksLikePst(path))) return add({ kind: 'pst', path, folder: [...folder, name.replace(/\.(pst|ost)$/i, '') || name], size })
    if (!explicit) {
      if (IGNORED_FILES.test(name)) return
      if (extension !== 'mbox' && extension !== 'mbx' && !startsWithFromLine(path)) return
    }
    // Apple Mail exports keep the messages in a file called "mbox" inside a
    // "Name.mbox" directory; the directory already supplies the folder name.
    if (name === 'mbox' && folder.length) return add({ kind: 'mbox', path, folder, size })
    add({ kind: 'mbox', path, folder: [...folder, stripMailboxSuffix(name)], size })
  }
  const visitDirectory = (path: string, folder: string[], depth: number) => {
    if (depth > limits.maxDepth) throw new Error('The chosen folder is nested too deeply to import')
    const children = readdirSync(path, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
    for (const child of children) {
      const childPath = join(path, child.name)
      if (child.isDirectory()) {
        if (child.name.startsWith('.')) continue
        visitDirectory(childPath, [...folder, stripMailboxSuffix(child.name)], depth + 1)
      } else if (child.isFile()) {
        visitFile(childPath, statSync(childPath).size, folder, false)
      }
    }
  }
  for (const path of paths) {
    const stats = statSync(path)
    if (stats.isDirectory()) visitDirectory(path, [stripMailboxSuffix(basename(path))], 0)
    else if (stats.isFile()) visitFile(path, stats.size, [], true)
  }
  const label = paths.length === 1 ? basename(paths[0]) : `${paths.length.toLocaleString('en-US')} items`
  return { label, entries, unsupported }
}

const messageIdFor = (jobId: string, key: string) => createHash('sha256').update(`import:${jobId}:${key}`).digest('hex').slice(0, 32)
const flagLabels = (flags: { read?: boolean; flagged?: boolean }) => [
  // Archives usually carry no read state; treat unknown as read so an import
  // does not flood unread counts. An explicit unread flag is kept.
  ...(flags.read === false ? ['UNREAD'] : []),
  ...(flags.flagged ? ['STARRED'] : [])
]

class ImportStop extends Error {
  constructor(readonly reason: 'pause' | 'cancel' | 'disk') {
    super(reason)
  }
}

export const publicImportJob = ({ plan: _plan, options: _options, cursor: _cursor, ...job }: StoredImportJob): MailImportJob => job

/**
 * Runs Local Folders import jobs one at a time inside the mail worker. Every
 * message's outcome is written together with the job cursor, so pausing,
 * cancelling or a crash never loses or duplicates work: a resumed job starts
 * at the next unprocessed mbox message or EML file, and message ids are
 * derived from the job and source position so a replayed message overwrites
 * itself instead of creating a copy.
 */
export class MailImportService {
  private running?: { id: string; stop?: ImportStop['reason']; abort: AbortController }
  private pumping?: Promise<void>
  private readonly limits: typeof MAIL_IMPORT_LIMITS
  private lastEmit = 0

  constructor(private readonly deps: MailImportDeps) {
    this.limits = { ...MAIL_IMPORT_LIMITS, ...deps.limits }
  }

  private get store() {
    return this.deps.database.localMail
  }

  private job(id: string) {
    const job = this.store.getJob(id)
    if (!job) throw new Error('This import no longer exists')
    return job
  }

  private publish(job: StoredImportJob, force = false) {
    const now = Date.now()
    if (!force && now - this.lastEmit < 250) return
    this.lastEmit = now
    this.deps.emit(publicImportJob(job))
  }

  list() {
    return this.store.listJobs().map(publicImportJob)
  }

  items(jobId: string): MailImportItem[] {
    this.job(jobId)
    return this.store.listItems(jobId).map(({ sourceKind: _kind, contentOffset: _offset, storedBytes: _bytes, labelIds: _labels, sha256: _hash, ...item }) => item)
  }

  start(input: MailImportStartInput) {
    const account = this.store.ensureAccount()
    if (input.parentLabelId && !this.deps.database.listLabels([account.id]).some((label) => label.id === input.parentLabelId)) throw new Error('The destination folder no longer exists')
    const plan = planMailImport(input.paths, this.limits)
    if (!plan.entries.length) {
      throw new Error(plan.unsupported[0]?.reason ?? 'No MBOX, EML or Outlook data files were found in the chosen items')
    }
    const job = this.store.createJob({
      accountId: account.id,
      label: plan.label,
      plan: plan.entries,
      options: { parentLabelId: input.parentLabelId, duplicates: input.duplicates, mboxVariant: input.mboxVariant }
    })
    this.publish(job, true)
    void this.pump()
    return publicImportJob(job)
  }

  pause(id: string) {
    const job = this.job(id)
    if (this.running?.id === id) {
      this.running.stop = 'pause'
      this.running.abort.abort()
      return publicImportJob(job)
    }
    if (job.status !== 'queued') return publicImportJob(job)
    const paused = this.store.setJobStatus(id, 'paused')
    this.publish(paused, true)
    return publicImportJob(paused)
  }

  resume(id: string) {
    const job = this.job(id)
    if (!['paused', 'interrupted', 'failed'].includes(job.status)) return publicImportJob(job)
    const queued = this.store.setJobStatus(id, 'queued')
    this.publish(queued, true)
    void this.pump()
    return publicImportJob(queued)
  }

  cancel(id: string) {
    const job = this.job(id)
    if (this.running?.id === id) {
      this.running.stop = 'cancel'
      this.running.abort.abort()
      return publicImportJob(job)
    }
    if (job.status === 'completed' || job.status === 'cancelled') return publicImportJob(job)
    const cancelled = this.store.setJobStatus(id, 'cancelled')
    this.publish(cancelled, true)
    return publicImportJob(cancelled)
  }

  dismiss(id: string) {
    const job = this.job(id)
    if (job.status === 'running' || job.status === 'queued' || this.running?.id === id) throw new Error('Pause or cancel this import before removing it from the list')
    this.store.deleteJob(id)
  }

  /** Asks a running job to stop after its current message (worker shutdown). */
  halt() {
    if (!this.running) return
    this.running.stop = 'pause'
    this.running.abort.abort()
  }

  /** Starts queued jobs; resolves when no job is left to run. */
  pump() {
    this.pumping ??= (async () => {
      try {
        while (true) {
          const next = this.store.nextQueuedJob()
          if (!next) break
          await this.run(next)
        }
      } catch {
        // Only reachable when the database closed underneath a job (shutdown);
        // the job is still marked running and is recovered as interrupted.
      } finally {
        this.pumping = undefined
      }
    })()
    return this.pumping
  }

  private async run(initial: StoredImportJob) {
    const control = { id: initial.id, stop: undefined as ImportStop['reason'] | undefined, abort: new AbortController() }
    this.running = control
    let job = this.store.setJobStatus(initial.id, 'running')
    this.publish(job, true)
    const counts = { imported: job.imported, duplicates: job.duplicates, failed: job.failed, skipped: job.skipped }
    let pendingReview = job.pendingReview
    const folders = new Map<string, string>()
    let cursor: MailImportCursor = { ...job.cursor }
    let messagesSinceCheck = Number.POSITIVE_INFINITY
    const prefixBytes = [0]
    for (const entry of job.plan) prefixBytes.push(prefixBytes.at(-1)! + entry.size)

    // Progress is written for every message, so the published snapshot is
    // built in memory instead of re-reading the (possibly large) plan.
    const save = (next: MailImportCursor, source?: string) => {
      cursor = next
      const processedBytes = Math.min(job.totalBytes, prefixBytes[Math.min(cursor.entry, job.plan.length)] + cursor.offset)
      this.store.saveProgress(job.id, { cursor, processedBytes, currentSource: source, counts })
      this.publish({ ...job, ...counts, pendingReview, cursor, processedBytes, currentSource: source, updatedAt: new Date().toISOString() })
    }
    const checkpoint = async () => {
      if (control.stop) throw new ImportStop(control.stop)
      if (++messagesSinceCheck >= 25) {
        messagesSinceCheck = 0
        if (this.deps.freeBytes() < this.limits.minFreeBytes) throw new ImportStop('disk')
      }
      // Let the worker answer other mail requests between messages.
      await new Promise((resolve) => setImmediate(resolve))
    }
    const folderFor = (segments: string[]) => {
      const key = segments.join('\u0000')
      let labelId = folders.get(key)
      if (!labelId) {
        labelId = this.store.ensureFolderPath(job.accountId, job.options.parentLabelId, segments)
        folders.set(key, labelId)
        this.deps.changed(job.accountId)
      }
      return labelId
    }

    const importOne = async (raw: Buffer, entry: MailImportPlanEntry, key: string, labelId: string, extra: { contentOffset?: number; storedBytes?: number; fallbackDate?: string; flags?: ImportFlags }) => {
      const metadata = importMetadata(raw)
      const base = { key, sourcePath: entry.path, sourceKind: entry.kind, contentOffset: extra.contentOffset, storedBytes: extra.storedBytes, subject: metadata.subject, from: metadata.from, date: metadata.date ?? extra.fallbackDate, size: raw.length, messageIdHeader: metadata.messageId }
      // Outlook items carry their read/flag state as MAPI properties, not headers.
      const flags = extra.flags ?? metadata.flags
      if (flags.deleted) {
        counts.skipped += 1
        return
      }
      const id = messageIdFor(job.id, key)
      const labelIds = [labelId, ...flagLabels(flags)]
      const hash = sha256(raw)
      // Replayed after a crash: the message was stored before the cursor moved.
      if (this.deps.database.hasMessage(job.accountId, id)) {
        this.store.addFingerprint(job.accountId, id, hash, metadata.messageId)
        counts.imported += 1
        return
      }
      // Also a replay: the duplicate was recorded before the cursor moved. (A
      // message that failed to store is simply tried again.)
      if (this.store.hasItem(job.id, key, 'duplicate')) {
        counts.duplicates += 1
        return
      }
      if (job.options.duplicates === 'review') {
        const duplicate = this.store.findDuplicate(job.accountId, hash, metadata.messageId, id)
        if (duplicate) {
          this.store.addItem(job.id, {
            ...base, status: 'duplicate', labelIds, sha256: hash, duplicateOf: duplicate.messageId,
            reason: duplicate.reason === 'identical' ? 'An identical copy is already in Local Folders' : 'A message with the same Message-ID but different content is already in Local Folders'
          })
          counts.duplicates += 1
          pendingReview += 1
          return
        }
      }
      try {
        await this.deps.store(job.accountId, {
          id,
          threadId: importThreadId(metadata.threadRoot ?? `local:${id}`),
          historyId: `import:${job.id}`,
          raw,
          labelIds,
          internalDate: metadata.date ?? extra.fallbackDate,
          sizeEstimate: raw.length
        })
        this.store.addFingerprint(job.accountId, id, hash, metadata.messageId)
        counts.imported += 1
        // A failure recorded just before a crash, now stored on the retry.
        if (this.store.hasItem(job.id, key, 'failed')) this.store.setItemStatus(job.id, key, 'imported', 'Imported when the import resumed')
        this.deps.changed(job.accountId)
      } catch (error) {
        this.store.addItem(job.id, { ...base, status: 'failed', reason: error instanceof Error ? error.message : String(error) })
        counts.failed += 1
      }
    }

    const fail = (entry: MailImportPlanEntry, key: string, reason: string, size = entry.size, subject = basename(entry.path)) => {
      this.store.addItem(job.id, { key, status: 'failed', reason, sourcePath: entry.path, sourceKind: entry.kind, subject, size })
      counts.failed += 1
    }

    // Outlook data files: the cursor is the PST folder plus the next item in
    // it, and the byte offset only estimates progress through the file.
    const importPst = async (entry: MailImportPlanEntry, index: number, resume?: MailImportCursor) => {
      let archive: PstArchive
      try {
        archive = new PstArchive(entry.path)
      } catch (error) {
        fail(entry, `${index}:file`, readError(error))
        return
      }
      try {
        const pstFolders = archive.folders({ maxDepth: this.limits.maxDepth })
        const resuming = resume?.folder !== undefined
        if (!resuming) {
          // Counted once per file, not again when an import resumes.
          counts.skipped += archive.nonMailItems
          archive.problems.forEach((problem, number) => fail(entry, `${index}:folders:${number}`, problem, 0))
        }
        const before = [0]
        for (const folder of pstFolders) before.push(before.at(-1)! + folder.count)
        const total = Math.max(1, before.at(-1)!)
        const progress = (folder: number, message: number) => Math.min(entry.size, Math.floor(entry.size * Math.min(total, before[folder] + message) / total))
        for (let folderIndex = resuming ? resume.folder! : 0; folderIndex < pstFolders.length; folderIndex += 1) {
          const first = resuming && folderIndex === resume.folder ? resume.message ?? 0 : 0
          save({ entry: index, offset: progress(folderIndex, first), folder: folderIndex, message: first }, entry.path)
          let labelId: string
          try {
            labelId = folderFor([...entry.folder, ...pstFolders[folderIndex].path])
          } catch (error) {
            fail(entry, `${index}:${folderIndex}:folder`, error instanceof Error ? error.message : String(error), 0, pstFolders[folderIndex].path.join('/'))
            continue
          }
          for (const record of archive.messages(folderIndex, first)) {
            // A stop here leaves the cursor on this item, so it is read again on resume.
            await checkpoint()
            const key = `${index}:${folderIndex}:${record.index}`
            if (record.error) {
              fail(entry, key, record.error, 0)
            } else if (!record.message) {
              counts.skipped += 1
            } else {
              const message = record.message
              let raw: Buffer | undefined
              try {
                raw = pstMessageToMime(message, { maxBytes: this.limits.maxMessageBytes, seed: String(record.nodeId ?? key) })
              } catch (error) {
                fail(entry, key, error instanceof PstMessageTooLargeError ? tooLarge(this.limits.maxMessageBytes) : `This Outlook message could not be converted (${readError(error)})`, message.size, message.subject || basename(entry.path))
              }
              const date = message.deliveryTime ?? message.creationTime
              if (raw) await importOne(raw, entry, key, labelId, { contentOffset: folderIndex, storedBytes: record.index, fallbackDate: date && date.getTime() > 0 ? date.toISOString() : undefined, flags: { read: message.read, flagged: message.flagged } })
            }
            save({ entry: index, offset: progress(folderIndex, record.index + 1), folder: folderIndex, message: record.index + 1 }, entry.path)
          }
        }
      } catch (error) {
        if (error instanceof ImportStop) throw error
        fail(entry, `${index}:file`, readError(error))
      } finally {
        archive.close()
      }
    }

    try {
      for (let index = cursor.entry; index < job.plan.length; index += 1) {
        const entry = job.plan[index]
        if (entry.kind === 'pst') {
          const resume = index === cursor.entry ? cursor : undefined
          save(resume?.folder !== undefined ? { ...resume } : { entry: index, offset: 0 }, entry.path)
          await checkpoint()
          await importPst(entry, index, resume)
          if (control.stop) throw new ImportStop(control.stop)
          save({ entry: index + 1, offset: 0 })
          continue
        }
        const start = index === cursor.entry ? cursor.offset : 0
        save({ entry: index, offset: start }, entry.path)
        let labelId: string
        try {
          labelId = folderFor(entry.folder)
        } catch (error) {
          fail(entry, `${index}:folder`, error instanceof Error ? error.message : String(error))
          continue
        }
        if (entry.kind === 'eml') {
          await checkpoint()
          try {
            const size = statSync(entry.path).size
            if (size > this.limits.maxMessageBytes) fail(entry, `${index}:0`, tooLarge(this.limits.maxMessageBytes), size)
            else await importOne(await readFile(entry.path), entry, `${index}:0`, labelId, { fallbackDate: statSync(entry.path).mtime.toISOString() })
          } catch (error) {
            fail(entry, `${index}:0`, readError(error))
          }
          save({ entry: index + 1, offset: 0 })
          continue
        }
        try {
          for await (const message of readMbox(entry.path, { start, variant: job.options.mboxVariant, maxMessageBytes: this.limits.maxMessageBytes, signal: control.abort.signal })) {
            // A stop here leaves the cursor on this message, so it is read again on resume.
            await checkpoint()
            const key = `${index}:${message.offset}`
            if (message.oversized) fail(entry, key, tooLarge(this.limits.maxMessageBytes), message.storedBytes)
            else await importOne(message.raw, entry, key, labelId, { contentOffset: message.contentOffset, storedBytes: message.storedBytes, fallbackDate: mboxSeparatorDate(message.separator) })
            save({ entry: index, offset: message.nextOffset }, entry.path)
          }
        } catch (error) {
          if (error instanceof ImportStop) throw error
          fail(entry, `${index}:file`, readError(error))
        }
        if (control.stop) throw new ImportStop(control.stop)
        save({ entry: index + 1, offset: 0 })
      }
      job = this.store.setJobStatus(job.id, 'completed')
    } catch (error) {
      if (error instanceof ImportStop) {
        save(cursor)
        job = error.reason === 'cancel' ? this.store.setJobStatus(job.id, 'cancelled')
          : error.reason === 'disk' ? this.store.setJobStatus(job.id, 'paused', 'Import paused: less than 512 MB of disk space is free. Free some space, then resume.')
            : this.store.setJobStatus(job.id, 'paused')
      } else {
        save(cursor)
        job = this.store.setJobStatus(job.id, 'failed', error instanceof Error ? error.message : String(error))
      }
    } finally {
      this.running = undefined
    }
    this.publish(job, true)
    this.deps.changed(job.accountId, true)
  }

  // Applies the user's duplicate-review decision. Imported duplicates are
  // re-read from the original file and verified against the recorded hash.
  async resolve(jobId: string, keys: string[], decision: 'import' | 'discard') {
    const job = this.job(jobId)
    const wanted = new Set(keys)
    const items = this.store.listItems(jobId, 100_000).filter((item) => wanted.has(item.key) && item.status === 'duplicate')
    let imported = 0
    // Outlook data files are opened once per review, not once per message.
    const archives = new Map<string, PstArchive>()
    const readPst = (item: (typeof items)[number]) => {
      let archive = archives.get(item.source)
      if (!archive) {
        archive = new PstArchive(item.source)
        archives.set(item.source, archive)
        archive.folders({ maxDepth: this.limits.maxDepth })
      }
      const record = archive.message(item.contentOffset, item.storedBytes)
      if (!record?.message) throw new Error('The source file changed since it was imported')
      return pstMessageToMime(record.message, { maxBytes: this.limits.maxMessageBytes, seed: String(record.nodeId ?? item.key) })
    }
    try {
      for (const item of items) {
        if (decision === 'discard') {
          this.store.setItemStatus(jobId, item.key, 'discarded')
          continue
        }
        try {
          const raw = item.sourceKind === 'pst' ? readPst(item) : item.sourceKind === 'eml' ? await readFile(item.source) : await readMboxRange(item.source, item.contentOffset, item.storedBytes, job.options.mboxVariant)
          const hash = sha256(raw)
          if (item.sha256 && hash !== item.sha256) throw new Error('The source file changed since it was imported')
          const id = messageIdFor(jobId, item.key)
          const metadata = importMetadata(raw)
          const folder = item.labelIds.find((label) => label.startsWith('folder:'))
          if (folder && !this.deps.database.listLabels([job.accountId]).some((label) => label.id === folder)) throw new Error('The destination folder no longer exists')
          await this.deps.store(job.accountId, {
            id,
            threadId: importThreadId(metadata.threadRoot ?? `local:${id}`),
            historyId: `import:${jobId}`,
            raw,
            labelIds: item.labelIds,
            internalDate: metadata.date ?? item.date,
            sizeEstimate: raw.length
          })
          this.store.addFingerprint(job.accountId, id, hash, metadata.messageId)
          this.store.setItemStatus(jobId, item.key, 'imported', 'Imported after review')
          imported += 1
        } catch (error) {
          this.store.setItemStatus(jobId, item.key, 'failed', readError(error))
        }
      }
    } finally {
      for (const archive of archives.values()) archive.close()
    }
    if (imported) this.store.adjustImported(jobId, imported)
    const updated = this.job(jobId)
    this.publish(updated, true)
    if (imported) this.deps.changed(job.accountId, true)
    return publicImportJob(updated)
  }
}

const tooLarge = (limit: number) => `The message is larger than the ${limit >= 1024 * 1024 ? `${Math.round(limit / 1024 / 1024)} MB` : `${Math.max(1, Math.round(limit / 1024))} KB`} import limit`

function readError(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') return 'The file is no longer available'
  if (code === 'EACCES' || code === 'EPERM') return 'Aerio does not have permission to read this file'
  return error instanceof Error ? error.message : String(error)
}

