import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailProviderId } from '../../src/mail-types'
import {
  CloudAttachmentService,
  CloudAttachmentStateStore,
  CloudPermissionError,
  DRIVE_FILE_SCOPE,
  ONEDRIVE_SCOPE,
  registerCloudAttachments,
  validateShareOptions,
  type CloudAttachmentDependencies
} from './cloud-attachments'

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const empty = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers })
const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name)

let directory: string
let file: string
const content = Buffer.from('0123456789')

/** A fake Drive resumable endpoint that stores bytes and answers like Google. */
function driveServer(options: { failChunkAt?: number; permissionStatus?: number } = {}) {
  const received: Buffer[] = []
  let stored = 0
  let chunks = 0
  const calls: Array<{ url: string; method: string; body?: string; auth?: string | null }> = []
  const handler: Handler = async (url, init) => {
    const method = init.method ?? 'GET'
    calls.push({ url, method, body: typeof init.body === 'string' ? init.body : undefined, auth: header(init, 'authorization') })
    if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files')) return empty(200, { Location: 'https://upload.example.test/session-1' })
    if (url === 'https://upload.example.test/session-1') {
      if (method === 'DELETE') return empty(499)
      const range = header(init, 'content-range')!
      if (range.startsWith('bytes */')) return stored >= content.length ? json({ id: 'drive-file', name: 'report.pdf', webViewLink: 'https://drive.example.test/file/drive-file' }) : empty(308, stored ? { Range: `bytes=0-${stored - 1}` } : {})
      chunks += 1
      if (options.failChunkAt === chunks) throw new TypeError('fetch failed')
      const body = Buffer.from(init.body as Uint8Array)
      received.push(body)
      stored += body.length
      if (stored >= content.length) return json({ id: 'drive-file', name: 'report.pdf', webViewLink: 'https://drive.example.test/file/drive-file' }, 200)
      return empty(308, { Range: `bytes=0-${stored - 1}` })
    }
    if (url.includes('/permissions?')) {
      if (options.permissionStatus) return json({ error: { message: 'Bad Request', errors: [{ reason: 'invalidSharingRequest' }] } }, options.permissionStatus)
      return json({ id: `perm-${calls.filter((call) => call.url.includes('/permissions?')).length}` })
    }
    if (method === 'DELETE' && url.startsWith('https://www.googleapis.com/drive/v3/files/')) return empty(204)
    throw new Error(`Unexpected request ${method} ${url}`)
  }
  return { handler, calls, received: () => Buffer.concat(received), get stored() { return stored } }
}

function setup(provider: MailProviderId, handler: Handler, overrides: Partial<CloudAttachmentDependencies> = {}) {
  const fetch = vi.fn((url: string | URL | Request, init: RequestInit = {}) => Promise.resolve(handler(String(url), init)))
  const statePath = join(directory, 'cloud-uploads.dat')
  const scopes = provider === 'gmail' ? ['https://www.googleapis.com/auth/gmail.modify', DRIVE_FILE_SCOPE] : ['Mail.ReadWrite', ONEDRIVE_SCOPE]
  const dependencies: CloudAttachmentDependencies = {
    account: async (id) => id === 'account' ? { id, provider, email: 'me@example.test' } : undefined,
    googleToken: async () => 'google-token',
    microsoftToken: async () => 'microsoft-token',
    grantedScopes: vi.fn(() => scopes),
    authorize: vi.fn(async () => undefined),
    isApprovedPath: (path) => path === file,
    state: new CloudAttachmentStateStore(statePath),
    fetch: fetch as unknown as typeof globalThis.fetch,
    chunkBytes: 4,
    now: () => Date.parse('2026-10-17T10:00:00Z'),
    ...overrides
  }
  return { service: new CloudAttachmentService(dependencies), fetch, dependencies, statePath }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aerio-cloud-'))
  file = join(directory, 'report.pdf')
  writeFileSync(file, content)
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('cloud attachment status and consent', () => {
  it('reports Drive as needing an opt-in until drive.file is granted, without touching the mail grant', async () => {
    const grantedScopes = vi.fn<CloudAttachmentDependencies['grantedScopes']>(() => ['https://www.googleapis.com/auth/gmail.modify'])
    const { service, dependencies } = setup('gmail', () => { throw new Error('no network') }, { grantedScopes })
    const before = await service.status('account')
    expect(before).toMatchObject({ provider: 'google-drive', supported: true, connected: false, requiredScope: DRIVE_FILE_SCOPE, audiences: ['anyone', 'recipients'], attachmentLimitBytes: 25 * 1024 * 1024 })
    expect(before.message).toMatch(/cannot see your other Drive files/)
    const notGranted = await service.connect('account')
    expect(dependencies.authorize).toHaveBeenCalledWith({ id: 'account', provider: 'gmail', email: 'me@example.test' }, [DRIVE_FILE_SCOPE])
    expect(notGranted.message).toMatch(/not granted/)
    grantedScopes.mockReturnValue(['https://www.googleapis.com/auth/gmail.modify', DRIVE_FILE_SCOPE])
    const connected = await service.connect('account')
    expect(connected.connected).toBe(true)
    expect(connected.message).toBeUndefined()
  })

  it('treats legacy grants without stored scopes as not connected and explains IMAP accounts', async () => {
    const legacy = setup('microsoft', () => { throw new Error('no network') }, { grantedScopes: () => undefined })
    expect(await legacy.service.status('account')).toMatchObject({ provider: 'onedrive', connected: false, audiences: ['anyone', 'organization', 'recipients'], attachmentLimitBytes: 3 * 1024 * 1024 })
    const imap = setup('imap', () => { throw new Error('no network') })
    expect(await imap.service.status('account')).toMatchObject({ supported: false, connected: false })
    await expect(imap.service.connect('account')).rejects.toThrow(/IMAP/)
  })

  it('validates share options for each provider', () => {
    expect(() => validateShareOptions('google-drive', { audience: 'organization', role: 'view' })).toThrow(/cannot share/)
    expect(() => validateShareOptions('onedrive', { audience: 'recipients', role: 'view', recipients: [] })).toThrow(/Add recipients/)
    expect(() => validateShareOptions('onedrive', { audience: 'recipients', role: 'view', recipients: ['not-an-address'] })).toThrow(/Correct/)
    expect(validateShareOptions('onedrive', { audience: 'recipients', role: 'edit', recipients: ['Ada <ADA@example.test>', 'ada@example.test'] }))
      .toEqual({ audience: 'recipients', role: 'edit', recipients: ['ada@example.test'] })
  })
})

describe('Google Drive uploads', () => {
  it('uploads in resumable chunks, shares with anyone as reader, reports progress, and clears session state', async () => {
    const drive = driveServer()
    const { service, statePath } = setup('gmail', drive.handler)
    const progress = vi.fn()
    const result = await service.upload('upload-0001', 'account', file, { audience: 'anyone', role: 'view' }, progress)
    expect(drive.received()).toEqual(content)
    expect(result).toMatchObject({ status: 'shared', link: { url: 'https://drive.example.test/file/drive-file', fileId: 'drive-file', scopeLabel: 'Anyone with the link can view', size: 10 } })
    expect(result.status === 'shared' && 'permissionIds' in result.link).toBe(false)
    const start = drive.calls[0]
    expect(start.url).toContain('uploadType=resumable')
    expect(start.auth).toBe('Bearer google-token')
    expect(JSON.parse(start.body!)).toEqual({ name: 'report.pdf' })
    // The session URI is a capability; chunks never carry the bearer token.
    expect(drive.calls.filter((call) => call.url.includes('session-1')).every((call) => !call.auth)).toBe(true)
    const permission = drive.calls.find((call) => call.url.includes('/permissions?'))!
    expect(permission.url).toContain('sendNotificationEmail=false')
    expect(JSON.parse(permission.body!)).toEqual({ type: 'anyone', role: 'reader', allowFileDiscovery: false })
    expect(progress.mock.calls.map(([value]) => value.sentBytes)).toEqual([0, 4, 8, 10])
    expect(await service.pending('account')).toEqual([])
    expect(JSON.parse(readFileSync(statePath, 'utf8')).links[0]).toMatchObject({ fileId: 'drive-file', permissionIds: ['perm-1'] })
  })

  it('shares only with recipients as writers and removes the file when Drive refuses a recipient', async () => {
    const drive = driveServer()
    const { service } = setup('gmail', drive.handler)
    const result = await service.upload('upload-0002', 'account', file, { audience: 'recipients', role: 'edit', recipients: ['a@example.test', 'b@example.test'] })
    expect(result.status === 'shared' && result.link.scopeLabel).toBe('Only 2 recipients can edit after signing in to a Google account')
    expect(drive.calls.filter((call) => call.url.includes('/permissions?')).map((call) => JSON.parse(call.body!))).toEqual([
      { type: 'user', role: 'writer', emailAddress: 'a@example.test' },
      { type: 'user', role: 'writer', emailAddress: 'b@example.test' }
    ])

    const refusing = driveServer({ permissionStatus: 400 })
    const failed = setup('gmail', refusing.handler)
    await expect(failed.service.upload('upload-0003', 'account', file, { audience: 'recipients', role: 'view', recipients: ['a@example.test'] })).rejects.toThrow(/without emailing them/)
    expect(refusing.calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/files/drive-file'))).toBe(true)
    expect(await failed.service.pending('account')).toEqual([])
  })

  it('recovers from a dropped connection by asking Drive for the confirmed offset', async () => {
    const drive = driveServer({ failChunkAt: 2 })
    const { service } = setup('gmail', drive.handler)
    const result = await service.upload('upload-0004', 'account', file, { audience: 'anyone', role: 'view' })
    expect(result.status).toBe('shared')
    expect(drive.received()).toEqual(content)
    expect(drive.calls.some((call) => call.method === 'PUT' && call.url.includes('session-1') && call.body === undefined)).toBe(true)
  })

  it('refuses unapproved files and known-missing grants before any request, and maps provider scope errors', async () => {
    const drive = driveServer()
    const { service, fetch } = setup('gmail', drive.handler, { grantedScopes: () => ['https://www.googleapis.com/auth/gmail.modify'] })
    await expect(service.upload('upload-0005', 'account', join(directory, 'other.txt'), { audience: 'anyone', role: 'view' })).rejects.toThrow(/Choose the file/)
    await expect(service.upload('upload-0006', 'account', file, { audience: 'anyone', role: 'view' })).rejects.toBeInstanceOf(CloudPermissionError)
    expect(fetch).not.toHaveBeenCalled()

    const revoked = setup('gmail', () => json({ error: { message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED', errors: [{ reason: 'insufficientPermissions' }] } }, 403))
    await expect(revoked.service.upload('upload-0007', 'account', file, { audience: 'anyone', role: 'view' })).rejects.toBeInstanceOf(CloudPermissionError)
  })
})

describe('cancellation and recovery', () => {
  it('cancels a running upload, discards the provider session, and shares nothing', async () => {
    let service!: CloudAttachmentService
    const drive = driveServer()
    const handler: Handler = async (url, init) => {
      const response = await drive.handler(url, init)
      // Cancel as soon as the first chunk has been accepted.
      if (drive.stored === 4 && init.method === 'PUT') await service.cancel('upload-0008')
      return response
    }
    const created = setup('gmail', (url, init) => {
      if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      return handler(url, init)
    })
    service = created.service
    const result = await service.upload('upload-0008', 'account', file, { audience: 'anyone', role: 'view' })
    expect(result).toEqual({ status: 'cancelled', uploadId: 'upload-0008' })
    expect(drive.calls.some((call) => call.method === 'DELETE' && call.url.includes('session-1'))).toBe(true)
    expect(drive.calls.some((call) => call.url.includes('/permissions'))).toBe(false)
    expect(await service.pending('account')).toEqual([])
  })

  it('resumes an interrupted Drive upload after a restart from the byte Drive confirmed', async () => {
    const drive = driveServer({ failChunkAt: 2 })
    // The first run fails repeatedly, as if Aerio quit mid-upload.
    const failing = setup('gmail', async (url, init) => {
      if (init.method === 'PUT' && header(init, 'content-range')?.startsWith('bytes 4-')) throw new TypeError('fetch failed')
      return drive.handler(url, init)
    })
    await expect(failing.service.upload('upload-0009', 'account', file, { audience: 'anyone', role: 'edit' })).rejects.toThrow(/fetch failed/)
    const restarted = setup('gmail', drive.handler)
    expect(await restarted.service.pending('account')).toEqual([expect.objectContaining({ uploadId: 'upload-0009', name: 'report.pdf', totalBytes: 10, share: { audience: 'anyone', role: 'edit' } })])
    expect(JSON.stringify(await restarted.service.pending('account'))).not.toContain('session-1')
    const result = await restarted.service.resume('upload-0009')
    expect(result.status === 'shared' && result.link.scopeLabel).toBe('Anyone with the link can edit')
    expect(drive.received()).toEqual(content)
    expect(await restarted.service.pending('account')).toEqual([])
  })

  it('clears interrupted uploads whose session expired or whose file changed', async () => {
    const drive = driveServer()
    const failingRun = () => setup('gmail', async (url, init) => {
      if (init.method === 'PUT' && header(init, 'content-range')?.startsWith('bytes 0-')) throw new TypeError('fetch failed')
      return drive.handler(url, init)
    })
    await expect(failingRun().service.upload('upload-0010', 'account', file, { audience: 'anyone', role: 'view' })).rejects.toThrow()
    const expired = setup('gmail', (url, init) => url.includes('session-1') && init.method === 'PUT' ? empty(404) : drive.handler(url, init))
    await expect(expired.service.resume('upload-0010')).rejects.toThrow(/expired/)
    expect(await expired.service.pending('account')).toEqual([])

    await expect(failingRun().service.upload('upload-0011', 'account', file, { audience: 'anyone', role: 'view' })).rejects.toThrow()
    utimesSync(file, new Date('2026-01-01'), new Date('2026-01-01'))
    const changed = setup('gmail', drive.handler)
    await expect(changed.service.resume('upload-0011')).rejects.toThrow(/moved or changed/)
    expect(await changed.service.pending('account')).toEqual([])
    expect(drive.calls.filter((call) => call.method === 'DELETE' && call.url.includes('session-1')).length).toBeGreaterThan(0)
  })
})

describe('OneDrive uploads', () => {
  function oneDrive(options: { linkStatus?: number } = {}) {
    let stored = 0
    const calls: Array<{ url: string; method: string; body?: string; auth?: string | null; range?: string | null }> = []
    const handler: Handler = (url, init) => {
      const method = init.method ?? 'GET'
      calls.push({ url, method, body: typeof init.body === 'string' ? init.body : undefined, auth: header(init, 'authorization'), range: header(init, 'content-range') })
      if (url.endsWith(':/createUploadSession')) return json({ uploadUrl: 'https://onedrive.example.test/upload-1', expirationDateTime: '2026-10-18T10:00:00Z' })
      if (url === 'https://onedrive.example.test/upload-1') {
        if (method === 'GET') return json({ nextExpectedRanges: [`${stored}-`] })
        if (method === 'DELETE') return empty(204)
        stored += Buffer.from(init.body as Uint8Array).length
        return stored >= content.length ? json({ id: 'item-1', name: 'report 1.pdf', webUrl: 'https://onedrive.example.test/item-1' }, 201) : json({ nextExpectedRanges: [`${stored}-`] }, 202)
      }
      if (url.endsWith('/createLink')) return options.linkStatus ? json({ error: { code: 'accessDenied', message: 'Sharing is disabled' } }, options.linkStatus) : json({ id: 'link-perm', link: { webUrl: 'https://1drv.example.test/s!abc' } })
      if (url.endsWith('/invite')) return json({ value: [{ id: 'invite-perm' }] })
      if (method === 'DELETE' && url.includes('/me/drive/items/')) return empty(204)
      throw new Error(`Unexpected request ${method} ${url}`)
    }
    return { handler, calls }
  }

  it('uses an upload session without the bearer token and creates organization or anonymous links', async () => {
    const graph = oneDrive()
    const { service } = setup('microsoft', graph.handler)
    const result = await service.upload('upload-0012', 'account', file, { audience: 'organization', role: 'edit' })
    expect(result).toMatchObject({ status: 'shared', link: { url: 'https://1drv.example.test/s!abc', name: 'report 1.pdf', provider: 'onedrive', scopeLabel: 'People in your organization with the link can edit' } })
    expect(graph.calls[0].url).toBe('https://graph.microsoft.com/v1.0/me/drive/root:/Aerio%20attachments/report.pdf:/createUploadSession')
    expect(JSON.parse(graph.calls[0].body!)).toEqual({ item: { '@microsoft.graph.conflictBehavior': 'rename' } })
    const chunks = graph.calls.filter((call) => call.url.includes('upload-1'))
    expect(chunks.map((call) => call.range)).toEqual(['bytes 0-3/10', 'bytes 4-7/10', 'bytes 8-9/10'])
    expect(chunks.every((call) => !call.auth)).toBe(true)
    expect(JSON.parse(graph.calls.find((call) => call.url.endsWith('/createLink'))!.body!)).toEqual({ type: 'edit', scope: 'organization' })
  })

  it('invites recipients without sending Microsoft invitations and falls back to the item URL', async () => {
    const graph = oneDrive()
    const { service } = setup('microsoft', graph.handler)
    const result = await service.upload('upload-0013', 'account', file, { audience: 'recipients', role: 'view', recipients: ['ada@example.test'] })
    expect(result.status === 'shared' && result.link.url).toBe('https://onedrive.example.test/item-1')
    expect(JSON.parse(graph.calls.find((call) => call.url.endsWith('/invite'))!.body!)).toEqual({ recipients: [{ email: 'ada@example.test' }], requireSignIn: true, sendInvitation: false, roles: ['read'] })
  })

  it('explains tenants that disable anonymous links and removes the unshared file', async () => {
    const graph = oneDrive({ linkStatus: 403 })
    const { service } = setup('microsoft', graph.handler)
    await expect(service.upload('upload-0014', 'account', file, { audience: 'anyone', role: 'view' })).rejects.toThrow(/without signing in/)
    expect(graph.calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/me/drive/items/item-1'))).toBe(true)
  })

  it('resumes from OneDrive nextExpectedRanges after a restart', async () => {
    const graph = oneDrive()
    const failing = setup('microsoft', (url, init) => {
      if (init.method === 'PUT' && header(init, 'content-range')?.startsWith('bytes 4-')) throw new TypeError('fetch failed')
      return graph.handler(url, init)
    })
    await expect(failing.service.upload('upload-0015', 'account', file, { audience: 'anyone', role: 'view' })).rejects.toThrow()
    const restarted = setup('microsoft', graph.handler)
    const result = await restarted.service.resume('upload-0015')
    expect(result.status).toBe('shared')
    expect(graph.calls.filter((call) => call.method === 'GET' && call.url.includes('upload-1')).length).toBeGreaterThan(0)
    expect(graph.calls.filter((call) => call.method === 'PUT').at(-1)?.range).toBe('bytes 8-9/10')
  })
})

describe('link verification', () => {
  const link = (overrides: Record<string, unknown> = {}) => ({
    provider: 'google-drive' as const, accountId: 'account', fileId: 'file-1', name: 'plan.pdf', size: 10, url: 'https://drive.example.test/file-1',
    share: { audience: 'anyone' as const, role: 'view' as const }, scopeLabel: 'Anyone with the link can view', permissionIds: ['perm-1'], ...overrides
  })

  it('reports expired, revoked, deleted and inaccessible links but ignores unknown URLs and network failures', async () => {
    const responses: Record<string, () => Response> = {
      'file-1': () => json({ id: 'file-1', trashed: false }),
      'file-1/perm-1': () => json({ id: 'perm-1', expirationTime: '2026-10-01T00:00:00Z' }),
      'file-2': () => json({ id: 'file-2' }),
      'file-2/perm-1': () => json({ error: { message: 'Permission not found' } }, 404),
      'file-3': () => json({ id: 'file-3', trashed: true }),
      'file-4': () => json({ error: { message: 'File not found' } }, 404),
      'file-5': () => json({ error: { message: 'Forbidden', errors: [{ reason: 'forbidden' }] } }, 403),
      'file-7': () => json({ id: 'file-7' }),
      'file-7/perm-1': () => json({ id: 'perm-1' })
    }
    const { service, dependencies } = setup('gmail', (url) => {
      const match = url.match(/files\/([^/?]+)(?:\/permissions\/([^/?]+))?/)!
      if (match[1] === 'file-6') throw new TypeError('fetch failed')
      return responses[match[2] ? `${match[1]}/${match[2]}` : match[1]]()
    })
    for (let index = 1; index <= 7; index += 1) dependencies.state.addLink(link({ fileId: `file-${index}`, url: `https://drive.example.test/file-${index}`, name: `file-${index}.pdf` }))
    dependencies.state.addLink(link({ fileId: 'local', url: 'https://drive.example.test/local', expiresAt: '2026-10-17T09:00:00Z' }))
    const urls = [...Array.from({ length: 7 }, (_, index) => `https://drive.example.test/file-${index + 1}`), 'https://drive.example.test/local', 'https://example.test/not-ours']
    const issues = await service.verify('account', urls)
    expect(issues.map((issue) => [issue.url.split('/').at(-1), issue.problem])).toEqual([
      ['file-1', 'expired'], ['file-2', 'revoked'], ['file-3', 'deleted'], ['file-4', 'deleted'], ['file-5', 'permission-denied'], ['local', 'expired']
    ])
    expect(await service.verify('other-account', urls)).toEqual([])
  })

  it('checks OneDrive permissions with Graph expiration fields', async () => {
    const { service, dependencies } = setup('microsoft', (url) => url.includes('/permissions/') ? json({ id: 'p', expirationDateTime: '2026-10-16T00:00:00Z' }) : json({ id: 'item' }))
    dependencies.state.addLink(link({ provider: 'onedrive', fileId: 'item', url: 'https://1drv.example.test/x' }))
    expect(await service.verify('account', ['https://1drv.example.test/x'])).toEqual([expect.objectContaining({ problem: 'expired', message: expect.stringMatching(/plan\.pdf/) })])
  })
})

describe('state store and IPC', () => {
  it('encodes persisted state and tolerates unreadable files', () => {
    const path = join(directory, 'state.dat')
    const codec = { encode: (value: string) => Buffer.from(value).toString('base64'), decode: (value: string) => Buffer.from(value, 'base64').toString() }
    const store = new CloudAttachmentStateStore(path, codec)
    store.addLink({ provider: 'onedrive', accountId: 'a', fileId: 'f', name: 'n', size: 1, url: 'https://x.test', share: { audience: 'anyone', role: 'view' }, scopeLabel: 's', permissionIds: [] })
    expect(readFileSync(path, 'utf8')).not.toContain('https://x.test')
    expect(new CloudAttachmentStateStore(path, codec).links()).toHaveLength(1)
    writeFileSync(path, 'garbage')
    expect(new CloudAttachmentStateStore(path, codec).links()).toEqual([])
  })

  it('registers handlers that forward progress to the requesting window only', async () => {
    const handlers = new Map<string, (...args: any[]) => any>()
    const service = { upload: vi.fn(async (_id, _account, _path, _share, progress) => { progress({ uploadId: 'u', name: 'n', sentBytes: 1, totalBytes: 2 }); return { status: 'cancelled', uploadId: 'u' } }) }
    registerCloudAttachments({ handle: (channel: string, handler: any) => handlers.set(channel, handler) } as any, () => service as any)
    expect([...handlers.keys()]).toEqual(['mail:cloud:status', 'mail:cloud:connect', 'mail:cloud:upload', 'mail:cloud:cancel', 'mail:cloud:pending', 'mail:cloud:resume', 'mail:cloud:discard', 'mail:cloud:verify'])
    const sender = { isDestroyed: () => false, send: vi.fn() }
    await handlers.get('mail:cloud:upload')!({ sender }, 'u', 'account', 'path', { audience: 'anyone', role: 'view' })
    expect(sender.send).toHaveBeenCalledWith('mail:cloud:progress', { uploadId: 'u', name: 'n', sentBytes: 1, totalBytes: 2 })
  })
})
