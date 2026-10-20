import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { AddressInfo } from 'node:net'
import { generate } from 'selfsigned'
import { describe, expect, it } from 'vitest'
import { MailDatabase } from './database'
import { ImapSmtpClient } from './imap-client'
import { createCalendarMimeBuffer } from './mime-builder'
import { calendarPartsFromRaw } from './invitation-parts'
import { parseTaskItip } from '../../src/lib/task-delegation-itip'
const { SMTPServer } = createRequire(import.meta.url)('smtp-server')
describe('task request mail transport fixture', () => {
  it('delivers request, acceptance and completion over real authenticated TLS SMTP and recognizes received MIME', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aerio-task-smtp-'))
    const mail = new MailDatabase(join(root, 'mail.sqlite'), join(root, 'mail'))
    const generated = await generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }, { type: 2, value: 'localhost' }] }] })
    const received: Buffer[] = [], recipients: string[] = []
    const server = new SMTPServer({ secure: true, key: generated.private, cert: generated.cert, logger: false,
      onAuth: (auth: { username: string; password: string }, _session: unknown, callback: (error: Error | null, user?: { user: string }) => void) => auth.username === 'fixture' && auth.password === 'fixture-password' ? callback(null, { user: 'fixture' }) : callback(new Error('Invalid fixture credentials')),
      onRcptTo: (address: { address: string }, _session: unknown, callback: () => void) => { recipients.push(address.address); callback() },
      onData: (stream: NodeJS.ReadableStream, _session: unknown, callback: () => void) => { const chunks: Buffer[] = []; stream.on('data', (chunk) => chunks.push(Buffer.from(chunk))); stream.on('end', () => { received.push(Buffer.concat(chunks)); callback() }) }
    })
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      for (const email of ['assignor@example.test', 'assignee@example.test']) mail.upsertAccount({ id: email, email, provider: 'imap', displayName: email, color: '#6558e8', status: 'ready', archived: false, signature: '', notifications: false, syncEnabled: false })
      const client = new ImapSmtpClient({ provider: 'imap', email: 'assignor@example.test', username: 'fixture', password: 'fixture-password', imapHost: '127.0.0.1', imapPort: 1, imapSecurity: 'tls', smtpHost: '127.0.0.1', smtpPort: (server.server.address() as AddressInfo).port, smtpSecurity: 'tls' }, { ca: generated.cert })
      const deliver = async (id: string, from: string, to: string) => {
        const draft = mail.getDraftRecord(id)!, calendar = mail.taskDelegations.calendar(id)!
        await client.send(createCalendarMimeBuffer({ ...draft, ...calendar, from }), [to])
        mail.updateDraftResult(id, { id, status: 'sent', updatedAt: new Date().toISOString() })
        const parts = await calendarPartsFromRaw(received.at(-1)!)
        expect(parts).toHaveLength(1)
        return mail.taskDelegations.observe(to, from, [to], parts)!
      }
      const sent = mail.taskDelegations.assign({ accountId: 'assignor@example.test', assignee: 'assignee@example.test', title: 'TLS fixture request', due: '2026-12-03' })
      let task = await deliver(sent.deliveries[0].id, sent.organizer, sent.assignee)
      expect(task).toMatchObject({ role: 'assignee', participation: 'NEEDS-ACTION' })
      task = mail.taskDelegations.respond({ id: task.id, expectedUpdatedAt: task.updatedAt, response: 'accept' })
      const accepted = await deliver(task.deliveries[0].id, task.assignee, task.organizer)
      expect(accepted.participation).toBe('ACCEPTED')
      task = mail.taskDelegations.respond({ id: task.id, expectedUpdatedAt: task.updatedAt, response: 'complete' })
      const complete = await deliver(task.deliveries[0].id, task.assignee, task.organizer)
      expect(complete).toMatchObject({ status: 'COMPLETED', percent: 100 })
      expect(recipients).toEqual(['assignee@example.test', 'assignor@example.test', 'assignor@example.test'])
      expect((await calendarPartsFromRaw(received[0])).map(parseTaskItip)[0]?.method).toBe('REQUEST')
      expect(mail.taskDelegations.list().every((item) => item.deliveries.every((message) => message.status === 'sent'))).toBe(true)
    } finally {
      await new Promise<void>((resolve) => server.close(resolve)); mail.close()
      expect(relative(tmpdir(), root)).toMatch(/^aerio-task-smtp-[^\\/]+$/); rmSync(root, { recursive: true, force: true })
    }
  }, 15000)
})
