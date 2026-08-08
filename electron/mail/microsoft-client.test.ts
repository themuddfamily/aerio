import { afterEach, describe, expect, it, vi } from 'vitest'
import { MicrosoftGraphClient, MicrosoftGraphError, microsoftLabels, microsoftMessageLabels } from './microsoft-client'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Microsoft Graph mail client', () => {
  it('follows message delta pagination and retains the opaque delta link', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [{ id: 'one' }], '@odata.nextLink': 'https://graph.microsoft.com/next' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [{ id: 'two' }], '@odata.deltaLink': 'https://graph.microsoft.com/delta-token' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new MicrosoftGraphClient(async () => 'token')

    await expect(client.delta('inbox')).resolves.toEqual({
      messages: [{ id: 'one' }, { id: 'two' }],
      deltaLink: 'https://graph.microsoft.com/delta-token'
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toContain('categories')
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer token', Prefer: 'IdType="ImmutableId"' })
  })

  it('preserves Outlook categories as visible mail labels', () => {
    expect(microsoftMessageLabels(
      { id: 'inbox-id', displayName: 'Inbox', specialUse: 'inbox' },
      { id: 'message-1', isRead: true, categories: ['Avast: Scanned', 'Customer'] }
    )).toEqual(expect.arrayContaining(['INBOX', 'category:Avast: Scanned', 'category:Customer']))
  })

  it('sends RFC 822 MIME as base64 through Graph', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new MicrosoftGraphClient(async () => 'token')
    await client.send(Buffer.from('Subject: hello\r\n\r\nBody'))
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', body: Buffer.from('Subject: hello\r\n\r\nBody').toString('base64') })
  })

  it('normalizes system state, flags, importance, and unique categories', () => {
    expect(microsoftMessageLabels(
      { id: 'deleted', displayName: 'Deleted Items', specialUse: 'deleteditems' },
      { id: 'message', isRead: false, isDraft: true, flag: { flagStatus: 'flagged' }, importance: 'high', categories: [' Customer ', '', 'Customer'] }
    )).toEqual(['folder:deleted', 'DRAFT', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT', 'category:Customer'])
    expect(microsoftMessageLabels({ id: 'sent', displayName: 'Sent Mail' }, { id: 'one', isRead: true })).toContain('SENT')
    expect(microsoftMessageLabels({ id: 'spam', displayName: 'Spam' }, { id: 'two', isRead: true })).toContain('SPAM')
    expect(microsoftMessageLabels({ id: 'archive', displayName: 'Archive' }, { id: 'three', isRead: true })).toContain('ARCHIVE')
  })

  it('discovers paginated folders, children, and well-known folder identities', async () => {
    const fetchMock = vi.fn(async (urlValue: string) => {
      const url = String(urlValue)
      if (url.includes('/childFolders')) return new Response(JSON.stringify({ value: [{ id: 'child', displayName: 'Child', childFolderCount: 0 }] }), { status: 200 })
      if (url.includes('/me/mailFolders?$top')) return new Response(JSON.stringify({ value: [{ id: 'root', displayName: 'Root', childFolderCount: 1 }] }), { status: 200 })
      if (url.includes('/me/mailFolders/inbox?')) return new Response(JSON.stringify({ id: 'root', displayName: 'Inbox', childFolderCount: 1 }), { status: 200 })
      if (url.includes('/me/mailFolders/archive?')) return new Response(JSON.stringify({ id: 'archive-id', displayName: 'Archive', childFolderCount: 0 }), { status: 200 })
      return new Response(JSON.stringify({ error: { message: 'Not available' } }), { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const folders = await new MicrosoftGraphClient(async () => 'token').listFolders()
    expect(folders).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'root', specialUse: 'inbox' }),
      expect.objectContaining({ id: 'child' }),
      expect.objectContaining({ id: 'archive-id', specialUse: 'archive' })
    ]))
  })

  it('downloads raw MIME through both binary APIs and encodes ids', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('Subject: Test\r\n\r\nBody', { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
    const client = new MicrosoftGraphClient(async () => 'token')
    expect(Buffer.from(await client.rawMessage('message/1')).toString()).toContain('Subject: Test')
    expect((await client.messageRaw('message/2')).toString()).toContain('Body')
    expect(fetchMock.mock.calls[0][0]).toContain('/messages/message%2F1/$value')
  })

  it('surfaces binary message download failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response('missing', { status: 404 }))))
    const client = new MicrosoftGraphClient(async () => 'token')
    await expect(client.rawMessage('missing')).rejects.toMatchObject({ status: 404 })
    await expect(client.messageRaw('missing')).rejects.toMatchObject({ status: 404 })
  })

  it('maps read, flag, and importance actions to Graph patches', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })))
    vi.stubGlobal('fetch', fetchMock)
    const client = new MicrosoftGraphClient(async () => 'token')
    for (const action of ['read', 'unread', 'star', 'unstar', 'important', 'unimportant'] as const) await client.applyAction(['message'], action)
    expect(fetchMock.mock.calls.map((call) => JSON.parse(call[1].body))).toEqual([
      { isRead: true }, { isRead: false }, { flag: { flagStatus: 'flagged' } }, { flag: { flagStatus: 'notFlagged' } }, { importance: 'high' }, { importance: 'normal' }
    ])
  })

  it('moves messages for folder actions and requires a destination', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })))
    vi.stubGlobal('fetch', fetchMock)
    const client = new MicrosoftGraphClient(async () => 'token')
    await client.applyAction(['one', 'two'], 'move', 'folder-id')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ destinationId: 'folder-id' })
    await expect(client.applyAction(['one'], 'archive')).rejects.toThrow(/destination mail folder/)
  })

  it('replaces an existing draft and returns the new immutable id', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'new-draft' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(new MicrosoftGraphClient(async () => 'token').saveDraft(Buffer.from('mime'), 'old/draft')).resolves.toBe('new-draft')
    expect(fetchMock.mock.calls[0][0]).toContain('old%2Fdraft')
    expect(fetchMock.mock.calls[1][1].body).toBe(Buffer.from('mime').toString('base64'))
  })

  it('continues draft replacement when deleting the old draft fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Gone' } }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'replacement' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(new MicrosoftGraphClient(async () => 'token').saveDraft(Buffer.from('mime'), 'old')).resolves.toBe('replacement')
  })

  it('rejects a draft response without an id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })))
    await expect(new MicrosoftGraphClient(async () => 'token').saveDraft(Buffer.from('mime'))).rejects.toThrow(/could not save the draft/)
  })

  it('sends existing drafts and deletes drafts through their dedicated endpoints', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })))
    vi.stubGlobal('fetch', fetchMock)
    const client = new MicrosoftGraphClient(async () => 'token')
    await client.send(Buffer.from('ignored'), 'draft/1')
    await client.deleteDraft('draft/2')
    expect(fetchMock.mock.calls[0][0]).toContain('/messages/draft%2F1/send')
    expect(fetchMock.mock.calls[1][0]).toContain('/messages/draft%2F2')
    expect(fetchMock.mock.calls[1][1].method).toBe('DELETE')
  })

  it('surfaces structured and fallback Graph errors', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Access denied' } }), { status: 403 }))
      .mockResolvedValueOnce(new Response('not-json', { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new MicrosoftGraphClient(async () => 'token')
    await expect(client.deleteDraft('one')).rejects.toEqual(expect.objectContaining({ message: 'Access denied', status: 403 }))
    await expect(client.deleteDraft('two')).rejects.toEqual(expect.objectContaining({ message: 'Microsoft Graph request failed (400)', status: 400 }))
  })

  it('retries transient failures using Retry-After', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => { callback(); return 0 }) as typeof setTimeout)
    await new MicrosoftGraphClient(async () => 'token').deleteDraft('draft')
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 2_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('maps synchronized folders to account-scoped labels', () => {
    expect(microsoftLabels('account', [
      { id: 'inbox', displayName: 'Inbox', specialUse: 'inbox' },
      { id: 'project', displayName: 'Project' }
    ])).toEqual([
      { accountId: 'account', id: 'folder:inbox', name: 'Inbox', type: 'system' },
      { accountId: 'account', id: 'folder:project', name: 'Project', type: 'user' }
    ])
  })
})
