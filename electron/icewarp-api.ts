import { ProviderChatError } from './chat/providers/adapter'
/** IceWarp's documented TeamChat user API, shared by chat and conference adapters. */
export type IceWarpObject = Record<string, any>
export class IceWarpApiError extends ProviderChatError {}
export function iceWarpServer(value: unknown): string {
  try {
    const input = typeof value === 'string' ? value.trim() : ''
    const url = new URL(input)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /%2f|%5c|%2e|\\/i.test(input) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(input)) throw Error()
    return url.href.replace(/\/+$/, '').replace(/\/teamchatapi$/i, '')
  } catch { throw new IceWarpApiError('Enter the HTTPS IceWarp server URL without credentials, query or fragment.', 'rejected') }
}
const methods = new Set(['iwauthentication.login.plain', 'auth.test', 'auth.revoke', 'channels.list', 'channels.info', 'channels.userPermissions', 'channels.setLastSeenId', 'threads.list', 'threads.comments', 'chat.postMessage', 'conferences.list', 'conferences.meetNow', 'conferences.info', 'events.add', 'events.get', 'events.delete'])
export const iceWarpText = (value: unknown, limit = 28_000): string => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, limit) : ''
export const iceWarpId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_+/.=@-]{1,2048}$/.test(value)
export const iceWarpTimestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{1,12}\.\d{1,10}$/.test(value) && Number.isFinite(Number(value))

export class IceWarpApi {
  readonly server: string
  constructor(server: string, private readonly token: string, private readonly fetcher: typeof fetch = fetch) {
    this.server = iceWarpServer(server)
    if (token && (token.length > 8192 || /[\x00-\x20\x7f]/.test(token))) throw new IceWarpApiError('Enter a valid IceWarp API token.', 'auth')
  }
  async request(method: string, parameters: Record<string, unknown> = {}, mutation = false): Promise<IceWarpObject> {
    if (!methods.has(method)) throw new IceWarpApiError('Unsupported IceWarp API operation.', 'rejected')
    if (method !== 'iwauthentication.login.plain' && !this.token) throw new IceWarpApiError('Reconnect IceWarp with a valid API token.', 'auth')
    let response: Response
    try {
      response = await this.fetcher(new URL(`${this.server}/teamchatapi/${method}`), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ ...parameters, ...(this.token ? { token: this.token } : {}) }), redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(20_000) })
    } catch { throw new IceWarpApiError(mutation ? 'IceWarp did not confirm delivery. Review the server before retrying.' : 'IceWarp could not be reached.', mutation ? 'uncertain' : 'network') }
    if (response.status === 401) throw new IceWarpApiError('IceWarp authorization expired. Reconnect your account.', 'auth')
    if (response.status === 403) throw new IceWarpApiError('IceWarp denied access. Check permissions and server policy.', 'permission')
    if (response.status === 429) throw new IceWarpApiError('IceWarp rate limit reached. Wait before trying again.', 'rate-limit', Math.max(1, Math.min(3600, Number(response.headers.get('Retry-After')) || 60)))
    if (!response.ok) throw new IceWarpApiError('IceWarp did not confirm the request.', mutation && response.status >= 500 ? 'uncertain' : 'rejected')
    let result: IceWarpObject
    try {
      if (Number(response.headers.get('content-length') ?? 0) > 4_000_000) throw Error()
      const reader = response.body?.getReader(); if (!reader) throw Error()
      const chunks: Uint8Array[] = []; let size = 0
      try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 4_000_000) throw Error(); chunks.push(next.value) } }
      finally { await reader.cancel().catch(() => {}) }
      result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error()
    } catch { throw new IceWarpApiError('IceWarp returned an invalid response.', mutation ? 'uncertain' : 'rejected') }
    if (result.ok !== true) {
      const kind = ['invalid_credentials', 'missing_token', 'invalid_token'].includes(result.error) ? 'auth' : ['no_permission', 'channel_not_found'].includes(result.error) ? 'permission' : mutation && result.ok !== false ? 'uncertain' : 'rejected'
      throw new IceWarpApiError('IceWarp rejected the request. Check authorization, permissions and server configuration.', kind)
    }
    return result
  }
}
