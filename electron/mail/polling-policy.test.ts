import { describe, expect, it } from 'vitest'
import {
  ACTIVE_MAIL_POLL_INTERVAL_MS,
  BACKGROUND_MAIL_POLL_INTERVAL_MS,
  MAX_MAIL_POLL_INTERVAL_MS,
  clampMailPollingInterval,
  mailPollingIntervalForProvider,
  mailPollingIntervalForWindow
} from './polling-policy'

describe('mail polling policy', () => {
  it('checks active windows every 15 seconds and background windows every minute', () => {
    expect(mailPollingIntervalForWindow({ visible: true, focused: true, minimized: false })).toBe(ACTIVE_MAIL_POLL_INTERVAL_MS)
    expect(mailPollingIntervalForWindow({ visible: true, focused: false, minimized: false })).toBe(BACKGROUND_MAIL_POLL_INTERVAL_MS)
    expect(mailPollingIntervalForWindow({ visible: true, focused: true, minimized: true })).toBe(BACKGROUND_MAIL_POLL_INTERVAL_MS)
    expect(mailPollingIntervalForWindow({ visible: false, focused: false, minimized: false })).toBe(BACKGROUND_MAIL_POLL_INTERVAL_MS)
  })

  it('clamps malformed and excessive intervals', () => {
    expect(clampMailPollingInterval(1)).toBe(ACTIVE_MAIL_POLL_INTERVAL_MS)
    expect(clampMailPollingInterval(Number.NaN)).toBe(BACKGROUND_MAIL_POLL_INTERVAL_MS)
    expect(clampMailPollingInterval(60 * 60_000)).toBe(MAX_MAIL_POLL_INTERVAL_MS)
  })

  it('avoids expensive full IMAP scans at Gmail polling frequency', () => {
    expect(mailPollingIntervalForProvider(ACTIVE_MAIL_POLL_INTERVAL_MS, 'gmail')).toBe(ACTIVE_MAIL_POLL_INTERVAL_MS)
    expect(mailPollingIntervalForProvider(ACTIVE_MAIL_POLL_INTERVAL_MS, 'microsoft')).toBe(30_000)
    expect(mailPollingIntervalForProvider(ACTIVE_MAIL_POLL_INTERVAL_MS, 'imap')).toBe(BACKGROUND_MAIL_POLL_INTERVAL_MS)
  })
})
