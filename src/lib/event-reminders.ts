import type { CalendarEvent } from '../types'

export const MAX_EVENT_REMINDERS = 5
export const MAX_EVENT_REMINDER_MINUTES = 40_320

/** An explicit empty list disables reminders; legacy zero retains its at-event-time meaning. */
export function eventReminders(event: Pick<CalendarEvent, 'reminderMinutes' | 'reminders'>): number[] {
  return event.reminders ?? [event.reminderMinutes]
}

export function validEventReminders(value: unknown): value is number[] | undefined {
  return value === undefined || (Array.isArray(value) && value.length <= MAX_EVENT_REMINDERS &&
    value.every((minutes) => Number.isInteger(minutes) && minutes >= 0 && minutes <= MAX_EVENT_REMINDER_MINUTES) &&
    new Set(value).size === value.length)
}

export function singleProviderReminder(event: CalendarEvent, provider: string): number | undefined {
  const reminders = eventReminders(event)
  if (reminders.length > 1) throw new Error(`${provider} supports one reminder per event. Remove additional reminders before saving.`)
  return reminders[0]
}
