import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { MailDatabase } from './database'

it('paginates a synthetic 100,000-conversation mailbox without scanning it in JavaScript', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aerio-scale-test-'))
  const path = join(directory, 'aerio.sqlite')
  const database = new MailDatabase(path, join(directory, 'mail'))
  database.upsertAccount({
    id: 'scale',
    provider: 'gmail',
    email: 'scale@example.com',
    displayName: 'Scale',
    color: '#6558e8',
    status: 'ready',
    archived: false,
    signature: '',
    notifications: true,
    syncEnabled: true
  })
  database.close()

  const sqlite = new DatabaseSync(path)
  sqlite.exec('BEGIN')
  const insert = sqlite.prepare(`
    INSERT INTO gmail_threads(
      account_id,id,subject,participants_json,snippet,last_date,unread,starred,important,
      trashed,draft,sent,inbox,has_attachments,message_count,label_ids_json
    ) VALUES('scale',?,?,?,?,?,0,0,0,0,0,0,1,0,1,'["INBOX"]')
  `)
  for (let index = 0; index < 100_000; index += 1) {
    insert.run(`thread-${index.toString().padStart(6, '0')}`, `Subject ${index}`, '["Sender"]', `Snippet ${index}`, new Date(1_700_000_000_000 + index * 1_000).toISOString())
  }
  sqlite.exec('COMMIT')
  sqlite.close()

  const reopened = new MailDatabase(path, join(directory, 'mail'))
  const started = performance.now()
  const first = reopened.listThreads({ folder: 'inbox', pageSize: 50 })
  const elapsed = performance.now() - started
  expect(first.total).toBe(100_000)
  expect(first.items).toHaveLength(50)
  expect(first.nextCursor).toBeTruthy()
  expect(elapsed).toBeLessThan(2_000)
  reopened.close()
  rmSync(directory, { recursive: true, force: true })
}, 20_000)
