import type { ProviderProductivityData, ProductivityProvider } from '../../src/productivity-types'

export interface ProductivityConnector {
  readonly provider: ProductivityProvider
  sync(): Promise<ProviderProductivityData>
}

export class ProductivityApiError extends Error {
  constructor(message: string, readonly provider: ProductivityProvider, readonly status: number) {
    super(message)
    this.name = 'ProductivityApiError'
  }
}

export async function retryingJson<T>(
  provider: ProductivityProvider,
  url: string,
  token: () => Promise<string>,
  init: RequestInit = {},
  attempt = 0
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${await token()}`,
      Accept: 'application/json',
      ...init.headers
    }
  })
  if (response.ok) return await response.json() as T
  if ((response.status === 429 || response.status >= 500) && attempt < 5) {
    const retryAfter = Number(response.headers.get('retry-after') ?? 0)
    const delay = retryAfter > 0 ? retryAfter * 1_000 : Math.min(32_000, (2 ** attempt) * 750 + Math.floor(Math.random() * 500))
    await new Promise((resolve) => setTimeout(resolve, delay))
    return retryingJson(provider, url, token, init, attempt + 1)
  }
  const details = await response.json().catch(() => ({})) as { error?: { message?: string } }
  throw new ProductivityApiError(details.error?.message ?? `${provider === 'gmail' ? 'Google' : 'Microsoft'} synchronization failed (${response.status})`, provider, response.status)
}
