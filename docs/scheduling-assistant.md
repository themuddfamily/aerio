# Scheduling assistant

The event editor's **Scheduling assistant** button opens a free/busy timeline for the organizer, required and optional attendees, and resources (rooms or equipment addressed by email). It shows one day at a time in 30-minute cells, suggests the next times that work, and writes the chosen start, end, and attendee list back into the editor. Nothing is saved until the event itself is saved.

## Which provider is asked

The organizer's calendar — the **Calendar** chosen in the editor — decides the provider, so mixed setups behave predictably:

| Organizer calendar | Lookup | Batch size |
| --- | --- | --- |
| Google | `POST calendar/v3/freeBusy` with `timeZone: UTC` | 50 addresses per request |
| Microsoft | `POST /me/calendar/getSchedule` with `Prefer: outlook.timezone="UTC"` and a 30-minute `availabilityViewInterval` | 20 addresses per request |
| Local or subscribed (ICS) | None — every row is shown as unknown with an explanation | — |

A Google organizer never queries Graph for a Microsoft attendee, or the reverse; the attendee's availability comes from whatever the organizer's provider can see (for example Google Workspace external sharing or Exchange federation). Each lookup covers seven days from the displayed day (at most 31 days and 100 attendees per request, validated in the main process). CalDAV free-busy (`VFREEBUSY` / scheduling outbox) is not supported.

## Unknown is not free

Availability that the provider can't describe is shown hatched and labeled, and it is never treated as free time:

- **External** — Google returns `notFound`, or Graph returns a not-found or access error, for an address in a different domain from the organizer.
- **Not shared / permission** — an address in the organizer's domain whose calendar refuses free/busy (`ErrorAccessDenied`, `ErrorNoFreeBusyAccess`), or the organizer's grant lacks a free/busy scope.
- **Not found** — an in-domain address with no calendar, or text that isn't an email address.
- **Provider error** — `backendError`, a missing entry in the response, a non-2xx response, a timeout (20 seconds), or a network failure. The whole lookup becomes unknown and the banner shows the provider's message; **Refresh** retries. Requests are not retried automatically.
- Graph `unknown` schedule items are shown as unknown windows inside an otherwise known row.

Busy, tentative, out-of-office, and working-elsewhere times use distinct fills. Tentative and out-of-office time block a suggestion; working elsewhere does not.

## Suggestions

Suggestions start at the later of the displayed day and now, step in 30-minute increments, and list up to five non-overlapping slots of the current duration that:

1. fall inside **My working hours** (days, start, and end, stored per device; default Monday–Friday 09:00–17:00 in the system zone),
2. fall inside each required attendee's or resource's own working hours when the provider reports them (Graph `workingHours`, converted from Windows zone names; Google does not expose working hours), and
3. are free for every required attendee and resource with known availability.

Optional attendees never block a slot; each suggestion says how many optional attendees are unavailable. Required attendees with unknown availability also don't block suggestions — they can't be checked — and are listed above the suggestions as "Not checked for …". Attendee roles are a scheduling aid only: Aerio's event model stores attendees as plain addresses, so roles are not sent to the provider.

## Time zones

The timeline and suggestions use the computer's time zone, the same one the event editor uses, and the header shows its abbreviation. **Second time zone** adds a row of times (and a line on each suggestion) for any IANA zone; the choice is remembered on the device. Day boundaries and working-hour checks use `src/lib/time-zones.ts`, so daylight-saving days have 23 or 25 hours.

## Permissions

| Provider | Accepted scopes | New connections request |
| --- | --- | --- |
| Google | `calendar.freebusy`, `calendar.events.freebusy`, `calendar.readonly`, or `calendar` | `https://www.googleapis.com/auth/calendar.freebusy` |
| Microsoft | `Calendars.ReadBasic`, `Calendars.Read`, `Calendars.ReadWrite`, or the `.Shared` variants | `Calendars.ReadWrite` (already requested) |

Google's `calendar.events` scope, which Aerio uses for editing, does not authorize `freeBusy.query`, so Google accounts connected before this release are asked to reconnect: the assistant reads the stored grant with `grantedScopes()`, explains the missing permission without calling Google, and offers **Reconnect account**, then looks up again. Grants stored before scope tracking are probed instead; a `401`/`403` (other than rate limiting) is reported the same way.

## Implementation

- `electron/productivity/availability.ts` — `AvailabilityService` (validation, provider choice, scope check, error mapping), Google and Graph request/response mapping, and the `productivity:availability` IPC handler.
- `src/lib/scheduling.ts` — cell status, working-hours checks, zoned day arithmetic, and `suggestSlots`.
- `src/components/SchedulingAssistant.tsx` — the timeline dialog and the `SchedulingAssistantButton` used by the event editor.

## Verification boundaries

Tests mock `fetch` for both providers (request bodies, batching, per-attendee errors, external and permission cases, 403 reconnects, 5xx, rate-limit 403, network failure, unsupported calendars) and cover suggestion and time-zone logic and the dialog. The live behavior of Google Workspace external sharing, Exchange federation, room mailboxes, and the exact Graph `responseCode` values for cross-tenant lookups has not been verified against real tenants.
