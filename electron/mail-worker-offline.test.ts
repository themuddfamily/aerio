import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mime } from './mail/offline-test-fixtures'

/**
 * The mail worker's provider sync paths under an offline scope (E36), with a
 * real mail database and scripted provider clients (no network).
 */

const fake = vi.hoisted(() => {
  const posted: any[] = []
  let handler: ((message: any) => void) | undefined
  const credentials: Record<string, any> = {}
  return {
    posted,
    credentials,
    port: {
      on: (_event: string, callback: (message: any) => void) => { handler = callback },
      postMessage: (message: any) => {
        posted.push(message)
        if (message.kind === 'credential-request') queueMicrotask(() => handler?.({ kind: 'credential-response', id: message.id, credential: credentials[message.accountId] }))
      }
    },
    emit(message: any) { handler?.(message) },
    gmail: undefined as any,
    imap: undefined as any,
    graph: undefined as any
  }
})

vi.mock('node:worker_threads', () => ({ parentPort: fake.port }))
vi.mock('./mail/gmail-client', async (importOriginal) => ({ ...await importOriginal<typeof import('./mail/gmail-client')>(), GmailClient: vi.fn(function () { return fake.gmail }) }))
vi.mock('./mail/imap-client', async (importOriginal) => ({ ...await importOriginal<typeof import('./mail/imap-client')>(), ImapSmtpClient: vi.fn(function () { return fake.imap }) }))
vi.mock('./mail/microsoft-client', async (importOriginal) => ({ ...await importOriginal<typeof import('./mail/microsoft-client')>(), MicrosoftGraphClient: vi.fn(function () { return fake.graph }) }))

import './mail-worker'

const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY)
let nextId = 0
let directory = ''

async function request<T = any>(command: any): Promise<T> {
  const id = `offline-${++nextId}`
  fake.emit({ kind: 'request', id, command })
  let response: any
  await vi.waitFor(() => {
    response = fake.posted.find((message) => message.kind === 'response' && message.id === id)
    expect(response).toBeTruthy()
  }, { timeout: 10_000 })
  if (response.error) throw new Error(response.error.message)
  return response.result
}

const account = (id: string, provider: string) => ({ id, provider, email: `${id}@example.com`, displayName: id, color: '#123456', status: 'ready', archived: false, signature: '', notifications: false, syncEnabled: true })
const idle = (accountId: string) => vi.waitFor(async () => {
  const [progress] = (await request<any[]>({ type: 'sync:progress' })).filter((item) => item.accountId === accountId)
  expect(['complete', 'error']).toContain(progress?.phase)
  if (progress.phase === 'error') throw new Error(progress.message)
}, { timeout: 10_000 })

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'aerio-worker-offline-'))
  await request({ type: 'initialize', payload: { databasePath: join(directory, 'aerio.sqlite'), contentPath: join(directory, 'mail') } })
})

afterAll(async () => {
  await request({ type: 'shutdown' })
  rmSync(directory, { recursive: true, force: true })
})

describe('mail worker offline scope (E36)', () => {
  it('Gmail: lists with after:, stores headers, backfills with before: when widened, and downloads on open', async () => {
    const messages: Record<string, { date: Date; labels: string[] }> = { recent: { date: ago(3), labels: ['INBOX'] }, older: { date: ago(60), labels: ['INBOX'] } }
    const headers = (id: string) => [{ name: 'Subject', value: `Gmail ${id}` }, { name: 'From', value: 'ada@example.com' }, { name: 'Message-ID', value: `<${id}@g>` }]
    const resource = (id: string) => ({ id, threadId: `t-${id}`, labelIds: messages[id].labels, historyId: '7', internalDate: String(messages[id].date.getTime()) })
    fake.gmail = {
      getProfile: vi.fn(async () => ({ historyId: '7' })),
      listLabels: vi.fn(async () => [{ accountId: 'gmail-1', id: 'INBOX', name: 'INBOX', type: 'system' }]),
      listMessages: vi.fn(async (_page?: string, query?: string) => {
        const after = Number(query?.match(/after:(\d+)/)?.[1] ?? 0) * 1000
        const before = Number(query?.match(/before:(\d+)/)?.[1] ?? Infinity) * 1000
        return { messages: Object.keys(messages).filter((id) => messages[id].date.getTime() > after && messages[id].date.getTime() < before).map((id) => ({ id, threadId: `t-${id}` })) }
      }),
      getMessage: vi.fn(async (id: string) => ({ ...resource(id), payload: { headers: headers(id) } })),
      getRawMessage: vi.fn(async (id: string) => ({ ...resource(id), raw: mime({ messageId: `<${id}@g>`, subject: `Gmail ${id}`, date: messages[id].date.toISOString(), body: `Full body of ${id}` }).toString('base64url') })),
      listHistory: vi.fn(async () => ({ history: [], historyId: '8' }))
    }
    fake.credentials['gmail-1'] = { type: 'oauth', accessToken: 'token' }
    await request({ type: 'accounts:upsert', payload: account('gmail-1', 'gmail') })
    await request({ type: 'offline:set-account-policy', payload: { accountId: 'gmail-1', policy: { downloadMode: 'headers', window: { unit: 'days', amount: 30 } } } })
    await idle('gmail-1')
    await vi.waitFor(async () => expect((await request<any>({ type: 'offline:availability', payload: { accountId: 'gmail-1' } })).total).toBe(1))
    expect(fake.gmail.listMessages.mock.calls[0][1]).toMatch(/^after:\d+$/)
    expect(fake.gmail.getRawMessage).not.toHaveBeenCalled()
    expect(await request({ type: 'offline:availability', payload: { accountId: 'gmail-1' } })).toMatchObject({ headersOnly: 1, full: 0 })

    // Widening to all mail lists only the newly included range, then downloads it.
    await request({ type: 'offline:set-account-policy', payload: { accountId: 'gmail-1', policy: { downloadMode: 'headers', window: { unit: 'all', amount: 0 } } } })
    await vi.waitFor(async () => expect((await request<any>({ type: 'offline:availability', payload: { accountId: 'gmail-1' } })).total).toBe(2), { timeout: 10_000 })
    expect(fake.gmail.listMessages.mock.calls.at(-1)[1]).toMatch(/^before:\d+$/)

    // Opening a header-only message downloads it; offline it shows the notice instead.
    await request({ type: 'network', payload: { online: false } })
    const offlineThread = await request<any>({ type: 'mail:thread', payload: { accountId: 'gmail-1', threadId: 't-older' } })
    expect(offlineThread.messages[0].offline).toEqual({ state: 'headers', notice: 'Not downloaded — connect to load' })
    await request({ type: 'network', payload: { online: true } })
    const thread = await request<any>({ type: 'mail:thread', payload: { accountId: 'gmail-1', threadId: 't-older' } })
    expect(thread.messages[0].text).toContain('Full body of older')
    expect(thread.messages[0].offline).toBeUndefined()
    expect(fake.gmail.getRawMessage).toHaveBeenCalledWith('older')
    // Search reports the headers-only mailbox and searches the server.
    const [coverage] = await request<any[]>({ type: 'offline:search-coverage', payload: { accountIds: ['gmail-1'] } })
    expect(coverage).toMatchObject({ complete: false, serverSearch: true })
  })

  it('IMAP: SEARCH SINCE limits which UIDs are downloaded, and ENVELOPE/BODYSTRUCTURE replaces BODY[] for headers', async () => {
    const folder = { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' }
    fake.imap = {
      withConnection: vi.fn(async (callback: (connection: unknown) => Promise<unknown>) => callback({})),
      listFolders: vi.fn(async () => [folder]),
      inventoryFolder: vi.fn(async () => ({
        uidValidity: '5', uidNext: 3, windowUids: new Set([2]),
        refs: [{ id: 'imap-old', threadId: 'x1', folder: 'INBOX', uid: 1, uidValidity: '5', labels: ['folder:INBOX', 'INBOX'] }, { id: 'imap-new', threadId: 'x2', folder: 'INBOX', uid: 2, uidValidity: '5', labels: ['folder:INBOX', 'INBOX'] }]
      })),
      fetchPartial: vi.fn(async () => ({ headers: 'Subject: IMAP new\r\nMessage-ID: <n@i>\r\n\r\n', text: '', html: '', attachments: [], internalDate: ago(1).toISOString(), labels: ['folder:INBOX', 'INBOX'], size: 50 })),
      fetchRaw: vi.fn()
    }
    fake.credentials['imap-1'] = { type: 'imap', config: { email: 'imap-1@example.com' } }
    await request({ type: 'accounts:upsert', payload: account('imap-1', 'imap') })
    await request({ type: 'offline:set-account-policy', payload: { accountId: 'imap-1', policy: { downloadMode: 'headers', window: { unit: 'days', amount: 7 } } } })
    await idle('imap-1')
    await vi.waitFor(async () => expect((await request<any>({ type: 'offline:availability', payload: { accountId: 'imap-1' } })).headersOnly).toBe(1))
    expect(fake.imap.inventoryFolder.mock.calls[0][2]).toBeInstanceOf(Date)
    expect(fake.imap.fetchRaw).not.toHaveBeenCalled()
    expect(fake.imap.fetchPartial).toHaveBeenCalledWith({}, folder, 2, false)
  })

  it('Microsoft: starts a receivedDateTime-filtered delta and selects header fields', async () => {
    fake.graph = {
      listFolders: vi.fn(async () => [{ id: 'f-inbox', displayName: 'Inbox', specialUse: 'inbox' }]),
      delta: vi.fn(async () => ({ messages: [{ id: 'g-new', conversationId: 'c-new', receivedDateTime: ago(1).toISOString() }], deltaLink: 'next' })),
      messageFields: vi.fn(async (id: string) => ({ id, subject: 'Graph new', internetMessageId: '<g@x>', receivedDateTime: ago(1).toISOString() })),
      attachmentList: vi.fn(async () => []),
      messageRaw: vi.fn()
    }
    fake.credentials['ms-1'] = { type: 'oauth', accessToken: 'token' }
    await request({ type: 'accounts:upsert', payload: account('ms-1', 'microsoft') })
    await request({ type: 'offline:set-account-policy', payload: { accountId: 'ms-1', policy: { downloadMode: 'headers', window: { unit: 'months', amount: 1 } } } })
    await idle('ms-1')
    await vi.waitFor(async () => expect((await request<any>({ type: 'offline:availability', payload: { accountId: 'ms-1' } })).headersOnly).toBe(1))
    expect(fake.graph.delta.mock.calls[0][2]).toBeInstanceOf(Date)
    expect(fake.graph.messageFields).toHaveBeenCalledWith('g-new', false)
    expect(fake.graph.messageRaw).not.toHaveBeenCalled()
  })
})
