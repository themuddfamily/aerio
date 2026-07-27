import { afterEach, describe, expect, it, vi } from 'vitest'
import { GmailClient } from './gmail-client'

afterEach(() => {
  vi.unstubAllGlobals()
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
})
