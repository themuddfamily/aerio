# CalDAV and CardDAV accounts

Aerio connects to calendar and contact servers that speak CalDAV (RFC 4791) and CardDAV (RFC 6352): iCloud, Fastmail, Nextcloud, and generic servers such as Radicale, Baïkal, SOGo, or Synology. These accounts are separate from mail accounts. The iCloud and Fastmail mail (IMAP) presets provide mail only, so to see their calendars and contacts you add the same provider under **Settings › Calendar and contacts accounts**.

Calendars and address books from a DAV account appear in Calendar and Contacts next to Google, Microsoft, and local data. They go through the same productivity snapshot (`ProductivityProvider = 'dav'`), so the existing views, ICS export, and contact export work with them unchanged.

## Signing in

| Service | Server | Password |
| --- | --- | --- |
| iCloud | `caldav.icloud.com` and `contacts.icloud.com` (fixed) | An app-specific password from account.apple.com |
| Fastmail | `caldav.fastmail.com` and `carddav.fastmail.com` (fixed) | An app password with CalDAV/CardDAV access |
| Nextcloud | Your server address; `remote.php/dav` is tried automatically | An app password from Personal settings › Security |
| Other | Your server address | An app-specific password if the provider offers one |

- **HTTPS is required.** Plain `http://` is accepted only for loopback addresses (`localhost`, `127.0.0.0/8`, `::1`), for example a server on this computer or an SSH tunnel. User names and passwords embedded in the URL are refused.
- **Credentials.** Passwords are sent with HTTP Basic authentication over TLS. They are encrypted with OS secure storage (DPAPI, Keychain, or libsecret) in `dav-credentials.dat`, and Aerio refuses to save one if the OS cannot encrypt it, including Linux's weak `basic_text` fallback. Passwords never reach the renderer and are never written to `dav.sqlite`, diagnostics, or backups. Digest and OAuth authentication are not supported.
- **Redirects** are followed only within the same site and never from HTTPS to HTTP, so iCloud's move from `caldav.icloud.com` to `pNN-caldav.icloud.com` works. A redirect to another site stops the request before the password is sent there.

## Discovery

`electron/productivity/dav-discovery.ts` runs these steps for each service:

1. **RFC 6764 bootstrapping.** When only a host is given, Aerio asks `/.well-known/caldav` (or `/.well-known/carddav`) first and then the given path. Otherwise it asks the given path first.
2. **`current-user-principal`** is read from the context path. Some servers answer `calendar-home-set` / `addressbook-home-set` on that path directly. Otherwise Aerio asks the principal.
3. The home set is listed with a Depth 1 `PROPFIND` for `resourcetype`, `displayname`, Apple `calendar-color`, `supported-calendar-component-set`, `current-user-privilege-set`, CalendarServer `getctag`, `sync-token`, and `supported-report-set`.

Calendars and contacts can live on different hosts (iCloud, Fastmail), and each has its own start points. When both services share a home set, it is listed once.

### Capabilities

| Signal | Effect |
| --- | --- |
| `supported-calendar-component-set` without `VEVENT` | Listed in Settings as **Tasks only (shown in Tasks)**. It is kept out of Calendar and its VTODOs sync into Tasks ([CalDAV tasks](caldav-tasks.md)). |
| `supported-calendar-component-set` with `VEVENT` and `VTODO` | **Events and tasks**: its VEVENTs go to Calendar and its VTODOs to Tasks, from one shared pull |
| `current-user-privilege-set` without `all`, `write`, or `write-content` | Read-only: Aerio blocks edits before sending anything |
| CalendarServer `subscribed` resource type | Read-only |
| CalendarServer `shared` / `shared-owner` resource type | Marked **Shared**; still writable if the privileges allow it |
| No privilege set reported | Treated as writable. A server `403` puts the change in review instead of losing it. |

Each calendar and address book can be hidden in Settings without removing the account. Deleting an event from a calendar object that also holds VTODOs removes only the VEVENT, so tasks are never deleted from Calendar.

## Synchronization

`electron/productivity/dav-sync.ts` pulls one collection at a time:

1. **RFC 6578 `sync-collection`** (`sync-level` 1) is used when the collection advertises it or returns a `sync-token`. Changed members are listed with their ETags, and removed members come back as `404` responses. A `507` truncation is followed with the returned token until the list is complete. If the server rejects a stored token (`403`/`409` `valid-sync-token`, `410`, or `400`), Aerio restarts with an empty token, and that full listing also removes local copies the server no longer has.
2. **Fallback: ctag + ETag diff.** If the report isn't available, Aerio compares the CalendarServer `getctag` first. An unchanged ctag costs a single Depth 0 `PROPFIND`. Otherwise every member's `getetag` is listed and diffed against the cache.
3. **Fetching.** Only members whose ETag changed are read, 100 at a time, with `calendar-multiget` / `addressbook-multiget`. If the server doesn't support multiget, or omits a member, that member is read with `GET`.

Reads retry `429`/`503` up to three times and honor `Retry-After`. Responses are limited to 32 MB and 60 seconds. A failing collection records its error and the others continue. A `401` marks the account **Password needed** and keeps the last good cache. Accounts sync about 25 seconds after launch, every 15 minutes, on **Sync now** in Calendar or Contacts, and from Settings.

`dav.sqlite` stores the server copy and ETag of every resource, including the VTODO objects of task calendars. Tasks reads them from there. Calendar objects are parsed with the E26 ICS parser (`src/lib/ics.ts`), including VTIMEZONE and Windows/IANA zone handling, recurrence rules, `EXDATE`, and `RECURRENCE-ID` overrides, which appear as separate instances. vCards use `src/lib/vcard.ts`. Contact-group cards (`KIND:group`, `X-ADDRESSBOOKSERVER-KIND:group`) are skipped.

## Writes, the offline queue, and conflicts

Every create, edit, or delete is first saved in `dav_operations` and shown immediately. Aerio then tries to send it. The queue survives restarts. There is at most one pending write per resource, and later edits merge into it. A create that is deleted before it was sent never reaches the server.

| Change | Request |
| --- | --- |
| Create | `PUT <collection>/<uuid>.ics` or `.vcf` with `If-None-Match: *` |
| Edit | `PUT` with `If-Match: <cached ETag>` |
| Delete | `DELETE` with `If-Match: <cached ETag>` |
| Delete one occurrence of a series | `PUT` of the series with the override removed and an `EXDATE` added to the master |

- **Offline or failing servers.** Network errors, `5xx`, `429`, and `408` keep the write queued and retry with backoff (30 seconds, doubling, up to 30 minutes). The queue is retried every minute and when the network comes back. If the account is offline, later writes wait so the order is kept.
- **Server copies are preserved.** Edits reuse the ICS/vCard serializers. Every property Aerio does not edit is carried over from the server copy: `ORGANIZER`, attendee parameters such as `PARTSTAT`, alarms when the reminder didn't change, other instances of a recurring series, `X-` properties, `PHOTO`, and the `UID`. `SEQUENCE` is incremented when the timing changes.
- **No ETag after `PUT`.** Some servers rewrite the item and omit the ETag. Aerio then reads the stored copy back so the cache matches the server.
- **Conflicts.** `412 Precondition Failed`, or a `404` for an item you edited, never overwrites anything. Aerio downloads the server's current copy and moves the change to **Settings › Calendar and contacts accounts › changes to review**. Your version stays visible locally until you choose:
  - **Keep server version** discards your change and shows the server copy.
  - **Keep my version** sends your change again, still conditionally, with `If-Match` set to the revision you just reviewed. If the server changed again meanwhile, you get another conflict. If the item was deleted on the server, keeping your version recreates it with `If-None-Match: *`.
  - Further edits to an item in review are blocked until it is resolved.
- **Refused writes** (`403`, `405`, `415`, and other non-transient errors) go to review as **failed**. You can send them again or discard them.

## Backups

`dav.sqlite` is in the full-profile backup (accounts, discovered collections, the resource cache, and pending writes). `dav-credentials.dat` is never included. On restore, DAV accounts show **Password needed**. Writes that were still queued are **held** in review, so a restored backup can't silently resend old changes. Choose **Send again** or **Discard my change** for each one.

## Tests

`electron/productivity/dav-fixture-server.ts` is an in-process CalDAV/CardDAV server on `127.0.0.1`. Its behavior can be configured, and the service tests run real HTTP, XML, and SQLite against it. The suites cover:

- `.well-known` and principal discovery, calendars and contacts on separate hosts, read-only, shared, and tasks-only collections, and a missing privilege set
- `sync-collection` incremental pulls, invalid tokens, `507` paging, ctag/ETag fallback, and multiget with GET fallback
- conditional create, update, and delete, property preservation, and single-occurrence deletion
- the offline queue with coalescing, backoff, and durability
- `412` and deleted-on-server conflicts with both resolutions, `403` refusals, servers that omit the ETag on PUT, and `401` handling
- HTTPS and redirect policy, credential storage, restore holds, and the Settings UI

## Known limits

- The behavior of the real iCloud, Fastmail, and Nextcloud servers has not been verified against live accounts. The presets, the separate iCloud hosts, and the quirks above follow published documentation and are covered only by the controlled fixture.
- CalDAV scheduling (RFC 6638 inbox/outbox and iTIP invitations), free/busy, VJOURNAL, and creating or sharing calendars are not implemented. VTODO task lists are synchronized into Tasks and can be created there. See [CalDAV tasks and iCalendar task files](caldav-tasks.md).
- Editing a single occurrence that has no override yet edits the whole series (recurrence editing is E24).
- When two clients edit the same item, Aerio doesn't merge field by field. You choose one version in review.
- New contacts go to the first writable, visible address book of the account.
- Only Basic authentication is supported.
