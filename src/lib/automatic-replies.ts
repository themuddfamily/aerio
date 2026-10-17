import { format } from 'date-fns'
import type { MailAutomaticRepliesState, MailAutomaticReplyAudience, MailProviderId } from '../mail-types'

const pad = (value: number) => String(value).padStart(2, '0')

/** Formats a UTC instant for a datetime-local input in the computer's time zone. */
export function isoToLocalInput(iso?: string) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Reads a datetime-local value as local wall-clock time and returns the UTC instant. */
export function localInputToIso(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) return undefined
  const [, year, month, day, hour, minute] = match.map(Number)
  const date = new Date(year, month - 1, day, hour, minute)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** The next whole hour, used as a starting point for a new schedule. */
export function nextWholeHour(now = new Date()) {
  const date = new Date(now)
  date.setMinutes(0, 0, 0)
  date.setHours(date.getHours() + 1)
  return date
}

export function localTimeZoneName() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time' } catch { return 'local time' }
}

const formatWhen = (iso: string) => format(new Date(iso), 'EEE d MMM yyyy, HH:mm')

export function automaticReplyStatusText(state: MailAutomaticRepliesState) {
  const settings = state.settings
  if (!settings) return undefined
  switch (state.phase) {
    case 'active': return settings.endAt ? `On now · ends ${formatWhen(settings.endAt)}` : 'On now · until you turn it off'
    case 'scheduled': return `Scheduled · starts ${formatWhen(settings.startAt!)}${settings.endAt ? `, ends ${formatWhen(settings.endAt)}` : ''}`
    case 'ended': return `Ended ${formatWhen(settings.endAt!)} · no longer replying`
    default: return 'Off'
  }
}

export function audienceLabel(provider: MailProviderId, audience: MailAutomaticReplyAudience) {
  if (provider === 'gmail') {
    return audience === 'all' ? 'Everyone who emails me' : audience === 'contacts' ? 'Only people in my contacts' : 'Only people in my organization'
  }
  return audience === 'all' ? 'Anyone outside my organization' : audience === 'contacts' ? 'Only my contacts outside my organization' : 'Nobody outside my organization'
}

export const providerLabel = (provider: MailProviderId) => provider === 'gmail' ? 'Gmail' : provider === 'microsoft' ? 'Microsoft' : 'the provider'
