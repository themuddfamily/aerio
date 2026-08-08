import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImapAccountInput, MailActionKind } from '../../src/mail-types'

const mocks = vi.hoisted(() => ({
  createTransport: vi.fn(),
  imapConstructor: vi.fn()
}))

vi.mock('imapflow', () => ({ ImapFlow: mocks.imapConstructor }))
vi.mock('nodemailer', () => ({ default: { createTransport: mocks.createTransport } }))

import {
  ImapSmtpClient,
  imapMessageLabels,
  labelsForImapFolders,
  normalizeImapFolders,
  type ImapFolder,
  type ImapMessageRef
} from './imap-client'

const config: ImapAccountInput = {
  provider: 'imap',
  email: 'person@example.test',
  username: 'person',
  password: 'secret',
  imapHost: 'imap.example.test',
  imapPort: 993,
  imapSecurity: 'tls',
  smtpHost: 'smtp.example.test',
  smtpPort: 587,
  smtpSecurity: 'starttls'
}

const lock = () => ({ release: vi.fn() })

function connectedClient(overrides: Record<string, unknown> = {}) {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    ...overrides
  }
}

function useConnection(subject: ImapSmtpClient, client: Record<string, unknown>) {
  vi.spyOn(subject, 'withConnection').mockImplementation(async (callback) => callback(client as never))
}

describe('IMAP message labels', () => {
  it('retains custom keywords while normalizing system flags', () => {
    const labels = imapMessageLabels(
      { path: 'INBOX', name: 'Inbox', specialUse: '\\Inbox' },
      new Set(['\\Seen', '\\Flagged', '$Important', 'Avast: Scanned'])
    )
    expect(labels).toEqual(expect.arrayContaining(['INBOX', 'STARRED', 'IMPORTANT', 'keyword:Avast: Scanned']))
    expect(labels).not.toContain('UNREAD')
  })

  it.each([
    ['\\Sent', 'SENT'],
    ['\\Drafts', 'DRAFT'],
    ['\\Junk', 'SPAM'],
    ['\\Trash', 'TRASH'],
    ['\\Archive', 'ARCHIVE'],
    ['\\All', 'ARCHIVE']
  ])('maps the %s special-use folder to %s', (specialUse, expected) => {
    expect(imapMessageLabels({ path: 'Other', name: 'Other', specialUse }, new Set())).toEqual(
      expect.arrayContaining([`folder:Other`, expected, 'UNREAD'])
    )
  })

  it('recognizes the alternate Important keyword and skips system flags', () => {
    expect(imapMessageLabels({ path: 'Inbox', name: 'Inbox' }, new Set(['Important', '\\Answered']))).toEqual([
      'folder:Inbox', 'INBOX', 'UNREAD', 'IMPORTANT'
    ])
  })
})

describe('IMAP folders and inventory', () => {
  const subject = new ImapSmtpClient(config)

  it('filters non-selectable folders and normalizes provider folder results', async () => {
    const folders = [
      { path: 'INBOX', name: 'Inbox', specialUse: '\\Inbox', flags: new Set<string>() },
      { path: '[Provider]', name: '[Provider]', flags: new Set(['\\Noselect']) }
    ]
    const client = { list: vi.fn().mockResolvedValue(folders) }
    await expect(subject.listFolders(client as never)).resolves.toEqual([
      { path: 'INBOX', name: 'Inbox', specialUse: '\\Inbox' }
    ])
    expect(client.list).toHaveBeenCalledWith({ statusQuery: expect.objectContaining({ messages: true, uidValidity: true }) })
    expect(normalizeImapFolders(folders as never)).toEqual([
      { path: 'INBOX', name: 'Inbox', specialUse: '\\Inbox' },
      { path: '[Provider]', name: '[Provider]', specialUse: undefined }
    ])
  })

  it('classifies system and user folders as labels', () => {
    expect(labelsForImapFolders('account-1', [
      { path: 'INBOX', name: 'Inbox' },
      { path: 'Sent', name: 'Sent', specialUse: '\\Sent' },
      { path: 'Projects', name: 'Projects' }
    ])).toEqual([
      { accountId: 'account-1', id: 'folder:INBOX', name: 'INBOX', type: 'system' },
      { accountId: 'account-1', id: 'folder:Sent', name: 'Sent', type: 'system' },
      { accountId: 'account-1', id: 'folder:Projects', name: 'Projects', type: 'user' }
    ])
  })

  it('returns metadata for an empty folder and always releases its lock', async () => {
    const mailboxLock = lock()
    const client = {
      mailbox: { uidValidity: 25n, highestModseq: 42n, uidNext: 7 },
      getMailboxLock: vi.fn().mockResolvedValue(mailboxLock),
      search: vi.fn().mockResolvedValue(false)
    }
    await expect(subject.inventoryFolder(client as never, { path: 'INBOX', name: 'Inbox' })).resolves.toEqual({
      refs: [], uidValidity: '25', highestModseq: '42', uidNext: 7
    })
    expect(mailboxLock.release).toHaveBeenCalledOnce()
  })

  it('creates stable local references for every fetched message', async () => {
    const mailboxLock = lock()
    const fetch = vi.fn(async function* () {
      yield { uid: 3, threadId: 'provider-thread', flags: new Set(['\\Seen']) }
      yield { uid: 4, envelope: { inReplyTo: '<parent@example.test>' } }
      yield { uid: 5, envelope: { messageId: '<message@example.test>' }, flags: new Set(['Important']) }
      yield { uid: 6 }
    })
    const client = {
      mailbox: { uidValidity: 25n, uidNext: 9 },
      getMailboxLock: vi.fn().mockResolvedValue(mailboxLock),
      search: vi.fn().mockResolvedValue([3, 4, 5, 6]),
      fetch
    }
    const result = await subject.inventoryFolder(client as never, { path: 'INBOX', name: 'Inbox' })
    expect(result.refs).toHaveLength(4)
    expect(result.refs[0]).toMatchObject({ threadId: 'provider-thread', folder: 'INBOX', uid: 3, uidValidity: '25' })
    expect(new Set(result.refs.map((row) => row.id)).size).toBe(4)
    expect(result.refs[2].labels).toContain('IMPORTANT')
    expect(fetch).toHaveBeenCalledWith([3, 4, 5, 6], expect.objectContaining({ uid: true, threadId: true }), { uid: true })
    expect(mailboxLock.release).toHaveBeenCalledOnce()
  })

  it('rejects a folder that the server could not open', async () => {
    const mailboxLock = lock()
    const client = { mailbox: false, getMailboxLock: vi.fn().mockResolvedValue(mailboxLock) }
    await expect(subject.inventoryFolder(client as never, { path: 'Missing', name: 'Missing' })).rejects.toThrow('Could not open Missing')
    expect(mailboxLock.release).toHaveBeenCalledOnce()
  })

  it('fetches raw content with provider and fallback metadata', async () => {
    const mailboxLock = lock()
    const source = Buffer.from('Subject: Hello\r\n\r\nBody')
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue(mailboxLock),
      fetchOne: vi.fn().mockResolvedValue({ source, internalDate: new Date('2026-08-08T10:00:00Z'), flags: new Set(), size: 100 })
    }
    const ref = { uid: 3 } as ImapMessageRef
    await expect(subject.fetchRaw(client as never, { path: 'INBOX', name: 'Inbox' }, ref)).resolves.toMatchObject({
      raw: source, internalDate: '2026-08-08T10:00:00.000Z', size: 100
    })

    client.fetchOne.mockResolvedValueOnce({ source })
    const fallback = await subject.fetchRaw(client as never, { path: 'Archive', name: 'Archive' }, ref)
    expect(fallback.size).toBe(source.byteLength)
    expect(new Date(fallback.internalDate).getTime()).not.toBeNaN()
    expect(mailboxLock.release).toHaveBeenCalledTimes(2)
  })

  it('rejects a message that disappeared and releases its lock', async () => {
    const mailboxLock = lock()
    const client = { getMailboxLock: vi.fn().mockResolvedValue(mailboxLock), fetchOne: vi.fn().mockResolvedValue(false) }
    await expect(subject.fetchRaw(client as never, { path: 'INBOX', name: 'Inbox' }, { uid: 99 } as ImapMessageRef))
      .rejects.toThrow('Message UID 99 is no longer available in INBOX')
    expect(mailboxLock.release).toHaveBeenCalledOnce()
  })
})

describe('IMAP actions and drafts', () => {
  let subject: ImapSmtpClient
  let client: Record<string, ReturnType<typeof vi.fn>>
  let mailboxLock: ReturnType<typeof lock>

  beforeEach(() => {
    subject = new ImapSmtpClient(config)
    mailboxLock = lock()
    client = {
      getMailboxLock: vi.fn().mockResolvedValue(mailboxLock),
      messageMove: vi.fn().mockResolvedValue(undefined),
      messageFlagsAdd: vi.fn().mockResolvedValue(undefined),
      messageFlagsRemove: vi.fn().mockResolvedValue(undefined),
      messageDelete: vi.fn().mockResolvedValue(undefined),
      append: vi.fn().mockResolvedValue({ uid: 88 })
    }
    useConnection(subject, client)
    vi.spyOn(subject, 'listFolders').mockResolvedValue([
      { path: 'INBOX', name: 'Inbox', specialUse: '\\Inbox' },
      { path: 'Archive', name: 'Archive', specialUse: '\\Archive' },
      { path: 'Trash', name: 'Trash', specialUse: '\\Trash' },
      { path: 'Drafts', name: 'Drafts', specialUse: '\\Drafts' }
    ])
  })

  it.each([
    ['read', 'messageFlagsAdd', '\\Seen'],
    ['unread', 'messageFlagsRemove', '\\Seen'],
    ['star', 'messageFlagsAdd', '\\Flagged'],
    ['unstar', 'messageFlagsRemove', '\\Flagged'],
    ['important', 'messageFlagsAdd', '$Important'],
    ['unimportant', 'messageFlagsRemove', '$Important']
  ] as const)('applies the %s flag operation per source folder', async (action, method, flag) => {
    await subject.applyAction([{ folder: 'INBOX', uid: 1 }, { folder: 'INBOX', uid: 2 }], action)
    expect(client[method]).toHaveBeenCalledWith([1, 2], [flag], { uid: true })
    expect(mailboxLock.release).toHaveBeenCalledOnce()
  })

  it.each([
    ['trash', undefined, 'Trash', 'INBOX'],
    ['untrash', undefined, 'INBOX', 'Trash'],
    ['archive', undefined, 'Archive', 'INBOX'],
    ['unarchive', undefined, 'INBOX', 'Archive'],
    ['label', 'folder:Projects', 'Projects', 'INBOX'],
    ['move', 'folder:Projects', 'Projects', 'INBOX']
  ] as const)('moves messages for %s', async (action, labelId, destination, source) => {
    await subject.applyAction([{ folder: source, uid: 7 }], action as MailActionKind, labelId)
    expect(client.messageMove).toHaveBeenCalledWith([7], destination, { uid: true })
    expect(mailboxLock.release).toHaveBeenCalledOnce()
  })

  it('groups actions by source folder and does not move to the same folder', async () => {
    const secondLock = lock()
    client.getMailboxLock.mockResolvedValueOnce(mailboxLock).mockResolvedValueOnce(secondLock)
    await subject.applyAction([{ folder: 'Projects', uid: 1 }, { folder: 'Archive', uid: 2 }], 'move', 'folder:Projects')
    expect(client.messageMove).toHaveBeenCalledOnce()
    expect(client.messageMove).toHaveBeenCalledWith([2], 'Projects', { uid: true })
    expect(mailboxLock.release).toHaveBeenCalledOnce()
    expect(secondLock.release).toHaveBeenCalledOnce()
  })

  it.each(['trash', 'untrash', 'archive', 'unarchive', 'label', 'move'] as MailActionKind[])(
    'rejects %s when the server has no matching destination', async (action) => {
      vi.mocked(subject.listFolders).mockResolvedValue([])
      await expect(subject.applyAction([{ folder: 'INBOX', uid: 1 }], action)).rejects.toThrow(`destination folder for ${action}`)
    }
  )

  it('allows unsupported no-op actions without inventing an IMAP operation', async () => {
    await expect(subject.applyAction([{ folder: 'INBOX', uid: 1 }], 'unlabel')).resolves.toBeUndefined()
    expect(client.messageMove).not.toHaveBeenCalled()
    expect(client.messageFlagsAdd).not.toHaveBeenCalled()
  })

  it('replaces an existing draft and returns the appended UID', async () => {
    await expect(subject.saveDraft(Buffer.from('draft'), '12')).resolves.toBe('88')
    expect(client.messageDelete).toHaveBeenCalledWith(12, { uid: true })
    expect(client.append).toHaveBeenCalledWith('Drafts', Buffer.from('draft'), ['\\Draft', '\\Seen'])
    expect(mailboxLock.release).toHaveBeenCalledOnce()
  })

  it('uses a local ID when APPEND does not return a UID', async () => {
    client.append.mockResolvedValueOnce(false)
    const id = await subject.saveDraft(Buffer.from('draft'), 'not-a-number')
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(client.messageDelete).not.toHaveBeenCalled()
  })

  it('requires the server to expose a Drafts folder before saving', async () => {
    vi.mocked(subject.listFolders).mockResolvedValue([])
    await expect(subject.saveDraft(Buffer.from('draft'))).rejects.toThrow('does not expose a Drafts folder')
  })

  it('deletes numeric server drafts and ignores local or unavailable drafts', async () => {
    await subject.deleteDraft('12')
    expect(client.messageDelete).toHaveBeenCalledWith(12, { uid: true })
    expect(mailboxLock.release).toHaveBeenCalledOnce()

    vi.mocked(subject.listFolders).mockResolvedValue([])
    await subject.deleteDraft('13')
    await subject.deleteDraft('local-id')
    expect(client.messageDelete).toHaveBeenCalledOnce()
  })
})

describe('IMAP and SMTP connections', () => {
  beforeEach(() => {
    mocks.imapConstructor.mockReset()
    mocks.createTransport.mockReset()
  })

  it('verifies IMAP and SMTP with the configured transport security', async () => {
    const imap = connectedClient()
    const transport = { verify: vi.fn().mockResolvedValue(undefined) }
    mocks.imapConstructor.mockImplementation(function () { return imap })
    mocks.createTransport.mockReturnValue(transport)
    await new ImapSmtpClient({ ...config, allowInvalidCertificates: true }).verify()
    expect(mocks.imapConstructor).toHaveBeenCalledWith(expect.objectContaining({
      host: config.imapHost, secure: true, doSTARTTLS: false, verifyOnly: true,
      tls: { rejectUnauthorized: false }
    }))
    expect(imap.connect).toHaveBeenCalledOnce()
    expect(mocks.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: config.smtpHost, secure: false, requireTLS: true, tls: { rejectUnauthorized: false }
    }))
    expect(transport.verify).toHaveBeenCalledOnce()
  })

  it('returns callback results and logs out even after callback or logout failures', async () => {
    const imap = connectedClient()
    mocks.imapConstructor.mockImplementation(function () { return imap })
    const subject = new ImapSmtpClient(config)
    await expect(subject.withConnection(async () => 'result')).resolves.toBe('result')
    expect(imap.logout).toHaveBeenCalledOnce()

    imap.logout.mockRejectedValueOnce(new Error('socket closed'))
    await expect(subject.withConnection(async () => { throw new Error('callback failed') })).rejects.toThrow('callback failed')
    expect(imap.logout).toHaveBeenCalledTimes(2)
  })

  it('sends raw mail with an explicit SMTP envelope', async () => {
    const transport = { sendMail: vi.fn().mockResolvedValue(undefined) }
    mocks.createTransport.mockReturnValue(transport)
    const raw = Buffer.from('Subject: Hello\r\n\r\nBody')
    await new ImapSmtpClient(config).send(raw, ['one@example.test', 'two@example.test'])
    expect(mocks.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: config.smtpHost, port: config.smtpPort, secure: false, requireTLS: true
    }))
    expect(transport.sendMail).toHaveBeenCalledWith({
      envelope: { from: config.email, to: ['one@example.test', 'two@example.test'] }, raw
    })
  })
})
