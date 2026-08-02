import type { MailProviderId } from '../../src/gmail-types'

export const ACTIVE_MAIL_POLL_INTERVAL_MS = 15_000
export const BACKGROUND_MAIL_POLL_INTERVAL_MS = 60_000
export const MAX_MAIL_POLL_INTERVAL_MS = 5 * 60_000

export function clampMailPollingInterval(intervalMs: number) {
  if (!Number.isFinite(intervalMs)) return BACKGROUND_MAIL_POLL_INTERVAL_MS
  return Math.min(Math.max(Math.round(intervalMs), ACTIVE_MAIL_POLL_INTERVAL_MS), MAX_MAIL_POLL_INTERVAL_MS)
}

export function mailPollingIntervalForWindow(state: { visible: boolean; focused: boolean; minimized: boolean }) {
  return state.visible && state.focused && !state.minimized
    ? ACTIVE_MAIL_POLL_INTERVAL_MS
    : BACKGROUND_MAIL_POLL_INTERVAL_MS
}

export function mailPollingIntervalForProvider(intervalMs: number, provider: MailProviderId) {
  const requested = clampMailPollingInterval(intervalMs)
  if (provider === 'gmail') return requested
  if (provider === 'microsoft') return Math.max(requested, 30_000)
  return Math.max(requested, BACKGROUND_MAIL_POLL_INTERVAL_MS)
}
