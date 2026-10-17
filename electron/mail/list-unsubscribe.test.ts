import { describe, expect, it, vi } from 'vitest'
import { bracketedEntries, headerValues, isPrivateAddress, parseListUnsubscribe, performUnsubscribe, type UnsubscribeDependencies } from './list-unsubscribe'

const headers = (...lines: string[]) => ['From: News <news@example.test>', 'Subject: Weekly', ...lines].join('\r\n')
const oneClickHeaders = headers('List-Id: Weekly News <weekly.example.test>', 'List-Unsubscribe: <mailto:leave@example.test?subject=unsubscribe%20me>,', ' <https://lists.example.test/u/abc', '  def?x=1>', 'List-Unsubscribe-Post: List-Unsubscribe=One-Click')
const dependencies = (overrides: Partial<UnsubscribeDependencies> = {}): UnsubscribeDependencies => ({
  fetch: vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch,
  resolve: vi.fn(async () => ['93.184.216.34']),
  openExternal: vi.fn(async () => undefined),
  sendMail: vi.fn(async () => ({})),
  ...overrides
})
const act = (info: ReturnType<typeof parseListUnsubscribe>, url: string, method: string, deps: UnsubscribeDependencies, readOnly = false) => performUnsubscribe({ info, url, method, accountId: 'account', readOnly }, deps)

describe('List-Unsubscribe parsing', () => {
  it('unfolds headers and reads RFC 2369 entries with folded URIs and comments', () => {
    expect(headerValues('List-unsubscribe: <a>\r\n\t<b>\r\nOther: x\r\n\r\nList-Unsubscribe: <body>', 'List-Unsubscribe')).toEqual(['<a> <b>'])
    expect(bracketedEntries('<https://a.test/x> (web), (mail <ignored>) <mailto:x@a.test>')).toEqual(['https://a.test/x', 'mailto:x@a.test'])
    expect(bracketedEntries('https://a.test/x')).toBeUndefined()
    expect(bracketedEntries('<https://a.test/x')).toBeUndefined()
    expect(bracketedEntries('<a<b>')).toBeUndefined()
  })
  it('exposes HTTPS one-click and mailto destinations together with the list id', () => {
    expect(parseListUnsubscribe(oneClickHeaders)).toEqual({
      listId: 'weekly.example.test',
      warnings: [],
      options: [
        { kind: 'mailto', url: 'mailto:leave@example.test?subject=unsubscribe%20me', destination: 'leave@example.test', oneClick: false, mailto: { to: ['leave@example.test'], subject: 'unsubscribe me', body: '' } },
        { kind: 'https', url: 'https://lists.example.test/u/abcdef?x=1', destination: 'lists.example.test', oneClick: true }
      ]
    })
  })
  it('only offers one-click when List-Unsubscribe-Post is exactly the RFC 8058 value', () => {
    const plain = parseListUnsubscribe(headers('List-Unsubscribe: <https://a.test/u>'))
    expect(plain.options[0]).toMatchObject({ kind: 'https', oneClick: false })
    expect(plain.warnings).toEqual([])
    const malformed = parseListUnsubscribe(headers('List-Unsubscribe: <https://a.test/u>', 'List-Unsubscribe-Post: List-Unsubscribe=Yes'))
    expect(malformed.options[0].oneClick).toBe(false)
    expect(malformed.warnings).toEqual([expect.stringMatching(/one-click unsubscribe header is malformed/)])
    expect(parseListUnsubscribe(headers('List-Unsubscribe: <mailto:x@a.test>', 'List-Unsubscribe-Post: List-Unsubscribe=One-Click')).warnings).toEqual([expect.stringMatching(/without an HTTPS link/)])
  })
  it('ignores malformed, insecure, unsupported and credential-bearing entries with explanations', () => {
    expect(parseListUnsubscribe(headers('List-Unsubscribe: https://a.test/u'))).toEqual({ options: [], warnings: ['The List-Unsubscribe header is malformed'] })
    const info = parseListUnsubscribe(headers(`List-Unsubscribe: <http://a.test/u>, <javascript:alert(1)>, <https://user:pw@a.test/u>, <mailto:not-an-address>, <mailto:%ZZ@a.test>, <https://a.test/${'x'.repeat(2100)}>, <https://ok.test/u>, <https://ok.test/u>`, 'List-Unsubscribe: <https://second.test/u>'))
    expect(info.options.map((option) => option.url)).toEqual(['https://ok.test/u'])
    expect(info.warnings).toEqual([
      expect.stringMatching(/more than one List-Unsubscribe/),
      expect.stringMatching(/unencrypted HTTP/),
      expect.stringMatching(/unsupported javascript:/),
      expect.stringMatching(/credentials/),
      expect.stringMatching(/address is not valid/),
      expect.stringMatching(/not correctly encoded/),
      expect.stringMatching(/too long/)
    ])
    expect(parseListUnsubscribe(headers('Subject: none'))).toEqual({ options: [], warnings: [] })
  })
  it('sanitizes mailto subjects and bodies and accepts extra recipients from to fields', () => {
    const [option] = parseListUnsubscribe(headers('List-Unsubscribe: <mailto:A@List.test?to=b@list.test&subject=a%0D%0ABcc:%20x@evil.test&body=please+remove>')).options
    expect(option.mailto).toEqual({ to: ['a@list.test', 'b@list.test'], subject: 'a Bcc: x@evil.test', body: 'please remove' })
    expect(option.destination).toBe('a@list.test, b@list.test')
  })
  it('classifies local and private network addresses', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '[::1]', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) expect(isPrivateAddress(address)).toBe(true)
    for (const address of ['93.184.216.34', '2606:2800:220:1::', 'example.test']) expect(isPrivateAddress(address)).toBe(false)
  })
})

describe('performing an unsubscribe', () => {
  const info = parseListUnsubscribe(oneClickHeaders)
  const https = 'https://lists.example.test/u/abcdef?x=1'
  it('sends a credential-free RFC 8058 POST that does not follow redirects', async () => {
    const deps = dependencies()
    await expect(act(info, https, 'one-click', deps)).resolves.toEqual({ method: 'one-click', destination: 'lists.example.test', status: 'unsubscribed' })
    expect(deps.fetch).toHaveBeenCalledWith(https, expect.objectContaining({ method: 'POST', redirect: 'manual', credentials: 'omit', body: 'List-Unsubscribe=One-Click', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }))
    expect(deps.resolve).toHaveBeenCalledWith('lists.example.test')
  })
  it('reports redirects, HTTP failures and network errors without claiming success', async () => {
    await expect(act(info, https, 'one-click', dependencies({ fetch: vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/confirm' } })) as unknown as typeof fetch }))).rejects.toThrow(/redirect the unsubscribe request to elsewhere\.test.*does not follow/)
    await expect(act(info, https, 'one-click', dependencies({ fetch: vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch }))).rejects.toThrow('lists.example.test rejected the unsubscribe request (HTTP 500)')
    await expect(act(info, https, 'one-click', dependencies({ fetch: vi.fn(async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch }))).rejects.toThrow('Could not reach lists.example.test: fetch failed')
  })
  it('refuses local or privately resolving one-click destinations before sending', async () => {
    const deps = dependencies({ resolve: vi.fn(async () => ['10.0.0.5']) })
    await expect(act(info, https, 'one-click', deps)).rejects.toThrow(/resolves to a local or private address/)
    await expect(act(info, https, 'one-click', dependencies({ resolve: vi.fn(async () => { throw new Error('ENOTFOUND') }) }))).rejects.toThrow(/Could not find the unsubscribe server/)
    const local = parseListUnsubscribe(headers('List-Unsubscribe: <https://127.0.0.1:8080/u>, <https://router.local/u>', 'List-Unsubscribe-Post: List-Unsubscribe=One-Click'))
    await expect(act(local, 'https://127.0.0.1:8080/u', 'one-click', deps)).rejects.toThrow(/local or private address 127\.0\.0\.1:8080/)
    await expect(act(local, 'https://router.local/u', 'one-click', deps)).rejects.toThrow(/local or private/)
    expect(deps.fetch).not.toHaveBeenCalled()
  })
  it('only acts on destinations and methods the message headers advertise', async () => {
    const deps = dependencies()
    await expect(act(info, 'https://attacker.test/', 'one-click', deps)).rejects.toThrow(/not listed in the email/)
    await expect(act(info, https, 'delete', deps)).rejects.toThrow(/Choose an unsubscribe method/)
    await expect(act(info, https, 'mailto', deps)).rejects.toThrow(/not an email address/)
    await expect(act(info, info.options[0].url, 'one-click', deps)).rejects.toThrow(/not an HTTPS link/)
    await expect(act(parseListUnsubscribe(headers('List-Unsubscribe: <https://a.test/u>')), 'https://a.test/u', 'one-click', deps)).rejects.toThrow(/does not support one-click/)
    expect(deps.fetch).not.toHaveBeenCalled()
    expect(deps.openExternal).not.toHaveBeenCalled()
    expect(deps.sendMail).not.toHaveBeenCalled()
  })
  it('opens HTTPS pages in the browser and queues mailto requests from the receiving account', async () => {
    const deps = dependencies()
    await expect(act(info, https, 'browser', deps)).resolves.toMatchObject({ status: 'opened' })
    expect(deps.openExternal).toHaveBeenCalledWith(https)
    await expect(act(info, info.options[0].url, 'mailto', deps)).resolves.toEqual({ method: 'mailto', destination: 'leave@example.test', status: 'queued' })
    expect(deps.sendMail).toHaveBeenCalledWith({ accountId: 'account', to: ['leave@example.test'], cc: [], bcc: [], subject: 'unsubscribe me', text: 'unsubscribe', attachmentPaths: [] })
    await expect(act(info, info.options[0].url, 'mailto', deps, true)).rejects.toThrow(/archived/)
    expect(deps.sendMail).toHaveBeenCalledTimes(1)
    expect(deps.fetch).not.toHaveBeenCalled()
  })
})
