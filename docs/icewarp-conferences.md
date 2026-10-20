# IceWarp conferences (D16)

In **Settings → Online meetings**, connect your IceWarp HTTPS server and a TeamChat user API token with conference permissions. This connection is separate from Chat and from Google/Microsoft calendar consent. Tokens and the durable provisioning journal are encrypted together using operating-system credential storage in `icewarp-meetings.dat`; the renderer receives only connection status. Invalid TLS certificates, embedded URL credentials and redirects are refused.

Choose **IceWarp** when adding an online meeting to a writable Google or Microsoft calendar event. Single timed events are supported. Aerio writes the public join link into the calendar description/invitation. The regular calendar connector sends any calendar invitations; the IceWarp API calls never add attendees, join a conference, request a host JWT or start recording. Meeting links on private IceWarp domains use the existing unfamiliar-domain confirmation when opened.

## Provisioning and recovery

The official [TeamChat user API](https://wwwcdn.icewarp.com/docs/teamchat-api.html) exposes `conferences.meetNow` for provisioning, plus `events.get`, `events.add` and `events.delete` for conference event management. It does not document a dedicated scheduled-create endpoint. Aerio therefore:

1. Persists a pending request before contacting the server.
2. Provisions a conference with recording disabled and lobby enabled. A request marker appears in its temporary title. This provisions a resource immediately; Aerio does not join it or admit/invite participants.
3. Saves the returned event identifier immediately. It reads the server vCalendar, preserves its UID and `X-ICEWARP-MEETING` linkage, and updates title/start/end through `events.add` without a channel argument. The API documents omission of channel for conferences. Unexpected attendees or recurrence cause the update to stop for review.
4. Reports the meeting scheduled and saves the calendar invitation only after IceWarp accepts that schedule update. The requested event is not reported saved when provisioning or scheduling fails.

Changing the calendar title/time updates the same conference event. Removing/deleting a linked calendar event cancels it through `events.delete` unless the existing Keep meeting option is selected. No recording/download or live-call-control API is exposed.

If scheduling fails after provisioning, Aerio retains the ID and pending state. Saving again or restarting then saving retries the schedule on that resource. An initial lost response is searched through bounded upcoming/history lists using the exact request marker and original organizer. A missing result is **not** permission to provision another conference: Aerio reports the uncertain outcome and requires review in IceWarp. After reviewing any provisioned resources, removing and re-adding the online meeting deliberately creates a new request. Aerio does not automatically delete a provisioned conference after failure because its outcome may be uncertain.

Meeting identities bind the event identifier to the original server and user. Changing the connected account cannot update/delete an old account's conference. Disconnecting does not delete conferences or recovery records; reconnect the original account for their management. Corrupted or undecryptable recovery records block further provisioning until the original profile is restored. The journal is limited to 2,000 requests; it is not silently pruned. Keep the original profile when managing these meetings.

Each operation captures its server, user and token once. The connector uses only that captured credential snapshot and checks it before and after network waits. Changing credentials or locking Aerio stops continuation: an old server response cannot be rebound to the new account, and its event identifier cannot be sent to the new server. An in-flight provisioning outcome remains pending under the original account for recovery.

Each API request has a twenty-second timeout and four-megabyte response cap. Lookup examines at most ten history pages and one upcoming result. These bounded searches may not find very old/high-volume conferences; uncertainty remains visible rather than causing an automatic duplicate. Recurring/all-day events, attachments, recording and direct conference participant management are unsupported.

Tests cover actual official method names and JSON bodies, encrypted restart recovery, unknown initial outcomes, schedule failures, server/user binding, attendee/ICS injection rejection, safe public links, locking, settings and preload integration. They use deterministic server responses based on official schemas. A live IceWarp deployment is required to certify server-version-specific interoperability; no live credentials were available for these checks.

`node scripts/desktop-icewarp-settings-audit.mjs` additionally verifies the native Electron chat catalog, conference status/settings and real preload/main HTTPS validation using a disposable profile. It performs no live IceWarp calls.
