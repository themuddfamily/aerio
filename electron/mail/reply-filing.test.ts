import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { MailDatabase, type ParsedMailMessage } from './database'
import type { ApplyMailActionInput, MailAccountSummary } from '../../src/mail-types'

const open: { db: MailDatabase; path: string }[] = []
afterEach(() => { for (const { db, path } of open.splice(0)) { db.close(); rmSync(path, { recursive: true, force: true }) } })
const account: MailAccountSummary = { id: 'a', provider: 'gmail', email: 'me@example.test', displayName: 'Me', color: '#123456', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true }
const message = (overrides: Partial<ParsedMailMessage> = {}): ParsedMailMessage => ({ accountId: 'a', id: 'reply', threadId: 'reply-thread', historyId: '1', internalDate: new Date(Date.now() + 5000).toISOString(), fromName: 'Me', fromEmail: account.email, to: ['you@example.test'], cc: [], subject: 'Re: Planning', messageIdHeader: '<reply@test>', references: ['<original@test>'], snippet: '', text: 'Yes', html: '', labelIds: ['SENT'], sizeEstimate: 1, rawPath: 'missing', attachments: [], ...overrides })
function setup(provider: MailAccountSummary['provider'] = 'gmail') {
  const path = mkdtempSync(join(tmpdir(), 'aerio-reply-filing-'))
  const db = new MailDatabase(join(path, 'mail.sqlite'), join(path, 'content'))
  open.push({ db, path }); db.upsertAccount({ ...account, provider })
  db.replaceLabels('a', [{ accountId: 'a', id: 'project', name: 'Project', type: 'user' }, { accountId: 'a', id: 'folder:Project', name: 'Project', type: 'user' }])
  const put = (record: ParsedMailMessage) => { db.addInventory(record.accountId, [{ id: record.id, threadId: record.threadId }]); db.upsertMessage(record) }
  const queue = (input: ApplyMailActionInput, id: string) => db.applyLocalAction(input, crypto.randomUUID(), 0, [id])
  return { db, path, put, queue }
}
it('defaults off and only files new sent copies after enabling, preserving original and unrelated messages', () => {
  const { db, put, queue } = setup()
  const reply = message()
  put(message({ id: 'original', threadId: 'original-thread', messageIdHeader: '<original@test>', references: [], labelIds: ['INBOX', 'project'] }))
  put(reply); put(message({ id: 'unrelated', messageIdHeader: '<unrelated@test>' }))
  expect(db.replyFiling.enabled('a')).toBe(false)
  db.replyFiling.observe([reply]); expect(db.replyFiling.process('a', 'gmail', queue)).toEqual([])
  db.replyFiling.configure('a', true)
  db.replyFiling.observe([reply, message({ id: 'old', internalDate: '2020-01-01T00:00:00Z' })])
  expect(db.replyFiling.process('a', 'gmail', queue)).toHaveLength(2)
  const thread = db.getThread('a', 'reply-thread')
  expect(thread.messages.find((item) => item.id === 'reply')?.labelIds).toEqual(expect.arrayContaining(['SENT', 'INBOX', 'project']))
  expect(thread.messages.find((item) => item.id === 'unrelated')?.labelIds).toEqual(['SENT'])
  expect(db.getThread('a', 'original-thread').messages[0].labelIds).toEqual(['INBOX', 'project'])
  db.replyFiling.observe([message({ id: 'another-copy' })]); expect(db.replyFiling.process('a', 'gmail', queue)).toEqual([])
  expect(db.replyFiling.issues('a')).toEqual([])
})
it('waits for an uncached original, survives restart and never changes another account', () => {
  const { db, path, put } = setup()
  const reply = message(); put(reply); db.replyFiling.configure('a', true); db.replyFiling.observe([reply])
  expect(db.replyFiling.process('a', 'gmail', () => { throw Error('must wait') })).toEqual([])
  expect(db.replyFiling.issues('a')[0].reason).toMatch(/Waiting for the original/)
  db.close(); open.pop()
  const restored = new MailDatabase(join(path, 'mail.sqlite'), join(path, 'content')); open.push({ db: restored, path })
  restored.upsertAccount({ ...account, id: 'b', email: 'other@example.test' })
  const original = message({ id: 'original', accountId: 'b', messageIdHeader: '<original@test>', references: [], labelIds: ['INBOX'] })
  restored.addInventory('b', [{ id: original.id, threadId: original.threadId }]); restored.upsertMessage(original)
  expect(restored.replyFiling.process('a', 'gmail', () => { throw Error('cross-account') })).toEqual([])
  restored.addInventory('a', [{ id: 'original', threadId: 'original-thread' }]); restored.upsertMessage({ ...original, accountId: 'a', threadId: 'original-thread' })
  expect(restored.replyFiling.process('a', 'gmail', (input, id) => restored.applyLocalAction(input, crypto.randomUUID(), 0, [id]))).toHaveLength(1)
  expect(restored.replyFiling.process('a', 'gmail', () => { throw Error('duplicate') })).toEqual([])
})
it('rolls back all filing operations on failure and retries without ever sending mail', () => {
  const { db, put, queue } = setup()
  put(message({ id: 'original', messageIdHeader: '<original@test>', references: [], labelIds: ['INBOX', 'project'] }))
  const reply = message(); put(reply); db.replyFiling.configure('a', true); db.replyFiling.observe([reply])
  let count = 0
  expect(db.replyFiling.process('a', 'gmail', (input, id) => { if (++count === 2) throw Error('unavailable'); return queue(input, id) })).toEqual([])
  expect(db.getThread('a', 'reply-thread').messages.find((item) => item.id === 'reply')?.labelIds).toEqual(['SENT'])
  expect(db.replyFiling.issues('a')[0].reason).toMatch(/will not be sent again/)
  expect(db.replyFiling.process('a', 'gmail', queue)).toHaveLength(2)
  expect(db.replyFiling.issues('a')).toEqual([])
})
it('moves only the sent copy for folder providers and reports ambiguous locations for manual filing', () => {
  const { db, put, queue } = setup('microsoft')
  const reply = message(); put(reply)
  put(message({ id: 'original', threadId: 'original-thread', messageIdHeader: '<original@test>', references: [], labelIds: ['INBOX', 'folder:Project'] }))
  db.replyFiling.configure('a', true); db.replyFiling.observe([reply])
  expect(db.replyFiling.process('a', 'microsoft', queue)).toHaveLength(1)
  expect(db.getThread('a', 'reply-thread').messages[0].labelIds).toContain('folder:Project')
  const ambiguous = message({ id: 'ambiguous', messageIdHeader: '<ambiguous@test>', references: ['<multiple@test>'] }); put(ambiguous)
  put(message({ id: 'multiple', messageIdHeader: '<multiple@test>', references: [], labelIds: ['folder:Project', 'folder:Other'] }))
  db.replyFiling.observe([ambiguous]); expect(db.replyFiling.process('a', 'microsoft', queue)).toEqual([])
  expect(db.replyFiling.issues('a')[0].reason).toMatch(/several folder locations/)
  db.replyFiling.configure('a', false); expect(db.replyFiling.enabled('a')).toBe(false)
})
