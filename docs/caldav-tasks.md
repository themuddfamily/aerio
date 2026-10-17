# CalDAV tasks and iCalendar task files

CalDAV accounts added under **Settings › Calendar and contacts accounts** (see [CalDAV and CardDAV accounts](caldav-carddav.md)) also bring their task lists into **Tasks**, next to Google Tasks and Microsoft To Do. Tasks can also be imported from and exported to `.ics` files, for local lists and for every connected list.

The task provider is `TaskProvider = 'dav'`. It uses the same task queue, conflict review, undo, and connected-task backups as the other providers ([`src/task-provider-types.ts`](../src/task-provider-types.ts)). It also uses the DAV account, credentials, and sync engine that calendars and contacts use.

## Supported servers

Any server that stores VTODO in CalDAV calendars (RFC 4791) works, using the same presets and app passwords as calendars:

| Server | Task lists |
| --- | --- |
| iCloud | Reminders lists appear as task-only calendars. Recent iCloud Reminders versions keep upgraded lists out of CalDAV entirely, so only lists still visible to CalDAV clients appear. |
| Fastmail | Task lists appear as calendars that hold VTODO. |
| Nextcloud (Tasks app) | Task-only and mixed calendars. |
| Radicale, Baïkal, SOGo, Synology, and other generic servers | Task-only and mixed calendars, as advertised by the server. |

These servers have not been verified against live accounts (see [Interoperability limits](#interoperability-limits)). The behavior below is covered by the fixture server tests.

## Discovery and routing

- During calendar discovery, Aerio reads each collection's `supported-calendar-component-set`. A calendar that lists `VTODO` is a task list. If it lists `VTODO` but not `VEVENT`, it is **task-only**: it appears in Tasks and not in Calendar. If it lists both, it is **mixed**. A calendar that reports no component set is treated as allowing VEVENT, VTODO, and VJOURNAL.
- Each calendar object is routed by component. In a mixed calendar, objects with VEVENTs go to Calendar and objects with VTODOs go to Tasks. Calendar never shows a VTODO and Tasks never shows a VEVENT. Neither side writes the other's components. Deleting an event from an object that also holds VTODOs rewrites the object without the VEVENT rather than deleting it. An object that holds both a VTODO and a VEVENT is invalid in CalDAV. Its task is shown read-only, and Aerio never changes it from Tasks.
- **Read-only** comes from `current-user-privilege-set`: a calendar without `all`, `write`, or `write-content` is read-only, and so is a CalendarServer `subscribed` calendar. Aerio blocks edits before anything is sent. If a server reports no privilege set, the calendar is treated as writable, and a `403` sends the change to review as **failed**.
- In Settings, each task calendar has a **Show** toggle. Turning a task-only calendar off removes it from Tasks. Turning a mixed calendar off removes it from both Calendar and Tasks.
- From the list manager in Tasks, task-only lists can be created (`MKCALENDAR` with a VTODO component set), renamed (`PROPPATCH` of `displayname`), and deleted. Mixed calendars and read-only calendars are marked as managed by the server.

## Synchronization

Task calendars are pulled by the same engine as event calendars ([`dav-sync.ts`](../electron/productivity/dav-sync.ts)). Aerio uses RFC 6578 `sync-collection` with a stored sync token. If the server doesn't offer it, Aerio falls back to comparing the CalendarServer `getctag`, then listing ETags. Changed objects are fetched 100 at a time with `calendar-multiget`, or with a single `GET` per object when multiget isn't available. A mixed calendar is pulled once, and the same cache serves both Calendar and Tasks. Task lists refresh every minute with the other connected tasks, and from **Sync now** in a task list. An unchanged list costs one small request.

The raw calendar objects and their ETags live in `dav.sqlite`, the same cache calendars use. The task view in `provider-tasks.sqlite` is built from that cache ([`caldav-tasks.ts`](../electron/productivity/caldav-tasks.ts)).

## Writes, the offline queue, and conflicts

Edits are saved to the task queue first and appear at once. They are sent when Aerio is online, and the queue survives restarts. A write that was running when Aerio stopped goes to review instead of being sent again.

| Change | Request |
| --- | --- |
| New task | `PUT <calendar>/<uuid>.ics` with `If-None-Match: *` |
| Edit, complete, move under a parent | `PUT` with `If-Match: <ETag the edit was made against>` |
| Delete | `DELETE` with `If-Match` |
| Delete one occurrence | `PUT` of the series with the override removed and an `EXDATE` on the master |

- **Only edited properties are written.** Aerio keeps the server copy of each object. To write, it patches only the properties whose mapped value changed. Every other property and parameter stays byte for byte, including `X-` properties, `ORGANIZER`, `CLASS`, `URL`, other alarms, `RELATED-TO` links of other types, inline attachments, and `VTIMEZONE`s.
- **Conflicts.** If the cached copy is older than the edit's base, or the server answers `412`, the change goes to **Review change** in the task list. A `404` means the task was deleted on the server, and it is handled the same way. There you can refresh, then **Retry my change** to apply your edit on top of the server's current version (other clients' changes to other properties are kept), **Confirm applied**, or **Discard local change**.
- Servers that omit the ETag after `PUT` are read back with `GET` so the cache matches the server.
- A rejected app password (`401`) marks the account **Password needed** in Settings. The task list shows how to fix it.

## VTODO mapping

| VTODO property | Aerio task field | Notes |
| --- | --- | --- |
| `SUMMARY` | Title | Empty titles read as "Untitled task". |
| `DESCRIPTION` | Notes | Notes longer than 8,192 characters are read-only in Aerio. The full text stays unchanged on the server. |
| `DTSTART` (DATE, or DATE-TIME with `TZID`, UTC, or floating) | Start date/time and zone (E44 `start`/`startTimeZone`) | UTC starts are shown in UTC. |
| `DUE` (DATE, DATE-TIME with `TZID`, UTC, or floating) | Due date/time and time zone | Floating times stay floating. Setting `DUE` removes `DURATION`. |
| `COMPLETED`, `STATUS` | Completed; status `NEEDS-ACTION`/`IN-PROCESS`/`COMPLETED`/`CANCELLED` ↔ Needs action/In process/Completed/Cancelled | Completing sets `STATUS:COMPLETED` and a `COMPLETED` timestamp. Reopening removes `COMPLETED`. |
| `PERCENT-COMPLETE` | Percent complete (native) | Completing a task whose progress is tracked sets it to 100. |
| `PRIORITY` 1–4 / 5 / 6–9 (0 or absent) | High / Normal / Low (Normal) | The value is rewritten only when the priority changes. Written as 1, 5, or 9. |
| `CATEGORIES` (one or more lines) | Tags | Unique ignoring case, up to 50. |
| First `VALARM` `TRIGGER` | Reminder (an absolute instant) | Relative triggers are resolved against `DTSTART`, or against `DUE` for `RELATED=END`. An unchanged reminder leaves the alarm untouched, so a relative alarm still follows the due date. A changed reminder writes `TRIGGER;VALUE=DATE-TIME`. Clearing the reminder removes the task's alarms. |
| `RELATED-TO` (`RELTYPE=PARENT` or none) | Parent task (subtasks) | Resolved within the same list. Other relation types are kept. Moving a task rewrites only its parent link. |
| `RRULE` (with `RDATE`/`EXDATE`) | Shown as "Repeats …" | Kept unchanged and read-only (see below). |
| `RECURRENCE-ID` overrides | A separate task, "One occurrence" | Edits change only that override. |
| `ATTACH` (URI) | Shown under **Server attachments** | Kept. Files added in Aerio are a local overlay, labeled **Aerio only**. |
| `ATTACH;VALUE=BINARY` | Shown as read-only embedded files | Kept on every write, never edited. |
| `UID`, `DTSTAMP`, `LAST-MODIFIED`, `SEQUENCE` | — | `DTSTAMP` and `LAST-MODIFIED` are updated on each write. `SEQUENCE` is incremented when the dates change. |
| Anything else (`X-…`, `CLASS`, `URL`, `GEO`, …) | Listed as **Kept unchanged on every save** | Never changed. |

### Repeating tasks

- A series master shows its rule, for example "Repeats weekly on Monday". **Repeat rules cannot be edited in Aerio.** Creating, changing, or removing an `RRULE`, `RDATE`, or `EXDATE` is refused with that explanation, so another app's rule is never rewritten. Edits to other fields of the master apply to the whole series. Completing the master completes the series, as RFC 5545 defines.
- An overridden occurrence (`RECURRENCE-ID`) is a separate task. Editing it changes only that override in the shared object. Deleting it removes the override and adds an `EXDATE` to the master. Occurrences can't be moved to another parent.
- Occurrences that have no override yet are not listed as separate tasks.

## .ics task import and export

**Task files (.ics)** in the Tasks sidebar opens a `.ics` file or saves the open list.

- **Preview.** Every VTODO in the file is listed before anything changes, grouped by UID, so a series and its overridden occurrences form one task. The preview shows dates, status, progress, tags, parent, repeat rule, links, embedded files, and the extra properties that will be kept. Events in the file are ignored, with a note.
- **Target.** You can import into any local list or any writable connected list. Connected imports go through the offline queue, like edits.
- **Duplicates by UID.** Aerio shows how many tasks in the file already exist and lets you choose:
  - **Skip them**
  - **Replace them with the file's version.** Local tasks are replaced in place. Connected tasks get the file's values for the fields Aerio maps.
  - **Import them as copies.** The copy gets a new UID.

  Local tasks keep the UID they were imported with. CalDAV stores the UID. For Google Tasks and Microsoft To Do, Aerio remembers the UID each imported task used, and exported tasks carry a stable UID, so importing your own export again is recognized.
- **What is kept.**
  - CalDAV lists receive the whole object from the file, including occurrences and properties Aerio does not edit.
  - Local tasks store the original VTODO alongside the task. On export it is patched with your current values, so `X-` properties, alarms, overrides, attachments, and non-simple repeat rules survive a round trip. Daily, weekly, and monthly repeats are applied in Aerio. Other rules stay in the stored data, and the preview says so.
  - Google Tasks and Microsoft To Do receive only what they can store. Start, reminder, progress, and tags they lack become Aerio's local overlay (E44). Repeat rules (other than Google's simple local repeats), changed occurrences, links, and extra properties are not imported, and the import lists each one.
- **Export** writes one `VCALENDAR` with the list name in `X-WR-CALNAME`, using the mapping above:
  - CalDAV tasks are exported from the server copy, with pending edits applied.
  - Local subtasks become child VTODOs with `RELATED-TO`.
  - Microsoft recurrence patterns become `RRULE`s.
  - `VTIMEZONE`s are added for the zones that are used.
  - Local attachment files are not embedded.

The import and export channels refuse to run while Aerio is locked.

## Backups

- **Full-profile backups.** `dav.sqlite` (the task calendars, their sync tokens, and the cached VTODO objects) and `provider-tasks.sqlite` (the task cache, queue, review history, and imported UIDs) are both included. On restore, DAV accounts ask for their password again. Queued task writes are held under **Review change** as "restored from backup" and are never resent on their own.
- **Connected-task backups** (**Back up connected tasks**) include CalDAV tasks too.

## Interoperability limits

- Real iCloud, Fastmail, and Nextcloud servers have not been verified against live accounts. The behavior is covered by the loopback fixture server only.
- Repeat rules are read-only. Occurrences without an override aren't expanded into separate tasks. Completing a series master completes the whole series instead of advancing it to the next occurrence.
- When a task's object changes on the server between your edit and its upload, the edit is reviewed instead of merged. Two quick edits to different occurrences of one series can trigger the same review, because they share one object.
- `ATTACH` with inline data, `VALARM`s other than the first, and the `RELATED-TO` types `CHILD` and `SIBLING` are kept but not editable. Files attached in Aerio stay a local overlay and are not uploaded.
- An unknown `TZID` without an IANA or Windows equivalent is read as a floating time.
- Aerio does not send scheduling messages (`ORGANIZER`/`ATTENDEE` on a VTODO, RFC 6638).
- VJOURNAL is not shown.

## Tests

- [`src/lib/vtodo.test.ts`](../src/lib/vtodo.test.ts): the property mapping, alarm resolution, byte-for-byte unchanged round trips, patching only edited properties, and occurrence removal.
- [`src/lib/task-ics.test.ts`](../src/lib/task-ics.test.ts): round-trip fixtures through local tasks, duplicate import (skip, replace, copy), and the mapping to each provider.
- [`electron/productivity/caldav-tasks.test.ts`](../electron/productivity/caldav-tasks.test.ts): against the DAV fixture server.
  - Separate calendar and task routing, including the event-deletion guard.
  - `sync-collection`, multiget, and ctag fallback.
  - `If-Match` writes that keep unknown properties.
  - Offline queueing, `412` and deleted-on-server conflicts with retry or discard.
  - Recurrence exceptions and read-only privileges.
  - `MKCALENDAR` lists and subtasks.
  - Restart recovery, connected-task backups, and `.ics` import with duplicates.
- [`electron/productivity/task-ics-ipc.test.ts`](../electron/productivity/task-ics-ipc.test.ts), [`src/views/CalDavTasks.test.tsx`](../src/views/CalDavTasks.test.tsx), and the profile backup layout tests cover IPC validation and locking, the editor and import preview, and backup and restore.
