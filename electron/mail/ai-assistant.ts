import { ipcMain, safeStorage } from 'electron'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { AI_DEFAULT_ANTHROPIC_MODEL, AI_DEFAULT_OPENAI_BASE_URL, AI_FEATURES, type AiAssistantSettingsInput, type AiAssistantStatus, type AiComposeInput, type AiFeature, type AiProviderId } from '../../src/ai-assistant-types'
import type { MailMessageRef, MailThreadDetail } from '../../src/mail-types'
import type { MailWorkerClient } from './worker-client'
import { assertSecureCredentialStorage } from './secure-storage'
import { AiRequestError, requestAiCompletion, validateAiBaseUrl, type AiPrompt } from './ai-provider'
import { composePrompt, conversationSummaryPrompt, learnWritingStylePrompt, parseReplySuggestions, parseSearchSuggestion, repliesPrompt, sanitizeModelText, searchPrompt, summarizePrompt } from './ai-prompts'

// The optional AI assistant is off by default. Non-secret settings live in a
// small JSON file; the API key is encrypted with OS secure storage in its own
// file and never crosses to the renderer. Every handler returns preview text
// only and only ever reads mail from the worker.

type StoredSettings = Omit<AiAssistantStatus, 'hasApiKey' | 'secureStorage'>

export interface AiKeyStorage {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

const defaultFeatures = (): Record<AiFeature, boolean> => ({ summarize: true, compose: true, replies: true, search: true })
export const defaultAiSettings = (): StoredSettings => ({ enabled: false, automaticReplies: false, provider: 'anthropic', model: AI_DEFAULT_ANTHROPIC_MODEL, baseUrl: AI_DEFAULT_OPENAI_BASE_URL, features: defaultFeatures(), includeSenderDetails: false })
const providers: AiProviderId[] = ['anthropic', 'openai-compatible']

function normalizeSettings(value: unknown): StoredSettings {
  const fallback = defaultAiSettings()
  const input = value && typeof value === 'object' ? value as Partial<StoredSettings> : {}
  const features = input.features && typeof input.features === 'object' ? input.features : {} as Partial<Record<AiFeature, boolean>>
  return {
    enabled: input.enabled === true,
    automaticReplies: input.automaticReplies === true,
    writingStyles: Object.fromEntries(Object.entries(input.writingStyles && typeof input.writingStyles === 'object' ? input.writingStyles : {})
      .filter(([id, style]) => /^[\w-]{1,100}$/.test(id) && typeof style === 'string' && style.trim()).slice(0, 100)
      .map(([id, style]) => [id, sanitizeModelText(style, 2_000)])),
    provider: providers.includes(input.provider as AiProviderId) ? input.provider as AiProviderId : fallback.provider,
    model: typeof input.model === 'string' ? input.model : fallback.model,
    baseUrl: typeof input.baseUrl === 'string' ? input.baseUrl : fallback.baseUrl,
    features: Object.fromEntries(AI_FEATURES.map((feature) => [feature, features[feature] !== false])) as Record<AiFeature, boolean>,
    includeSenderDetails: input.includeSenderDetails === true
  }
}

const writeAtomic = (path: string, data: string) => {
  const temporary = `${path}.partial`
  writeFileSync(temporary, data, { mode: 0o600 })
  renameSync(temporary, path)
}

export class AiAssistantStore {
  private settings: StoredSettings
  constructor(private readonly settingsPath: string, private readonly keyPath: string, private readonly storage: AiKeyStorage = safeStorage) {
    try { this.settings = normalizeSettings(JSON.parse(readFileSync(settingsPath, 'utf8'))) } catch { this.settings = defaultAiSettings() }
  }

  private secure() {
    try { assertSecureCredentialStorage(this.storage); return true } catch { return false }
  }

  apiKey() {
    if (!existsSync(this.keyPath)) return undefined
    assertSecureCredentialStorage(this.storage)
    try { return this.storage.decryptString(Buffer.from(readFileSync(this.keyPath, 'utf8'), 'base64')) || undefined } catch { return undefined }
  }

  status(): AiAssistantStatus {
    return { ...this.settings, writingStyles: { ...this.settings.writingStyles }, features: { ...this.settings.features }, hasApiKey: existsSync(this.keyPath), secureStorage: this.secure() }
  }

  configure(input: AiAssistantSettingsInput): AiAssistantStatus {
    if (!input || typeof input !== 'object') throw new Error('Invalid AI assistant settings')
    const next = normalizeSettings(input)
    next.model = next.model.trim()
    next.baseUrl = next.baseUrl.trim()
    if (next.model && !/^[\w.:/@-]{1,200}$/.test(next.model)) throw new Error('Enter a model name using letters, numbers, and . : / @ - _')
    if (next.provider === 'openai-compatible') validateAiBaseUrl(next.baseUrl)
    if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
      const key = input.apiKey.trim()
      if (key.length > 500 || /\s/.test(key)) throw new Error('The API key looks invalid')
      assertSecureCredentialStorage(this.storage)
      writeAtomic(this.keyPath, this.storage.encryptString(key).toString('base64'))
    } else if (input.clearApiKey) rmSync(this.keyPath, { force: true })
    writeAtomic(this.settingsPath, JSON.stringify(next))
    this.settings = next
    return this.status()
  }

  /** Resolves the provider settings for a feature, or explains what is missing. */
  providerFor(feature: AiFeature) {
    const settings = this.settings
    if (!settings.enabled) throw new AiRequestError('Turn on AI assistance in Settings first', 'config')
    if (!settings.features[feature]) throw new AiRequestError('This AI feature is turned off in Settings', 'config')
    return { config: { provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl, apiKey: this.apiKey() }, includeSenderDetails: settings.includeSenderDetails }
  }

  writingStyle(accountId?: string) {
    return accountId && Object.hasOwn(this.settings.writingStyles ?? {}, accountId) ? this.settings.writingStyles![accountId] : undefined
  }
}

const validId = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{1,100}$/.test(value)
const validRef = (ref: MailMessageRef) => ref && [ref.accountId, ref.threadId, ref.messageId].every((id) => typeof id === 'string' && id.length > 0 && id.length < 1024)

export function registerAiAssistant(options: { worker(): MailWorkerClient; store: AiAssistantStore; fetch?: typeof fetch; timeoutMs?: number }) {
  const { store } = options
  const active = new Map<string, AbortController>()
  const messageFor = async (ref: MailMessageRef) => {
    if (!validRef(ref)) throw new Error('Invalid message reference')
    // Read-only: the assistant never issues any other worker command.
    const thread = await options.worker().request<MailThreadDetail>({ type: 'mail:thread', payload: { accountId: ref.accountId, threadId: ref.threadId } })
    const message = thread.messages.find((item) => item.id === ref.messageId)
    if (!message) throw new Error('Message not found in this conversation')
    return message
  }
  const run = async (requestId: unknown, feature: AiFeature, build: (includeSenderDetails: boolean) => Promise<AiPrompt>) => {
    if (!validId(requestId)) throw new Error('Invalid AI request')
    if (active.has(requestId)) throw new Error('That AI request is already running')
    const controller = new AbortController()
    active.set(requestId, controller)
    try {
      const { config, includeSenderDetails } = store.providerFor(feature)
      const prompt = await build(includeSenderDetails)
      if (controller.signal.aborted) throw new AiRequestError('The AI request was cancelled', 'cancelled')
      return await requestAiCompletion(config, prompt, controller.signal, options.fetch ?? fetch, options.timeoutMs)
    } finally { active.delete(requestId) }
  }

  ipcMain.handle('ai:status', () => store.status())
  ipcMain.handle('ai:configure', (_event, input: AiAssistantSettingsInput) => store.configure(input))
  ipcMain.handle('ai:cancel', (_event, requestId: unknown) => {
    const controller = validId(requestId) ? active.get(requestId) : undefined
    controller?.abort()
    return Boolean(controller)
  })
  ipcMain.handle('ai:summarize', async (_event, requestId: unknown, ref: MailMessageRef, scope: unknown = 'message') => {
    if (scope !== 'message' && scope !== 'conversation') throw new Error('Choose message or conversation summary')
    const text = sanitizeModelText(await run(requestId, 'summarize', async (sender) => {
      if (scope === 'message') return summarizePrompt(await messageFor(ref), sender)
      if (!validRef(ref)) throw new Error('Invalid message reference')
      const thread = await options.worker().request<MailThreadDetail>({ type: 'mail:thread', payload: { accountId: ref.accountId, threadId: ref.threadId } })
      if (!thread.messages.some((message) => message.id === ref.messageId)) throw new Error('Message not found in this conversation')
      return conversationSummaryPrompt(thread.messages, sender)
    }))
    if (!text) throw new Error('The AI assistant returned an empty summary')
    return text
  })
  ipcMain.handle('ai:replies', async (_event, requestId: unknown, ref: MailMessageRef, automatic: unknown = false) => {
    if (typeof automatic !== 'boolean') throw new Error('Invalid reply suggestion mode')
    if (automatic && !store.status().automaticReplies) throw new Error('Automatic reply suggestions are turned off in Settings')
    return parseReplySuggestions(await run(requestId, 'replies', async (sender) => repliesPrompt(await messageFor(ref), sender, store.writingStyle(ref.accountId))))
  })
  ipcMain.handle('ai:compose', async (_event, requestId: unknown, input: AiComposeInput) => {
    if (!input || typeof input.instruction !== 'string' || typeof input.draft !== 'string') throw new Error('Enter what you would like the assistant to write')
    if (!input.instruction.trim() && !input.draft.trim()) throw new Error('Enter an instruction or some draft text first')
    if (input.accountId !== undefined && !validId(input.accountId)) throw new Error('Choose a valid sending account')
    const text = sanitizeModelText(await run(requestId, 'compose', async (sender) => composePrompt(input, input.replyTo ? { message: await messageFor(input.replyTo), includeSenderDetails: sender } : undefined, store.writingStyle(input.accountId))))
    if (!text) throw new Error('The AI assistant returned an empty draft')
    return text
  })
  ipcMain.handle('ai:learn-style', async (_event, requestId: unknown, sample: unknown) => {
    if (typeof sample !== 'string' || !sample.trim() || sample.length > 12_000) throw new Error('Paste up to 12,000 characters of your selected sent messages')
    const style = sanitizeModelText(await run(requestId, 'compose', async () => learnWritingStylePrompt(sample)), 2_000)
    if (!style) throw new Error('The AI provider returned an empty writing style')
    return style
  })
  ipcMain.handle('ai:search', async (_event, requestId: unknown, request: unknown) => {
    if (typeof request !== 'string' || !request.trim()) throw new Error('Describe the mail you are looking for')
    return { query: parseSearchSuggestion(await run(requestId, 'search', async () => searchPrompt(request))) }
  })
}
