import { afterEach, describe, expect, it, vi } from 'vitest'
import { MicrosoftGraphClient } from './microsoft-client'

afterEach(() => vi.unstubAllGlobals())

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
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer token', Prefer: 'IdType="ImmutableId"' })
  })

  it('sends RFC 822 MIME as base64 through Graph', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new MicrosoftGraphClient(async () => 'token')
    await client.send(Buffer.from('Subject: hello\r\n\r\nBody'))
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', body: Buffer.from('Subject: hello\r\n\r\nBody').toString('base64') })
  })
})
