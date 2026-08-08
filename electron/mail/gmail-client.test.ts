import { afterEach, describe, expect, it, vi } from 'vitest'
import { GmailApiError, GmailClient } from './gmail-client'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GmailClient', () => {
  it('uses a bearer token and requests full mailbox inventory pages', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      messages: [{ id: 'one', threadId: 'thread-one' }],
      nextPageToken: 'next'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new GmailClient('account', async () => 'access-token')
    const result = await client.listMessages()

    expect(result.messages?.[0].id).toBe('one')
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('maxResults=500'),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer access-token' }) })
    )
  })

  it('surfaces non-retryable API errors with their Gmail reason', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'Invalid credentials', errors: [{ reason: 'authError' }] }
    }), { status: 401, headers: { 'Content-Type': 'application/json' } })))
    const client = new GmailClient('account', async () => 'expired')
    await expect(client.getProfile()).rejects.toEqual(expect.objectContaining({
      status: 401,
      reason: 'authError'
    }))
  })

  it('normalizes labels and preserves provider colours', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ labels: [
      { id: 'INBOX', name: 'Inbox', type: 'SYSTEM' },
      { id: 'Label_1', name: 'Project', type: 'USER', color: { backgroundColor: '#4986e7' } }
    ] }), { status: 200 })))
    await expect(new GmailClient('account', async () => 'token').listLabels()).resolves.toEqual([
      { accountId: 'account', id: 'INBOX', name: 'Inbox', type: 'system', color: undefined },
      { accountId: 'account', id: 'Label_1', name: 'Project', type: 'user', color: '#4986e7' }
    ])
  })

  it('adds page tokens and safely encodes message identifiers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new GmailClient('account', async () => 'token')
    await client.listMessages('page/token')
    await client.getRawMessage('message/one')
    await client.getMessageMinimal('message two')
    expect(fetchMock.mock.calls[0][0]).toContain('pageToken=page%2Ftoken')
    expect(fetchMock.mock.calls[1][0]).toContain('/messages/message%2Fone?format=RAW')
    expect(fetchMock.mock.calls[2][0]).toContain('/messages/message%20two?format=MINIMAL')
  })

  it('collects successful and failed concurrent raw-message downloads', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('bad')
      ? new Response(JSON.stringify({ error: { message: 'Missing' } }), { status: 404 })
      : new Response(JSON.stringify({ id: url.includes('one') ? 'one' : 'two', threadId: 'thread', raw: 'raw' }), { status: 200 })))
    const results = await new GmailClient('account', async () => 'token').getRawMessages(['one', 'bad', 'two'])
    expect(results).toHaveLength(3)
    expect(results.find((item) => item.id === 'one')?.message?.id).toBe('one')
    expect(results.find((item) => item.id === 'bad')?.error).toBeInstanceOf(GmailApiError)
  })

  it('builds paginated history requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ history: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await new GmailClient('account', async () => 'token').listHistory('123', 'next page')
    expect(fetchMock.mock.calls[0][0]).toContain('startHistoryId=123')
    expect(fetchMock.mock.calls[0][0]).toContain('pageToken=next+page')
  })

  it('calls the expected thread mutation endpoints and payloads', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new GmailClient('account', async () => 'token')
    await client.modifyThreads(['thread/1'], ['STARRED'], ['UNREAD'])
    await client.trashThreads(['thread/1'])
    await client.untrashThreads(['thread/1'])
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      expect.stringContaining('/threads/thread%2F1/modify'),
      expect.stringContaining('/threads/thread%2F1/trash'),
      expect.stringContaining('/threads/thread%2F1/untrash')
    ])
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ addLabelIds: ['STARRED'], removeLabelIds: ['UNREAD'] })
  })

  it('creates, updates, and deletes provider drafts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'draft-1', message: { id: 'message-1', threadId: 'thread-1' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new GmailClient('account', async () => 'token')
    await client.createDraft('raw', 'thread-1')
    await client.updateDraft('draft/1', 'new-raw')
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await client.deleteDraft('draft/1')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ message: { raw: 'raw', threadId: 'thread-1' } })
    expect(fetchMock.mock.calls[1][0]).toContain('/drafts/draft%2F1')
    expect(fetchMock.mock.calls[1][1].method).toBe('PUT')
    expect(fetchMock.mock.calls[2][1].method).toBe('DELETE')
  })

  it('sends existing drafts with and without replacement MIME', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'message', threadId: 'thread' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new GmailClient('account', async () => 'token')
    await client.sendDraft('draft-1')
    await client.sendDraft('draft-2', 'replacement')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ id: 'draft-1' })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ id: 'draft-2', message: { raw: 'replacement' } })
  })

  it('sends new messages with optional thread association', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'message', threadId: 'thread' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new GmailClient('account', async () => 'token')
    await client.sendMessage('raw')
    await client.sendMessage('reply', 'thread-1')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ raw: 'raw' })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ raw: 'reply', threadId: 'thread-1' })
  })

  it('retries rate-limited requests and honours Retry-After', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Slow down' } }), { status: 429, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ emailAddress: 'me@example.com' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => { callback(); return 0 }) as typeof setTimeout)
    await expect(new GmailClient('account', async () => 'token').getProfile()).resolves.toMatchObject({ emailAddress: 'me@example.com' })
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 1_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('falls back to HTTP status text when an error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not-json', { status: 400, statusText: 'Bad Request' })))
    await expect(new GmailClient('account', async () => 'token').getProfile()).rejects.toMatchObject({ message: '400 Bad Request', status: 400 })
  })
})
