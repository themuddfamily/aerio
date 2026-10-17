import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FakePop3Server } from './mail/pop3-test-server'

// Runs the real mail worker (real SQLite store, real POP3 client against a
// disposable loopback server) with only the worker port and the SMTP sender
// replaced, to check how POP3 accounts are wired into sync, drafts and sending.

const mocks = vi.hoisted(() => {
  const posted: any[] = []
  let handler: ((message: any) => void) | undefined
  let credential: any
  const port = {
    on: vi.fn((_event: string, callback: (message: any) => void) => { handler = callback }),
    postMessage: vi.fn((message: any) => {
      posted.push(message)
      if (message.kind === 'credential-request') queueMicrotask(() => handler?.({ kind: 'credential-response', id: message.id, credential }))
    })
  }
  const smtp = { send: vi.fn(async () => undefined), verifySmtp: vi.fn(async () => undefined) }
  return {
    port, posted, smtp,
    ImapSmtpClient: vi.fn(function () { return smtp }),
    setCredential(value: any) { credential = value },
    emit(message: any) { handler?.(message) }
  }
})

vi.mock('node:worker_threads', () => ({ parentPort: mocks.port }))
vi.mock('./mail/imap-client', () => ({ ImapSmtpClient: mocks.ImapSmtpClient, labelsForImapFolders: vi.fn(() => []) }))

let nextId = 0
async function request(command: any) {
  const id = `pop3-request-${++nextId}`
  mocks.emit({ kind: 'request', id, command })
  await vi.waitFor(() => expect(mocks.posted.some((message) => message.kind === 'response' && message.id === id)).toBe(true), { timeout: 10_000 })
  const response = mocks.posted.find((message) => message.kind === 'response' && message.id === id)
  if (response.error) throw new Error(response.error.message)
  return response.result
}

const ACCOUNT = 'pop3-worker-account'
const raw = (id: string) => `From: Ada <ada@example.test>\r\nTo: me@example.test\r\nSubject: ${id}\r\nMessage-ID: <${id}@example.test>\r\nDate: Wed, 15 Oct 2025 12:00:00 +0000\r\n\r\nBody of ${id}\r\n`
const directory = mkdtempSync(join(tmpdir(), 'aerio-pop3-worker-'))
const server = new FakePop3Server({ mode: 'plain', messages: [{ uidl: 'w1', raw: raw('first') }, { uidl: 'w2', raw: raw('second') }] })

beforeAll(async () => {
  await server.start()
  await import('./mail-worker')
  await request({ type: 'initialize', payload: { databasePath: join(directory, 'aerio.sqlite'), contentPath: join(directory, 'mail') } })
  const config = { email: 'me@example.test', username: 'ada', password: 'secret', pop3Host: '127.0.0.1', pop3Port: server.port, pop3Security: 'none', allowPlaintext: true, auth: 'auto', smtpHost: 'smtp.example.test', smtpPort: 587, smtpSecurity: 'starttls' }
  mocks.setCredential({ type: 'pop3', config })
  await request({ type: 'accounts:upsert', payload: { id: ACCOUNT, provider: 'pop3', email: 'me@example.test', displayName: 'Me', color: '#123456', status: 'connecting', archived: false, signature: '', notifications: true, syncEnabled: true } })
  await request({ type: 'pop3', payload: { action: 'settings:save', accountId: ACCOUNT, settings: { server: config, retention: { leaveOnServer: true, removeWhenDeleted: false }, destination: { kind: 'account' } } } })
}, 30_000)

afterAll(async () => {
  await request({ type: 'shutdown' }).catch(() => undefined)
  await server.close()
  rmSync(directory, { recursive: true, force: true })
})

const subjects = async (folder: string) => ((await request({ type: 'mail:list', payload: { accountIds: [ACCOUNT], folder, pageSize: 50 } })).items as { subject: string }[]).map((item) => item.subject).sort()

describe.sequential('mail worker with a POP3 account', () => {
  it('downloads POP3 mail into the account Inbox through the normal sync path', async () => {
    await request({ type: 'sync:start', payload: { accountId: ACCOUNT } })
    await vi.waitFor(async () => expect(await subjects('inbox')).toEqual(['first', 'second']), { timeout: 10_000 })
    await vi.waitFor(async () => expect((await request({ type: 'accounts:list' })).find((account: any) => account.id === ACCOUNT).status).toBe('ready'))
    expect(await request({ type: 'pop3', payload: { action: 'status', accountId: ACCOUNT } })).toMatchObject({ downloaded: 2, onServer: 2 })
    server.add({ uidl: 'w3', raw: raw('third') })
    await request({ type: 'sync:start', payload: { accountId: ACCOUNT } })
    await vi.waitFor(async () => expect(await subjects('inbox')).toEqual(['first', 'second', 'third']), { timeout: 10_000 })
    expect(server.commands.filter((command) => command.startsWith('RETR'))).toHaveLength(3)
  })

  it('tests the POP3 and SMTP servers without downloading', async () => {
    const before = server.commands.filter((command) => command.startsWith('RETR')).length
    await request({ type: 'accounts:verify', payload: { accountId: ACCOUNT } })
    expect(mocks.smtp.verifySmtp).toHaveBeenCalled()
    expect(server.commands.filter((command) => command.startsWith('RETR'))).toHaveLength(before)
    expect(mocks.ImapSmtpClient).toHaveBeenCalledWith(expect.objectContaining({ smtpHost: 'smtp.example.test', smtpPort: 587, smtpSecurity: 'starttls', username: 'ada' }))
  })

  it('keeps drafts on this computer and sends through the SMTP Outbox, keeping a local Sent copy', async () => {
    const draft = { id: 'pop3-draft', accountId: ACCOUNT, to: ['bob@example.test'], cc: [], bcc: [], subject: 'Reply from POP3', text: 'Hello', references: [], attachmentPaths: [] }
    expect(await request({ type: 'drafts:save', payload: draft })).toMatchObject({ status: 'local' })
    await request({ type: 'drafts:schedule', payload: { input: draft, deliveryAt: new Date(Date.now() - 1_000).toISOString() } })
    await vi.waitFor(() => expect(mocks.smtp.send).toHaveBeenCalledWith(expect.any(Buffer), ['bob@example.test'], undefined), { timeout: 10_000 })
    await vi.waitFor(async () => expect(await subjects('sent')).toEqual(['Reply from POP3']), { timeout: 10_000 })
  })

  it('explains that POP3 folders cannot be rebuilt or hold copies', async () => {
    await expect(request({ type: 'sync:rebuild', payload: { accountId: ACCOUNT } })).rejects.toThrow(/nothing to rebuild/)
    await expect(request({ type: 'mail:copy', payload: { accountId: ACCOUNT, threadId: 't', messageId: 'm', destination: 'folder:x' } })).rejects.toThrow(/copy it to Local Folders/)
  })

  it('completes POP3 mail changes locally without a provider call', async () => {
    const sessions = server.sessions
    const clients = mocks.ImapSmtpClient.mock.calls.length
    const page = await request({ type: 'mail:list', payload: { accountIds: [ACCOUNT], folder: 'inbox', pageSize: 50 } })
    const operation = await request({ type: 'mail:action', payload: { accountId: ACCOUNT, threadIds: [page.items[0].id], action: 'read' } })
    expect(operation.status).toBe('queued')
    const folder = await request({ type: 'folders:create', payload: { accountId: ACCOUNT, name: 'Receipts' } })
    expect(folder.label).toMatchObject({ name: 'Receipts', type: 'user' })
    expect(await request({ type: 'mail:undo', payload: { operationId: operation.id } })).toBe(true)
    // Neither the change nor the folder touched the POP3 or SMTP servers.
    expect(server.sessions).toBe(sessions)
    expect(mocks.ImapSmtpClient.mock.calls.length).toBe(clients)
  })
})
