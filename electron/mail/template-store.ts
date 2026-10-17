import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { decodeHTML } from 'entities'
import sanitizeHtml from 'sanitize-html'
import type { MailTemplate, MailTemplateAttachment, MailTemplateInput, MailTemplateKind } from '../../src/mail-template-types'

export const MAX_MAIL_TEMPLATES = 5_000
export const MAIL_TEMPLATE_HTML_MAX = 2_000_000
export const MAIL_TEMPLATE_ATTACHMENT_LIMIT = 10
// Matches Aerio's sending limit so a template can always be used as-is.
export const MAIL_TEMPLATE_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024
const MAIL_TEMPLATE_BACKUP_MAX_BYTES = 100 * 1024 * 1024

export interface ArchivedMailTemplateAttachment {
  id: string
  name: string
  size: number
  mime?: string
  dataBase64: string
}

export interface MailTemplateBackup {
  format: 'aerio-mail-templates'
  schemaVersion: 1
  exportedAt: string
  templates: Array<Omit<MailTemplate, 'attachments'> & { attachments: Omit<MailTemplateAttachment, 'path'>[] }>
  attachments: ArchivedMailTemplateAttachment[]
}

export interface PreparedMailTemplateRestore {
  count: number
  commit(): void
  rollback(): void
}

interface TemplateRow {
  id: string
  kind: MailTemplateKind
  name: string
  subject: string
  html: string
  text: string
  attachments_json: string
  created_at: string
  updated_at: string
  last_used_at: string | null
}

/** Composer-safe HTML: formatting, links, lists, tables, and inline/HTTPS images only. */
export function sanitizeTemplateHtml(html: string) {
  return sanitizeHtml(html, {
    allowedTags: [
      'a', 'b', 'blockquote', 'br', 'code', 'div', 'em', 'font', 'h1', 'h2', 'h3', 'h4', 'hr', 'i', 'img',
      'li', 'ol', 'p', 'pre', 's', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'table', 'tbody',
      'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul'
    ],
    allowedAttributes: {
      a: ['href'],
      img: ['src', 'alt', 'width', 'height'],
      font: ['color', 'face', 'size'],
      td: ['align', 'colspan', 'rowspan', 'valign'],
      th: ['align', 'colspan', 'rowspan', 'valign']
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['https', 'data'] },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    // Relative URLs have no meaning in a sent message, so only absolute safe URLs survive.
    transformTags: {
      a: (tagName, attribs) => {
        const { href, ...rest } = attribs
        return { tagName, attribs: href && /^(?:https?:\/\/|mailto:)/i.test(href) ? { ...rest, href } : rest }
      },
      img: (tagName, attribs) => {
        const { src, ...rest } = attribs
        return { tagName, attribs: src && /^(?:https:\/\/|data:image\/)/i.test(src) ? { ...rest, src } : rest }
      }
    }
  }).trim()
}

/** Plain-text projection used for search and for the text part of drafts. */
export function templateTextFromHtml(html: string) {
  const structured = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote|pre)>/gi, '\n')
  return decodeHTML(sanitizeHtml(structured, { allowedTags: [], allowedAttributes: {} }))
    .replaceAll(' ', ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const text = (value: unknown, max: number, required = false): value is string =>
  typeof value === 'string' && value.length <= max && (!required || Boolean(value.trim()))
const timestamp = (value: unknown) => text(value, 100, true) && Number.isFinite(Date.parse(value))
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** Validates an untrusted template backup without touching the filesystem. */
export function parseMailTemplateBackup(value: unknown): MailTemplateBackup | undefined {
  if (!value || typeof value !== 'object') return
  const backup = value as Partial<MailTemplateBackup>
  if (backup.format !== 'aerio-mail-templates' || backup.schemaVersion !== 1 || !timestamp(backup.exportedAt)) return
  if (!Array.isArray(backup.templates) || backup.templates.length > MAX_MAIL_TEMPLATES || !Array.isArray(backup.attachments) || backup.attachments.length > MAX_MAIL_TEMPLATES * MAIL_TEMPLATE_ATTACHMENT_LIMIT) return
  if (new Set(backup.templates.map((template) => template?.id)).size !== backup.templates.length) return
  if (new Set(backup.templates.map((template) => `${template?.kind}:${String(template?.name ?? '').trim().toLowerCase()}`)).size !== backup.templates.length) return
  const validTemplates = backup.templates.every((template) => template && text(template.id, 300, true) && ['snippet', 'template'].includes(template.kind) &&
    text(template.name, 200, true) && text(template.subject, 998) && text(template.html, MAIL_TEMPLATE_HTML_MAX) && text(template.text, MAIL_TEMPLATE_HTML_MAX) &&
    timestamp(template.createdAt) && timestamp(template.updatedAt) && (template.lastUsedAt === undefined || timestamp(template.lastUsedAt)) &&
    Array.isArray(template.attachments) && template.attachments.length <= MAIL_TEMPLATE_ATTACHMENT_LIMIT && (template.kind === 'template' || template.attachments.length === 0) &&
    template.attachments.every((attachment) => attachment && text(attachment.id, 300, true) && text(attachment.name, 1_000, true) &&
      Number.isSafeInteger(attachment.size) && attachment.size >= 0 && attachment.size <= MAIL_TEMPLATE_ATTACHMENT_MAX_BYTES && (attachment.mime === undefined || text(attachment.mime, 300))))
  if (!validTemplates) return
  const validArchive = backup.attachments.every((attachment) => attachment && text(attachment.id, 300, true) && text(attachment.name, 1_000, true) &&
    Number.isSafeInteger(attachment.size) && attachment.size >= 0 && attachment.size <= MAIL_TEMPLATE_ATTACHMENT_MAX_BYTES && (attachment.mime === undefined || text(attachment.mime, 300)) &&
    typeof attachment.dataBase64 === 'string' && attachment.dataBase64.length <= Math.ceil(MAIL_TEMPLATE_ATTACHMENT_MAX_BYTES / 3) * 4 + 4 && base64Pattern.test(attachment.dataBase64))
  if (!validArchive) return
  const archived = new Map(backup.attachments.map((attachment) => [attachment.id, attachment]))
  if (archived.size !== backup.attachments.length) return
  const referenced = backup.templates.flatMap((template) => template.attachments)
  // Every reference must be archived exactly once with matching metadata, and nothing extra may ride along.
  if (new Set(referenced.map((attachment) => attachment.id)).size !== referenced.length || referenced.length !== archived.size) return
  for (const attachment of referenced) {
    const stored = archived.get(attachment.id)
    if (!stored || stored.name !== attachment.name || stored.size !== attachment.size || stored.mime !== attachment.mime) return
  }
  return backup as MailTemplateBackup
}

export class MailTemplateStore {
  private readonly db: DatabaseSync
  private lastRevision = 0

  constructor(path: string, private readonly attachmentsDirectory: string, private readonly canReadSource: (path: string) => boolean = () => false) {
    this.db = new DatabaseSync(path)
    this.migrate()
  }

  private migrate() {
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS mail_templates (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        html TEXT NOT NULL,
        text TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mail_templates_kind_name ON mail_templates(kind, name COLLATE NOCASE);
    `)
    const columns = new Set((this.db.prepare('PRAGMA table_info(mail_templates)').all() as unknown as { name: string }[]).map((column) => column.name))
    if (!columns.has('last_used_at')) this.db.exec('ALTER TABLE mail_templates ADD COLUMN last_used_at TEXT')
  }

  private nextRevision() {
    // Rapid consecutive saves still produce distinct, monotonic revisions.
    this.lastRevision = Math.max(Date.now(), this.lastRevision + 1)
    return new Date(this.lastRevision).toISOString()
  }

  private fromRow(row: TemplateRow): MailTemplate {
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      subject: row.subject,
      html: row.html,
      text: row.text,
      attachments: JSON.parse(row.attachments_json) as MailTemplateAttachment[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {})
    }
  }

  isManagedPath(path: string) {
    const nested = relative(resolve(this.attachmentsDirectory), resolve(path))
    return Boolean(nested) && !nested.startsWith('..') && !isAbsolute(nested)
  }

  all(): MailTemplate[] {
    return (this.db.prepare('SELECT * FROM mail_templates ORDER BY kind, name COLLATE NOCASE, id').all() as unknown as TemplateRow[]).map((row) => this.fromRow(row))
  }

  /** Every whitespace-separated term must appear in the name, subject, or body text. */
  list(query = ''): MailTemplate[] {
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0, 20)
    const templates = this.all()
    if (!terms.length) return templates
    return templates.filter((template) => {
      const haystack = `${template.name}\n${template.subject}\n${template.text}`.toLocaleLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
  }

  get(id: string): MailTemplate | undefined {
    const row = this.db.prepare('SELECT * FROM mail_templates WHERE id=?').get(id) as unknown as TemplateRow | undefined
    return row ? this.fromRow(row) : undefined
  }

  save(input: MailTemplateInput): MailTemplate {
    if (!input || typeof input !== 'object' || !['snippet', 'template'].includes(input.kind)) throw new Error('Choose whether this is a snippet or a message template')
    if (input.id !== undefined && !text(input.id, 300, true)) throw new Error('The template id is invalid')
    if (!text(input.name, 200, true)) throw new Error('Give the template a name of at most 200 characters')
    if (input.subject !== undefined && !text(input.subject, 998)) throw new Error('The template subject is too long')
    if (!text(input.html, MAIL_TEMPLATE_HTML_MAX)) throw new Error('The template body is too large')
    if (input.expectedUpdatedAt !== undefined && !timestamp(input.expectedUpdatedAt)) throw new Error('The template revision is invalid')
    const requested = input.attachments ?? []
    if (!Array.isArray(requested) || requested.length > MAIL_TEMPLATE_ATTACHMENT_LIMIT) throw new Error(`A template can contain at most ${MAIL_TEMPLATE_ATTACHMENT_LIMIT} attachments`)
    if (input.kind === 'snippet' && requested.length) throw new Error('Snippets cannot contain attachments; save a message template instead')
    const name = input.name.trim()
    const existing = input.id ? this.get(input.id) : undefined
    if (existing && input.expectedUpdatedAt && existing.updatedAt !== input.expectedUpdatedAt) throw new Error('This template changed in another window; reopen it before saving')
    if (existing && existing.kind !== input.kind) throw new Error('A snippet cannot be converted into a message template')
    const duplicate = this.db.prepare('SELECT id FROM mail_templates WHERE kind=? AND name=? COLLATE NOCASE AND id<>?').get(input.kind, name, input.id ?? '') as { id: string } | undefined
    if (duplicate) throw new Error(`A ${input.kind === 'snippet' ? 'snippet' : 'template'} named “${name}” already exists`)
    if (!existing && this.count() >= MAX_MAIL_TEMPLATES) throw new Error(`Aerio stores at most ${MAX_MAIL_TEMPLATES} templates and snippets`)

    const html = sanitizeTemplateHtml(input.html)
    const kept = new Map((existing?.attachments ?? []).map((attachment) => [attachment.id, attachment]))
    const copied: string[] = []
    let attachments: MailTemplateAttachment[]
    try {
      let total = 0
      attachments = requested.map((attachment) => {
        if (!attachment || !text(attachment.path, 32_767, true)) throw new Error('A template attachment is invalid')
        const current = attachment.id ? kept.get(attachment.id) : undefined
        if (current && resolve(current.path) === resolve(attachment.path)) {
          total += current.size
          if (total > MAIL_TEMPLATE_ATTACHMENT_MAX_BYTES) throw new Error('Template attachments exceed Aerio’s 20 MB sending limit')
          return current
        }
        // New files must come from an Aerio file chooser, a staged draft, or another managed template.
        if (!this.canReadSource(attachment.path) && !this.isManagedPath(attachment.path)) throw new Error('A template referenced a file that was not selected through Aerio')
        let size: number
        try {
          const details = statSync(attachment.path)
          if (!details.isFile()) throw new Error('not a file')
          size = details.size
        } catch {
          throw new Error(`An attachment is no longer available: ${basename(attachment.path)}`)
        }
        total += size
        if (total > MAIL_TEMPLATE_ATTACHMENT_MAX_BYTES) throw new Error('Template attachments exceed Aerio’s 20 MB sending limit')
        const displayName = text(attachment.name, 1_000, true) ? attachment.name.trim() : basename(attachment.path)
        const path = this.managedPathFor(displayName)
        copyFileSync(attachment.path, path)
        copied.push(path)
        const mime = extname(displayName).slice(1).toLowerCase()
        return { id: crypto.randomUUID(), name: displayName, size, path, ...(mime ? { mime } : {}) }
      })
    } catch (error) {
      this.removeFiles(copied)
      throw error
    }

    const now = this.nextRevision()
    const template: MailTemplate = {
      id: existing?.id ?? input.id ?? crypto.randomUUID(),
      kind: input.kind,
      name,
      subject: input.kind === 'template' ? (input.subject ?? '').trim() : '',
      html,
      text: templateTextFromHtml(html),
      attachments,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing?.lastUsedAt ? { lastUsedAt: existing.lastUsedAt } : {})
    }
    try {
      this.write(template)
    } catch (error) {
      this.removeFiles(copied)
      throw error
    }
    this.cleanupUnreferencedFiles(existing?.attachments ?? [])
    return template
  }

  delete(id: string) {
    const existing = this.get(id)
    if (!existing) return
    this.db.prepare('DELETE FROM mail_templates WHERE id=?').run(id)
    this.cleanupUnreferencedFiles(existing.attachments)
  }

  markUsed(id: string): MailTemplate {
    const existing = this.get(id)
    if (!existing) throw new Error('That template no longer exists')
    const missing = existing.attachments.find((attachment) => !existsSync(attachment.path))
    if (missing) throw new Error(`The template attachment “${missing.name}” is no longer available`)
    const lastUsedAt = new Date().toISOString()
    this.db.prepare('UPDATE mail_templates SET last_used_at=? WHERE id=?').run(lastUsedAt, id)
    return { ...existing, lastUsedAt }
  }

  count() {
    return Number((this.db.prepare('SELECT COUNT(*) AS count FROM mail_templates').get() as { count: number }).count)
  }

  exportBackup(): MailTemplateBackup {
    const templates = this.all()
    const attachments: ArchivedMailTemplateAttachment[] = []
    let total = 0
    for (const attachment of templates.flatMap((template) => template.attachments)) {
      if (!this.isManagedPath(attachment.path) || !existsSync(attachment.path)) throw new Error(`The template attachment “${attachment.name}” is unavailable`)
      const bytes = Buffer.from(readFileSync(attachment.path))
      if (bytes.byteLength !== attachment.size) throw new Error(`The template attachment “${attachment.name}” changed after it was saved`)
      total += bytes.byteLength
      if (total > MAIL_TEMPLATE_BACKUP_MAX_BYTES) throw new Error('Template attachments exceed the 100 MB backup limit')
      attachments.push({ id: attachment.id, name: attachment.name, size: attachment.size, ...(attachment.mime ? { mime: attachment.mime } : {}), dataBase64: bytes.toString('base64') })
    }
    return {
      format: 'aerio-mail-templates',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      templates: templates.map((template) => ({
        ...template,
        attachments: template.attachments.map(({ path: _path, ...attachment }) => attachment)
      })),
      attachments
    }
  }

  /**
   * Writes restored attachment files and returns a commit step, so callers can
   * combine template restore with other local-data restores and roll back cleanly.
   * `merge` replaces templates with matching ids; `replace` removes all others.
   */
  prepareRestore(backup: MailTemplateBackup, mode: 'merge' | 'replace'): PreparedMailTemplateRestore {
    const archived = new Map(backup.attachments.map((attachment) => [attachment.id, attachment]))
    const created: string[] = []
    let total = 0
    let templates: MailTemplate[]
    try {
      templates = backup.templates.map((template) => {
        const html = sanitizeTemplateHtml(template.html)
        return {
          id: template.id,
          kind: template.kind,
          name: template.name.trim(),
          subject: template.kind === 'template' ? template.subject : '',
          html,
          text: templateTextFromHtml(html),
          createdAt: template.createdAt,
          updatedAt: template.updatedAt,
          ...(template.lastUsedAt ? { lastUsedAt: template.lastUsedAt } : {}),
          attachments: template.attachments.map((attachment) => {
            const stored = archived.get(attachment.id)
            if (!stored) throw new Error(`The backup is missing the attachment “${attachment.name}”`)
            const bytes = Buffer.from(stored.dataBase64, 'base64')
            if (bytes.byteLength !== stored.size || bytes.toString('base64') !== stored.dataBase64) throw new Error(`The backup attachment “${attachment.name}” is invalid`)
            total += bytes.byteLength
            if (total > MAIL_TEMPLATE_BACKUP_MAX_BYTES) throw new Error('Template attachments exceed the 100 MB restore limit')
            const path = this.managedPathFor(stored.name)
            created.push(path)
            writeFileSync(path, bytes, { mode: 0o600 })
            return { id: stored.id, name: stored.name, size: stored.size, ...(stored.mime ? { mime: stored.mime } : {}), path }
          })
        }
      })
    } catch (error) {
      this.removeFiles(created)
      throw error
    }
    let settled = false
    return {
      count: templates.length,
      commit: () => {
        if (settled) return
        settled = true
        const previous = this.all()
        const restoredIds = new Set(templates.map((template) => template.id))
        this.db.exec('BEGIN IMMEDIATE')
        try {
          if (mode === 'replace') this.db.prepare('DELETE FROM mail_templates').run()
          for (const template of templates) {
            // A restored template that collides by name with a different local template keeps both, renamed.
            let name = template.name
            for (let index = 2; this.db.prepare('SELECT 1 FROM mail_templates WHERE kind=? AND name=? COLLATE NOCASE AND id<>?').get(template.kind, name, template.id); index++) {
              name = `${template.name} (${index})`
            }
            this.write({ ...template, name })
          }
          this.db.exec('COMMIT')
        } catch (error) {
          this.db.exec('ROLLBACK')
          this.removeFiles(created)
          throw error
        }
        this.cleanupUnreferencedFiles(previous.filter((template) => mode === 'replace' || restoredIds.has(template.id)).flatMap((template) => template.attachments))
      },
      rollback: () => {
        if (settled) return
        settled = true
        this.removeFiles(created)
      }
    }
  }

  restore(backup: MailTemplateBackup, mode: 'merge' | 'replace') {
    const prepared = this.prepareRestore(backup, mode)
    prepared.commit()
    return prepared.count
  }

  /** Removes managed files that no template references, e.g. after an interrupted save. */
  cleanupOrphanedFiles() {
    if (!existsSync(this.attachmentsDirectory)) return 0
    const referenced = new Set(this.all().flatMap((template) => template.attachments).map((attachment) => resolve(attachment.path).toLowerCase()))
    let removed = 0
    for (const filename of readdirSync(this.attachmentsDirectory)) {
      const path = join(this.attachmentsDirectory, filename)
      if (referenced.has(resolve(path).toLowerCase())) continue
      try { unlinkSync(path); removed++ } catch { /* The next cleanup pass can retry an in-use file. */ }
    }
    return removed
  }

  close() { this.db.close() }

  private write(template: MailTemplate) {
    this.db.prepare(`
      INSERT INTO mail_templates(id,kind,name,subject,html,text,attachments_json,created_at,updated_at,last_used_at) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,name=excluded.name,subject=excluded.subject,html=excluded.html,text=excluded.text,
        attachments_json=excluded.attachments_json,created_at=excluded.created_at,updated_at=excluded.updated_at,last_used_at=excluded.last_used_at
    `).run(template.id, template.kind, template.name, template.subject, template.html, template.text, JSON.stringify(template.attachments),
      template.createdAt, template.updatedAt, template.lastUsedAt ?? null)
  }

  private managedPathFor(name: string) {
    mkdirSync(this.attachmentsDirectory, { recursive: true })
    const extension = extname(name)
    return join(this.attachmentsDirectory, `${crypto.randomUUID()}${extension.length <= 12 ? extension : ''}`)
  }

  private cleanupUnreferencedFiles(candidates: MailTemplateAttachment[]) {
    if (!candidates.length) return
    const retained = new Set(this.all().flatMap((template) => template.attachments).map((attachment) => resolve(attachment.path)))
    this.removeFiles(candidates.map((attachment) => attachment.path).filter((path) => !retained.has(resolve(path)) && this.isManagedPath(path)))
  }

  private removeFiles(paths: string[]) {
    for (const path of paths) {
      try { if (existsSync(path)) unlinkSync(path) } catch { /* Do not mask the original error; orphan cleanup retries later. */ }
    }
  }
}
