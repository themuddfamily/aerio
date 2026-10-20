import { googleMessage, microsoftMessage, mime, providerClient, ProviderError, recipients } from '../src/core/providers';
import type { Draft } from '../src/core/types';
import { response } from './http';
const draft: Draft = { id: 'draft', accountId: 'a', to: 'recipient@example.test', subject: 'Review α', body: 'Hello\nUnicode α', inReplyTo: '<original@example.test>', status: 'editing', updatedAt: '' };
describe('real provider request contracts', () => {
  it('reads nested Gmail MIME as Unicode plain text without loading remote HTML resources', () => {
    const result = googleMessage('a', { id: 'm', labelIds: ['INBOX', 'UNREAD', 'STARRED'], payload: { headers: [{ name: 'From', value: 'Sender <sender@example.test>' }], parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Hello α').toString('base64url') } }, { mimeType: 'image/png', filename: 'photo.png' }] } });
    expect(result).toMatchObject({ accountId: 'a', body: 'Hello α', read: false, starred: true, replyTo: 'sender@example.test', attachmentNames: ['photo.png'] });
    expect(microsoftMessage('b', { id: 'm', body: { contentType: 'html', content: '<script>bad()</script><p>Hello</p><img src="https://tracking.invalid">' } }).body).toBe('Hello');
  });
  it('uses Gmail modify labels and base64url RFC MIME send with reply headers', async () => {
    const request = jest.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response({ id: 'sent' })); const client = providerClient('google', request);
    await client.action('token', 'message', { kind: 'archive' });
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({ addLabelIds: [], removeLabelIds: ['INBOX'] });
    await client.send('token', draft, 'me@example.test');
    const payload = JSON.parse(String(request.mock.calls[1][1]?.body)), sent = Buffer.from(payload.raw, 'base64url').toString();
    expect(sent).toContain('In-Reply-To: <original@example.test>'); expect(sent).toContain('Content-Transfer-Encoding: base64');
    expect(request.mock.calls[1][0]).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
  });
  it('uses immutable Graph IDs, native read/star/move operations and MIME sendMail', async () => {
    const request = jest.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response({}, 202)); const client = providerClient('microsoft', request);
    await client.action('token', 'immutable', { kind: 'trash' });
    expect(request.mock.calls[0][0]).toContain('/me/messages/immutable/move'); expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({ destinationId: 'deleteditems' });
    await client.send('token', draft, 'me@example.test');
    expect(request.mock.calls[1][0]).toBe('https://graph.microsoft.com/v1.0/me/sendMail');
    expect(request.mock.calls[1][1]?.headers).toMatchObject({ 'Content-Type': 'text/plain', Prefer: expect.stringContaining('ImmutableId') });
    expect(Buffer.from(String(request.mock.calls[1][1]?.body), 'base64').toString()).toContain('References: <original@example.test>');
  });
  it('separates confirmed refusal from lost delivery responses and rejects credential-forwarding paging URLs', async () => {
    const refused = providerClient('google', jest.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response({}, 400)));
    await expect(refused.send('secret', draft, 'me@example.test')).rejects.toMatchObject({ submitted: false, status: 400 });
    const lost = providerClient('google', jest.fn(async () => { throw new Error('network'); }));
    await expect(lost.send('secret', draft, 'me@example.test')).rejects.toBeInstanceOf(ProviderError);
    await expect(lost.send('secret', draft, 'me@example.test')).rejects.toMatchObject({ submitted: true });
    const request = jest.fn(); await expect(providerClient('microsoft', request).inbox('a', 'secret', 'https://attacker.invalid/token')).rejects.toThrow('paging'); expect(request).not.toHaveBeenCalled();
  });
  it('validates recipients and prevents injected MIME headers', () => {
    expect(() => recipients('victim@example.test\r\nBcc: hidden@example.test')).toThrow();
    expect(mime({ ...draft, subject: 'Safe\r\nInjected: no' }, 'me@example.test')).not.toContain('\r\nInjected:');
  });
  it('caps inbox page schemas and stops streaming oversized message bytes before JSON parsing', async () => {
    const oversizedPage = providerClient('microsoft', jest.fn(async () => response({ value: Array.from({ length: 41 }, () => ({ id: 'm' })) })));
    await expect(oversizedPage.inbox('a', 'token')).rejects.toThrow('oversized');
    const oversized = response({}, 200, [new Uint8Array(1500001)]);
    const cancel = oversized.body!.getReader().cancel;
    const request = jest.fn(async (url: RequestInfo | URL) => String(url).endsWith('format=full') ? oversized : String(url).endsWith('format=metadata') ? response({ id: 'm', payload: { headers: [] } }) : response({ messages: [{ id: 'm' }] }));
    const result = await providerClient('google', request).inbox('a', 'token');
    expect(cancel).toHaveBeenCalled(); expect(result.messages[0].body).toContain('too large'); expect(request).toHaveBeenCalledTimes(3);
  });
  it('bounds MIME depth and encoded body bytes before decoding, and marks Graph truncation', () => {
    let part: NonNullable<Parameters<typeof googleMessage>[1]['payload']> = { mimeType: 'text/plain', body: { data: 'YQ==' } };
    for (let depth = 0; depth < 20; depth++) part = { parts: [part] };
    expect(googleMessage('a', { id: 'deep', payload: part }).body).toContain('too large or complex');
    expect(googleMessage('a', { id: 'large', payload: { mimeType: 'text/plain', body: { data: 'A'.repeat(500001) } } }).body).toContain('too large');
    expect(microsoftMessage('a', { id: 'large', body: { contentType: 'text', content: 'A'.repeat(250001) } }).body).toContain('Preview truncated');
  });
});
