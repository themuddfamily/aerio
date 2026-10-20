import { join } from 'node:path'
import type { CalendarEvent } from '../../src/types'
import { eventReminders } from '../../src/lib/event-reminders'
import { expandCalendarEvents, instantFromParts, wallParts, eventZone } from '../../src/lib/recurrence'
import { TaskReminderService, type TaskReminderCandidate } from './task-reminders'

/** A bounded catch-up window avoids alerting on an entire imported calendar's history. */
export function eventReminderCandidates(events: CalendarEvent[], now: number): TaskReminderCandidate[] {
  const start = now - 86_400_000
  const end = now + 29 * 86_400_000
  return expandCalendarEvents(events, start, end, { expand: (event) => !('remoteId' in event) || ('provider' in event && event.provider === 'dav') })
    .flatMap((event) => {
      const zone = eventZone(event)
      const at = /^\d{4}-\d{2}-\d{2}$/.test(event.start) ? Date.parse(instantFromParts(wallParts(event.start, zone), zone)) : Date.parse(event.start)
      if (!Number.isFinite(at) || at < start || at > end) return []
      return eventReminders(event).filter((minutes) => at - minutes * 60_000 >= start).map((minutes) => ({
        source: 'local' as const, taskId: `calendar:${event.id}:${minutes}`, title: event.title,
        reminder: new Date(at - minutes * 60_000).toISOString(), completed: false
      }))
    })
}

/** Reuses the durable delivery engine in a separate database; no task reminders are mixed in. */
export function startEventReminders(options: {
  userData: string; events(): CalendarEvent[]; enabled(): boolean; locked(): boolean
  notify(title: string, body: string): void
}) {
  const service = new TaskReminderService({
    path: join(options.userData, 'calendar-reminders.sqlite'),
    candidates: () => options.enabled() ? eventReminderCandidates(options.events(), Date.now()) : [],
    changed: () => {},
    notify: (items) => {
      for (const item of items) options.notify(item.missed ? 'Missed calendar reminder' : 'Calendar reminder', options.locked() ? 'Unlock Aerio to see this reminder' : item.title)
    }
  })
  service.tick()
  return service
}
