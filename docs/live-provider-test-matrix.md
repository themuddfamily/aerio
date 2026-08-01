# Aerio live-provider test matrix

Automated unit tests deliberately mock provider responses. This matrix is the release gate for behavior that can only be proven with disposable, real accounts. Never use a personal mailbox for destructive cases.

## Test accounts

| Provider key | Required account | Authentication | Release gate |
| --- | --- | --- | --- |
| `gmail` | Consumer Gmail with at least 250 seeded messages | Aerio Google OAuth client | Required |
| `microsoft` | Outlook.com consumer account and Microsoft 365 account | Aerio Microsoft OAuth client | Required |
| `icloud` | iCloud Mail account | App-specific password | Required |
| `yahoo` | Yahoo Mail account | App password | Required |
| `fastmail` | Fastmail account | App password | Required |
| `custom-imap` | Dovecot or equivalent disposable server | Password, TLS and STARTTLS variants | Required |
| `proton-bridge` | Proton Mail Bridge on the test machine | Bridge credentials | Beta |

Record no secrets in evidence. Use an account alias such as `gmail-a`, the Aerio version and commit, Windows version, start/end times, result, diagnostic export filename, and issue link.

## Scenarios

| ID | Scenario | Pass criteria |
| --- | --- | --- |
| `AUTH-01` | First connection | Account is verified before it is retained; a failed connection leaves no account or credential behind. |
| `AUTH-02` | Expired/revoked credential | Account changes to Needs attention, other accounts continue syncing, and reconnect restores sync without deleting local mail. |
| `SYNC-01` | Initial full sync | Every server folder and message is represented once, progress completes, and database diagnostics are healthy. |
| `SYNC-02` | Incremental receive | A message delivered by a second client appears once, with the correct thread, folder, flags, attachments and one notification. |
| `SYNC-03` | Move/label/read/star | Changes made in Aerio reach the provider; changes made in another client return to Aerio without oscillation. |
| `SYNC-04` | Delete/restore | Trash and restore preserve the message and converge across clients. No permanent deletion is performed by this case. |
| `SYNC-05` | Folder rename/delete | Local folders and message membership converge without orphaned messages. |
| `SYNC-06` | Interrupted full sync | Kill Aerio during inventory and download, reopen it, and confirm resume completes without missing or duplicate messages. |
| `SYNC-07` | Provider checkpoint expiry | Invalidate or age out the delta/history checkpoint; Aerio rebuilds safely and retains no stale mail. |
| `SYNC-08` | Rate limiting/transient failure | 429 and 5xx responses back off and recover; diagnostics explain the delay without exposing credentials. |
| `SYNC-09` | Offline mutation | Archive/read/star while offline, reconnect, and confirm queued operations converge or visibly fail and roll back. |
| `SYNC-10` | Duplicate physical folders | A message present in All Mail and Inbox is displayed once while preserving all folder membership. |
| `DRAFT-01` | New draft lifecycle | Autosave creates one provider draft; reopen, edit, close and discard all converge with the provider. |
| `DRAFT-02` | Reply/forward draft | Thread headers are retained, recipients are correct and forwarded attachments remain available. |
| `DRAFT-03` | Crash recovery | Force-close during composition and after Send; Aerio recovers the draft and never silently sends twice. |
| `SEND-01` | Plain and rich send | Text and HTML render correctly in Gmail, Outlook and a plain-text client. |
| `SEND-02` | Attachments | Multiple, Unicode-named and zero-byte attachments arrive intact; over-limit files are rejected clearly. |
| `MAIL-01` | MIME corpus | Multipart, nested, signed, Unicode, malformed and large messages remain readable and safe. |
| `MAIL-02` | Search/pagination | Seeded messages are found offline and appear exactly once across page boundaries. |
| `DESKTOP-01` | Background notification | With Aerio hidden, one incoming message creates one notification; clicking it opens Aerio. Disabled accounts stay silent. |
| `HEALTH-01` | Diagnostics | Health check reports zero orphans/missing files/failures; export contains no tokens, passwords, message bodies or full local parts of email addresses. |
| `PROD-AUTH-01` | Productivity consent | Google/Microsoft sign-in grants the documented read-only Calendar and Contacts scopes; an older connection explains that reconnect is required. |
| `CAL-01` | Calendar initial sync | Calendars and events in the supported date window appear once with correct account, time, location, attendees and recurrence; Aerio exposes no edit controls. |
| `CAL-02` | Calendar pagination/time zones | More than one provider page, all-day events, DST boundaries and UTC/non-UTC events render on the correct date and time. |
| `CONTACT-01` | Contacts initial sync | More than one provider page maps names, email, phone, company, title and groups without duplicates; contacts without an email remain viewable. |
| `PROD-FAIL-01` | Productivity refresh failure | Revoked scope, 429 and 5xx errors are visible, retry safely, and retain the last successful cached snapshot. |

## Provider coverage

Every Required cell must have dated evidence before a public beta. `N/A` must include a protocol reason.

| Provider | AUTH-01 | AUTH-02 | SYNC-01 | SYNC-02 | SYNC-03 | SYNC-04 | SYNC-05 | SYNC-06 | SYNC-07 | SYNC-08 | SYNC-09 | SYNC-10 | DRAFT-01 | DRAFT-02 | DRAFT-03 | SEND-01 | SEND-02 | MAIL-01 | MAIL-02 | DESKTOP-01 | HEALTH-01 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gmail | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required |
| microsoft | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | N/A: Graph immutable IDs | Required | Required | Required | Required | Required | Required | Required | Required | Required |
| icloud | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required |
| yahoo | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required |
| fastmail | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required |
| custom-imap | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required |
| proton-bridge | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta |

## Calendar and Contacts coverage

IMAP/SMTP is a mail protocol and does not imply Calendar or Contacts APIs. These scenarios apply only to the OAuth providers whose existing Aerio app connection can request the relevant service scopes.

| Provider | PROD-AUTH-01 | CAL-01 | CAL-02 | CONTACT-01 | PROD-FAIL-01 |
| --- | --- | --- | --- | --- | --- |
| gmail | Required | Required | Required | Required | Required |
| microsoft | Required | Required | Required | Required | Required |

## Execution log

Copy this row for every run. A failure remains a release blocker until its linked issue is fixed and the scenario is rerun.

| Date | Commit/version | Provider/account alias | Scenario | Result | Diagnostics | Issue/notes | Tester |
| --- | --- | --- | --- | --- | --- | --- | --- |
| YYYY-MM-DD | commit / version | gmail-a | SYNC-01 | Pass/Fail/Blocked | filename or N/A | issue URL or concise note | initials |

## Clean-room procedure

1. Start from a disposable provider account with a recorded server-side message/folder count.
2. Export diagnostics before the test, perform one scenario, wait for sync to settle, and run the health check.
3. Compare Aerio with the provider web client and a second standards-compliant client where applicable.
4. Export diagnostics after the test and record only the sanitized filename in the execution log.
5. Restore the account fixture before the next destructive scenario.
