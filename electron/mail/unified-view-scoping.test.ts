import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { MailDatabase, type ParsedMailMessage } from './database'
import { unifiedViewAccountIds } from '../../src/lib/mail-unified-views'

describe('unified account subset database scope', () => {
  it('never returns omitted accounts through search, pagination, unread counts or drafts, including an empty subset', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aerio-subset-query-'))
    const db = new MailDatabase(join(directory, 'mail.sqlite'), join(directory, 'mail'))
    try {
      for (const accountId of ['a', 'b', 'excluded']) {
        db.upsertAccount({ id: accountId, provider: 'gmail', email: `${accountId}@example.test`, displayName: accountId, color: '#000', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true })
        for (let index = 0; index < 4; index++) {
          const id = `${accountId}-${index}`
          const message: ParsedMailMessage = { accountId, id, threadId: id, historyId: '1', references: [], internalDate: `2026-10-${20 - index}T09:00:00Z`, fromName: 'Sender', fromEmail: 'sender@example.test', to: [`${accountId}@example.test`], cc: [], subject: 'Launch', snippet: 'Launch plans', text: 'Launch plans', html: '<p>Launch</p>', labelIds: ['INBOX', 'UNREAD'], rawPath: `${id}.eml`, sizeEstimate: 30, attachments: [] }
          db.upsertMessage(message)
        }
        db.saveDraft({ accountId, to: [], cc: [], bcc: [], subject: 'Draft', text: 'Draft', attachmentPaths: [] })
      }
      const scope = unifiedViewAccountIds({ id: 'work', name: 'Work', accountIds: ['a', 'b'] }, 'inbox', ['a', 'b', 'excluded'])
      const rows: { accountId: string }[] = []
      let cursor: string | undefined
      do {
        const page = db.listThreads({ accountIds: scope, folder: 'inbox', search: 'Launch', pageSize: 3, cursor })
        expect(page.total).toBe(8)
        rows.push(...page.items); cursor = page.nextCursor
      } while (cursor)
      expect(rows).toHaveLength(8)
      expect(new Set(rows.map((row) => row.accountId))).toEqual(new Set(['a', 'b']))
      db.offline.saveSearchHits('search', ['a', 'b', 'excluded'].flatMap((accountId) => [0, 1, 2, 3].map((index) => ({ accountId, threadId: `${accountId}-${index}` }))))
      expect(db.listThreads({ accountIds: scope, folder: 'all', serverSearchId: 'search' }).items.every((row) => row.accountId !== 'excluded')).toBe(true)
      expect(db.folderUnreadCounts(scope).inbox).toBe(8)
      expect(db.listDrafts(scope).map((draft) => draft.accountId).sort()).toEqual(['a', 'b'])
      expect(db.listThreads({ accountIds: [], folder: 'all', search: 'Launch', cursor: 'anything' })).toEqual({ items: [], total: 0 })
      expect(db.listDrafts([])).toEqual([])
      expect(Object.values(db.folderUnreadCounts([])).every((count) => count === 0)).toBe(true)
      expect(db.listThreads({ folder: 'all' }).total).toBe(12)
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }) }
  })
})
