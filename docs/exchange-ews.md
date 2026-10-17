# On-premises Exchange (EWS) accounts

Aerio connects to on-premises Microsoft Exchange through Exchange Web Services (EWS): mail, folders, drafts, and sending, plus Calendar and Contacts in the normal Calendar and Contacts views. Exchange accounts use the mail provider `exchange` and the productivity provider `exchange`.

**Exchange Online and Microsoft 365 use a different route.** Choose **Outlook & Microsoft 365**. That route uses Microsoft Graph (`electron/mail/microsoft-client.ts`, `electron/productivity/microsoft-connector.ts`) and is unchanged. Microsoft is retiring EWS in Exchange Online, so Aerio does not offer EWS for Microsoft 365 mailboxes. A hybrid deployment whose mailbox is still on premises can use EWS with an OAuth token (see [Authentication](#authentication)).

## Supported servers

| Server | Build | Status |
| --- | --- | --- |
| Exchange Server 2013 SP1 or later CU | 15.0.847+ | Supported (oldest accepted) |
| Exchange Server 2016 | 15.1.x | Supported |
| Exchange Server 2019 | 15.2.x | Supported |
| Exchange Server Subscription Edition (SE) | 15.2.2562+ | Supported |
| Exchange 2010 and older | 14.x and earlier | Refused with an explicit message |

Every request sends `<t:RequestServerVersion Version="Exchange2013_SP1"/>`. All supported servers accept this schema version, so Aerio needs only one request shape. Aerio reads `ServerVersionInfo` from each response, shows it in **Settings › Mail account › Exchange server**, and refuses servers older than 15.0.847 with "Aerio supports Exchange Server 2013 SP1 or later". The distinguished `archive` folder is requested separately because older schemas reject it. When it is missing, Archive is unavailable and Aerio says so.

## Account setup

**Add mail account › Connect Exchange Server** asks for the email address, an optional display name, the user name, the authentication method, and the password or token.

- **User name.** Use `DOMAIN\user`, `user@domain` (UPN), or a plain user name. If you leave it empty, Aerio uses the email address.
- **Find my server** runs POX Autodiscover (`electron/exchange/autodiscover.ts`), trying in order:
  1. `https://<domain>/autodiscover/autodiscover.xml`
  2. `https://autodiscover.<domain>/autodiscover/autodiscover.xml`
  3. The HTTP redirect method: an unauthenticated `GET http://autodiscover.<domain>/autodiscover/autodiscover.xml`. Only a `302`/`301` that points at an HTTPS Autodiscover URL is used. No credentials are sent over plain HTTP.
  4. The DNS SRV record `_autodiscover._tcp.<domain>`, looked up with `node:dns`. Records are tried by lowest priority, then highest weight.

  The `EXCH` (internal) endpoint is preferred, then `EXPR` (external). `redirectAddr` answers restart discovery for the new address (at most 10 hops). `redirectUrl` answers and HTTP redirects are followed only over HTTPS.
- **Cross-domain redirects need your consent.** Aerio stops and shows the host before sending your password outside the email domain or its subdomains. This applies to an HTTP redirect, an SRV target, a `redirectUrl`, or a `redirectAddr` in another domain. Choosing **Trust … and continue** adds only that host for this discovery.
- **Manual setup.** Choose **Enter the EWS URL instead**, or use it when discovery reports *not found* (the setup screen lists every attempt and why it failed). The URL is usually `https://mail.example.com/EWS/Exchange.asmx`.
- **Connect** verifies the settings before anything is saved: it reads the Inbox, checks the server version, and settles the authentication method when you chose Automatic. Then the account is stored and mail sync starts. Calendar and Contacts load in the background.

## Authentication

| Method | How it works | Notes |
| --- | --- | --- |
| Automatic | Sends one request without credentials and chooses from the `WWW-Authenticate` challenge: NTLM (or NTLM inside Negotiate), then Basic, then Bearer if you gave a token | The chosen method is stored so later sessions skip the probe |
| NTLM (Windows) | NTLMv2 implemented in `electron/exchange/ntlm.ts` with `node:crypto` HMAC-MD5. NT hashes use a small pure-TypeScript MD4 (`md4.ts`) because OpenSSL 3 moved MD4 to its legacy provider. A MIC is added when the server sends a timestamp. | NTLM authenticates a connection, so each account has a keep-alive agent limited to one socket. The handshake runs once and is repeated only after a 401. |
| NTLM via Negotiate | Servers that offer only `Negotiate` usually accept NTLM tokens in it. Aerio tries this automatically. | If the server answers with Kerberos only, Aerio reports it as unsupported rather than as a wrong password |
| Basic over HTTPS | `Authorization: Basic` on every request | Refused over plain HTTP. If Basic is turned off on the server, Aerio says so explicitly. |
| OAuth bearer (hybrid) | Paste an access token issued for your on-premises EWS resource (hybrid modern authentication) | Aerio does not acquire or refresh these tokens. When a token expires, Exchange returns 401 and Aerio asks for a new one. |

**Combinations Aerio reports as unsupported:**

- Kerberos-only servers (Negotiate without NTLM fallback)
- `http://` EWS or Autodiscover URLs, except loopback addresses used for tests or SSH tunnels
- OAuth-only servers when no token was entered
- Servers that require Extended Protection for Authentication (channel binding) with NTLM
- Client-certificate or smart-card authentication
- Exchange 2010 and older

**Credentials and session expiry.** The password or token is stored with the EWS settings in the OS-encrypted credential vault (`oauth-vault.dat`, DPAPI/Keychain/libsecret). It never reaches the renderer and is never included in backups or diagnostics. When a session expires or the password changes, Exchange returns 401. The account then shows **Sign-in needed**: the mail worker marks it `needs-auth`, and Calendar/Contacts writes stay queued instead of retrying with failing credentials. **Settings › Mail account › Exchange server** asks for the new password or token, verifies it against the server before replacing the stored one, and then restarts mail and Calendar/Contacts sync.

## Mail

`electron/exchange/ews-mail.ts` runs in the mail worker and stores mail through the same parse-and-store path as other providers.

- **Folders.** `SyncFolderHierarchy` keeps an incremental folder map (an invalid state starts it over). `IPF.Note` folders become `folder:<FolderId>` labels. Inbox, Sent Items, Drafts, Deleted Items, Junk Email, and Archive are system folders, mapped to Aerio's Inbox, Sent, Drafts, Trash, Spam, and Archive.
- **Messages.** Each mail folder is read with `SyncFolderItems` in pages of `MaxChangesReturned` = 100. After each page, the items it listed are inventoried as pending, and then the folder's sync state is saved. An interrupted first sync therefore resumes at the next page and still downloads everything it had listed. Raw MIME comes from `GetItem` with `IncludeMimeContent`, 10 messages at a time. Read state, flag, importance, and categories become labels. A `ReadFlagChange` updates labels without downloading the message again.
- **Invalid sync state** (`ErrorInvalidSyncStateData`). The folder is listed again from scratch. Messages the new listing does not contain are removed after it completes.
- **Moves made elsewhere** arrive as a delete in the old folder and a create in the new one. Exchange changes an item's `ItemId` when it moves, so the message is downloaded again in its new folder.
- **Actions** use Aerio's existing durable mail operation queue (`gmail_operations`). A change is applied locally at once, and the queue survives restarts and offline periods. It retries with back-off and is restored if it finally fails. The queue sends:
  - `UpdateItem` for read/unread, flag/unflag, and importance (`ConflictResolution="AutoResolve"`)
  - `MoveItem` for move, Archive, Trash (to Deleted Items), and restore
  - `CopyItem` for copy

  Items already moved or deleted elsewhere are skipped and converge on the next sync.
- **Sending** builds the same MIME as other providers and submits it with `CreateItem MessageDisposition="SendAndSaveCopy"`, saving a copy in Sent Items. Bcc travels in the MIME. Read and delivery receipt requests are also set as `IsReadReceiptRequested`/`IsDeliveryReceiptRequested`. OpenPGP and S/MIME protection is applied before submission as usual.
- **Drafts** are saved with `CreateItem MessageDisposition="SaveOnly"` in Drafts. `PR_MESSAGE_FLAGS` = `MSGFLAG_UNSENT` makes Outlook treat them as unsent. A changed draft is saved as a new item first, and then the previous server copy is hard-deleted. Before replacing or sending a draft, Aerio compares its `ChangeKey`. If the draft was changed in another client, you get the existing "changed in another mail client" conflict instead of an overwrite. Discarding a draft moves it to Deleted Items.
- **Folder management** uses `CreateFolder`, `UpdateFolder` (rename), `MoveFolder`, and `DeleteFolder` with `MoveToDeletedItems`. As in Outlook, a deleted folder and its messages go to Deleted Items. Non-empty folders need the usual confirmation.

## Calendar and Contacts

`electron/exchange/exchange-productivity.ts` maps Exchange calendars and contacts into the normalized productivity store (`ProductivityProvider = 'exchange'`). They appear in Calendar and Contacts with Google, Microsoft, CalDAV, and local data.

- **Discovery.** Aerio reads the distinguished `calendar` and `contacts` folders, plus every `IPF.Appointment` and `IPF.Contact` folder under the mailbox root (`FindFolder`, deep traversal). `EffectiveRights` (`CreateContents`, `Modify`) decides whether a folder is writable. Read-only folders show their items without edit controls.
- **Synchronization.** Each folder is read with `SyncFolderItems` pages and per-page checkpoints. Created and changed items are read with `GetItem`, 50 at a time, with plain-text bodies. Calendar series are stored as their recurring master with an RRULE; EWS patterns use the same model as Graph, so the Graph recurrence helpers convert them. Deleted occurrences become exceptions, and modified occurrences are read separately and shown as overrides. Attendees, organizer, responses, reminders, all-day events, and time zones (`StartTimeZoneId`) are mapped. Contacts map display and structured names, up to three email addresses, phone numbers by type, company, title, nickname, birthday, home page, notes, and categories.
- **Revision-aware writes.**

  | Change | Request |
  | --- | --- |
  | Create | `CreateItem` (meeting invitations only when the event has attendees). Times are sent in UTC with `StartTimeZone`/`EndTimeZone`; all-day events use local midnight with `TimeZoneContext`. |
  | Edit | `UpdateItem` with the cached `ItemId`/`ChangeKey` and `ConflictResolution="NeverOverwrite"`. Only changed fields are sent, so untouched server data stays as it was. |
  | Delete | The `ChangeKey` is compared first, because EWS deletes do not check it. Then `DeleteItem` moves the item to Deleted Items. |
  | One occurrence | `OccurrenceItemId` (series master + `InstanceIndex`) for edits and deletes of a single occurrence |
  | Whole series | Updates the master. "This and following" is reported as unsupported. |

- **Conflicts.** `ErrorIrresolvableConflict`, a changed `ChangeKey` before a delete, or an item that vanished never overwrites anything. Aerio reads the server's current copy and puts the change in **Settings › Mail account › Exchange server › changes to review**. **Keep my version** sends it again against the revision you reviewed, still with `NeverOverwrite`. **Keep server version** discards it. Further edits to an item in review are blocked until it is resolved.
- **Offline queue.** Every write is first saved in `exchange.sqlite` and shown at once. Network errors, HTTP 5xx/429, and transient EWS codes (`ErrorServerBusy` and similar) keep it queued with back-off from 30 seconds up to 30 minutes. The queue is retried every minute, on reconnect, and on sync. A create that is deleted before it was sent never reaches the server.
- **Capabilities** are reported per account in Settings: mail, calendar, and contacts read/write, folder management, and detected limitations. The general provider catalog (`src/providers/provider.ts`) also lists Exchange.

## Notes

The `notes` distinguished folder and other `IPF.StickyNote` folders appear in the Notes module. Sticky notes are `Message` items with `ItemClass` `IPM.StickyNote`. `Subject`, `Body` (HTML or text), `Categories`, and `FileAttachment`s are synchronized with `SyncFolderItems`, `GetItem`, `GetAttachment`, `CreateItem`, `UpdateItem` (changed fields only, `NeverOverwrite`), `CreateAttachment`/`DeleteAttachment`, and `DeleteItem`. Outlook's note color and other extended properties are never changed. Their cache and queue are in `server-notes.sqlite`, and disconnecting the account removes them after an offer to copy them to Local Notes. See [Server-synchronized Notes](server-notes.md).

## Backups

`exchange.sqlite` is part of the full-profile backup: per-account status, calendar and contacts folders with their sync states, the item cache, and queued writes. Mail for Exchange accounts is in `aerio.sqlite` like other accounts. Credentials are not backed up. After a restore, the mail account needs sign-in again, and queued Exchange writes are **held** in review so an old change cannot be resent silently.

## For developers: the EWS layer

Delegation and public folders (E40) and directory lookup (E41) build on these modules. Exchange Notes (E43, [server-synchronized Notes](server-notes.md)) already do, in `electron/exchange/exchange-notes.ts`:

| Module | Role |
| --- | --- |
| `electron/exchange/ews-client.ts` | `EwsClient.call(operation, body)` sends any EWS operation and returns its per-item response messages. It handles authentication, SOAP faults, `ErrorServerBusy` back-off (`BackOffMilliseconds`), HTTP 503/429 retries, and the reported server version. It also has typed helpers for folders (`GetFolder`, `FindFolder`, `SyncFolderHierarchy`, `Create/Update/Move/DeleteFolder`) and items (`SyncFolderItems`, `GetItem`, `getMime`, `UpdateItem`, `MoveItem`, `CopyItem`, `DeleteItem`, `CreateItem`, `sendMime`, `saveDraftMime`, `changeKey`). Item-level failures come back as `EwsError` values with the EWS `ResponseCode`. |
| `electron/exchange/ews-xml.ts` | SOAP envelope (`RequestServerVersion`, optional `TimeZoneContext` and extra headers such as `ExchangeImpersonation`), namespace-aware readers (`t`, `m`, `path`), and `FolderRef`/`ItemRef` builders. `FolderRef.mailbox` addresses another mailbox's distinguished folder for delegate access. Parsing reuses the DOCTYPE-refusing reader in `productivity/dav-xml.ts`. |
| `electron/exchange/ews-transport.ts` | HTTPS-only transport with Basic, NTLM (connection-bound), Negotiate-with-NTLM, and bearer authentication, response size and time limits, and explicit errors (`EwsAuthError`, `EwsUnsupportedError`, `EwsHttpError`, `EwsNetworkError`) |
| `electron/exchange/ntlm.ts`, `md4.ts` | NTLMv2 messages and MD4, tested against RFC 1320 and MS-NLMP vectors |
| `electron/exchange/autodiscover.ts` | POX Autodiscover with injectable HTTP/DNS for tests |
| `electron/exchange/ews-mail.ts`, `ews-items.ts` | Mail sync/actions/drafts/folders; CalendarItem/Contact mapping and update builders |
| `electron/exchange/exchange-productivity.ts`, `exchange-store.ts`, `exchange-ipc.ts` | Calendar/Contacts service, its SQLite store, and IPC (`exchange:*`, exposed as `window.aerio.exchange`) |
| `electron/exchange/ews-directory.ts` | Directory helpers (E41): `ResolveNames`, `ExpandDL`, `GetRoomLists`/`GetRooms`, and `FindPeople` on the directory, used by the [organization directory](organization-directory.md) |
| `electron/exchange/exchange-notes.ts` | Exchange Notes adapter (`IPM.StickyNote` items and their FileAttachments) for the server-notes service in `electron/productivity/server-notes-service.ts` |
| `electron/exchange/ews-fixture-server.ts` | In-process EWS + Autodiscover responder used by the tests |

A new operation such as `ResolveNames` should be a thin helper over `call()`, returning parsed values and `EwsError`s instead of throwing for item-level failures.

## Tests

The suites use `electron/exchange/ews-fixture-server.ts`, a `node:http` SOAP responder on `127.0.0.1`. It verifies Basic credentials, real NTLMv2 proofs per connection, and bearer tokens, and keeps folders, MIME messages, calendar items, and contacts with change-sequence sync states. No real server, credential, or network is used.

- `ntlm.test.ts`: MD4 (RFC 1320) and NTLMv2/NT hash/session key (MS-NLMP) vectors, and authenticate messages with MIC
- `ews-client.test.ts`: NTLM connection reuse, Negotiate carrying NTLM, Kerberos-only, Basic disabled, bearer and expired tokens, expired sessions, plain-HTTP refusal, server-version refusal, `ErrorServerBusy` retry, FindFolder paging, SyncFolderHierarchy, SyncFolderItems paging/checkpoints/invalid state, MIME read/send/draft
- `autodiscover.test.ts`: domain and autodiscover-host endpoints, the HTTP redirect method with cross-domain consent, SRV, `redirectAddr`/`redirectUrl`, and not-found reporting
- `ews-mail.test.ts`: real `MailDatabase` sync, folder labels, page checkpoints with an interrupted-and-resumed first sync, incremental creates/read flags/moves/deletes, invalid-state resync, expired sessions, queued actions surviving a restart, drafts, and folder management
- `exchange-productivity.test.ts`: discovery and capabilities, mapping, paging/incremental/invalid-state, create/update/delete with `ChangeKey`, `ErrorIrresolvableConflict` review with both resolutions, delete conflicts, contacts with indexed fields, the durable offline queue across a restart, session expiry and recovery, occurrences and series, and restore holds
- `exchange-notes.test.ts`: Notes folder discovery and rights, sticky-note mapping, SyncState changes/deletions/invalid state, field-only updates that keep extended properties, FileAttachment create/read/delete with inline `cid:` pictures, and ChangeKey conflicts across a restart (the fixture's `addNotesFolder`, `noteProps`, and `GetAttachment`/`CreateAttachment`/`DeleteAttachment`)
- `exchange-ipc.test.ts`, `preload-exchange.test.ts`, `ExchangeAccount.test.tsx`, plus Exchange cases in `main.test.ts` and `mail-worker.test.ts`: IPC validation, connect/verify/rollback, reauth, renderer flows, and routing

## Limitations

- Behavior against real Exchange servers has not been verified yet. See the live-server validation matrix below. The fixture follows Microsoft's published EWS and Autodiscover documentation.
- Free/busy lookup (`GetUserAvailability`), tasks, delegate and shared mailboxes, public folders, the global address list, and server-side rules and automatic replies are not implemented for Exchange accounts. E40 and E41 cover several of these. Notes in the `notes` folder and other `IPF.StickyNote` folders synchronize with Aerio Notes; see [Server-synchronized Notes](server-notes.md).
- EWS push and streaming notifications are not used. Mail is polled at the IMAP cadence (at most every minute), and Calendar/Contacts every 15 minutes or on **Sync now**.
- Messages moved in another client are downloaded again because EWS `ItemId`s change on move.
- "This and following" edits to repeating Exchange events are not supported. Editing a series from one occurrence moves the whole series by the same offset.
- Contacts keep at most three email addresses (EWS `EmailAddress1-3`). Contact photos are not synchronized.
- OAuth tokens for hybrid deployments must be pasted and renewed by hand.
- NTLM without channel binding fails on servers that require Extended Protection for Authentication.

## Live-server validation

[docs/live-provider-test-matrix.md](live-provider-test-matrix.md#exchange-server-ews-coverage) lists the Exchange accounts, scenarios (`EWS-DISC-01`, `EWS-AUTH-01`, `EWS-SYNC-01`, `EWS-CONFLICT-01`, and the shared mail/calendar scenarios), and the coverage table for Exchange 2016, 2019, and Subscription Edition. No live results have been recorded. Exchange stays at the Beta gate until dated Pass evidence exists for each server version.
