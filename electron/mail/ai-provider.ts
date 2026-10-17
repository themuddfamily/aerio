import type { AiProviderId } from '../../src/ai-assistant-types'

// Minimal fetch-based clients for the Anthropic Messages API and any
// OpenAI-compatible chat completions endpoint (OpenAI, Ollama, LM Studio…).
// The model is never given tools, so a response can only ever be text.

export interface AiProviderConfig {
  provider: AiProviderId
  model: string
  baseUrl: string
  apiKey?: string
}

export interface AiPrompt {
  system: string
  user: string
  maxTokens: number
}

export const AI_REQUEST_TIMEOUT_MS = 60_000
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'

export class AiRequestError extends Error {
  constructor(message: string, readonly kind: 'cancelled' | 'timeout' | 'network' | 'auth' | 'rate-limit' | 'provider' | 'config') {
    super(message)
  }
}

/** Accepts HTTPS anywhere, or plain HTTP only for a model server on this computer. */
export function validateAiBaseUrl(value: string) {
  let url: URL
  try { url = new URL(value) } catch { throw new AiRequestError('Enter a valid AI server URL', 'config') }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new AiRequestError('Use HTTPS for the AI server, or a local server on localhost', 'config')
  if (url.username || url.password || url.search || url.hash) throw new AiRequestError('Enter an AI server URL without credentials or query parameters', 'config')
  return url
}

function chatCompletionsUrl(baseUrl: string) {
  const url = validateAiBaseUrl(baseUrl)
  url.pathname = `${url.pathname.replace(/\/$/, '').replace(/\/chat\/completions$/, '')}/chat/completions`
  return url
}

// Provider error bodies are shown to the user, so they are flattened to a short single line.
const providerMessage = (value: unknown) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 200) : ''

export function describeProviderFailure(status: number, body: unknown) {
  const record = body && typeof body === 'object' ? body as { error?: unknown; message?: unknown } : {}
  const error = record.error
  const detail = providerMessage(typeof error === 'string' ? error : error && typeof error === 'object' ? (error as { message?: unknown }).message : record.message)
  const suffix = detail ? ` ${detail}` : ''
  if (status === 401 || status === 403) return new AiRequestError(`The AI provider rejected the API key (${status}).${suffix}`, 'auth')
  if (status === 404) return new AiRequestError(`The AI model or endpoint was not found (404). Check the model name and server URL.${suffix}`, 'provider')
  if (status === 429) return new AiRequestError(`The AI provider is rate limiting requests (429). Try again shortly.${suffix}`, 'rate-limit')
  if (status >= 500) return new AiRequestError(`The AI provider is unavailable (${status}). Try again later.${suffix}`, 'provider')
  return new AiRequestError(`The AI request failed (${status}).${suffix}`, 'provider')
}

function requestFor(config: AiProviderConfig, prompt: AiPrompt): { url: URL; init: RequestInit } {
  if (config.provider === 'anthropic') {
    if (!config.apiKey) throw new AiRequestError('Add an Anthropic API key in Settings › AI assistance', 'config')
    return {
      url: new URL(ANTHROPIC_URL),
      init: {
        headers: { 'content-type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: config.model, max_tokens: prompt.maxTokens, system: prompt.system, messages: [{ role: 'user', content: prompt.user }] })
      }
    }
  }
  return {
    url: chatCompletionsUrl(config.baseUrl),
    init: {
      headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify({ model: config.model, max_tokens: prompt.maxTokens, stream: false, messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }] })
    }
  }
}

function responseText(provider: AiProviderId, body: unknown) {
  if (provider === 'anthropic') {
    const content = (body as { content?: unknown })?.content
    if (Array.isArray(content)) return content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text as string).join('')
  } else {
    const content = (body as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content
    if (typeof content === 'string') return content
  }
  throw new AiRequestError('The AI provider returned a response Aerio could not read', 'provider')
}

/**
 * Sends one prompt and resolves with the model's text. `signal` is the user's
 * cancel signal; a separate timeout bounds every request.
 */
export async function requestAiCompletion(config: AiProviderConfig, prompt: AiPrompt, signal: AbortSignal, fetchImpl: typeof fetch = fetch, timeoutMs = AI_REQUEST_TIMEOUT_MS) {
  if (!config.model) throw new AiRequestError('Choose an AI model in Settings › AI assistance', 'config')
  const { url, init } = requestFor(config, prompt)
  const timeout = AbortSignal.timeout(timeoutMs)
  let response: Response
  let body: unknown
  try {
    response = await fetchImpl(url, { ...init, method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, timeout]) })
    body = await response.json().catch(() => undefined)
  } catch (error) {
    if (signal.aborted) throw new AiRequestError('The AI request was cancelled', 'cancelled')
    if (timeout.aborted) throw new AiRequestError(`The AI provider did not respond within ${Math.round(timeoutMs / 1000)} seconds`, 'timeout')
    throw new AiRequestError(`Could not reach the AI provider. ${error instanceof Error ? providerMessage(error.message) : ''}`.trim(), 'network')
  }
  if (signal.aborted) throw new AiRequestError('The AI request was cancelled', 'cancelled')
  if (!response.ok) throw describeProviderFailure(response.status, body)
  return responseText(config.provider, body)
}
