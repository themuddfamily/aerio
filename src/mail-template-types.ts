// QuickText snippets and whole-message templates. Bodies are stored as
// sanitized HTML; template attachments are managed local copies owned by Aerio.

export type MailTemplateKind = 'snippet' | 'template'

export interface MailTemplateAttachment {
  id: string
  name: string
  size: number
  mime?: string
  path: string
}

export interface MailTemplate {
  id: string
  kind: MailTemplateKind
  name: string
  /** Whole-message templates only; snippets always use an empty subject. */
  subject: string
  html: string
  /** Plain-text projection of the sanitized HTML, used for search and plain-text drafts. */
  text: string
  /** Whole-message templates only. */
  attachments: MailTemplateAttachment[]
  createdAt: string
  updatedAt: string
  lastUsedAt?: string
}

export interface MailTemplateInput {
  id?: string
  kind: MailTemplateKind
  name: string
  subject?: string
  html: string
  /** Existing managed attachments are kept; other paths must have been chosen through Aerio and are copied. */
  attachments?: Array<{ id?: string; name: string; size: number; mime?: string; path: string }>
  /** Optimistic concurrency guard against another window editing the same template. */
  expectedUpdatedAt?: string
}

export interface MailTemplateImportResult {
  restored: number
}

export interface MailTemplatesApi {
  list(query?: string): Promise<MailTemplate[]>
  save(input: MailTemplateInput): Promise<MailTemplate>
  delete(id: string): Promise<void>
  /** Marks a template as used and authorizes its managed attachments for draft saves. */
  use(id: string): Promise<MailTemplate>
  exportBackup(): Promise<{ savedPath?: string }>
  importBackup(): Promise<MailTemplateImportResult | undefined>
}
