# Meeting invitations

Aerio reads meeting invitations, updates, cancellations, replies, and counter-proposals that arrive as iTIP (RFC 5546) `text/calendar` parts in mail, and answers them with Accept, Tentative, or Decline, optionally with a comment or a proposed new time. Events keep their organizer, attendee roles, rooms and resources, and response status, and the event editor writes required guests, optional guests, and rooms or resources.

## Data model

`CalendarEvent` (`src/types.ts`) keeps `attendees: string[]` as the plain address list every caller reads. Three optional fields carry meeting details:

| Field | Meaning |
| --- | --- |
| `attendeeDetails` | `EventAttendee[]` for the same addresses (matched case-insensitively): `name`, `role` (`chair`, `required`, `optional`, `non-participant` for RFC 5545 `ROLE`), `kind` (`individual`, `group`, `resource`, `room`, `unknown` for `CUTYPE`), `response` (`needs-action`, `accepted`, `tentative`, `declined`, `delegated` for `PARTSTAT`), `rsvp`, and `self` for this account's own entry. It is omitted when every attendee is a plain required person, and details for addresses no longer in `attendees` are ignored. |
| `organizer` | `{ email, name?, self? }` from `ORGANIZER`, Google `organizer`, or Graph `organizer`/`isOrganizer`. |
| `sequence` | The organizer's `SEQUENCE`. |

Synced provider events also carry `icalUid` (Google `iCalUID`, Graph `uid`, falling back to `iCalUId`), which matches incoming invitations to the provider copy. It is separate from `sourceUid` because synced instances of one series share it. `src/lib/event-attendees.ts` converts between these fields and the iCalendar, Google, and Graph vocabularies. Code that only understands `attendees: string[]` keeps working. ICS import and export (`src/lib/ics.ts`) now round-trip `ORGANIZER`, `SEQUENCE`, and the `CN`/`ROLE`/`CUTYPE`/`PARTSTAT`/`RSVP` attendee parameters. Plain attendees are still written as `ATTENDEE:mailto:…`.

## Incoming invitations

When an expanded message has a `text/calendar`, `application/ics`, or `.ics` part, the reader shows a notice (`src/components/MeetingInvitationNotice.tsx`). It includes the title, time, location, organizer, guest and room counts, response tallies, and a guest list showing each attendee's role and response.

1. The mail worker (`invitations:source`) pulls the calendar parts from the stored original message with postal-mime. Identical inline and attached copies count once. Each part is capped at 1 MB and four parts are read per message. The worker also returns the account address plus its sender-identity aliases, which identify "you" among the attendees.
2. `src/lib/itip.ts` parses the first part that is a valid iTIP message: `METHOD` `REQUEST`, `CANCEL`, `REPLY`, `COUNTER`, `ADD`, and `DECLINECOUNTER`/`REFRESH`/`PUBLISH` (the last three are shown for reference only). The message is checked against the newest `REQUEST`/`CANCEL` already recorded for that account, UID, and `RECURRENCE-ID`, which is stored in the `meeting_invitations` table of `productivity.sqlite`:
   - **New** or **update**: a higher `SEQUENCE`, or the same `SEQUENCE` with a later `DTSTAMP`. A new `SEQUENCE` clears the response recorded earlier, because the organizer made a significant change.
   - **Duplicate**: same UID, `SEQUENCE`, and `DTSTAMP` in a different message. The notice explains this, and responding still answers the same meeting.
   - **Stale**: a lower `SEQUENCE`, an older `DTSTAMP` at the same `SEQUENCE`, a request at or below the `SEQUENCE` of a recorded cancellation, or a lower `SEQUENCE` than the synced provider event reports. Responding is disabled, and the notice says which update was already received.
   - **Cancelled**: a `CANCEL` at or above the recorded `SEQUENCE`. At the same `SEQUENCE`, a cancellation outranks a request.
3. Reopening the message that set the current state shows it as current. The decision does not depend on the order in which messages are opened.
4. `REPLY` and `COUNTER` messages (when you are the organizer) show who answered, their comment, and the proposed time. Google and Exchange apply replies to provider calendars themselves. Aerio does not change the event automatically.

Responding is refused for stale messages, meetings this mailbox organized, archived accounts, and invitations without an organizer. The notice warns, but still allows a reply, when your address is not on the guest list (the invitation went to a group or was forwarded) and when the organizer set `RSVP=FALSE` or `ROLE=NON-PARTICIPANT`.

## Responding

The channel is chosen per invitation:

| Situation | Channel |
| --- | --- |
| Gmail account, and the UID is in that account's synced Google calendar | Google `events.patch`: Aerio reads the event and patches the full `attendees` array, changing only your entry's `responseStatus` (plus `comment`), with `sendUpdates=all`. A whole-series invitation answers the series master (`recurringEventId`); an invitation for one occurrence answers that instance. |
| Microsoft account, and the UID is in the synced Outlook calendar | Graph `POST /me/events/{id}/accept`, `tentativelyAccept`, or `decline` with `sendResponse: true` and an optional `comment`. Series invitations answer `seriesMasterId`. |
| Anything else (IMAP/SMTP accounts, invitations not in the provider calendar) | An iTIP `REPLY` mailed to the organizer: `multipart/alternative` with a `text/plain` summary and a base64 `text/calendar; method=REPLY` part (`createCalendarMimeBuffer` in `electron/mail/mime-builder.ts`). The reply echoes `UID`, `SEQUENCE`, `RECURRENCE-ID`, and `ORGANIZER`, and carries only your `ATTENDEE` with its `PARTSTAT`. It is sent at once through the account's normal transport (Gmail API, Graph, or SMTP) and needs a connection. |

Accepted or tentative meetings answered by mail are copied into a local **Invitations** calendar, including overridden instances, with your response stored on your attendee entry. A decline removes the copy. A later cancellation notice offers **Remove from calendar**: cancelling one occurrence adds an exception to the copied series, and cancelling the whole meeting removes every copy. Provider calendars apply cancellations themselves on the next synchronization.

**Proposed times**

- Microsoft sends `proposedNewTime` with Tentative or Decline only, and only when the organizer allows new time proposals. Graph's error is shown unchanged when it refuses.
- Google Calendar's API cannot propose a new time, so Aerio says so and refers you to Google Calendar.
- Over mail, a proposal is sent as an iTIP `COUNTER` with the new `DTSTART`/`DTEND`.
- Proposals for all-day meetings are not offered.

In Calendar, a synced meeting organized by someone else shows guest responses and Accept/Tentative/Decline buttons (`productivity.respondToEvent`). These buttons answer that event or occurrence through the provider. Aerio refuses the response when you organized the meeting or are not a guest.

## Creating meetings

The event editor (`src/views/EventAttendeesField.tsx`) has three comma-separated fields: **Attendees** (required), **Optional attendees**, and **Rooms and resources**. Saving keeps details the editor does not show for addresses that stay in the same field: names, responses, chair and non-participant roles, and room versus resource. Providers receive the following:

- **Google:** `optional: true` for optional guests and `resource: true` for rooms and resources. Known `responseStatus` values are written back so an organizer's edit does not reset them. Creates, updates, and deletes of events with guests use `sendUpdates=all`. Series-wide edits (`following`/`series` scopes) still use Google's default notification setting.
- **Microsoft:** attendee `type` is `required`, `optional`, or `resource`. Exchange sends the invitations.
- **Local and exported events:** the details are kept and written to ICS.

## Verification

Covered by Vitest:

- `src/lib/itip.test.ts`: parsing, lifecycle decisions for new, update, duplicate, stale, and cancelled messages, REPLY and COUNTER generation.
- `src/lib/event-attendees.test.ts`: mappings and validation.
- `src/lib/ics-meeting.test.ts`: ICS round trip.
- `electron/mail/invitation-parts.test.ts`: Outlook-style inline and attached parts, and a REPLY MIME round trip through postal-mime.
- `electron/productivity/invitations.test.ts`: the service against real SQLite stores, covering mail REPLY/COUNTER, local copies, cancellations, provider routing, instance responses, stale provider `SEQUENCE`, and organizer and non-guest refusals.
- `electron/productivity/connector-invitations.test.ts`: Google `events.patch`/`sendUpdates` and Graph `accept`/`tentativelyAccept`/`decline`/`proposedNewTime` requests.
- Component tests for the notice and the attendee fields.

Not verified against live services:

- How real Gmail, Outlook, Exchange, and Apple Calendar organizers process Aerio's mailed REPLY and COUNTER.
- Graph's `uid` property being present in `calendarView/delta` results. Matching falls back to `iCalUId`, which differs per occurrence, and then to a mailed reply.
- Google's handling of attendee comments.
- Delegated responses (`PARTSTAT=DELEGATED`) are displayed but cannot be sent.
- Aerio does not send `DECLINECOUNTER`, and does not act on `REFRESH` or `PUBLISH`.
