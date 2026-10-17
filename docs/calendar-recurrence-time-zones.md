# Calendar recurrence and time zones

Aerio keeps the full repeat rule, named time zone, all-day dates, exceptions, and series identity of calendar events. It shows every occurrence in the visible range and asks whether an edit or delete applies to one event, to this and following events, or to the whole series.

## Data model

`CalendarEvent` (`src/types.ts`) has these optional fields:

| Field | Meaning |
| --- | --- |
| `recurrenceRule` | Normalized RFC 5545 `RRULE` (without the `RRULE:` prefix). When present it is authoritative; the legacy `recurrence` value is set only when the rule is exactly `FREQ=DAILY/WEEKLY/MONTHLY`, and is `'none'` for richer rules. |
| `recurrenceExceptions` | `EXDATE` values: UTC ISO instants for timed events, `YYYY-MM-DD` for all-day events. |
| `timeZone` | IANA zone the event's wall-clock times belong to. Editor saves always name one. Events without a zone are floating and follow the viewer's zone. |
| `allDay` | Date-only event; `start`/`end` are `YYYY-MM-DD` with an exclusive end. |
| `recurrenceId` | Original start of the occurrence an override replaces. |
| `seriesId` | Series master identity: the provider master id (Google `recurringEventId`, Microsoft `seriesMasterId`) for synced instances, or the local master's id for local overrides. |
| `originalStart` | Unmodified start of an occurrence (Google `originalStartTime`, Microsoft `originalStart`, or the expander's generated value). |
| `occurrenceOf` | View-only marker on occurrences the expander generates. It is stripped before saving and rejected by IPC validation. |

No database schema changed: events are stored as JSON payloads.

## Recurrence engine

`src/lib/recurrence.ts` parses, formats, describes, and expands rules. It has no dependencies.

- It supports `FREQ` `DAILY`, `WEEKLY`, `MONTHLY`, and `YEARLY` with `INTERVAL`, `COUNT`, `UNTIL` (date, UTC, or floating), `BYDAY` (with ordinals in monthly/yearly rules, counted through the year when no `BYMONTH` is given), `BYMONTHDAY` (including negative days), `BYMONTH`, `BYSETPOS`, and `WKST`.
- Rules are evaluated on wall-clock dates in the event's zone, then converted to instants. A 09:00 New York meeting stays at 09:00 local across the March and November changes. A time that does not exist (inside a spring-forward gap) moves forward. An ambiguous fall-back time resolves to the first occurrence.
- `DTSTART` is always the first instance. `COUNT` is applied before exceptions, as RFC 5545 requires. Dates that do not exist, such as 31 February or 29 February in a non-leap year, are skipped.
- Expansion is bounded. A rule is expanded only for the visible range: the month grid, the week, the day, or 90 days for the agenda and *Up next*. A rule yields at most 1,000 occurrences per range. Iteration stops after 50,000 periods. Rules without `COUNT` skip ahead to the visible range.
- Overrides are events that share the master's `sourceUid` (or have `seriesId` set to the master's id) and carry a `recurrenceId`. Each one replaces the matching generated occurrence.
- **Unsupported rules are never dropped.** These rules are reported as unsupported: `SECONDLY`/`MINUTELY`/`HOURLY`, `BYHOUR`/`BYMINUTE`/`BYSECOND`, `BYYEARDAY`, `BYWEEKNO`, `RSCALE`/`SKIP`, and ordinal `BYDAY` in daily or weekly rules. The stored event appears once. The editor shows *Custom rule (kept as is)* and saves the rule unchanged unless you pick another repeat option. Microsoft writes refuse rules that Graph cannot represent and report an error; they are never simplified.

Synced provider events are not expanded again in the view. Google is read with `singleEvents=true` and Microsoft through `calendarView/delta`, so occurrences already arrive one by one. A series master that a write returns is replaced by its occurrences on the next sync, and creating a recurring provider event starts that sync right away.

## Editor

- **Starts/Ends** are wall-clock times in the selected **Time zone**. Opening an event shows it in its own zone. When that zone differs from yours, a line below gives the time in your zone. **All day** switches to date inputs with an inclusive last day.
- **Repeat** offers *Daily*, *Weekly on <day>*, *Every weekday*, *Monthly on day N*, *Yearly on <date>*, and *Custom…*. The custom options are an interval, the days of the week, day-of-month or nth/last weekday for monthly and yearly rules, and an end: never, on a date (`UNTIL`), or after N times (`COUNT`). A summary of the rule is shown beneath. Monthly and yearly rules that the custom controls cannot show are kept and labelled *As set: …*.
- For synced provider occurrences, the repeat pattern is managed by the provider and is not editable in Aerio. Edits can still apply to one event, to this and following events, or to all events.

## Scoped edits and deletes

When you save or delete an event that belongs to a series, the editor offers **this event**, **this and following events**, or **all events**. The event's context menu has the same three delete actions. If you change the repeat rule, *this event* is not offered.

| Scope | Local calendars (`src/lib/recurrence-edit.ts`) | Google | Microsoft |
| --- | --- | --- | --- |
| This event | Creates or updates an override with `recurrenceId` and `seriesId`. Delete adds an `EXDATE`. | `PATCH`/`DELETE` of the instance, with no `recurrence` sent. | `PATCH`/`DELETE` of the occurrence, which creates an exception. |
| This and following | The master's rule ends with `UNTIL` just before the occurrence. A new series starts at the edited occurrence, with the remaining `COUNT`, later exceptions, and later overrides. | `GET` the master, `PATCH` its `RRULE` to `UNTIL`, and `POST` a new series. Other recurrence lines (`EXDATE`/`RDATE`) are kept. | `GET` the master, `PATCH` its range to `endDate` (the day before, in the series zone), and `POST` a new series. |
| All events | The master moves by the same number of days and takes the edited wall-clock time in its zone, so it stays correct across DST. Exceptions and overrides move with it. Delete removes the master and its overrides. | `PATCH` the master with the shifted start, keeping its `recurrence`. `DELETE` the master. | `PATCH` the master with the shifted start, keeping its pattern. `DELETE` the master. |

After a provider series write, the account is synchronized so that every affected occurrence is refreshed. *This and following* on the first occurrence is treated as *all events*.

## Provider mapping

- **Google:** reads `start.timeZone`, `start.date` (all-day), `recurrence` (`RRULE`), `recurringEventId`, and `originalStartTime`. Writes send `{date}` for all-day events and `{dateTime, timeZone}` for timed events. Recurring timed events without a zone fall back to `UTC`, because Google requires a zone on recurring events. The rule is written with `EXDATE` lines in the event's zone.
- **Microsoft:** reads `type`, `seriesMasterId`, `originalStart`, `originalStartTimeZone` (Windows or IANA names are resolved to IANA), `isAllDay`, and `patternedRecurrence`. Pattern types are `daily`, `weekly`, `absolute`/`relativeMonthly`, and `absolute`/`relativeYearly`, with `index` first through fourth or last, and range types `noEnd`, `endDate`, and `numbered`. Writes send the event's wall-clock time with its Windows zone name when CLDR maps it, and UTC otherwise. Rules map to the same patterns (`src/lib/provider-recurrence.ts`). A rule Graph cannot store raises an error and is not simplified: for example, several month days, days counted from month end, a fifth weekday, several months, or sub-daily rules.

## Secondary time zone

The Calendar sidebar has a **Secondary time zone** picker. Week and day views then show the hour in that zone beside each local hour, with GMT offset labels in the header. The choice is remembered on this computer.

## Tests

- `src/lib/recurrence.test.ts` covers rule parsing, formatting, and description. It also covers `COUNT`/`UNTIL`, intervals, weekday, month-day, `BYSETPOS`, and yearly rules, leap days, and impossible dates. DST cases are America/New_York in March and November, plus Europe/London, including a nonexistent local time. Further cases: travel between viewer zones, floating events, all-day dates in Pacific/Auckland, America/Los_Angeles, and UTC, exceptions, overrides, the expansion bounds, and counting before a split.
- `src/lib/recurrence-edit.test.ts` covers local occurrence overrides and this-and-following splits that keep `COUNT` and local time across DST. It also covers moving a whole series with its exceptions and overrides, and all three delete scopes.
- `src/lib/provider-recurrence.test.ts` covers Google `RRULE` line handling, Graph pattern/rule round trips, defaults, and refusal of unsupported rules.
- `electron/productivity/connector-recurrence.test.ts` covers Google and Microsoft instance mapping, all-day and zone handling, write bodies, and series, this-and-following, and delete request sequences against mocked APIs.
- `src/views/CalendarRecurrence.test.tsx` covers occurrence display with exceptions, scope prompts and context-menu deletes, yearly, custom, and preserved rules, the custom rule builder, all-day and named-zone saves, provider instances, the all-day row, and the secondary zone.

## Not verified

- Live Google and Microsoft APIs have not been tested. Not verified: series `PATCH`/`POST` behaviour, Graph's handling of all-day values under `Prefer: outlook.timezone="UTC"`, and whether `calendarView/delta` returns `seriesMasterId`/`originalStart`/`originalStartTimeZone` for every occurrence.
- Google instance ids for moved series and existing exceptions after a series time change follow provider rules that Aerio does not control.
- `COUNT` remaining after a split is computed from at most 1,000 earlier occurrences.
- The time grid still shows 07:00–19:00 only. Events outside those hours appear in month and agenda views.
- `RDATE` is not expanded for local events. Microsoft custom time zones (`tzone://Microsoft/Custom`) are treated as UTC or the viewer's zone.
