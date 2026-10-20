import type { MeetingHostProvider } from '../../src/meeting-host-types'
import { MEETING_HOSTS } from './meeting-host-providers'
import { MeetingHostAuthError, revokedMessage } from './meeting-host-vault'

// Authenticated JSON requests to the Zoom and Webex APIs (E47).

export interface MeetingHostTokens {
  accessToken(provider: MeetingHostProvider, options?: { forceRefresh?: boolean }): Promise<string>
  markRevoked(provider: MeetingHostProvider, reason?: string): void
}

// A request that failed. `uncertain` means the provider may have acted on it anyway (no response, a timeout,
// or a gateway/server error), so a creation must be looked up before it is attempted again.
export class MeetingHostRequestError extends Error {
  constructor(message: string, readonly status: number | undefined, readonly uncertain: boolean) {
    super(message)
    this.name = 'MeetingHostRequestError'
  }
}

export const isUncertainOutcome = (error: unknown) => error instanceof MeetingHostRequestError && error.uncertain

const providerMessage = (body: unknown) => {
  if (!body || typeof body !== 'object') return undefined
  const value = body as { message?: unknown; errors?: { description?: unknown }[] }
  const detail = value.errors?.map((item) => item.description).find((item) => typeof item === 'string')
  return [typeof value.message === 'string' ? value.message : undefined, typeof detail === 'string' ? detail : undefined].filter(Boolean).join(': ') || undefined
}

export class MeetingHostHttp {
  private readonly fetch: typeof fetch
  private readonly timeoutMs: number

  constructor(readonly provider: MeetingHostProvider, private readonly tokens: MeetingHostTokens, options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  get label() {
    return MEETING_HOSTS[this.provider].label
  }

  url(path: string, query?: Record<string, string | number | undefined>) {
    const url = new URL(`${MEETING_HOSTS[this.provider].apiBase}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value))
    return url.toString()
  }

  async request<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown, options: { allowNotFound?: boolean } = {}): Promise<T | undefined> {
    const target = new URL(url), base = new URL(MEETING_HOSTS[this.provider].apiBase)
    if (target.origin !== base.origin || target.username || target.password || !(target.pathname === base.pathname || target.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/'))) throw new MeetingHostRequestError('Invalid meeting provider resource URL', undefined, false)
    const send = async (token: string) => {
      try {
        return await this.fetch(url, {
          method,
          redirect: 'error',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.timeoutMs)
        })
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        throw new MeetingHostRequestError(timedOut ? `${this.label} did not answer in time` : `${this.label} could not be reached`, undefined, true)
      }
    }
    let response = await send(await this.tokens.accessToken(this.provider))
    if (response.status === 401) {
      // An access token can be revoked before it expires: renew once, then treat a second 401 as revoked.
      response = await send(await this.tokens.accessToken(this.provider, { forceRefresh: true }))
      if (response.status === 401) {
        const detail = providerMessage(await response.json().catch(() => undefined))
        this.tokens.markRevoked(this.provider, detail)
        throw new MeetingHostAuthError(this.provider, revokedMessage(this.label))
      }
    }
    if (response.status === 404 && options.allowNotFound) return undefined
    if (response.status === 204 || response.status === 202) return undefined
    const parsed = await response.json().catch(() => undefined) as unknown
    if (response.ok) return parsed as T
    const detail = providerMessage(parsed)
    if (response.status === 403) {
      throw new MeetingHostRequestError(`${this.label} refused this request${detail ? ` (${detail})` : ''}. The connected account may lack meeting-host permission or a required license, or the app may be missing a scope.`, 403, false)
    }
    if (response.status === 429) throw new MeetingHostRequestError(`${this.label} is limiting requests; try again in a minute`, 429, false)
    // Gateways and servers can fail after the request was applied.
    throw new MeetingHostRequestError(`${this.label} returned an error (${response.status})${detail ? `: ${detail}` : ''}`, response.status, response.status >= 500)
  }
}
