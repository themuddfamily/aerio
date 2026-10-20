import { normalizeDavUrl } from '../src/lib/dav-presets'
import { MAX_SYNC_BYTES } from './settings-sync-crypto'
export interface RemoteSettingsFile { text: string; etag: string }
export interface SettingsSyncRemote { get(): Promise<RemoteSettingsFile | undefined>; put(text: string, etag?: string): Promise<string> }
const strongEtag = (value: string | null) => { if (!value || !/^"[^"\r\n]+"$/.test(value)) throw new Error('Settings synchronization requires strong ETags from the WebDAV server.'); return value }
async function limitedText(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length') ?? 0) > MAX_SYNC_BYTES) throw new Error('The remote settings file exceeds 70 MB.')
  if (!response.body) return ''
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
  for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > MAX_SYNC_BYTES) { await reader.cancel(); throw new Error('The remote settings file exceeds 70 MB.') } chunks.push(value) }
  return Buffer.concat(chunks).toString('utf8')
}
export function settingsSyncUrl(value: unknown): string {
  const url = normalizeDavUrl(value)
  if (new URL(url).pathname.endsWith('/')) throw new Error('Enter the full WebDAV file URL, for example https://cloud.example.com/aerio-settings.enc.json.')
  return url
}
export class WebDavSettingsRemote implements SettingsSyncRemote {
  constructor(private readonly url: string, private readonly username: string, private readonly password: string, private readonly request: typeof fetch = fetch, private readonly signal?: AbortSignal) {}
  private async fetch(method: string, extra: Record<string, string> = {}, body?: string) {
    const response = await this.request(this.url, { method, redirect: 'error', signal: this.signal ? AbortSignal.any([AbortSignal.timeout(60_000), this.signal]) : AbortSignal.timeout(60_000), headers: { Authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`, 'Content-Type': 'application/json', ...extra }, ...(body !== undefined ? { body } : {}) })
    if (response.status === 401 || response.status === 403) throw new Error('The WebDAV server rejected access. Check your user name and app password.')
    if (response.status === 412) throw new Error('The remote settings changed during synchronization. Sync again to review the latest version.')
    if (response.status !== 404 && !response.ok) throw new Error(`The WebDAV server returned ${response.status}.`)
    return response
  }
  async get(): Promise<RemoteSettingsFile | undefined> {
    const response = await this.fetch('GET')
    if (response.status === 404) { await response.body?.cancel(); return }
    return { text: await limitedText(response), etag: strongEtag(response.headers.get('etag')) }
  }
  async put(text: string, etag?: string): Promise<string> {
    if (Buffer.byteLength(text) > MAX_SYNC_BYTES) throw new Error('The synchronized settings file exceeds 70 MB.')
    const response = await this.fetch('PUT', etag ? { 'If-Match': strongEtag(etag) } : { 'If-None-Match': '*' }, text)
    if (response.status === 404) throw new Error('The WebDAV destination folder does not exist. Create it on your server first.')
    await response.body?.cancel()
    const returned = response.headers.get('etag')
    if (returned) return strongEtag(returned)
    const reread = await this.get()
    if (!reread || reread.text !== text) throw new Error('The uploaded settings changed before their version could be verified. Sync again.')
    return reread.etag
  }
}
