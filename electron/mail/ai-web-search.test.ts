import { describe, expect, it, vi } from 'vitest'
import { searchAiWeb } from './ai-web-search'
const signal = () => new AbortController().signal
const response = (generic: unknown[]) => new Response(JSON.stringify({ grounding: { generic } }))
describe('Brave public web context', () => {
  it('uses only the fixed authenticated provider and returns bounded extracted content with safe citation links', async () => {
    const fetcher = vi.fn(async () => response([{ url: 'https://example.com/page', title: 'Source', snippets: ['Extracted public text'] }, { url: 'http://127.0.0.1', snippets: [] }, { url: 'https://user:pass@example.com', snippets: [] }, { url: 'https://service.local', snippets: [] }, { url: 'https://[::1]', snippets: [] }]))
    const results = await searchAiWeb('public research', 'secret-token', signal(), fetcher as typeof fetch)
    const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.origin + url.pathname).toBe('https://api.search.brave.com/res/v1/llm/context')
    expect(url.searchParams.get('q')).toBe('public research')
    expect(options).toMatchObject({ redirect: 'error', credentials: 'omit', headers: { 'X-Subscription-Token': 'secret-token' } })
    expect(results).toEqual([{ id: 'web:0', title: 'Source', url: 'https://example.com/page', content: 'Extracted public text' }])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('rejects oversized queries and responses, malformed data, and hides provider error bodies', async () => {
    const fetcher = vi.fn(async () => response([]))
    await expect(searchAiWeb('word '.repeat(76), 'key', signal(), fetcher as typeof fetch)).rejects.toThrow(/75 words/)
    expect(fetcher).not.toHaveBeenCalled()
    await expect(searchAiWeb('q', 'key', signal(), vi.fn(async () => new Response('secret-token', { status: 401 })) as typeof fetch)).rejects.toThrow('returned 401')
    await expect(searchAiWeb('q', 'key', signal(), vi.fn(async () => new Response('{}')) as typeof fetch)).rejects.toThrow(/unsupported/)
    await expect(searchAiWeb('q', 'key', signal(), vi.fn(async () => new Response('x'.repeat(1_000_001))) as typeof fetch)).rejects.toThrow(/too large/)
  })
})
