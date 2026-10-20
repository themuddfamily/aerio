import { isIP } from 'node:net'
import type { AiWebSource } from '../../src/ai-conversation-types'
import { sanitizeModelText } from './ai-prompts'

export interface AiWebContext extends AiWebSource { content: string }
/** No arbitrary page requests: Brave returns extracted public-page content from its fixed API. */
export async function searchAiWeb(query: string, key: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<AiWebContext[]> {
  if (!query.trim() || query.length > 600 || query.trim().split(/\s+/).length > 75) throw new Error('Web queries must contain at most 600 characters and 75 words')
  const url = new URL('https://api.search.brave.com/res/v1/llm/context')
  url.search = new URLSearchParams({ q: query.trim(), count: '5', maximum_number_of_urls: '5', maximum_number_of_tokens: '2048', maximum_number_of_snippets: '10', maximum_number_of_tokens_per_url: '512', safesearch: 'moderate', enable_local: 'false' }).toString()
  const response = await fetchImpl(url, { headers: { 'X-Subscription-Token': key, Accept: 'application/json' }, redirect: 'error', credentials: 'omit', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) })
  if (!response.ok) throw new Error(`The web search provider returned ${response.status}. Check the Brave Search token and subscription.`)
  if (Number(response.headers.get('content-length') ?? 0) > 1_000_000) throw new Error('The web search response was too large')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('The web search provider returned no content')
  const chunks: Uint8Array[] = []; let bytes = 0
  while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 1_000_000) { await reader.cancel(); throw new Error('The web search response was too large') }; chunks.push(next.value) }
  const body = JSON.parse(Buffer.concat(chunks).toString())
  const values = body?.grounding?.generic
  if (!Array.isArray(values)) throw new Error('The web search provider returned an unsupported response')
  return values.slice(0, 5).flatMap((item, index) => {
    let source: URL
    try { source = new URL(item.url) } catch { return [] }
    if (source.protocol !== 'https:' || source.username || source.password || isIP(source.hostname.replace(/^\[|\]$/g, '')) || !source.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(source.hostname)) return []
    const snippets = Array.isArray(item.snippets) ? item.snippets.filter((value: unknown): value is string => typeof value === 'string').join('\n') : ''
    return [{ id: `web:${index}`, title: sanitizeModelText(typeof item.title === 'string' ? item.title : source.hostname, 200), url: source.toString(), content: sanitizeModelText(snippets, 5000) }]
  })
}
