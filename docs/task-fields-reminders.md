# Task start dates, reminders, progress, tags, and attachments

Local tasks, Google Tasks, and Microsoft To Do share one set of extra task fields: a start date or time with a time zone, a reminder that does not depend on the due date, percent complete, tags (categories), and attachments. The contract is `TaskExtendedFields` in [`src/task-fields-types.ts`](../src/task-fields-types.ts). It is provider-neutral so that CalDAV VTODO (E45) can use it without changes.

When a provider stores a field, Aerio sends it to the provider. When the provider has no such field, Aerio keeps it locally next to the cached task and labels it **Aerio only** in the editor. Aerio never drops these values without saying so.

## Provider capability matrix

| Field | Local Tasks | Google Tasks | Microsoft To Do | Neutral representation (E45 VTODO mapping) |
| --- | --- | --- | --- | --- |
| Start date/time and zone | Aerio | Aerio only | Native `startDateTime` (wall clock + zone) | `start` `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm[:ss]`, `startTimeZone` IANA (DTSTART as DATE, or DATE-TIME with TZID) |
| Reminder | Aerio | Aerio only | Native `reminderDateTime` with `isReminderOn` | `reminder` UTC instant `…Z` (VALARM with an absolute TRIGGER) |
| Percent complete | Aerio | Aerio only | Aerio only (Graph has only `status`) | `percentComplete` integer 0–100 (PERCENT-COMPLETE) |
| Tags / categories | Aerio | Aerio only | Native `categories` | `categories` string array, unique ignoring case (CATEGORIES) |
| Attachments | Managed local files | Aerio only (managed local files) | Native `taskFileAttachment`, 3 MB or smaller per file from Aerio | `attachments` managed `Attachment[]` (ATTACH) |
| Due | Date and time | Date only (Google discards the time) | Date and time + zone | unchanged |
| Status / recurrence / priority / subtasks | unchanged | unchanged | Native status, recurrence, importance, checklist | unchanged |

`TASK_FIELD_CAPABILITIES` in `src/task-fields-types.ts` is the code version of this table. The editors label each field from it, and the stores validate local overlays against it with `localOverlayFields(provider)`. Microsoft overlays may therefore contain only `percentComplete`. Google overlays may contain any extended field. Microsoft checklist items still support only a name and a completion state.

CalDAV task lists (E45) store start, reminder, percent complete, and tags natively as `DTSTART`, `VALARM`, `PERCENT-COMPLETE`, and `CATEGORIES` (`TASK_FIELD_CAPABILITIES.dav`). Files added in Aerio stay a local overlay. The server's `ATTACH` links and embedded files are shown and kept. See [CalDAV tasks](caldav-tasks.md#vtodo-mapping).

### Where values live

- **Local tasks**: the fields are on `Task` in [`src/types.ts`](../src/types.ts), stored in `productivity.sqlite` with the other local modules and validated by `validLocalTaskExtras` before each save.
- **Connected tasks**: the native Microsoft fields are in `TaskNativeFields` (`start`, `startTimeZone`, `reminder`, `categories`, read-only `attachments` metadata). They go through the durable queue like the other native fields: undo, conflict review, and accepted-result matching all apply. A `null` start or reminder, or an empty category list, is an explicit clear, and undo uses those clears. Local-only values are stored in `TaskLocalMetadata.extended` in `provider-tasks.sqlite`. They are never sent, so they stay put across refreshes, provider edits, and restarts.

## Microsoft To Do mapping

`microsoft-tasks-connector.ts` reads `startDateTime` as a wall clock rounded to whole seconds, together with its zone. It reads `reminderDateTime` only when `isReminderOn` is true and converts it to a UTC instant; Windows zone names are resolved with the CLDR table. It also reads `categories`. For a task with `hasAttachments`, it lists the attachment metadata (id, name, size, content type) without downloading the contents.

Writes send only the fields that changed. A reminder is written in UTC with `isReminderOn: true`, and a cleared reminder sends `isReminderOn: false`. A cleared start sends `startDateTime: null`. Changing only the start zone re-sends the start with the new zone.

Attachments are changed straight away rather than through the offline queue:

- **Add files** uploads each file of 3 MB or smaller as a `taskFileAttachment`. Larger files would need a Graph upload session, which is not implemented.
- **Remove** deletes the attachment from the task.
- **Open** downloads the file to a temporary folder and opens it.

Each change first compares the cached ETag with the current task, then re-reads the task and stores the new revision with `TaskStore.replaceRemoteTask`. The change is refused while the task has pending or unresolved edits, so a queued edit can never be rebased without the user knowing. These changes cannot be undone, and they do not appear in Recent changes.

## Reminder behavior

Reminders are delivered in the main process by `electron/productivity/task-reminders.ts`, which keeps its own `task-reminders.sqlite`.

- **Sources**: local tasks with a `reminder`; Microsoft tasks with a native reminder; Google tasks with an overlay reminder. Completed tasks never remind. Archived accounts and caches recovered from a backup do not remind until the account is reconnected.
- **Identity**: each delivery is keyed by source, task, and reminder instant. If the reminder time changes, or a new occurrence of a recurring task is created, the next delivery starts fresh. Dismissing one occurrence does not hide the next.
- **States**: a reminder is *fired* when its time arrives, *snoozed* until a later time (from now up to 30 days ahead), or *dismissed*. These states are stored in SQLite, so they survive a restart. A dismissed reminder never fires again. A snoozed reminder fires again after its snooze time, even if Aerio was restarted in between.
- **Missed reminders**: when a reminder falls due while Aerio is closed, it fires once on the next launch and is labeled *Missed*. The same label applies to any delivery more than a minute late. If more than three reminders fire at once, one summary notification is shown instead of one each.
- **Timing**: the service wakes at the next reminder or snooze time, and at least once a minute. It also runs again when local tasks are saved and when the connected-task cache changes.
- **Notifications**: these use the existing notification preference. While Aerio is locked, a notification shows only "Unlock Aerio to see this reminder", and every reminder and attachment IPC channel refuses requests until Aerio is unlocked.
- **In the app**: fired reminders appear above the task list with **Dismiss** and **Snooze** (5 minutes, 1 hour, tomorrow morning). Selecting a reminder opens its task. Dismissing a Microsoft reminder in Aerio does not turn off `isReminderOn` in Microsoft To Do, so other Microsoft clients may still remind.
- **Retention**: delivery state for a task that has disappeared, for example during a partial refresh, is kept for 30 days. If the task comes back within that time, its reminder does not fire again.

### Recurrence and time zones

When a recurring task is completed, the next occurrence gets updated extended fields. This applies to local tasks (`toggleTaskWithRecurrence`) and to Google tasks repeating in Aerio (`task-recurrence.ts`). Shared helpers in `src/lib/task-schedule.ts` do the date arithmetic:

- **Start** moves forward one daily, weekly, or monthly step on its wall clock. Monthly steps are clamped to the last day of the month, including leap years.
- **Reminder** keeps its wall-clock offset from the anchor in the anchor's zone. The anchor is the due time if there is one (a Google date-only due counts as midnight in the start zone), otherwise the start. So "15 minutes before 09:00" is still 08:45 after a daylight-saving change, and "one day before at 09:00" is still 09:00. A reminder with no anchor moves forward on its own wall clock.
- **Percent complete** resets to 0. Tags and attachments carry over. Completing a local task that tracks progress sets it to 100%.

A timed start is read in its zone with the shared `wallTimeToUtc` rules. A time that falls in a daylight-saving gap moves forward. An ambiguous time in the repeated fall-back hour resolves to the first occurrence.

Microsoft native recurrence is still generated by Microsoft: the next Graph occurrence brings its own start and reminder, and Aerio does not create a duplicate local successor.

## Attachments

Files attached to local tasks and to Google overlays are copied into the profile's `task-attachments` directory (`TaskAttachmentFiles`, which follows the Notes approach). Tasks refer to these files by path, and they open only from inside that directory. Each task can have up to 50 attachments of up to 25 MB each.

Cleanup is based on references. After local tasks are saved or restored, and after connected-task changes, Aerio deletes any managed file that no local task and no connected-task overlay (including the baselines of pending operations) still refers to. Files copied during the current session but not yet saved are kept, so an editor can stay open safely. No sweep runs while the connected-task store is unavailable.

## Backups and migration

- **Local data backup** (`aerio-local-data`) is now at **schema 3**. It adds the extended task fields and `taskAttachments`, which embeds the bytes of each local task attachment. Notes and task files share the 100 MB embedded-file budget. Schema 1 and 2 backups still restore unchanged, because their tasks have no extended fields. A schema 1 or 2 file that references task attachments is rejected.
- **Connected-task backup** (`aerio-provider-tasks`) is now at **schema 2**. It adds overlay fields and an optional `attachments` archive that embeds overlay attachment files. On restore, those files are written to new managed paths, and the backup's references are relinked to them before the restore transaction. Schema 1 backups restore unchanged. A schema 1 file containing overlays is rejected, as is an archive that does not match its references exactly. Microsoft attachments are provider data and are not embedded.
- **Full profile backups** now include `task-attachments` and `task-reminders.sqlite`. A restored profile therefore keeps attachment files and the record of which reminders were dismissed or snoozed, so restoring an older profile does not refire reminders the user has already handled.

## Tests

- `src/lib/task-schedule.test.ts`: daylight-saving gaps and overlaps, Windows zone names, month clamping, reminder offsets across DST, and validation.
- `electron/productivity/task-reminders.test.ts`: on-time, missed, snoozed, and dismissed reminders across restart; completed tasks; changed reminder times; recurring occurrences; and retention.
- `electron/productivity/task-attachments.test.ts` and `task-extras-ipc.test.ts`: managed copies, reference-based cleanup, archive and restore rollback, lock enforcement, notifications, and native upload limits.
- `electron/productivity/microsoft-task-fields.test.ts`: Graph mapping, minimal writes and clears, and attachment upload, delete, and download against controlled HTTP responses.
- `electron/productivity/task-extended-fields.test.ts` and `task-fields-service.test.ts`: real SQLite overlays, recurring Google completion across DST, undo and accepted-result matching for native fields, immediate attachment changes, reminder sources, and backup round trips and migration.
- `electron/main.test.ts` and `electron/profile-backup-layout.test.ts`: schema 3 local backups, older-backup migration, and profile-backup inclusion.
- `src/views/TaskFields.test.tsx`: the editors' Aerio-only labels, native and local saves, attachments, and the reminders bar.

None of these tests use a real Google or Microsoft account. Hosted Graph behavior for `startDateTime`, reminders, categories, and attachments is untested.
