import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MailDatabase, type ParsedMailMessage } from './database'
import type { MailRule, MailRuleInput } from '../../src/mail-types'

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const input: MailRuleInput = { accountId: 'a', name: 'Scheduled project review', enabled: true, trigger: 'periodic', schedule: { intervalMinutes: 60, folder: 'inbox' }, match: 'all', conditions: [{ field: 'subject', operator: 'contains', value: 'project' }], actions: [{ action: 'star' }] }

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-periodic-'))
  directories.push(directory)
  const path = join(directory, 'mail.sqlite')
  const content = join(directory, 'content')
  const db = new MailDatabase(path, content)
  db.upsertAccount({ id: 'a', provider: 'imap', email: 'me@test', displayName: 'Me', color: '#123456', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true })
  const records = ['inbox', 'archive', 'sent', 'spam', 'trash', 'draft'].map((folder): ParsedMailMessage => ({
    accountId: 'a', id: folder, threadId: folder, historyId: '1', references: [], internalDate: '2026-01-01T12:00:00Z', fromName: '', fromEmail: 'team@test', to: [], cc: [], subject: 'Project report', snippet: '', text: '', html: '', rawPath: 'missing.eml', sizeEstimate: 1000, attachments: [],
    labelIds: folder === 'archive' ? [] : [({ inbox: 'INBOX', sent: 'SENT', spam: 'SPAM', trash: 'TRASH', draft: 'DRAFT' } as Record<string, string>)[folder]]
  }))
  db.addInventory('a', records.map(({ id, threadId }) => ({ id, threadId })))
  records.forEach((record) => db.upsertMessage(record))
  return { db, path, content }
}

function applyStar(db: MailDatabase, rule: MailRule, threadIds: string[]) {
  for (const threadId of threadIds) db.applyLocalAction({ accountId: rule.accountId, threadIds: [threadId], action: 'star' }, crypto.randomUUID(), 0)
}

describe('durable periodic rules', () => {
  it('queues one overdue pass across restart and persists the advanced deadline and operation together', () => {
    const { db, path, content } = setup()
    const rule = db.saveRule(input)
    const firstDeadline = Date.parse(rule.nextRunAt!)
    expect(db.dueScheduledRules(firstDeadline - 1)).toEqual([])
    expect(db.saveRule({ ...rule, name: 'Renamed' }).nextRunAt).toBe(rule.nextRunAt)
    db.close()
    const reopened = new MailDatabase(path, content)
    const overdue = firstDeadline + 7 * 86_400_000
    expect(reopened.dueScheduledRules(overdue)).toHaveLength(1)
    expect(reopened.runScheduledRule(rule.id, (current, ids) => applyStar(reopened, current, ids), overdue)).toBe(true)
    expect(reopened.getRule(rule.id)).toMatchObject({ matchCount: 1, nextRunAt: new Date(overdue + 3_600_000).toISOString() })
    expect(reopened.dueOperations()).toHaveLength(1)
    expect(reopened.dueOperations()[0].kind).toBe('star')
    expect(reopened.runScheduledRule(rule.id, () => { throw new Error('should not run twice') }, overdue)).toBe(false)
    reopened.close()
    const again = new MailDatabase(path, content)
    expect(again.dueScheduledRules(overdue)).toEqual([])
    expect(again.dueOperations()).toHaveLength(1)
    again.close()
  })

  it('rolls back changes, queued operations, counts and deadline on failure, allowing retry', () => {
    const { db } = setup()
    const rule = db.saveRule(input)
    const due = Date.parse(rule.nextRunAt!)
    expect(() => db.runScheduledRule(rule.id, (current, ids) => { applyStar(db, current, ids); throw new Error('interrupted') }, due)).toThrow('interrupted')
    expect(db.getRule(rule.id)).toMatchObject({ matchCount: 0, nextRunAt: rule.nextRunAt })
    expect(db.dueOperations()).toEqual([])
    expect(db.getThread('a', 'inbox')?.messages[0].labelIds).not.toContain('STARRED')
    expect(db.runScheduledRule(rule.id, (current, ids) => applyStar(db, current, ids), due)).toBe(true)
    expect(db.dueOperations()).toHaveLength(1)
    db.close()
  })

  it('honors folder scope, exceptions, disabled rules, and paused or archived accounts', () => {
    const { db } = setup()
    const rule = db.saveRule(input)
    for (const [folder, ids] of [['inbox', ['inbox']], ['archive', ['archive']], ['sent', ['sent']], ['all', ['archive', 'inbox', 'sent']]] as const) {
      const configured = db.saveRule({ ...rule, schedule: { intervalMinutes: 15, folder } })
      expect(db.matchingThreadIdsForRule(configured).sort()).toEqual([...ids])
    }
    const except = db.saveRule({ ...rule, exceptions: [{ field: 'from', operator: 'equals', value: 'team@test' }] })
    expect(db.matchingThreadIdsForRule(except)).toEqual([])
    db.saveRule({ ...rule, enabled: false })
    expect(db.dueScheduledRules(Date.now() + 86_400_000)).toEqual([])
    const enabled = db.saveRule(rule)
    const due = Date.parse(enabled.nextRunAt!)
    db.setAccountStatus('a', 'paused')
    expect(db.dueScheduledRules(due)).toEqual([])
    db.setAccountStatus('a', 'ready')
    expect(db.dueScheduledRules(due)).toHaveLength(1)
    db.disconnectAccount('a', 'archive')
    expect(db.dueScheduledRules(due)).toEqual([])
    db.close()
  })

  it('advances empty passes and resets cadence on interval changes, removing it for other triggers', () => {
    const { db } = setup()
    const rule = db.saveRule({ ...input, conditions: [{ field: 'subject', operator: 'equals', value: 'No match' }] })
    const due = Date.parse(rule.nextRunAt!)
    db.runScheduledRule(rule.id, (_rule, ids) => expect(ids).toEqual([]), due)
    expect(db.dueScheduledRules(due)).toEqual([])
    const rescheduled = db.saveRule({ ...rule, schedule: { intervalMinutes: 5, folder: 'inbox' } })
    expect(Date.parse(rescheduled.nextRunAt!)).toBeLessThan(due)
    expect(db.saveRule({ ...rescheduled, trigger: 'incoming' }).nextRunAt).toBeUndefined()
    expect(() => db.saveRule({ ...input, schedule: { intervalMinutes: 0, folder: 'inbox' } })).toThrow('interval')
    db.close()
  })
})
