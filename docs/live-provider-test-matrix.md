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
| `zoom` | Disposable Zoom user that may schedule meetings, plus a Google or Microsoft calendar account from this table | Zoom user-managed OAuth app (Settings › Online meetings) | Beta |
| `webex` | Disposable Webex user with a Meetings license, plus a Google or Microsoft calendar account from this table | Webex integration (Settings › Online meetings) | Beta |
| `exchange-2016`, `exchange-2019`, `exchange-se` | Disposable mailbox on on-premises Exchange Server 2016, 2019, and Subscription Edition (EWS) | NTLM and Basic over HTTPS; OAuth bearer on a hybrid test tenant | Beta |

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
| `OOO-01` | Automatic replies | On Gmail (consumer and Workspace) and Microsoft, save a scheduled reply in Aerio, confirm the provider web client shows the same window and audience, quit Aerio, and confirm replies stop at the end time. An older connection reads Gmail but explains the missing `gmail.settings.basic` / `MailboxSettings.ReadWrite` permission and reconnects to grant it. |
| `CLOUD-01` | Cloud attachments | On Gmail and Microsoft (personal and work), connect storage from the composer and confirm existing mail access still works; share a >25 MB file as anyone-with-link, organization (Microsoft), and recipients-only links and open each from another account; cancel mid-upload and confirm no file remains; quit during an upload and resume it; remove the sharing permission or delete the file in the provider web UI and confirm Aerio warns before sending. |
| `CLOUD-02` | Connected storage accounts | With disposable Dropbox Basic and Plus/Business accounts (aliases `dropbox-basic-`, `dropbox-business-`), a Nextcloud 26+ server (`nextcloud-`) and an ownCloud 10 server (`owncloud-`): connect each in Settings › Cloud storage accounts and compare the shown capabilities with the admin/plan settings (enforced password, enforced expiry with a maximum, public uploads, Dropbox team link policy); share a >25 MB file from an IMAP account with each allowed audience, password and expiry and open the link signed out; quit mid-upload and resume (Dropbox and Nextcloud continue from the acknowledged offset, ownCloud restarts); cancel mid-upload and confirm no file or chunk folder remains; revoke a link from Settings and in the provider web UI and confirm the pre-send warning; disconnect and confirm credentials, interrupted uploads and link records are gone and the Dropbox token is revoked. Not a release gate; record runs in the execution log. |
| `PROD-AUTH-01` | Productivity consent | Google sign-in grants Calendar event and Contacts read/write plus read-only Calendar-list access; Microsoft grants Calendars.ReadWrite and Contacts.ReadWrite. Older connections offer the one-time enable/reconnect path for added write scopes. |
| `CAL-01` | Calendar initial sync | Calendars and events in the supported date window appear once with correct account, time, location, attendees, recurrence and per-calendar write capability. |
| `CAL-02` | Calendar pagination/time zones | More than one provider page, all-day events, DST boundaries and UTC/non-UTC events render on the correct date and time. |
| `CAL-WRITE-01` | Provider event lifecycle | On Google and Microsoft, double-click a blank month/week/day slot, create an event, then edit and delete it; each change appears in the provider client and survives a fresh Aerio sync. Include recurrence and reminders. |
| `CAL-WRITE-02` | Provider write permissions | Reader calendars and events that cannot be changed expose details without edit/delete controls; an older token offers the one-time enable/reconnect path. |
| `CONTACT-01` | Contacts initial sync | More than one provider page maps names, email, phone, company, title and groups without duplicates; contacts without an email remain viewable. |
| `CONTACT-WRITE-01` | Provider contact lifecycle | Explicitly target Google or Microsoft when creating a contact; create, edit and delete converge in the provider client and survive refresh. New contacts default to local storage. |
| `CONTACT-WRITE-02` | Contact conflicts and permissions | Edit a contact in another client before saving a stale Aerio edit; newer data is not silently overwritten. Revoked write permissions fail visibly without losing the cached contact. |
| `PROD-SYNC-01` | Incremental refresh and checkpoint expiry | Calendar and Contacts changes from another client arrive on automatic/manual refresh; expire stored checkpoints and verify full-refresh recovery without duplicates or stale records. |
| `DRAFT-04` | Cross-client draft conflict | Change a Gmail or Microsoft draft in another client, then save the stale Aerio editor; explain the conflict and preserve the stale edit as a separate copy when requested. |
| `LOCAL-TIME-01` | Scheduled actions and recovery | Scheduled sending, Undo Send, snooze and rules recover across offline use/restart without duplicate sends. Tray mode processes due actions; fully quitting defers due actions until next launch as documented. |
| `PROD-FAIL-01` | Productivity refresh failure | Revoked scope, 429 and 5xx errors are visible, retry safely, and retain the last successful cached snapshot. |
| `MEET-01` | Meeting-host connection | Connect Zoom or Webex in Settings › Online meetings. Consent lists the documented scopes, Settings shows the connected account, and a registration missing a scope is refused with the scope named. Disconnect removes the grant (Zoom also revokes it) and leaves existing meetings in place. |
| `MEET-02` | Hosted meeting lifecycle | On a Google and a Microsoft calendar, add Zoom or Webex to a new event with an attendee. Exactly one meeting appears in the host's web portal with the Aerio reference in its agenda. The join link, meeting number, passcode, and dial-in numbers appear in the event and in the attendee's invitation. Changing the title and time updates the meeting. Remove cancels it. Delete cancels it with *Cancel the meeting* on, and keeps it with the option off. Each change survives a fresh Aerio sync. |
| `MEET-03` | Duplicate prevention after an uncertain outcome | Drop the connection while a save is creating the meeting (after the request leaves, before the response), save again, and quit and reopen before a third save. The host has exactly one meeting for the event. A save whose calendar write fails reuses the meeting on retry. |
| `MEET-04` | Revoked meeting-host credential | Remove the Aerio app from the Zoom account or revoke the Webex integration. The next save or delete explains the revoked access and does not change the event. Settings shows Reconnect. Reconnecting restores scheduling, and events that already have meetings keep their links. |
| `MEET-05` | Host permissions | An account without meeting-host permission or a Meetings license, or an account whose administrator blocks the app, gets a clear refusal. No event or meeting is left behind. |

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

| Provider | PROD-AUTH-01 | CAL-01 | CAL-02 | CAL-WRITE-01 | CAL-WRITE-02 | CONTACT-01 | CONTACT-WRITE-01 | CONTACT-WRITE-02 | PROD-SYNC-01 | PROD-FAIL-01 | DRAFT-04 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gmail | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required |
| microsoft | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required | Required |

`LOCAL-TIME-01` is additionally Required for every required mail provider and Beta for Proton Bridge.

## Online meeting coverage

Zoom and Webex meetings are scheduled through the host's own account and written onto a Google or Microsoft calendar event, so run `MEET-02` and `MEET-03` once on each calendar provider. These rows are Beta. They are not part of the public-beta release gate, and `npm run verify:live-evidence` does not check them yet. Record runs in the execution log like any other scenario. No evidence has been recorded.

| Host | MEET-01 | MEET-02 | MEET-03 | MEET-04 | MEET-05 |
| --- | --- | --- | --- | --- | --- |
| zoom | Beta | Beta | Beta | Beta | Beta |
| webex | Beta | Beta | Beta | Beta | Beta |

## Exchange Server (EWS) coverage

On-premises Exchange uses EWS ([exchange-ews.md](exchange-ews.md)); Microsoft 365 stays on the `microsoft` rows above. These scenarios add to the mail and Calendar/Contacts scenarios:

| ID | Scenario | Pass criteria |
| --- | --- | --- |
| `EWS-DISC-01` | Autodiscover | Discovery succeeds through `https://<domain>/autodiscover`, `autodiscover.<domain>`, the HTTP redirect method, and the SRV record on separately configured test domains; a cross-domain redirect asks for consent before any password is sent there; a domain without Autodiscover reports every attempt and accepts a manual EWS URL. |
| `EWS-AUTH-01` | Authentication matrix | Automatic picks NTLM where enabled; NTLM, Negotiate-with-NTLM, and Basic over HTTPS connect; a Kerberos-only virtual directory, Basic turned off, `http://` URLs, and Exchange 2010 are refused with their specific messages; an expired hybrid token or changed password shows Sign-in needed and re-authentication resumes sync without losing local mail or queued writes. |
| `EWS-SYNC-01` | Large folders and checkpoints | A folder with more than 512 items synchronizes completely in 100-item pages; killing Aerio mid-folder resumes from the saved page; invalidating the sync state (mailbox move or server restore) relists the folder without duplicates or stale items. |
| `EWS-CONFLICT-01` | ChangeKey conflicts | An event and a contact edited in Outlook before a stale Aerio edit or delete reach review with the server version shown; both resolutions converge in Outlook and OWA. |

Use account aliases starting with `exchange-2016-`, `exchange-2019-`, or `exchange-se-`. Exchange is not part of the release gate checked by `verify:live-evidence` until it moves from Beta to Required.

| Server | EWS-DISC-01 | EWS-AUTH-01 | EWS-SYNC-01 | EWS-CONFLICT-01 | AUTH-02 | SYNC-02 | SYNC-03 | SYNC-04 | SYNC-05 | SYNC-09 | DRAFT-01 | DRAFT-04 | SEND-01 | SEND-02 | CAL-01 | CAL-02 | CAL-WRITE-01 | CAL-WRITE-02 | CONTACT-01 | CONTACT-WRITE-01 | CONTACT-WRITE-02 | PROD-SYNC-01 | PROD-FAIL-01 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| exchange-2016 | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta |
| exchange-2019 | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta |
| exchange-se | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta |

No Exchange results have been recorded yet.

## Organization directory coverage

The read-only organization directory and offline address book ([organization-directory.md](organization-directory.md)) need a work or school tenant, a Google Workspace domain, or an Exchange Server organization with at least 1,000 directory entries (so listings span pages), two people with the same display name, a mail-enabled group, and a room list with two rooms.

| ID | Scenario | Pass criteria |
| --- | --- | --- |
| `DIR-01` | Consent and denied consent | **Allow directory access** adds `User.ReadBasic.All`/`People.Read` (Microsoft 365) or `directory.readonly` (Workspace) without disturbing mail. On a tenant that blocks user consent, Aerio shows the administrator-consent explanation and keeps personal contacts and recent recipients working. A consumer Gmail account reports that it has no directory. |
| `DIR-02` | Lookup and disambiguation | In the composer, typing a partial name lists directory people, groups, and rooms after the cached suggestions and personal contacts, marked read-only with type icons. The two people with the same name show title, department, and address. The group inserts its address, and **Expand members** inserts its members (Exchange; Microsoft 365 with GroupMember.Read.All). |
| `DIR-03` | Offline address book | **Refresh now** lists every page into the cache, and Contacts › Directory shows the entry count and age. With the network disconnected, lookups answer from the cache and say so. Interrupting a refresh (disconnect mid-listing) keeps the previous cache and shows the failure and last success. |
| `DIR-04` | Rooms in scheduling | The scheduling assistant finds a room by a word in its name and adds it as a resource whose free/busy is then looked up. |

Use account aliases starting with `directory-m365-`, `directory-workspace-`, or `directory-exchange-`. These rows are Beta and are not checked by `verify:live-evidence`.

| Directory | DIR-01 | DIR-02 | DIR-03 | DIR-04 |
| --- | --- | --- | --- | --- |
| directory-m365 | Beta | Beta | Beta | Beta |
| directory-workspace | Beta | Beta | Beta | N/A: the Workspace directory API has no rooms |
| directory-exchange | N/A: no consent step | Beta | Beta | Beta |

No organization directory results have been recorded yet.

## Shared mailboxes, delegation, and public folders coverage

[Shared mailboxes, delegation, and public folders](shared-mailboxes-delegation.md) (E40) need test mailboxes that grant the test user Full Access, Reviewer-only delegate access, Send As, and Send on Behalf, plus a public folder hierarchy with a read-only and a writable mail folder and a calendar folder.

| ID | Scenario | Pass criteria |
| --- | --- | --- |
| `SHARE-RO-01` | Read-only versus writable shares | A Full Access mailbox shows **Can edit** and accepts read/flag/move/trash into its own Deleted Items; a Reviewer delegate mailbox shows **Read-only**, its actions are disabled, and a forced change is refused and rolled back with an explanation. |
| `SHARE-REVOKE-01` | Revoked access | Removing the permission (or deleting the mailbox) marks the mailbox **Access removed** on the next sync, holds queued changes for review, keeps the cache readable, and **Remove** deletes the local copy only. |
| `SHARE-SEND-01` | Send as versus send on behalf | Send as arrives with From = the shared mailbox; send on behalf arrives as "Delegate on behalf of Owner"; the copy is in the owner's Sent Items where permitted; a missing permission keeps the draft with the ErrorSendAsDenied explanation. |
| `SHARE-ISOLATION-01` | Owner isolation | Two mailboxes with an Inbox of the same name keep separate folders, counts, and caches; synchronizing or rebuilding the own mailbox leaves the shared caches intact. |
| `SHARE-PARTIAL-01` | Partial failures | A folder without read permission is marked **No access** while the rest of the mailbox and other mailboxes keep synchronizing. |
| `SHARE-DISCOVER-01` | Discovery | **Find my mailboxes** lists automapped delegate and shared mailboxes from Autodiscover AlternativeMailbox entries (Exchange). |
| `SHARE-DELEGATE-01` | Delegate management | Adding, updating, and removing a delegate with folder permission levels, meeting-copy and private-item options, and meeting request delivery matches what Outlook shows (Exchange). |
| `SHARE-PF-01` | Public folders | The public folder tree is browsable through the hierarchy mailbox; a subscribed read-only and writable mail folder and a calendar folder appear with the right access (Exchange). |

| Account | SHARE-RO-01 | SHARE-REVOKE-01 | SHARE-SEND-01 | SHARE-ISOLATION-01 | SHARE-PARTIAL-01 | SHARE-DISCOVER-01 | SHARE-DELEGATE-01 | SHARE-PF-01 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| exchange-2016 | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta |
| exchange-2019 | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta |
| exchange-se | Beta | Beta | Beta | Beta | Beta | Beta | Beta | Beta |
| microsoft-365 | Beta | Beta | Beta | Beta | Beta | N/A: Graph cannot list shared mailboxes | N/A: no Graph delegate API | N/A: no Graph public folders |

No shared mailbox, delegation, or public folder results have been recorded yet; these rows stay Beta until dated Pass evidence exists.

## Execution log

Copy this row for every run. A failure remains a release blocker until its linked issue is fixed and the scenario is rerun.

Use aliases starting with `gmail-`, `icloud-`, `yahoo-`, `fastmail-`, `custom-imap-`, `proton-bridge-`, `zoom-`, or `webex-`. For a meeting scenario, name the calendar account in the notes. Microsoft needs separate runs with aliases starting with `microsoft-consumer-` and `microsoft-365-`. Record the package version and exact commit in Commit/version. Evidence for a public release must match that package version. The last recorded result for each account class/scenario determines its status.

`npm run test:live-matrix` checks the checklist structure only. Before publishing, run `npm run verify:live-evidence` to require dated Pass results for all Required scenarios, on both Microsoft account classes. This verifies recorded evidence, not the provider behavior itself; review diagnostics and confirm results apply to the candidate commit.

The [opt-in live-provider runner](live-provider-runner.md) can check preconfigured accounts and export sanitized diagnostic reports and execution rows. It marks limited enrollment, sync, and pagination checks as Partial; these do not satisfy the release gate. It never inserts rows into this log automatically.

| Date | Commit/version | Provider/account alias | Scenario | Result | Diagnostics | Issue/notes | Tester |
| --- | --- | --- | --- | --- | --- | --- | --- |
| YYYY-MM-DD | commit / version | gmail-a | SYNC-01 | Pass/Fail/Blocked | filename or N/A | issue URL or concise note | initials |

## Clean-room procedure

1. Start from a disposable provider account with a recorded server-side message/folder count.
2. Export diagnostics before the test, perform one scenario, wait for sync to settle, and run the health check.
3. Compare Aerio with the provider web client and a second standards-compliant client where applicable.
4. Export diagnostics after the test and record only the sanitized filename in the execution log.
5. Restore the account fixture before the next destructive scenario.
