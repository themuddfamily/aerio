import { useCallback, useEffect, useRef, useState } from 'react'
import type { AiAssistantStatus, AiFeature } from '../ai-assistant-types'

const SETTINGS_EVENT = 'aerio-ai-settings-changed'

export const aiProviderName = (status: Pick<AiAssistantStatus, 'provider' | 'baseUrl'>) => {
  if (status.provider === 'anthropic') return 'Anthropic'
  try { return new URL(status.baseUrl).host } catch { return 'your AI server' }
}

export const aiFeatureAvailable = (status: AiAssistantStatus | undefined, feature: AiFeature) =>
  Boolean(status?.enabled && status.features[feature])

/** Strips Electron's IPC prefix so provider errors read as plain sentences. */
export const friendlyAiError = (error: unknown) =>
  error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*(?:\w*Error:\s*)?/, '') || 'The AI request failed' : 'The AI request failed'

export function notifyAiSettingsChanged(status: AiAssistantStatus) {
  window.dispatchEvent(new CustomEvent<AiAssistantStatus>(SETTINGS_EVENT, { detail: status }))
}

/** Current assistant settings, refreshed whenever Settings saves them. Undefined while loading or unavailable. */
export function useAiAssistantStatus() {
  const [status, setStatus] = useState<AiAssistantStatus>()
  useEffect(() => {
    let active = true
    void window.aerio?.ai?.status?.().then((value) => { if (active) setStatus(value) }).catch(() => undefined)
    const listener = (event: Event) => setStatus((event as CustomEvent<AiAssistantStatus>).detail)
    window.addEventListener(SETTINGS_EVENT, listener)
    return () => { active = false; window.removeEventListener(SETTINGS_EVENT, listener) }
  }, [])
  return status
}

/**
 * Runs one cancellable assistant request at a time. Cancelling aborts the
 * provider call in the main process and discards any late result.
 */
export function useAiRequest() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const current = useRef<string>(undefined)
  useEffect(() => () => {
    if (current.current) void window.aerio.ai.cancel(current.current).catch(() => undefined)
    current.current = undefined
  }, [])
  const start = useCallback(async <T,>(call: (requestId: string) => Promise<T>): Promise<T | undefined> => {
    const id = crypto.randomUUID()
    current.current = id
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await call(id)
      return current.current === id ? result : undefined
    } catch (reason) {
      if (current.current === id) setError(friendlyAiError(reason))
      return undefined
    } finally {
      if (current.current === id) { current.current = undefined; setBusy(false) }
    }
  }, [])
  const cancel = useCallback(() => {
    const id = current.current
    if (!id) return
    current.current = undefined
    setBusy(false)
    setNotice('Request cancelled. Nothing was changed.')
    void window.aerio.ai.cancel(id).catch(() => undefined)
  }, [])
  return { busy, error, notice, start, cancel }
}
