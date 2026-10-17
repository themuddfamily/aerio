# Calendar and contact interchange

Aerio imports and exports standard calendar and contact files, keeps local calendars on the PC, and subscribes to read-only internet calendars. This is separate from the JSON local-data backup (`productivity:local-export` / `productivity:local-import`). That backup restores Aerio's own records exactly; interchange moves data to and from other applications.

## Formats

| Data | Import | Export |
| --- | --- | --- |
| Calendars | iCalendar (`.ics`, RFC 5545) | iCalendar 2.0 with generated `VTIMEZONE` blocks |
| Contacts | vCard 2.1 (best effort), 3.0, 4.0; CSV (Google, Outlook, or any header row) | vCard 3.0 (default) or 4.0; CSV |

The parsers live in `src/lib` and have no dependencies:

- `content-lines.ts` handles line unfolding, including vCard 2.1 quoted-printable soft breaks. It also parses parameters (quoted values and RFC 6868 caret escapes), escapes and unescapes text, folds lines at 75 octets without splitting UTF-8 sequences, and builds component trees.
- `ics.ts` reads `DTSTART`/`DTEND`/`DURATION`, `VALUE=DATE`, `TZID`, UTC and floating times, `RRULE`, `EXDATE`, `RECURRENCE-ID`, `VALARM` triggers, and attendees. It skips `STATUS:CANCELLED` events.
- `time-zones.ts` resolves TZIDs in this order: IANA names, then Windows names (CLDR subset), then vendor-prefixed names such as `/mozilla.org/.../Europe/Paris`. It converts wall-clock times with the Intl time-zone database. A wall time that falls in a DST gap moves forward. An ambiguous time resolves to its first occurrence.
- If a TZID is unknown to Intl, its `VTIMEZONE` STANDARD/DAYLIGHT rules are evaluated instead (yearly `BYMONTH`/`BYDAY` rules, `RDATE`, `UNTIL`). If neither source can resolve it, the time is treated as local and a warning is shown.
- `vcard.ts` reads `FN`, `N`, multiple typed `EMAIL`/`TEL`/`ADR`/`URL` values (`TYPE`, `PREF`, and 3.0 `pref`), `ORG`, `TITLE`, `NOTE`, `NICKNAME`, `BDAY`, `CATEGORIES` (every value), `PHOTO` (embedded images within the photo bound; see [rich-contacts.md](rich-contacts.md)), and `UID`. Linked photos are ignored.
- `contact-csv.ts` is an RFC 4180 parser. It handles the BOM, quoted delimiters, embedded newlines, and comma/semicolon/tab detection. It also suggests column mappings, maps rows to contacts (splitting Google's ` ::: ` multi-value cells), and exports CSV with formula-prefix protection.

### Resource limits

Imports are capped at 20 MB per file and 20,000 events or contacts. CSV files are also limited to 300 columns and 100,000 characters per cell. Other limits cover properties per record, line length after unfolding, and nesting depth. Internet calendar feeds are capped at 10 MB and 30 seconds per refresh.

### Malformed input

A file without `VCALENDAR`/`VCARD`, or with a mismatched `END`, is rejected and the error is shown. Recoverable problems produce warnings in the import preview, and the valid records still import. Recoverable problems are:

- malformed lines
- events without a valid start
- unreadable repeat rules
- unknown time zones
- cards without a name or email address
- a file truncated mid-record (complete records before the truncation are kept)

## What is preserved

Events and contacts carry optional interchange fields (`src/types.ts`):

- **Events:** `allDay`, `timeZone`, `recurrenceRule` (normalized raw `RRULE`), `recurrenceExceptions`, `recurrenceId`, `sourceUid`. The simple `recurrence` value shown in the editor is derived from the rule.
- **Contacts:** `emails`, `phones`, `addresses` (with the seven `ADR` parts), `urls`, `nameParts`, `nickname`, `birthday`, `sourceUid`. `email` and `phone` stay the primary values.

The event and contact editors carry these fields forward when you edit. A rule or exception list is dropped only if you change the repeat choice. An all-day flag is dropped only if you change the times. Lists follow edits to the primary email or phone.

Provider calendars and contacts (Google, Microsoft) receive only the fields their connectors already support. When importing into a provider, all-day events become local-midnight times, and time zones and detailed repeat rules are not sent. Local calendars and local contacts keep everything. Round trips through `.ics`, vCard 3.0, vCard 4.0, and CSV are covered by unit tests.

## Import preview and duplicates

Imports always open a preview first. In the preview, you choose the destination and see how many records are new, will be updated or merged, or will be skipped:

- **Calendars:** a new local calendar, an existing local calendar, or a writable provider calendar.
- **Contacts:** local contacts, or a connected Google/Microsoft account.

For CSV, the preview also lets you change the mapping for each column. Each column shows an example value.

Duplicate handling (`src/lib/interchange-plan.ts`):

- **Events** match on `UID` + `RECURRENCE-ID`. Events that have no UID match on identical title, start, and end. Choose *update*, *skip*, or *import as copies*. Repeated records within one file are imported once.
- **Contacts** match on source UID, then any shared email address, then the same name with a shared phone number. Choose *merge*, *skip*, or *import as separate contacts*. *Merge* keeps the existing record's identity, values, and favourite state, fills empty fields, and adds new emails, phones, addresses, and websites. Repeated rows within one file are folded into a single new contact.

## Internet calendar subscriptions

Subscriptions are created from `https://`, `webcal://`, or `webcals://` addresses (`webcal` is mapped to `https`). Plain HTTP and addresses with embedded credentials are refused. Feeds are fetched in the main process only (`electron/productivity/calendar-subscriptions.ts`):

- The fetch uses a 30-second deadline and a streaming 10 MB ceiling.
- Up to five redirects are followed, and each one is re-checked for `https`.
- The fetch sends `If-None-Match` and `If-Modified-Since` headers.

The first fetch must succeed before the subscription is saved. After that, a background check runs every five minutes and refreshes subscriptions whose interval has elapsed. Intervals range from 15 minutes to once a day, and the default is hourly. You can also refresh a subscription manually from the Calendar sidebar.

A successful refresh replaces the subscription's events atomically. Event ids are derived from the feed's UID and RECURRENCE-ID, so they stay stable across refreshes. A failed refresh keeps the last good copy. Failures include network errors, HTTP errors, oversized feeds, timeouts, and malformed calendars. The failure is recorded on the calendar and shown in the sidebar.

Subscribed events are read-only. Local calendars are fully editable through the normal event editor.

Local calendars and subscriptions are stored in `interchange_calendars` and `interchange_events` (created with `CREATE TABLE IF NOT EXISTS`). These tables live in `productivity.sqlite`, alongside the provider cache, and are not part of the JSON local-data backup.

## Verification boundaries

Unit tests cover the parsers and serializers, limits, malformed files, round trips, duplicate planning, the subscription fetcher (with injected `fetch`), the store, the IPC handlers (with a mocked Electron), the preload bridge, and the renderer panels.

These have not been verified against live services:

- real feeds from Google, Outlook, or iCloud
- the conversion of imported events and contacts by Google and Microsoft provider APIs

Since E24, the views expand imported recurring events: they show every occurrence, apply `EXDATE`s, and replace overridden occurrences, while rules Aerio cannot evaluate are kept unchanged. See [calendar recurrence and time zones](calendar-recurrence-time-zones.md).
