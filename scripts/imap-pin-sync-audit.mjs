import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import hoodiecrow from 'hoodiecrow-imap'
import { generate } from 'selfsigned'
import { ImapSmtpClient } from '../electron/mail/imap-client.ts'
import { MailDatabase } from '../electron/mail/database.ts'

// Disposable real IMAP protocol exercise; no user mailbox or credentials are used.
const directory = mkdtempSync(join(tmpdir(), 'aerio-pin-audit-'))
const certificates = await generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, algorithm: 'sha256' })
const raw = 'From: Sender <sender@example.test>\r\nTo: testuser@example.test\r\nSubject: Pin audit\r\nMessage-ID: <pin-audit@example.test>\r\n\r\nFixture body'
const server = hoodiecrow({ secureConnection: true, credentials: { key: certificates.private, cert: certificates.cert }, plugins: ['ID', 'NAMESPACE', 'UNSELECT'], storage: { INBOX: { messages: [{ raw }] } } })
const sockets = new Set(), databases = new Set()
server.server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
const open = (name) => {
  const db = new MailDatabase(join(directory, `${name}.sqlite`), join(directory, name)); databases.add(db)
  db.upsertAccount({ id: 'a', provider: 'imap', email: 'testuser@example.test', displayName: 'Fixture', color: '#000', status: 'ready', archived: false, signature: '', notifications: true, syncEnabled: true })
  return db
}
try {
  await new Promise((done, reject) => { server.server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const client = new ImapSmtpClient({ provider: 'imap', email: 'testuser@example.test', username: 'testuser', password: 'testpass', imapHost: '127.0.0.1', imapPort: server.server.address().port, imapSecurity: 'tls', smtpHost: '127.0.0.1', smtpPort: 1, smtpSecurity: 'tls', allowInvalidCertificates: true })
  const sync = async (db) => client.withConnection(async (connection) => {
    const folder = (await client.listFolders(connection)).find((item) => item.path === 'INBOX')
    const inventory = await client.inventoryFolder(connection, folder)
    assert.equal(inventory.pinSync.mode, 'imap-keyword')
    db.pinSync.recordFolder('a', 'INBOX', inventory.pinSync)
    for (const ref of inventory.refs) db.upsertMessage({ accountId: 'a', id: ref.id, threadId: ref.threadId, historyId: `${ref.uidValidity}:${ref.uid}`, references: [], internalDate: '2026-10-20T09:00:00Z', fromName: 'Sender', fromEmail: 'sender@example.test', to: ['testuser@example.test'], cc: [], subject: 'Pin audit', snippet: 'Fixture body', text: 'Fixture body', html: '', labelIds: ref.labels, rawPath: '', sizeEstimate: raw.length, attachments: [], remoteFolderId: ref.folder, remoteUid: String(ref.uid) })
    db.reconcileImapPins('a')
    return inventory.refs[0]
  })
  let first = open('first')
  const second = open('second')
  const ref = await sync(first)
  await sync(second)
  first.applyLocalAction({ accountId: 'a', threadIds: [ref.threadId], action: 'pin' }, 'pin', 0)
  first.close(); databases.delete(first)
  first = open('first')
  assert.equal(first.dueOperations()[0].id, 'pin', 'The native operation survives restart')
  const readback = await client.setPinned(first.pinSync.targets('a', [ref.threadId]), true)
  first.pinSync.acknowledge('a', readback); first.updateOperation('pin', 'succeeded'); first.reconcileImapPins('a')
  await sync(second)
  assert.ok(second.pins.pinnedAt('a', ref.threadId), 'A second installation imports the server pin')
  assert.equal(second.listThreads({ folder: 'all' }).items[0].starred, false, 'Pinning never stars mail')
  await client.setPinned(second.pinSync.targets('a', [ref.threadId]), false)
  await sync(first)
  assert.equal(first.pins.pinnedAt('a', ref.threadId), undefined, 'An external unpin reads back')
  assert.equal(server.getMailbox('INBOX').messages[0].flags.includes('\\Flagged'), false)
  console.log('IMAP pin audit passed: permanent-keyword capability, STORE/FETCH, durable restart, second-installation readback, external unpin, and star independence.')
} finally {
  for (const db of databases) db.close()
  for (const socket of sockets) socket.destroy()
  if (server.server.listening) await new Promise((done) => server.close(done))
  const target = resolve(directory), temporaryRoot = resolve(tmpdir()) + sep
  if (!target.startsWith(temporaryRoot) || !basename(target).startsWith('aerio-pin-audit-')) throw new Error('Unexpected audit cleanup path')
  rmSync(target, { recursive: true, force: true })
}
