import { describe, expect, it, vi } from 'vitest'
import { describeProviderFailure, requestAiCompletion, validateAiBaseUrl } from './ai-provider'

const prompt = { system: 'System rules', user: 'User text', maxTokens: 100 }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const anthropic = { provider: 'anthropic' as const, model: 'claude-sonnet-5-5', baseUrl: '', apiKey: 'sk-ant-test' }
const local = { provider: 'openai-compatible' as const, model: 'llama3.1', baseUrl: 'http://localhost:11434/v1' }

describe('AI providers', () => {
  it('calls the Anthropic Messages API with the key in headers and no tools', async () => {
    const fetchMock = vi.fn(async () => json({ content: [{ type: 'text', text: 'Hello ' }, { type: 'tool_use', name: 'x' }, { type: 'text', text: 'there' }] }))
    expect(await requestAiCompletion(anthropic, prompt, new AbortController().signal, fetchMock as typeof fetch)).toBe('Hello there')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(String(url)).toBe('https://api.anthropic.com/v1/messages')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } })
    const body = JSON.parse(String(init.body))
    expect(body).toEqual({ model: 'claude-sonnet-5-5', max_tokens: 100, system: 'System rules', messages: [{ role: 'user', content: 'User text' }] })
    expect(body).not.toHaveProperty('tools')
  })

  it('calls an OpenAI-compatible chat completions endpoint, with a bearer key only when one is set', async () => {
    const fetchMock = vi.fn(async () => json({ choices: [{ message: { content: 'Local answer' } }] }))
    expect(await requestAiCompletion(local, prompt, new AbortController().signal, fetchMock as typeof fetch)).toBe('Local answer')
    expect(await requestAiCompletion({ ...local, baseUrl: 'https://ai.example.test/v1/chat/completions/', apiKey: 'key' }, prompt, new AbortController().signal, fetchMock as typeof fetch)).toBe('Local answer')
    const calls = fetchMock.mock.calls as unknown as Array<[URL, RequestInit]>
    expect(String(calls[0][0])).toBe('http://localhost:11434/v1/chat/completions')
    expect(calls[0][1].headers).not.toHaveProperty('authorization')
    expect(String(calls[1][0])).toBe('https://ai.example.test/v1/chat/completions')
    expect(calls[1][1].headers).toMatchObject({ authorization: 'Bearer key' })
    expect(JSON.parse(String(calls[0][1].body)).messages).toEqual([{ role: 'system', content: 'System rules' }, { role: 'user', content: 'User text' }])
  })

  it('rejects remote plain HTTP, credentials in URLs, and a missing key or model before contacting anything', async () => {
    const fetchMock = vi.fn()
    expect(() => validateAiBaseUrl('http://ai.example.test/v1')).toThrow(/HTTPS/)
    expect(() => validateAiBaseUrl('https://user:pass@ai.example.test/v1')).toThrow(/credentials/)
    expect(() => validateAiBaseUrl('not a url')).toThrow(/valid/)
    await expect(requestAiCompletion({ ...anthropic, apiKey: undefined }, prompt, new AbortController().signal, fetchMock)).rejects.toThrow(/API key/)
    await expect(requestAiCompletion({ ...local, model: '' }, prompt, new AbortController().signal, fetchMock)).rejects.toThrow(/model/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps provider failures to readable, single-line errors', async () => {
    expect(describeProviderFailure(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } })).toMatchObject({ kind: 'auth', message: expect.stringMatching(/rejected the API key \(401\)\. invalid x-api-key/) })
    expect(describeProviderFailure(429, {}).kind).toBe('rate-limit')
    expect(describeProviderFailure(529, { error: { message: 'Overloaded\n\nretry' } }).message).toMatch(/unavailable \(529\)\. Try again later\. Overloaded retry$/)
    expect(describeProviderFailure(404, { error: 'model "x" not found' }).message).toMatch(/not found/)
    const fetchMock = vi.fn(async () => json({ error: { message: 'bad request' } }, 400))
    await expect(requestAiCompletion(anthropic, prompt, new AbortController().signal, fetchMock as typeof fetch)).rejects.toThrow(/failed \(400\)\. bad request/)
    const unreadable = vi.fn(async () => json({ unexpected: true }))
    await expect(requestAiCompletion(anthropic, prompt, new AbortController().signal, unreadable as typeof fetch)).rejects.toThrow(/could not read/)
    const offline = vi.fn(async () => { throw new TypeError('fetch failed') })
    await expect(requestAiCompletion(local, prompt, new AbortController().signal, offline as typeof fetch)).rejects.toMatchObject({ kind: 'network' })
  })

  it('aborts on user cancellation and on timeout with distinct messages', async () => {
    const hanging = vi.fn((_url: URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))))
    const controller = new AbortController()
    const pending = requestAiCompletion(anthropic, prompt, controller.signal, hanging as unknown as typeof fetch)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ kind: 'cancelled', message: 'The AI request was cancelled' })
    await expect(requestAiCompletion(anthropic, prompt, new AbortController().signal, hanging as unknown as typeof fetch, 20)).rejects.toMatchObject({ kind: 'timeout' })
  })
})
