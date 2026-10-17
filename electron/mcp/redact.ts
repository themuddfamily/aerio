/**
 * Diagnostics for external automation record what happened, never what was read
 * or written: tool names, argument names, counts, durations, and error codes.
 * Argument values, message content, and addresses are never logged.
 */

const EMAIL = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi
const QUOTED = /(["“'‘])[^"”'’\n]{1,500}(["”'’])/g
const BASE64_RUN = /[A-Za-z0-9+/_-]{48,}={0,2}/g

/** Removes addresses, quoted text, and long encoded runs from a message destined for a log. */
export function redactMcpText(value: unknown) {
  const text = typeof value === 'string' ? value : value instanceof Error ? value.message : String(value ?? '')
  return text.replace(EMAIL, '[address]').replace(QUOTED, '[text]').replace(BASE64_RUN, '[data]').slice(0, 300)
}

export interface McpDiagnosticInput {
  tool?: string
  clientId?: string
  outcome?: 'ok' | 'error' | 'refused'
  errorCode?: string
  error?: unknown
  durationMs?: number
  arguments?: unknown
  itemCount?: number
  duplicate?: boolean
}

const SAFE_NAME = /^[a-z0-9_.:-]{1,80}$/i

/** Builds a details object that is safe to write to Aerio's diagnostic log or stderr. */
export function mcpDiagnosticDetails(input: McpDiagnosticInput): Record<string, unknown> {
  const details: Record<string, unknown> = {}
  if (input.tool) details.tool = SAFE_NAME.test(input.tool) ? input.tool : '[invalid]'
  if (input.clientId) details.clientId = SAFE_NAME.test(input.clientId) ? input.clientId : '[invalid]'
  if (input.outcome) details.outcome = input.outcome
  if (input.errorCode) details.errorCode = SAFE_NAME.test(input.errorCode) ? input.errorCode : '[invalid]'
  if (input.error !== undefined) details.reason = redactMcpText(input.error)
  if (typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)) details.durationMs = Math.round(input.durationMs)
  if (input.arguments && typeof input.arguments === 'object' && !Array.isArray(input.arguments)) {
    details.argumentNames = Object.keys(input.arguments).filter((key) => SAFE_NAME.test(key)).sort().slice(0, 30)
  }
  if (typeof input.itemCount === 'number') details.itemCount = input.itemCount
  if (input.duplicate) details.duplicate = true
  return details
}
