# Online meetings

Aerio can add a Google Meet or Microsoft Teams meeting to a provider calendar event, keep it through later edits, and join it from the event editor. With a connected Zoom or Webex account it can also schedule a Zoom or Webex meeting for a Google or Microsoft calendar event and keep that meeting in step with the event ([Zoom and Webex](#zoom-and-webex)).

## Data model

`CalendarEvent.conference` (`src/types.ts`) is an optional `EventConference`:

| Field | Meaning |
| --- | --- |
| `provider` | `googleMeet`, `teams`, `skype`, `zoom`, `webex`, or `other`. Read from Google `conferenceSolution.key.type` (Meet), or from the add-on name for third-party Google add-ons. Read from Graph `onlineMeetingProvider` for Microsoft. |
| `status` | On reads: `ready`, `pending` (the provider is still creating it, or no join URL yet), or `failed` (Google `createRequest.status`). On writes: `pending` with a `requestId` asks for a new meeting, and `removed` asks to detach the existing one. |
| `requestId` | Stable id for a creation request (32 hex characters). It is made once, when *Add Google Meet*, *Add Microsoft Teams*, *Add Zoom*, or *Add Webex* is clicked, and every retry of that save reuses it. |
| `joinUrl`, `conferenceId`, `name`, `phone`, `pin` | Join and dial-in details. Google reads these from `entryPoints` and `hangoutLink`. Microsoft reads them from `onlineMeeting.joinUrl`, `conferenceId`, and `tollNumber`, with the older `onlineMeetingUrl` as a fallback. |

If `conference` is absent on a write, nothing changes. Connectors send conference fields only to create or remove a meeting, so an editor that never sets `conference` cannot drop one. IPC accepts the field only after `validEventConference` (`src/lib/online-meetings.ts`) checks it. No database schema changed, because events and calendars are stored as JSON payloads.

## Capability reporting

`SyncedCalendar.conferences` (`CalendarConferenceSupport`) is filled in during sync:

- **Google:** `calendarList` `conferenceProperties.allowedConferenceSolutionTypes`. Aerio creates a meeting only when that list contains `hangoutsMeet`. Workspace and consumer calendars both normally report it. A Workspace domain where an administrator turned off Meet reports nothing, and Aerio shows that reason.
- **Microsoft:** `/me/calendars?$select=…,allowedOnlineMeetingProviders,defaultOnlineMeetingProvider`. Aerio creates a meeting only when the list contains `teamsForBusiness`. Personal Microsoft accounts report `skypeForConsumer` or nothing. In that case the editor says Teams needs a work or school account, and Aerio does not create Skype meetings.
- Both report `creatable: []` when the calendar is not writable. `canRemove` is `true` for Google and `false` for Microsoft, because Graph ignores `isOnlineMeeting: false` once a meeting exists.

`conferenceCapabilities(calendar, hosts)` turns this into the list the editor shows. It also lists Zoom and Webex through `hostedConferenceCapability`, which the main process uses as well. They are offered on writable Google and Microsoft calendars once their account is connected. Otherwise the editor gives the reason: no app registration, not connected, or access revoked. Calendars synced before this feature have no `conferences` value until the next sync, and until then the editor asks the user to synchronize.

## Consent

Google Meet and Teams need no new OAuth scopes. Google `calendar.events` covers `conferenceData`, and Microsoft `Calendars.ReadWrite` covers `isOnlineMeeting`. Both are the same scopes Calendar editing already uses (*Enable editing* / reconnect). Zoom and Webex each have their own OAuth app and consent, described under [Zoom and Webex](#zoom-and-webex). `OnlineMeetingConnector.requiredScopes` records their scopes at the boundary.

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

- Links on `meet.google.com`, `teams.microsoft.com`, `teams.live.com`, `zoom.us`, `zoom.com`, `webex.com`, and their subdomains open directly.
- Other https hosts (third-party add-ons and anything else) open only after an inline *Open anyway* confirmation that names the host.
- Anything else disables **Join**.

Links open through `window.open(url, '_blank', 'noopener')`. The main window's handler refuses in-app navigation and passes https URLs to the system browser.

## Connector boundary

`electron/productivity/online-meetings.ts` defines `OnlineMeetingConnector` for providers with their own meeting API:

- `capability(calendar)` and `requiredScopes`.
- `createMeeting(request)`: one creation attempt.
- `findMeeting(request)`: the host's meeting that carries the request marker.
- `updateMeeting(meeting, request)` and `deleteMeeting(meeting)`.

A `HostedMeeting` holds the meeting id, join URL, meeting number, passcode, phone passcode, SIP address, and up to three dial-in numbers. It never holds Zoom's `start_url`, which embeds a host token.

`externalMeetingConnectors` starts with `UnavailableMeetingConnector` for both providers. At startup, `initializeMeetingHosts` (`meeting-host-ipc.ts`) registers the real connectors with `registerExternalMeetingConnector`. `assertConferenceCreatable` therefore gives the same reasons the editor shows.

## Zoom and Webex

### Setup

Each provider needs an OAuth app registration. A build can include one through two pairs of environment variables: `MAIN_VITE_ZOOM_CLIENT_ID` with `MAIN_VITE_ZOOM_CLIENT_SECRET`, and `MAIN_VITE_WEBEX_CLIENT_ID` with `MAIN_VITE_WEBEX_CLIENT_SECRET`. Set both values of a pair or neither (see `.env.example`). Without a built-in registration, **Settings › Online meetings** asks for the client ID and secret and stores them in the vault described below. A built-in registration cannot be replaced from Settings. Both providers require the client secret for the token exchange, as Google's desktop client does, so a build-time secret is embedded in the main-process bundle.

| | Zoom | Webex |
| --- | --- | --- |
| App type | General app (user-managed OAuth) in the Zoom App Marketplace | Integration on developer.webex.com |
| Redirect URL to register | `http://localhost:47817/oauth/zoom` | `http://localhost:47818/oauth/webex` |
| Scopes | `meeting:write:meeting`, `meeting:read:meeting`, `meeting:update:meeting`, `meeting:delete:meeting`, `user:read:user` | `meeting:schedules_write`, `meeting:schedules_read`, `spark:people_read` |
| Authorize and token endpoints | `https://zoom.us/oauth/authorize` and `https://zoom.us/oauth/token`. The client authenticates with HTTP Basic. | `https://webexapis.com/v1/authorize` and `https://webexapis.com/v1/access_token`. The client id and secret go in the form body. |
| Profile shown in Settings | `GET /v2/users/me` | `GET /v1/people/me` |

`spark:people_read` is used only to show which Webex account is connected. Webex receives the scope list on the authorize URL. Zoom grants the scopes listed on the app, so Aerio does not send a `scope` parameter. If Zoom's token response lists scopes and any of the five is missing, Aerio refuses the connection and names the missing scopes.

Unlike the Google and Microsoft sign-ins, the loopback port is fixed, because both providers compare the redirect URL with the registration exactly. If the port is in use, the sign-in stops and says so. Each sign-in uses PKCE (S256) and a random `state`. The local callback page is the same one the mail sign-ins use.

### Host permissions

The connected account must be allowed to schedule meetings:

- **Zoom:** any Zoom user. The meeting-length limits of the user's plan apply.
- **Webex:** a user with a Meetings license on a site.

An account administrator can block user-managed apps or integrations. When a provider refuses a request (403), Aerio shows the provider's message and notes that the account may lack meeting-host permission, a license, or a scope. Aerio creates meetings only for the connected user (`/users/me` on Zoom, the token's user on Webex), never on behalf of other hosts.

### Credentials

`MeetingHostVault` (`electron/productivity/meeting-host-vault.ts`) stores the registrations and grants for both providers in `meeting-host-vault.dat`, as one blob encrypted with OS secure storage (`safeStorage`). It refuses to store anything when OS encryption is unavailable. Like `oauth-vault.dat`, the file is excluded from profile backups (`PROFILE_BACKUP_EXCLUSIONS`). Tokens never reach the renderer. The renderer sees only `MeetingHostAccount`: configured, connected, email, display name, redirect URL, scopes, and a reconnect flag.

- An access token is renewed when it expires within a minute. Renewals run one at a time per provider because Zoom rotates refresh tokens, and the rotated refresh token is stored.
- An API call that returns 401 is retried once after a forced renewal. A second 401, or a renewal refused with 400/401 (`invalid_grant`), marks the account **revoked**. Aerio then makes no further calls with that grant:
  - The editor and Settings say *access was revoked or expired; reconnect*.
  - The next write fails with *"Zoom no longer accepts Aerio's access … Reconnect Zoom in Settings › Online meetings, then try again."*
  - Reconnecting replaces the grant.
- An unreachable token endpoint counts as a temporary failure and does not mark the account revoked.
- **Disconnect** removes the grant but keeps a registration entered in Settings. It also revokes the Zoom token (`POST https://zoom.us/oauth/revoke`); Webex has no revoke endpoint for integrations. Existing meetings are not cancelled.
- Settings refuses to configure, connect, or disconnect while Aerio is locked.

### Lifecycle

`HostedMeetingCoordinator` (`electron/productivity/meeting-coordinator.ts`) wraps single-event creates, updates, and deletes in `electron/main.ts`. Meetings Aerio created are recorded by request id in `online_meeting_links` (`MeetingLinkStore`). The table lives in `productivity.sqlite`, so it is included in profile backups. Each record holds the meeting, the schedule last sent, the event the meeting belongs to, and the delete choice.

#### Create

*Add Zoom* or *Add Webex* sets a pending request with a new request id. On save, Aerio checks the capability and refuses all-day and repeating events, because it creates only scheduled, single-occurrence meetings. It then creates the meeting before writing the calendar event:

- **Zoom:** `POST https://api.zoom.us/v2/users/me/meetings` with `type: 2`, `topic`, `start_time` (UTC), `duration` (minutes), `timezone`, and `agenda`.
- **Webex:** `POST https://webexapis.com/v1/meetings` with `title`, `agenda`, `start`, `end`, and `timezone`.

The agenda is `Scheduled from Aerio (reference aerio-<request id>)`. Aerio writes the event with the conference marked `ready`, so the Google and Microsoft connectors never request a Meet or Teams meeting for it. The join URL goes into the location when the location is empty. This block goes at the end of the notes, and later writes replace it rather than add another:

```
────────────────────
Join Zoom meeting
https://us02web.zoom.us/j/…
Meeting ID: 857 4606 5432
Passcode: …
Dial in (US (New York)): +1 646 558 8656
Phone passcode: …
────────────────────
```

A Webex block lists:

- the meeting number and password
- the dial-in numbers with the access code
- the phone and video system password
- the SIP address, under *Join by video system*

Google and Microsoft send the event description with their invitations, so attendees receive the same details. After the write, the meeting is linked to the event id.

#### Retries and uncertain outcomes

Aerio records the attempt (state `creating`) before calling the provider. What happens next depends on the result:

- **Definite refusal** (4xx including 403 and 429, or revoked credentials): the record is removed.
- **Uncertain outcome** (a timeout after 30 s, no connection, a 5xx, or a success without a join link): the record stays and the event is not saved. The editor says *"Zoom did not confirm whether the meeting was created … Save again: Aerio checks Zoom for this meeting before creating another."*

The next save reuses the same request id. The editor keeps it, and for an existing event the cached copy stores it before the write. Before creating anything, that save searches the host's meetings for the agenda marker:

- **Zoom:** `GET /v2/users/me/meetings?type=scheduled`, up to ten pages of 300. A match is then read with `GET /v2/meetings/{id}` for the passcode and dial-in numbers.
- **Webex:** `GET /v1/meetings` from a day before the start to a day after the end.

A match is reused. If the search fails, nothing is created. A new meeting is created only when the search finds nothing.

If the meeting was created but the calendar write failed, the record is already `created`. The retry reuses the meeting and updates it if the title or time changed.

#### Edit

If the title, start, end, or time zone of an event with an Aerio meeting changes, Aerio updates the meeting before writing the calendar event:

- **Zoom:** `PATCH /v2/meetings/{id}` with topic, start_time, duration, and timezone.
- **Webex:** `PUT /v1/meetings/{id}` with title, agenda, start, end, timezone, and the meeting password, which PUT requires.

If the provider refuses, the event is not saved and the error gives the reason. Edits that change only the notes do not call the provider. The details block is rewritten on every save. An event with a meeting cannot become an all-day event until the meeting is removed.

#### Remove

The editor offers *Remove* for Aerio's Zoom and Webex meetings on Google and Microsoft calendars, including Microsoft calendars, where a Teams meeting cannot be removed. Aerio writes the event without the details block, and clears the location if it was the join URL. It then cancels the meeting (`DELETE /v2/meetings/{id}` or `DELETE /v1/meetings/{id}`). A meeting the provider no longer has (404) counts as cancelled.

#### Delete

After the calendar event is deleted, the meeting is cancelled. The editor shows *Cancel the Zoom meeting if this event is deleted* under the meeting, on by default. The choice is stored with the meeting, so it also applies when the event is deleted from the context menu. With the option off, the meeting is kept and only unlinked from the event. If cancelling fails, the error says the event was deleted but the meeting could not be cancelled. That meeting is never attached to an event again.

#### Sync

Google and Microsoft do not report Aerio's meeting as a conference. After each synchronization, `decorate` attaches the meeting again to its linked event, unless the event now has a provider conference of its own. Changes made in another client are not coordinated: Aerio cancels or updates a meeting only for writes made in Aerio, so deleting the event elsewhere leaves the meeting in place.

Series-wide and "this and following" writes go straight to the calendar provider, and repeating events cannot get a new Zoom or Webex meeting.

## Verification and limits

Unit tests mock `fetch`:

- `src/lib/online-meetings.test.ts`: link checks, write rules, capabilities (including connected, unconfigured, and revoked Zoom and Webex accounts), and validation.
- `electron/productivity/online-meetings.test.ts`: Google and Graph mapping, sync capability, create, 409 retry recovery, detecting existing meetings, preservation on unrelated edits, removal, the split copy, and the unregistered connector boundary.
- `electron/productivity/meeting-hosts.test.ts`:
  - The Zoom and Webex OAuth flows over a real loopback callback: PKCE, state, client authentication, the scope check, and encrypted storage.
  - Token renewal: one renewal for concurrent callers, rotated refresh tokens, revoked and unreachable token endpoints, and disconnect.
  - Every Zoom and Webex request and response mapping, including renewal after a 401 and how failures are classified as uncertain or definite.
- `electron/productivity/meeting-coordinator.test.ts`:
  - The connector lifecycle with a mocked connector: create, link, re-attach after sync, edit, remove, and delete with and without cancelling.
  - Duplicate prevention after uncertain outcomes, including across a restart and after a failed search, and reuse after a failed calendar write.
  - Revoked credentials, refusals for all-day and repeating events, and Google Meet and Teams requests passing through unchanged.
  - The Google and Microsoft connector request bodies written for an event with a Zoom meeting.
- `electron/productivity/meeting-host-ipc.test.ts`, `electron/preload-meeting-hosts.test.ts`, `electron/main.test.ts`, and `electron/profile-backup-layout.test.ts`: IPC validation and refusal while locked, the preload bridge, coordination of event writes in the main process, and backup inclusion of the meeting links with the vault excluded.
- `src/components/EventConferenceField.test.tsx`, `src/components/MeetingHostsSection.test.tsx`, and `src/views/CalendarConference.test.tsx`: the editor and Settings flows.

None of this has been checked against live Google, Microsoft, Zoom, or Webex services. The [live-provider matrix](live-provider-test-matrix.md#online-meeting-coverage) lists the Zoom and Webex scenarios (`MEET-01` to `MEET-05`), with no evidence recorded yet. Not verified:

- Whether Graph `calendarView/delta` always returns `onlineMeeting`.
- Whether `transactionId` deduplicates retried POSTs.
- Exact Google behavior for `conferenceData: null` and for copying conferenceData to a new series.
- How Workspace policies report Meet availability.
- What personal Microsoft accounts report, given the move from Skype to Teams.
- Whether Zoom accepts `http://localhost` redirect URLs for a published (not development) app, and whether Zoom's token response lists granular scopes the way Aerio expects.
- Whether Zoom's meeting list includes `agenda` for every meeting, and whether it lists a just-created meeting immediately. A search that misses an earlier attempt can still create a second meeting.
- Whether Webex `GET /v1/meetings` with `from`/`to` returns the series created by `POST /v1/meetings`, and how Webex sites without a Meetings license respond.
- How Zoom and Webex handle scheduling in the past, plan meeting-length limits, and `PUT` on a meeting that has started.

A Google `pending` conference gets its join link on the next sync. Aerio does not poll for it. Local and subscribed calendars do not support online meetings. Aerio reads a Microsoft event body only as `bodyPreview`, so the notes it shows for a Microsoft event with a Zoom or Webex meeting may end partway through the details block. The full block is written again on the next save.
