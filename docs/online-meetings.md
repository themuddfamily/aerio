# Online meetings

Aerio can add a Google Meet or Microsoft Teams meeting to a provider calendar event, keep it through later edits, and join it from the event editor. Zoom and Webex have a connector interface and are reported as unavailable; neither is implemented.

## Data model

`CalendarEvent.conference` (`src/types.ts`) is an optional `EventConference`:

| Field | Meaning |
| --- | --- |
| `provider` | `googleMeet`, `teams`, `skype`, `zoom`, `webex`, or `other`. Read from Google `conferenceSolution.key.type` (Meet), or from the add-on name for third-party Google add-ons. Read from Graph `onlineMeetingProvider` for Microsoft. |
| `status` | On reads: `ready`, `pending` (the provider is still creating it, or no join URL yet), or `failed` (Google `createRequest.status`). On writes: `pending` with a `requestId` asks for a new meeting, and `removed` asks to detach the existing one. |
| `requestId` | Stable id for a creation request (32 hex characters). It is made once, when *Add Google Meet* or *Add Microsoft Teams* is clicked, and every retry of that save reuses it. |
| `joinUrl`, `conferenceId`, `name`, `phone`, `pin` | Join and dial-in details. Google reads these from `entryPoints` and `hangoutLink`. Microsoft reads them from `onlineMeeting.joinUrl`, `conferenceId`, and `tollNumber`, with the older `onlineMeetingUrl` as a fallback. |

If `conference` is absent on a write, nothing changes. Connectors send conference fields only to create or remove a meeting, so an editor that never sets `conference` cannot drop one. IPC accepts the field only after `validEventConference` (`src/lib/online-meetings.ts`) checks it. No database schema changed, because events and calendars are stored as JSON payloads.

## Capability reporting

`SyncedCalendar.conferences` (`CalendarConferenceSupport`) is filled in during sync:

- **Google:** `calendarList` `conferenceProperties.allowedConferenceSolutionTypes`. Aerio creates a meeting only when that list contains `hangoutsMeet`. Workspace and consumer calendars both normally report it. A Workspace domain where an administrator turned off Meet reports nothing, and Aerio shows that reason.
- **Microsoft:** `/me/calendars?$select=…,allowedOnlineMeetingProviders,defaultOnlineMeetingProvider`. Aerio creates a meeting only when the list contains `teamsForBusiness`. Personal Microsoft accounts report `skypeForConsumer` or nothing. In that case the editor says Teams needs a work or school account, and Aerio does not create Skype meetings.
- Both report `creatable: []` when the calendar is not writable. `canRemove` is `true` for Google and `false` for Microsoft, because Graph ignores `isOnlineMeeting: false` once a meeting exists.

`conferenceCapabilities(calendar)` turns this into the list the editor shows. That list also includes Zoom and Webex as "not connected". Calendars synced before this feature have no `conferences` value until the next sync, and until then the editor asks the user to synchronize.

## Consent

No new OAuth scopes are needed. Google `calendar.events` covers `conferenceData`, and Microsoft `Calendars.ReadWrite` covers `isOnlineMeeting`. Both are the same scopes Calendar editing already uses (*Enable editing* / reconnect). Zoom and Webex would each need their own OAuth app and consent. `OnlineMeetingConnector.requiredScopes` records this at the boundary.

## Writes

### Google (`electron/productivity/google-connector.ts`)

- Every insert and patch sends `conferenceDataVersion=1`. That includes series-master patches and the successor series created by "this and following". Without it Google ignores `conferenceData`. When a patch omits `conferenceData`, Google keeps the event's current conference.
- **Create:** `conferenceData.createRequest = { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } }`. The request id doubles as the client-supplied event `id` (hex is valid base32hex). If a retried insert's first attempt already reached Google, the retry fails with 409. Aerio then reads that event and returns it instead of creating a second one, and adds the `createRequest` only if the event has no conference yet.
- **Add to an existing event:** the event is read again first. If it already has `conferenceData`, from a lost earlier response or another client, nothing is created.
- **Remove:** `conferenceData: null`.
- **Split ("this and following"):** the new series receives a copy of the master's `conferenceData` without `createRequest`, so it keeps the same Meet. A removal or a new request in the same edit replaces the copy.

### Microsoft (`electron/productivity/microsoft-connector.ts`)

- **Create:** `isOnlineMeeting: true`, `onlineMeetingProvider: 'teamsForBusiness'`, and `transactionId` set to the request id, so Graph can recognize a retried POST.
- **Add to an existing event:** Aerio first runs `GET /me/events/{id}?$select=isOnlineMeeting,onlineMeetingProvider,onlineMeeting,onlineMeetingUrl`. If a meeting already exists, the Teams fields are left out.
- **Unrelated edits:** online-meeting fields are never sent. The event body is rewritten only when the notes changed. Aerio reads only `bodyPreview`, and rewriting the HTML body would drop the Teams join block Outlook adds to it. Editing the notes of a Teams event still replaces that body with plain text. The meeting itself and `onlineMeeting.joinUrl` survive this.
- **Remove:** refused with an explanation (see `canRemove`).
- **Split:** Graph cannot copy a meeting to another event, so a Teams series master gives the successor series its own new Teams meeting.

### Retries and persistence

- `retryingJson` retries 429/5xx responses. These retries resend the same body, and therefore the same request id, so they are covered by the rules above.
- The main process (`updateProductivityEvent`) stores the pending request on the cached event before calling the provider. If the save fails or the app exits, reopening the editor shows the same pending request, and saving again reuses its id. On the next save, a pending request under the event's own id is resent with that id instead of being treated as an existing meeting. `carryPendingConferences` keeps an unconfirmed request across sync. A successful write replaces it with the provider's copy.
- New events have no cached row before they are written. Here the Google event id and the Graph `transactionId` protect against duplicates, and the editor keeps the same draft and request id while it stays open after an error.

## Joining

`EventConferenceField` (`src/components/EventConferenceField.tsx`) shows the meeting name, host, and dial-in details, with a **Join** button. `checkJoinLink` accepts only `https:` URLs without credentials:

- Links on `meet.google.com`, `teams.microsoft.com`, `teams.live.com`, and their subdomains open directly.
- Other https hosts (Zoom, Webex, and add-ons) open only after an inline *Open anyway* confirmation that names the host.
- Anything else disables **Join**.

Links open through `window.open(url, '_blank', 'noopener')`. The main window's handler refuses in-app navigation and passes https URLs to the system browser.

## Connector boundary

`electron/productivity/online-meetings.ts` defines `OnlineMeetingConnector`: `capability(calendar)`, `requiredScopes`, `createMeeting(request)` (idempotent per `requestId`), and `deleteMeeting(conference)`. A Zoom or Webex implementation would create the meeting through its own API. The calendar connector would then write the join link onto the event, in the description or location, or as a Google `conferenceData` add-on, which needs a Workspace add-on. `externalMeetingConnectors` currently maps `zoom` and `webex` to `UnavailableMeetingConnector`, which reports them as not connected and refuses to create them.

## Verification and limits

Unit tests mock `fetch`:

- `src/lib/online-meetings.test.ts`: link checks, write rules, capabilities, and validation.
- `electron/productivity/online-meetings.test.ts`: Google and Graph mapping, sync capability, create, 409 retry recovery, detecting existing meetings, preservation on unrelated edits, removal, the split copy, and the Zoom/Webex boundary.
- `src/components/EventConferenceField.test.tsx` and `src/views/CalendarConference.test.tsx`: the editor flows.

None of this has been checked against live Google or Microsoft services. Not verified:

- Whether Graph `calendarView/delta` always returns `onlineMeeting`.
- Whether `transactionId` deduplicates retried POSTs.
- Exact Google behavior for `conferenceData: null` and for copying conferenceData to a new series.
- How Workspace policies report Meet availability.
- What personal Microsoft accounts report, given the move from Skype to Teams.

A Google `pending` conference gets its join link on the next sync. Aerio does not poll for it. Local and subscribed calendars do not support online meetings.
