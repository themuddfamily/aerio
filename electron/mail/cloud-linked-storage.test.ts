import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudUploadProgress } from '../../src/cloud-attachment-types'
import { fakeSecureStorage } from '../productivity/dav-test-harness'
import { DavCredentialVault } from '../productivity/dav-credentials'
import { CloudAttachmentService, CloudAttachmentStateStore } from './cloud-attachments'
import { dropboxArg } from './cloud-dropbox'
import { LinkedCloudStorageService, registerCloudStorage } from './cloud-linked-storage'
import { parseOcsCapabilities } from './cloud-ocs'
import { CloudStorageAccountStore, normalizeCloudServerUrl } from './cloud-storage-accounts'
import { DropboxFixtureServer, OcsFixtureServer, type DropboxFixtureOptions, type OcsFixtureOptions } from './cloud-storage-fixtures'

const content = Buffer.from('The quick brown fox jumps over the lazy dog')
const CHUNK = 8
let directory: string
let file: string
const servers: Array<{ stop(): Promise<void> }> = []

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aerio-linked-cloud-'))
  file = join(directory, 'report.pdf')
  writeFileSync(file, content)
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()))
  rmSync(directory, { recursive: true, force: true })
})

interface Harness {
  linked: LinkedCloudStorageService
  service: CloudAttachmentService
  state: CloudAttachmentStateStore
  now: { value: number }
}

/** One app session; a second call with the same directory is Aerio after a restart. */
function harness(options: { dropbox?: DropboxFixtureServer; builtInKey?: boolean; now?: { value: number } } = {}): Harness {
  const now = options.now ?? { value: Date.parse('2026-10-17T10:00:00Z') }
  const state = new CloudAttachmentStateStore(join(directory, 'cloud-uploads.dat'))
  const accounts = new CloudStorageAccountStore(join(directory, 'cloud-storage-accounts.json'), new DavCredentialVault(join(directory, 'cloud-storage-credentials.dat'), fakeSecureStorage()))
  const linked = new LinkedCloudStorageService({
    accounts, state, isApprovedPath: (path) => path === file,
    openExternal: async (url) => { await options.dropbox!.approve(url) },
    ...(options.builtInKey && options.dropbox ? { builtInDropboxAppKey: options.dropbox.appKey } : {}),
    ...(options.dropbox ? { dropboxEndpoints: options.dropbox.endpoints } : {}),
    dropboxPort: 0, chunkBytes: CHUNK, now: () => now.value
  })
  const service = new CloudAttachmentService({
    account: async (id) => id === 'imap-account' ? { id, provider: 'imap', email: 'me@example.test' } : undefined,
    googleToken: async () => { throw new Error('unused') },
    microsoftToken: async () => { throw new Error('unused') },
    grantedScopes: () => [],
    authorize: async () => undefined,
    isApprovedPath: (path) => path === file,
    state, linked, now: () => now.value
  })
  return { linked, service, state, now }
}

async function dropboxFixture(options: DropboxFixtureOptions = {}) {
  const fixture = await new DropboxFixtureServer(options).start()
  servers.push(fixture)
  return fixture
}

async function ocsFixture(options: OcsFixtureOptions = {}) {
  const fixture = await new OcsFixtureServer(options).start()
  servers.push(fixture)
  return fixture
}

async function connectDropbox(options: DropboxFixtureOptions = {}) {
  const fixture = await dropboxFixture(options)
  const app = harness({ dropbox: fixture, builtInKey: true })
  const snapshot = await app.linked.connectDropbox()
  return { fixture, app, account: snapshot.accounts[0] }
}

async function connectServer(options: OcsFixtureOptions = {}, provider: 'nextcloud' | 'owncloud' = 'nextcloud') {
  const fixture = await ocsFixture(options)
  const app = harness()
  const snapshot = await app.linked.connectServer({ provider, serverUrl: fixture.serverUrl, username: fixture.username, password: fixture.password })
  return { fixture, app, account: snapshot.accounts[0] }
}

describe('Dropbox connector', () => {
  it('signs in with PKCE, keeps the refresh token only in secure storage, and reads plan capabilities', async () => {
    const fixture = await dropboxFixture()
    const app = harness({ dropbox: fixture })
    expect(app.linked.snapshot()).toMatchObject({ dropboxConfigured: false, dropboxBuiltIn: false })
    await expect(app.linked.connectDropbox()).rejects.toThrow(/app key first/)
    expect(() => app.linked.configureDropbox('no')).toThrow(/8–32 letters/)
    app.linked.configureDropbox(fixture.appKey)
    const snapshot = await app.linked.connectDropbox()
    expect(fixture.tokenGrants).toEqual(['authorization_code'])
    expect(snapshot.accounts).toEqual([expect.objectContaining({
      provider: 'dropbox', name: 'Dropbox · ada@example.test', status: 'ready',
      capabilities: expect.objectContaining({ audiences: ['anyone', 'members'], password: 'unavailable', expiry: 'unavailable', edit: 'unavailable', resumableUpload: true })
    })])
    const registry = readFileSync(join(directory, 'cloud-storage-accounts.json'), 'utf8')
    const refresh = [...fixture.refreshTokens][0]
    expect(registry).not.toContain(refresh)
    expect(readFileSync(join(directory, 'cloud-storage-credentials.dat'), 'utf8')).not.toContain(refresh)
    // After a restart the access token is renewed from the stored refresh token.
    fixture.expireAccessTokens()
    const restarted = harness({ dropbox: fixture })
    await restarted.linked.refresh(snapshot.accounts[0].id)
    expect(fixture.tokenGrants).toEqual(['authorization_code', 'refresh_token'])
  })

  it('reports team audiences and team-only link policies for Business accounts', async () => {
    const business = await connectDropbox({ accountType: 'business' })
    expect(business.account.capabilities).toMatchObject({ audiences: ['anyone', 'organization', 'members'], password: 'available', expiry: 'available' })
    const restricted = await connectDropbox({ accountType: 'business', linkPolicy: 'team_only' })
    expect(restricted.account.capabilities.audiences).toEqual(['organization', 'members'])
    expect(restricted.account.capabilities.notes).toContain('Your Dropbox team only allows links for team members.')
  })

  it('uploads through upload sessions and shares with audience, password and expiry', async () => {
    const { fixture, app, account } = await connectDropbox({ accountType: 'pro' })
    const progress: CloudUploadProgress[] = []
    const result = await app.service.upload('upload-dropbox-1', 'imap-account', file, { audience: 'anyone', role: 'view', password: 'pw-1', expiresOn: '2026-11-01' }, (value) => progress.push(value), account.id)
    expect(result.status).toBe('shared')
    const stored = [...fixture.files.values()][0]
    expect(stored.data.equals(content)).toBe(true)
    expect(stored.path).toBe('/Aerio attachments/report.pdf')
    expect(fixture.appendOffsets).toEqual([0, 8, 16, 24, 32])
    expect(progress.at(-1)).toMatchObject({ sentBytes: content.length, totalBytes: content.length })
    const link = [...fixture.links.values()][0]
    expect(link.settings).toEqual({ audience: { '.tag': 'public' }, access: { '.tag': 'viewer' }, allow_download: true, requested_visibility: { '.tag': 'password' }, link_password: 'pw-1', expires: '2026-11-01T23:59:59Z' })
    if (result.status !== 'shared') throw new Error('not shared')
    expect(result.link).toMatchObject({ provider: 'dropbox', storageAccountId: account.id, accountId: 'imap-account', scopeLabel: 'Anyone with the link can view, with a password until 2026-11-01', expiresAt: '2026-11-01T23:59:59Z' })
    expect(JSON.stringify(result.link)).not.toContain('pw-1')
    expect(JSON.stringify(app.state.links())).not.toContain('pw-1')
    expect(await app.service.verify('imap-account', [link.url])).toEqual([])
  })

  it('refuses settings the plan does not allow before uploading, and explains server refusals', async () => {
    const { fixture, app, account } = await connectDropbox()
    await expect(app.service.upload('upload-dropbox-2', 'imap-account', file, { audience: 'anyone', role: 'view', password: 'x' }, undefined, account.id)).rejects.toThrow(/cannot protect links with a password/)
    await expect(app.service.upload('upload-dropbox-3', 'imap-account', file, { audience: 'anyone', role: 'edit' }, undefined, account.id)).rejects.toThrow(/can only be viewed/)
    await expect(app.service.upload('upload-dropbox-4', 'imap-account', file, { audience: 'organization', role: 'view' }, undefined, account.id)).rejects.toThrow(/cannot share with people in your dropbox team/)
    expect(fixture.sessions.size).toBe(0)
    // Stale capabilities: the server refuses and the unshared upload is removed.
    app.linked.account(account.id).capabilities.password = 'available'
    await expect(app.service.upload('upload-dropbox-5', 'imap-account', file, { audience: 'anyone', role: 'view', password: 'x' }, undefined, account.id)).rejects.toThrow(/plan does not allow link passwords/)
    expect(fixture.files.size).toBe(0)
    expect(app.state.uploads()).toEqual([])
  })

  it('continues from the corrected offset when a chunk connection drops', async () => {
    const { fixture, app, account } = await connectDropbox({ dropAfterAppend: 2 })
    const result = await app.service.upload('upload-dropbox-6', 'imap-account', file, { audience: 'members', role: 'view' }, undefined, account.id)
    expect(result.status).toBe('shared')
    expect([...fixture.files.values()][0].data.equals(content)).toBe(true)
    expect([...fixture.links.values()][0].settings.audience).toEqual({ '.tag': 'no_one' })
  })

  it('resumes an interrupted upload after a restart from the acknowledged offset', async () => {
    const { fixture, app, account } = await connectDropbox()
    await expect(app.service.upload('upload-dropbox-7', 'imap-account', file, { audience: 'anyone', role: 'view' }, (value) => { if (value.sentBytes >= 16) fixture.offline = true }, account.id)).rejects.toThrow()
    fixture.offline = false
    const restarted = harness({ dropbox: fixture, builtInKey: true })
    const [pending] = await restarted.service.pending('imap-account')
    expect(pending).toMatchObject({ uploadId: 'upload-dropbox-7', provider: 'dropbox', storageAccountId: account.id, totalBytes: content.length })
    expect(pending).not.toHaveProperty('sessionUrl')
    const before = fixture.appendOffsets.length
    const resumed = await restarted.service.resume('upload-dropbox-7')
    expect(resumed.status).toBe('shared')
    expect([...fixture.files.values()][0].data.equals(content)).toBe(true)
    // Nothing before the acknowledged 16 bytes was sent again.
    expect(Math.min(...fixture.appendOffsets.slice(before).filter((offset) => offset > 0))).toBeGreaterThanOrEqual(16)
    expect(await restarted.service.pending('imap-account')).toEqual([])
  })

  it('reports expired, revoked and deleted links before sending, and revokes on request', async () => {
    const { fixture, app, account } = await connectDropbox({ accountType: 'pro' })
    const share = async (id: string, expiresOn?: string) => {
      const result = await app.service.upload(id, 'imap-account', file, { audience: 'anyone', role: 'view', ...(expiresOn ? { expiresOn } : {}) }, undefined, account.id)
      if (result.status !== 'shared') throw new Error('not shared')
      return result.link
    }
    const expiring = await share('upload-dropbox-8', '2026-10-20')
    const revoked = await share('upload-dropbox-9')
    const deleted = await share('upload-dropbox-10')
    fixture.links.delete(revoked.url)
    fixture.files.delete(deleted.fileId)
    app.now.value = Date.parse('2026-10-25T00:00:00Z')
    const issues = await app.service.verify('imap-account', [expiring.url, revoked.url, deleted.url])
    expect(issues.map((issue) => issue.problem)).toEqual(['expired', 'revoked', 'deleted'])
    expect(issues[1].message).toBe('Sharing for report (2).pdf was turned off in Dropbox, so recipients cannot open it.')
    expect(app.linked.links(account.id).map((link) => link.url)).toEqual([deleted.url, revoked.url, expiring.url])
    expect(await app.linked.revoke(expiring.url)).toHaveLength(2)
    expect(fixture.links.has(expiring.url)).toBe(false)
    await expect(app.linked.revoke('https://unknown.test/x')).rejects.toThrow(/did not create/)
  })

  it('disconnect signs out and clears credentials, sessions and links', async () => {
    const { fixture, app, account } = await connectDropbox()
    await app.service.upload('upload-dropbox-11', 'imap-account', file, { audience: 'anyone', role: 'view' }, undefined, account.id)
    await expect(app.service.upload('upload-dropbox-12', 'imap-account', file, { audience: 'anyone', role: 'view' }, (value) => { if (value.sentBytes >= 8) fixture.offline = true }, account.id)).rejects.toThrow()
    fixture.offline = false
    expect(app.state.uploads()).toHaveLength(1)
    expect((await app.linked.disconnect(account.id)).accounts).toEqual([])
    expect(fixture.accessTokens.size).toBe(0)
    expect(fixture.refreshTokens.size).toBe(0)
    expect(app.state.uploads()).toEqual([])
    expect(app.state.links()).toEqual([])
    const restarted = harness({ dropbox: fixture, builtInKey: true })
    expect(restarted.linked.snapshot().accounts).toEqual([])
    expect(() => restarted.linked.links(account.id)).toThrow(/no longer connected/)
  })

  it('escapes non-ASCII characters in Dropbox-API-Arg', () => {
    expect(dropboxArg({ path: '/Aerio attachments/Rapport été.pdf' })).toBe('{"path":"/Aerio attachments/Rapport \\u00e9t\\u00e9.pdf"}')
  })
})

describe('ownCloud and Nextcloud connector', () => {
  it('checks the app password, discovers capabilities, and keeps the password in secure storage', async () => {
    const fixture = await ocsFixture({ passwordEnforced: true, expiryEnforcedDays: 7 })
    const app = harness()
    await expect(app.linked.connectServer({ provider: 'nextcloud', serverUrl: fixture.serverUrl, username: 'ada', password: 'wrong' })).rejects.toThrow(/did not accept the user name and app password/)
    await expect(app.linked.connectServer({ provider: 'nextcloud', serverUrl: 'http://cloud.example.test', username: 'ada', password: 'x' })).rejects.toThrow(/must use https/)
    const snapshot = await app.linked.connectServer({ provider: 'nextcloud', serverUrl: `${fixture.url}/index.php/login`, username: fixture.username, password: fixture.password })
    expect(snapshot.accounts).toEqual([expect.objectContaining({
      provider: 'nextcloud', name: 'Nextcloud · Ada Lovelace', username: 'ada', serverUrl: fixture.serverUrl, status: 'ready',
      capabilities: expect.objectContaining({ audiences: ['anyone'], password: 'enforced', expiry: 'enforced', maxExpiryDays: 7, edit: 'unavailable', resumableUpload: true })
    })])
    expect(snapshot.accounts[0]).not.toHaveProperty('remoteUserId')
    expect(readFileSync(join(directory, 'cloud-storage-accounts.json'), 'utf8')).not.toContain(fixture.password)
    expect(readFileSync(join(directory, 'cloud-storage-credentials.dat'), 'utf8')).not.toContain(fixture.password)
    // Connecting the same server and user again updates the account instead of adding one.
    expect((await app.linked.connectServer({ provider: 'nextcloud', serverUrl: fixture.serverUrl, username: fixture.username, password: fixture.password, name: 'Work cloud' })).accounts).toEqual([expect.objectContaining({ name: 'Work cloud' })])
  })

  it('maps OCS capabilities to enforced, available and unavailable settings', () => {
    expect(parseOcsCapabilities('owncloud', { version: { major: 10 }, capabilities: { dav: { chunking: '1.0' }, files_sharing: { public: { enabled: true, password: { enforced_for: { read_only: true } }, expire_date: { enabled: true, days: '30' }, upload: true } } } })).toMatchObject({
      serverVersion: 10, chunkedUpload: false,
      capabilities: { audiences: ['anyone'], password: 'enforced', expiry: 'available', defaultExpiryDays: 30, edit: 'available', resumableUpload: false }
    })
    expect(parseOcsCapabilities('nextcloud', { version: { major: 25 }, capabilities: { dav: { chunking: '1.0' }, files_sharing: { public: { enabled: true } } } }).chunkedUpload).toBe(false)
    expect(parseOcsCapabilities('nextcloud', { capabilities: { files_sharing: { public: { enabled: false } } } }).capabilities).toMatchObject({ audiences: [], password: 'unavailable', expiry: 'unavailable', edit: 'unavailable' })
  })

  it('uploads with chunked upload v2 and creates a public link with password and expiry', async () => {
    const { fixture, app, account } = await connectServer({ passwordEnforced: true, expiryEnforcedDays: 7 })
    const result = await app.service.upload('upload-ocs-1', 'imap-account', file, { audience: 'anyone', role: 'view', password: 'pw-2', expiresOn: '2026-10-20' }, undefined, account.id)
    expect(fixture.files.get('Aerio attachments/report.pdf')?.equals(content)).toBe(true)
    expect(fixture.chunkPuts).toEqual([1, 2, 3, 4, 5, 6])
    expect(fixture.plainPuts).toBe(0)
    expect([...fixture.shares.values()][0]).toMatchObject({ path: 'Aerio attachments/report.pdf', password: 'pw-2', expiration: '2026-10-20 00:00:00', permissions: 1 })
    expect(result).toMatchObject({ status: 'shared', link: { provider: 'nextcloud', fileId: '/Aerio attachments/report.pdf', expiresAt: '2026-10-20T23:59:59Z', scopeLabel: 'Anyone with the link can view, with a password until 2026-10-20' } })
    // A second upload of the same name gets its own file.
    await app.service.upload('upload-ocs-2', 'imap-account', file, { audience: 'anyone', role: 'view', password: 'pw-2', expiresOn: '2026-10-20' }, undefined, account.id)
    expect(fixture.files.has('Aerio attachments/report (2).pdf')).toBe(true)
  })

  it('enforces server link rules before uploading and surfaces server refusals', async () => {
    const { fixture, app, account } = await connectServer({ passwordEnforced: true, expiryEnforcedDays: 7 })
    const upload = (id: string, share: Record<string, unknown>) => app.service.upload(id, 'imap-account', file, { audience: 'anyone', role: 'view', ...share }, undefined, account.id)
    await expect(upload('upload-ocs-3', { expiresOn: '2026-10-20' })).rejects.toThrow(/requires a password/)
    await expect(upload('upload-ocs-4', { password: 'x' })).rejects.toThrow(/requires an expiry date within 7 days/)
    await expect(upload('upload-ocs-5', { password: 'x', expiresOn: '2026-12-31' })).rejects.toThrow(/at most 7 days/)
    await expect(upload('upload-ocs-6', { password: 'x', expiresOn: '2026-10-20', role: 'edit' })).rejects.toThrow(/can only be viewed/)
    await expect(upload('upload-ocs-7', { password: 'x', expiresOn: '2026-01-01' })).rejects.toThrow(/in the future/)
    expect(fixture.uploads.size + fixture.files.size).toBe(0)
    // The administrator tightened the rules after Aerio last checked: the server's reason is shown.
    app.linked.account(account.id).capabilities.expiry = 'available'
    await expect(upload('upload-ocs-8', { password: 'x' })).rejects.toThrow('Nextcloud refused the link: Expiration date is enforced')
    expect(fixture.files.size).toBe(0)
    await app.linked.refresh(account.id)
    expect(app.linked.account(account.id).capabilities.expiry).toBe('enforced')
  })

  it('retries a dropped chunk from the chunks the server already holds', async () => {
    const { fixture, app, account } = await connectServer({ dropAfterChunk: 3 })
    const result = await app.service.upload('upload-ocs-9', 'imap-account', file, { audience: 'anyone', role: 'view' }, undefined, account.id)
    expect(result.status).toBe('shared')
    expect(fixture.files.get('Aerio attachments/report.pdf')?.equals(content)).toBe(true)
    expect(fixture.chunkPuts).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('resumes a chunked upload after a restart without resending stored chunks', async () => {
    const { fixture, app, account } = await connectServer()
    await expect(app.service.upload('upload-ocs-10', 'imap-account', file, { audience: 'anyone', role: 'view' }, (value) => { if (value.sentBytes >= 24) fixture.offline = true }, account.id)).rejects.toThrow()
    fixture.offline = false
    expect(fixture.chunkPuts).toEqual([1, 2, 3])
    const restarted = harness()
    expect(await restarted.service.pending('imap-account')).toEqual([expect.objectContaining({ uploadId: 'upload-ocs-10', provider: 'nextcloud' })])
    const progress: number[] = []
    const resumed = await restarted.linked.resume('upload-ocs-10', (value) => progress.push(value.sentBytes))
    expect(resumed.status).toBe('shared')
    expect(progress[0]).toBe(24)
    expect(fixture.chunkPuts).toEqual([1, 2, 3, 4, 5, 6])
    expect(fixture.files.get('Aerio attachments/report.pdf')?.equals(content)).toBe(true)
  })

  it('clears an upload whose chunk folder the server already removed', async () => {
    const { fixture, app, account } = await connectServer()
    await expect(app.service.upload('upload-ocs-11', 'imap-account', file, { audience: 'anyone', role: 'view' }, (value) => { if (value.sentBytes >= 8) fixture.offline = true }, account.id)).rejects.toThrow()
    fixture.offline = false
    fixture.uploads.clear()
    await expect(app.service.resume('upload-ocs-11')).rejects.toThrow(/expired/)
    expect(app.state.uploads()).toEqual([])
  })

  it('falls back to one streamed PUT on ownCloud and restarts it after a dropped connection', async () => {
    const { fixture, app, account } = await connectServer({ major: 10, chunking: false, dropAfterChunk: 1, publicUpload: true }, 'owncloud')
    expect(account.capabilities).toMatchObject({ resumableUpload: false, edit: 'available' })
    const result = await app.service.upload('upload-ocs-12', 'imap-account', file, { audience: 'anyone', role: 'edit' }, undefined, account.id)
    expect(result.status).toBe('shared')
    expect(fixture.plainPuts).toBe(2)
    expect(fixture.chunkPuts).toEqual([])
    expect(fixture.files.get('Aerio attachments/report.pdf')?.equals(content)).toBe(true)
    expect([...fixture.shares.values()][0].permissions).toBe(3)
  })

  it('cancels a running chunked upload and removes the chunk folder', async () => {
    const { fixture, app, account } = await connectServer()
    const result = await app.service.upload('upload-ocs-13', 'imap-account', file, { audience: 'anyone', role: 'view' }, (value) => { if (value.sentBytes >= 16) void app.service.cancel('upload-ocs-13') }, account.id)
    expect(result).toEqual({ status: 'cancelled', uploadId: 'upload-ocs-13' })
    expect(fixture.uploads.size).toBe(0)
    expect(fixture.shares.size).toBe(0)
    expect(app.state.uploads()).toEqual([])
  })

  it('reports expired, revoked and deleted shares, and turns links off with DELETE', async () => {
    const { fixture, app, account } = await connectServer()
    const share = async (id: string, expiresOn?: string) => {
      const result = await app.service.upload(id, 'imap-account', file, { audience: 'anyone', role: 'view', ...(expiresOn ? { expiresOn } : {}) }, undefined, account.id)
      if (result.status !== 'shared') throw new Error('not shared')
      return result.link
    }
    const expiring = await share('upload-ocs-14', '2026-10-19')
    const revoked = await share('upload-ocs-15')
    const deleted = await share('upload-ocs-16')
    const healthy = await share('upload-ocs-17')
    fixture.shares.delete([...fixture.shares.values()].find((item) => item.url === revoked.url)!.id)
    fixture.files.delete(deleted.fileId.slice(1))
    app.now.value = Date.parse('2026-10-21T00:00:00Z')
    expect((await app.service.verify('imap-account', [expiring.url, revoked.url, deleted.url, healthy.url])).map((issue) => issue.problem)).toEqual(['expired', 'revoked', 'deleted'])
    await app.linked.revoke(healthy.url)
    expect([...fixture.shares.values()].some((item) => item.url === healthy.url)).toBe(false)
    expect(app.linked.links(account.id).map((link) => link.url)).not.toContain(healthy.url)
  })

  it('marks the account as needing sign-in when the app password is revoked', async () => {
    const { app, account } = await connectServer({}, 'nextcloud')
    const vault = new DavCredentialVault(join(directory, 'cloud-storage-credentials.dat'), fakeSecureStorage())
    vault.save(account.id, 'revoked-password')
    const restarted = harness()
    await expect(restarted.linked.refresh(account.id)).rejects.toThrow(/no longer accepts the app password/)
    expect(restarted.linked.snapshot().accounts[0]).toMatchObject({ status: 'needs-auth' })
    await expect(restarted.service.upload('upload-ocs-18', 'imap-account', file, { audience: 'anyone', role: 'view' }, undefined, account.id)).rejects.toThrow(/no longer accepts/)
    void app
  })

  it('disconnect deletes the app password, unfinished chunk folders and link records', async () => {
    const { fixture, app, account } = await connectServer()
    await app.service.upload('upload-ocs-19', 'imap-account', file, { audience: 'anyone', role: 'view' }, undefined, account.id)
    await expect(app.service.upload('upload-ocs-20', 'imap-account', file, { audience: 'anyone', role: 'view' }, (value) => { if (value.sentBytes >= 8) fixture.offline = true }, account.id)).rejects.toThrow()
    fixture.offline = false
    expect(fixture.uploads.size).toBe(1)
    await app.linked.disconnect(account.id)
    expect(fixture.uploads.size).toBe(0)
    expect(app.state.uploads()).toEqual([])
    expect(app.state.links()).toEqual([])
    expect(new DavCredentialVault(join(directory, 'cloud-storage-credentials.dat'), fakeSecureStorage()).has(account.id)).toBe(false)
    // Links already sent are not revoked by disconnecting.
    expect(fixture.shares.size).toBe(1)
  })
})

describe('linked storage plumbing', () => {
  it('normalizes server addresses', () => {
    expect(normalizeCloudServerUrl('cloud.example.test/nextcloud/remote.php/dav/files/ada')).toBe('https://cloud.example.test/nextcloud/')
    expect(normalizeCloudServerUrl('http://localhost:8080')).toBe('http://localhost:8080/')
    expect(() => normalizeCloudServerUrl('https://ada:pw@cloud.example.test')).toThrow(/Remove the user name/)
  })

  it('registers storage IPC with input validation and app-lock enforcement', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    let locked = false
    const service = { snapshot: vi.fn(() => ({ accounts: [] })), disconnect: vi.fn(async () => ({ accounts: [] })), revoke: vi.fn(async () => []) }
    registerCloudStorage({ handle: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler) } } as never, () => service as never, () => locked)
    expect([...handlers.keys()]).toEqual(['mail:cloud:storage:snapshot', 'mail:cloud:storage:configure-dropbox', 'mail:cloud:storage:connect-dropbox', 'mail:cloud:storage:connect-server', 'mail:cloud:storage:refresh', 'mail:cloud:storage:disconnect', 'mail:cloud:storage:links', 'mail:cloud:storage:revoke'])
    expect(handlers.get('mail:cloud:storage:snapshot')!({})).toEqual({ accounts: [] })
    expect(() => handlers.get('mail:cloud:storage:disconnect')!({}, 42)).toThrow(/Choose a storage account/)
    expect(() => handlers.get('mail:cloud:storage:revoke')!({}, '')).toThrow(/Choose a link/)
    await handlers.get('mail:cloud:storage:disconnect')!({}, 'nextcloud-1')
    expect(service.disconnect).toHaveBeenCalledWith('nextcloud-1')
    locked = true
    expect(() => handlers.get('mail:cloud:storage:snapshot')!({})).toThrow(/Unlock Aerio/)
  })

  it('rejects linked uploads for unknown storage accounts and unapproved files', async () => {
    const app = harness()
    await expect(app.service.upload('upload-x-1', 'imap-account', file, { audience: 'anyone', role: 'view' }, undefined, 'nextcloud-missing')).rejects.toThrow(/no longer connected/)
    await expect(app.service.upload('upload-x-2', 'imap-account', join(directory, 'other.txt'), { audience: 'anyone', role: 'view' }, undefined, 'nextcloud-missing')).rejects.toThrow(/Choose the file/)
    await expect(app.service.upload('upload-x-3', 'missing-account', file, { audience: 'anyone', role: 'view' }, undefined, 'nextcloud-missing')).rejects.toThrow(/Account not found/)
  })
})
