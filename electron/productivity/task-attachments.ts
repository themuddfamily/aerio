import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Attachment } from '../../src/types'
import { TASK_ATTACHMENT_LIMIT, TASK_ATTACHMENT_MAX_BYTES } from '../../src/lib/task-schedule'
import type { ArchivedTaskAttachment } from './task-backup'

/** Embedded task attachment bytes per backup file, matching the Notes limit. */
export const TASK_BACKUP_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024

/**
 * Managed copies of files attached to local tasks and to connected tasks' local-only overlays (E44).
 * Mirrors the Notes approach: files are copied into the profile, referenced by path, embedded in
 * JSON backups, and deleted once nothing references them.
 */
export class TaskAttachmentFiles {
  // Copied this session but not yet saved by a task. A sweep never removes these, so an editor
  // can stay open; once saved they become ordinary referenced files.
  private readonly pending = new Set<string>()

  constructor(readonly root: string) {}

  isManaged(path: string) {
    if (typeof path !== 'string' || !path || path.length > 32_767) return false
    const nested = relative(resolve(this.root), resolve(path))
    return Boolean(nested) && !nested.startsWith('..') && !isAbsolute(nested) && !nested.includes('/') && !nested.includes('\\')
  }

  private target(name: string) {
    const extension = extname(name)
    return join(this.root, `${randomUUID()}${extension.length <= 12 ? extension : ''}`)
  }

  /** Copies chosen files in. Every copy is removed again if any file fails. */
  copyIn(sources: string[]): Attachment[] {
    if (sources.length > TASK_ATTACHMENT_LIMIT) throw new Error(`Attach no more than ${TASK_ATTACHMENT_LIMIT} files to a task`)
    const files = sources.map((source) => ({ source, file: statSync(source) }))
    for (const { source, file } of files) {
      if (!file.isFile() || file.size > TASK_ATTACHMENT_MAX_BYTES) throw new Error(`“${basename(source)}” must be a file no larger than 25 MB`)
    }
    mkdirSync(this.root, { recursive: true })
    const copied: string[] = []
    try {
      return files.map(({ source, file }) => {
        const path = this.target(source)
        copyFileSync(source, path)
        copied.push(path)
        this.pending.add(resolve(path))
        const extension = extname(source)
        return { id: randomUUID(), name: basename(source), size: file.size, path, mime: extension.slice(1) || undefined }
      })
    } catch (error) {
      this.remove(copied)
      throw error
    }
  }

  remove(paths: string[]) {
    for (const path of paths) {
      this.pending.delete(resolve(path))
      try { if (this.isManaged(path) && existsSync(path)) unlinkSync(path) } catch { /* A later sweep retries. */ }
    }
  }

  /**
   * Deletes managed files nothing references. Callers pass every reference from local tasks and
   * connected-task overlays; files copied this session but not yet saved are kept.
   */
  sweep(referenced: Iterable<string>) {
    if (!existsSync(this.root)) return []
    const kept = new Set<string>()
    for (const path of referenced) {
      const resolved = resolve(path)
      kept.add(resolved)
      this.pending.delete(resolved)
    }
    const removed: string[] = []
    for (const name of readdirSync(this.root)) {
      const path = resolve(join(this.root, name))
      if (kept.has(path) || this.pending.has(path)) continue
      try {
        if (!statSync(path).isFile()) continue
        unlinkSync(path)
        removed.push(path)
      } catch { /* An in-use file is retried by the next sweep. */ }
    }
    return removed
  }

  /** Reads referenced files for a backup. Shared references are stored once. */
  archive(attachments: Attachment[], budget = TASK_BACKUP_ATTACHMENT_MAX_BYTES): ArchivedTaskAttachment[] {
    const archived = new Map<string, ArchivedTaskAttachment>()
    const sources = new Map<string, string>()
    let total = 0
    for (const attachment of attachments) {
      const previous = archived.get(attachment.id)
      if (previous) {
        if (previous.name !== attachment.name || previous.size !== attachment.size || previous.mime !== attachment.mime || !attachment.path || sources.get(attachment.id) !== resolve(attachment.path)) throw new Error('Tasks contain conflicting attachment references; fix them before exporting')
        continue
      }
      if (!attachment.path || !this.isManaged(attachment.path) || !existsSync(attachment.path)) throw new Error(`The task attachment “${attachment.name}” is unavailable`)
      const bytes = Buffer.from(readFileSync(attachment.path))
      if (bytes.byteLength !== attachment.size || bytes.byteLength > TASK_ATTACHMENT_MAX_BYTES) throw new Error(`The task attachment “${attachment.name}” changed or is too large`)
      total += bytes.byteLength
      if (total > budget) throw new Error('Attachments exceed the 100 MB backup limit')
      archived.set(attachment.id, { id: attachment.id, name: attachment.name, size: bytes.byteLength, ...(attachment.mime !== undefined ? { mime: attachment.mime } : {}), dataBase64: bytes.toString('base64') })
      sources.set(attachment.id, resolve(attachment.path))
    }
    return [...archived.values()]
  }

  /**
   * Writes embedded backup files into managed storage and returns the new path for each attachment
   * id. Created files are removed if any entry is invalid; on success they stay pending until saved.
   */
  materialize(archived: ArchivedTaskAttachment[], budget = TASK_BACKUP_ATTACHMENT_MAX_BYTES) {
    const paths = new Map<string, string>()
    const created: string[] = []
    let total = 0
    try {
      for (const stored of archived) {
        const bytes = Buffer.from(stored.dataBase64, 'base64')
        if (bytes.byteLength !== stored.size || bytes.toString('base64') !== stored.dataBase64 || bytes.byteLength > TASK_ATTACHMENT_MAX_BYTES) throw new Error(`The backup attachment “${stored.name}” is invalid`)
        total += bytes.byteLength
        if (total > budget) throw new Error('Attachments exceed the 100 MB restore limit')
        mkdirSync(this.root, { recursive: true })
        const path = this.target(stored.name)
        writeFileSync(path, bytes, { mode: 0o600 })
        created.push(path)
        this.pending.add(resolve(path))
        paths.set(stored.id, path)
      }
      return { paths, created }
    } catch (error) {
      this.remove(created)
      throw error
    }
  }
}

/** Replaces attachment paths by id, leaving other fields untouched. */
export function relinkAttachments<T extends { attachments?: Attachment[] }>(value: T, paths: Map<string, string>): T {
  if (!value.attachments) return value
  return { ...value, attachments: value.attachments.map((attachment) => {
    const path = paths.get(attachment.id)
    if (!path) throw new Error(`The backup is missing the attachment “${attachment.name}”`)
    return { ...attachment, path }
  }) }
}
