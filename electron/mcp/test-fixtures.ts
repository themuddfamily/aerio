import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { MailAccountSummary, MailDraftInput, MailDraftRecord, MailDraftResult, MailLabel, MailQuery, MailThreadDetail, MailThreadSummary } from '../../src/mail-types'
import type { McpSettings } from '../../src/mcp-types'
import type { MailWorkerCommand } from '../mail-protocol'
import { McpToolService } from './service'
import { McpAutomationStore } from './store'

/** Fixture mailbox for MCP tests: fake addresses only, no network or credentials. */
export const fixtureAccounts: MailAccountSummary[] = [
  { id: 'acct-work', provider: 'gmail', email: 'ada@example.test', displayName: 'Ada Work', color: '#123456', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true, lastSyncAt: '2026-10-01T10:00:00.000Z' },
  { id: 'acct-home', provider: 'imap', email: 'ada.home@example.test', displayName: 'Ada Home', color: '#654321', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true }
]

export const fixtureLabels: MailLabel[] = [
  { accountId: 'acct-work', id: 'INBOX', name: 'Inbox', type: 'system' },
  { accountId: 'acct-work', id: 'Label_Projects', name: 'Projects', type: 'user' },
  { accountId: 'acct-home', id: 'folder:INBOX', name: 'INBOX', type: 'system' }
]

const summary = (accountId: string, index: number): MailThreadSummary => ({
  accountId, id: `${accountId}-thread-${index}`, subject: `Quarterly report ${index}`, participants: ['Grace <grace@example.test>'], senderEmail: 'grace@example.test',
  snippet: `Confidential numbers ${index}`, lastDate: `2026-09-${String(30 - index).padStart(2, '0')}T10:00:00.000Z`, unread: index % 2 === 0, starred: false, important: false,
  trashed: false, draft: false, hasAttachments: index === 0, messageCount: 2, labelIds: ['INBOX']
})

export const fixtureThreads = [...fixtureAccounts.flatMap((account) => Array.from({ length: 5 }, (_, index) => summary(account.id, index)))]

export function fixtureThread(accountId: string, threadId: string): MailThreadDetail {
  const base = { accountId, threadId, to: ['ada@example.test'], cc: [], labelIds: ['INBOX'], html: '<p>x</p>', remoteContent: { remoteImages: 0, trackers: [] } }
  return {
    accountId, id: threadId, subject: 'Quarterly report 0',
    messages: [
      { ...base, id: `${threadId}-m1`, fromName: 'Grace', fromEmail: 'grace@example.test', subject: 'Quarterly report 0', messageIdHeader: '<m1@example.test>', references: [], date: '2026-09-29T10:00:00.000Z', text: 'First message body', sanitizedHtml: '<p>First message body</p>', attachments: [] },
      {
        ...base, id: `${threadId}-m2`, fromName: 'Grace', fromEmail: 'grace@example.test', subject: 'Re: Quarterly report 0', messageIdHeader: '<m2@example.test>', references: ['<m1@example.test>'],
        date: '2026-09-30T10:00:00.000Z', text: 'Second message body that is quite long', sanitizedHtml: '<p>Second</p>',
        attachments: [
          { id: 'att-pdf', messageId: `${threadId}-m2`, filename: 'report.pdf', mimeType: 'application/pdf', size: 12 },
          { id: 'att-png', messageId: `${threadId}-m2`, filename: 'chart.png', mimeType: 'image/png', size: 4, contentId: 'chart' },
          { id: 'att-big', messageId: `${threadId}-m2`, filename: 'video.mp4', mimeType: 'video/mp4', size: 50 * 1024 * 1024 }
        ]
      }
    ]
  }
}

export function fakeWorker() {
  const drafts = new Map<string, MailDraftRecord>()
  let draftCounter = 0
  const request = vi.fn(async (command: MailWorkerCommand): Promise<any> => {
    switch (command.type) {
      case 'accounts:list': return fixtureAccounts
      case 'labels:list': return fixtureLabels.filter((label) => !command.payload.accountIds?.length || command.payload.accountIds.includes(label.accountId))
      case 'mail:list': {
        const query = command.payload as MailQuery
        const items = fixtureThreads.filter((item) => !query.accountIds?.length || query.accountIds.includes(item.accountId))
        const start = query.cursor ? Number(Buffer.from(query.cursor, 'base64url').toString('utf8')) : 0
        const pageSize = query.pageSize ?? 50
        const page = items.slice(start, start + pageSize)
        const next = start + pageSize
        return { items: page, total: items.length, ...(next < items.length ? { nextCursor: Buffer.from(String(next)).toString('base64url') } : {}) }
      }
      case 'mail:thread':
        if (!fixtureThreads.some((item) => item.accountId === command.payload.accountId && item.id === command.payload.threadId)) throw new Error('Thread not found')
        return fixtureThread(command.payload.accountId, command.payload.threadId)
      case 'mail:action':
        if (command.payload.threadIds.some((id) => !fixtureThreads.some((item) => item.id === id))) throw new Error(`Conversation ${command.payload.threadIds[0]} was not found`)
        return { id: `op-${command.payload.action}`, accountId: command.payload.accountId, kind: command.payload.action, status: 'queued', undoUntil: '2026-10-01T10:00:10.000Z' }
      case 'attachment:extract':
        writeFileSync(command.payload.targetPath, `bytes of ${command.payload.attachmentId}`)
        return
      case 'drafts:send': {
        const record = drafts.get(command.payload.id!)!
        record.status = 'send-pending'
        return { id: record.id, status: 'send-pending', updatedAt: record.updatedAt, deliveryAt: '2026-10-01T10:01:10.000Z', undoUntil: '2026-10-01T10:01:10.000Z' }
      }
      case 'drafts:get': return drafts.get(command.payload.id)
      case 'drafts:save': {
        const input = command.payload as MailDraftInput
        const existing = input.id ? drafts.get(input.id) : undefined
        if (existing && input.expectedUpdatedAt && existing.updatedAt !== input.expectedUpdatedAt) throw new Error('This draft changed after it was opened. Your version was not overwritten; save it as a copy to keep both versions.')
        const id = input.id ?? `draft-${++draftCounter}`
        const { id: _id, expectedUpdatedAt: _expected, ...rest } = input
        const record: MailDraftRecord = { ...rest, id, status: existing?.status ?? 'local', updatedAt: `2026-10-01T10:00:${String(++draftCounter).padStart(2, '0')}.000Z` }
        drafts.set(id, record)
        return { id, status: record.status, updatedAt: record.updatedAt }
      }
    }
    throw new Error(`Unexpected worker command ${command.type}`)
  })
  return { request, drafts }
}

export const allCapabilities: McpSettings = { enabled: true, capabilities: { write: true, send: true, delete: true }, accountScope: 'all' }

export function temporaryDirectory(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), `aerio-mcp-${prefix}-`))
  return { directory, remove: () => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
}

export function serviceHarness(initial: McpSettings = allCapabilities) {
  const temporary = temporaryDirectory('service')
  const store = new McpAutomationStore(join(temporary.directory, 'mcp-automation.sqlite'))
  const worker = fakeWorker()
  let settings = structuredClone(initial)
  let locked = false
  const sendDraft = vi.fn(async (input: MailDraftInput): Promise<MailDraftResult> => {
    const record = worker.drafts.get(input.id!)!
    record.status = 'send-pending'
    return { id: input.id!, status: 'send-pending' as const, updatedAt: '2026-10-01T10:01:00.000Z', deliveryAt: '2026-10-01T10:01:10.000Z', undoUntil: '2026-10-01T10:01:10.000Z' }
  })
  const deps = {
    request: worker.request,
    settings: () => settings,
    isLocked: () => locked,
    validateDraft: vi.fn((input: MailDraftInput) => input),
    approveAttachmentPaths: vi.fn(),
    sendDraft,
    openMessage: vi.fn(),
    readAttachment: vi.fn(async (_accountId: string, _messageId: string, attachmentId: string) => attachmentId === 'att-png' ? Buffer.from([137, 80, 78, 71]) : Buffer.from('%PDF-1.7 test')),
    sends: store
  }
  const service = new McpToolService(deps)
  return {
    service, store, worker, deps,
    setSettings(next: Partial<McpSettings>) { settings = { ...settings, ...next } },
    setLocked(value: boolean) { locked = value },
    close() { store.close(); temporary.remove() }
  }
}
