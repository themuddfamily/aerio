# Organization directory and offline address book

Aerio can look up the people, groups, and rooms your organization publishes (the global address list, or GAL), in addition to your own contacts and the addresses it remembers from mail. The directory is a **read-only source**. Aerio never changes a directory entry. **Add to my contacts** copies an entry into your personal contacts, where you can edit it. Personal contact editing and the cached-mail recipient suggestions work as before.

## Supported directories

| Account | Directory API | People | Groups | Rooms | Group members | Offline address book |
| --- | --- | --- | --- | --- | --- | --- |
| Microsoft 365 (work or school) | Microsoft Graph | `/users` with `$search` (`ConsistencyLevel: eventual`) and `/me/people` | Mail-enabled groups from `/me/people`; `/groups` with `mailEnabled eq true` when GroupMember.Read.All is granted | `/places/microsoft.graph.room` with Place.Read.All | `/groups/{id}/members` with GroupMember.Read.All | Full: every `/users` page (999 per page through `@odata.nextLink`), plus groups and rooms when their permissions are granted |
| Google Workspace | People API | `people:searchDirectoryPeople`, `readMask=names,emailAddresses,organizations,phoneNumbers,locations`, sources `DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE` and `DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT` | Not available (the directory API lists people and shared domain contacts only) | Not available (calendar resources need the Admin SDK) | Not available | Full: `people:listDirectoryPeople`, 1,000 per page with `pageToken` |
| Exchange Server 2013 SP1 or later (EWS) | EWS through the [Exchange account](exchange-ews.md) | `ResolveNames` with `ReturnFullContactData`, `SearchScope="ActiveDirectory"`, `ContactDataShape="AllProperties"` | Distribution groups (`PublicDL`, `PrivateDL`, `GroupMailbox`) | `GetRoomLists` and `GetRooms` | `ExpandDL` | Full: `FindPeople` on the `directory` folder, 100 per page. Servers that only search the directory with a query string get an incremental cache (see below). |
| Outlook.com, consumer Gmail, IMAP, POP3 | None | — | — | — | — | — |

Personal accounts have no organization directory, and Aerio says so instead of offering a permission. Aerio recognizes them by address: `gmail.com` and `googlemail.com` for Google, and `outlook.com`, `hotmail.com`, `live.com`, `msn.com`, and `passport.com` (plus the `.co.uk` variants of the first three) for Microsoft. A Workspace or Microsoft 365 address on a custom domain is treated as an organization account. If the domain has no directory, the server's answer is reported instead.

**Equipment mailboxes.** The data model and the UI have an equipment type, but none of these APIs labels equipment mailboxes for non-administrators. They appear as people, and you can still add their addresses as resources.

## Consent and setup

Directory permissions are not part of the first sign-in. You add them through an explicit reconnect, the same way as cloud attachments: Contacts › Directory › **Allow directory access**. Aerio keeps the permissions it already has and adds the new ones (incremental consent). Later reconnects request them again, so a reconnect never drops them.

| Account | Permission | Who can approve |
| --- | --- | --- |
| Microsoft 365, people | `User.ReadBasic.All`, `People.Read` | Usually the user. Some tenants turn off user consent, and then an administrator must approve. |
| Microsoft 365, rooms and groups (**Allow rooms and groups**) | `Place.Read.All`, `GroupMember.Read.All` | An administrator (both need admin consent) |
| Google Workspace | `https://www.googleapis.com/auth/directory.readonly` | The user. The Workspace administrator must allow contact sharing (Directory settings › Sharing settings › Contact sharing). |
| Exchange Server | None. The directory uses your Exchange sign-in. | — |

**Denied consent is explained, not retried.** When Microsoft Graph answers `403 Authorization_RequestDenied` although the account's grant includes the directory permission, or the sign-in screen returns `AADSTS65001` (consent required) or another admin-approval error, Aerio records it and shows what is needed: *an administrator must grant consent for User.ReadBasic.All and People.Read in Microsoft Entra ID (Enterprise applications › Aerio › Permissions), or allow users to consent to these permissions*. Graph sends the same 403 when a permission was simply never granted. For an older grant without a recorded scope list, Aerio therefore asks you to allow directory access instead of reporting a refusal. While the permission is missing or denied, lookups use only the saved offline address book (if one exists) and do not ask the server again. Personal contacts and recent recipients keep working. A Google `403` that names insufficient scopes asks you to allow directory access; any other `403` explains that the administrator blocks directory lookups. A Workspace account whose domain has no directory (`FAILED_PRECONDITION`) is reported as having no directory.

After an administrator approves, choose **Allow directory access** again (or **Refresh now**) to clear the refusal. A denied **rooms and groups** request does not mark the people directory as denied. People lookup keeps working, and groups found through `/me/people` can still be inserted by address.

## Where the directory appears

- **Composer.** When you type in To, Cc, or Bcc, Aerio shows distribution lists, cached-mail suggestions (unchanged), then matching **My contacts**, then **Directory · read-only** entries from the sending account's directory. Each entry has a type icon (person, group, room, equipment). The directory is looked up 300 ms after you stop typing, and only for two or more characters. Late answers to an earlier query are ignored.
  - **Ambiguous names.** When several entries share a display name, each shows its title, department, office, and address, so you can pick the right one.
  - **Groups** insert the group address. Where the server can list members (Exchange `ExpandDL`, Microsoft 365 with GroupMember.Read.All), **Expand members** inserts the members instead, up to 500. Nested groups are inserted as group addresses.
  - **Offline.** Without a network connection, or when the server cannot be reached, the same list comes from the offline address book. The section heading then says *saved address book*.
- **Contacts › Directory** (under *Organization* in the sidebar). Search by name, address, title, or department. Results show their type. Selecting one shows its details (read-only), **Email**, **Show members** for expandable groups, and **Add to my contacts** for people. Add to my contacts opens the new-contact editor with the name, address, phones, company, and title filled in, and the department and office in the notes. You choose where to save it, as for any new contact.
- **Scheduling assistant.** **Find a room in the directory** searches rooms (and equipment, where labelled) across your accounts and adds the chosen one as a resource. Its free/busy is then looked up like any attendee's.

## Offline address book and freshness

Each account with a directory has its own cache in `directory.sqlite` (in the profile folder).

- **Refreshing.** **Refresh now** in Contacts › Directory rebuilds it at once. Aerio also checks every 30 minutes (first check two minutes after start) and refreshes a cache whose last success is more than 24 hours old. A failed scheduled refresh is retried after an hour. Scheduled refreshes run only while online, while the app is unlocked, and for accounts whose directory permission is granted (Exchange needs none).
- **Atomic refresh.** A refresh writes the listing into a staging table. Only when the whole listing has succeeded does Aerio replace the account's cache with the staged copy, in one transaction. If any page fails (network loss, `5xx`, throttling, a permission revoked mid-listing), the staged rows are discarded and the previous cache stays in use unchanged. Aerio records the error and the time of the attempt. Staging rows left behind by a crash are cleared when the next refresh starts.
- **Freshness in the UI.** Contacts › Directory shows each account's directory type, entry count, when it was last refreshed successfully, and the last failure with its time. While offline, lookup results say they come from the saved address book.
- **Incremental caches (Exchange).** Some Exchange servers search the directory with `FindPeople` only when a query string is given. Then the cache holds the organization's rooms (from the room lists) plus every person and group you have looked up online. These looked-up entries are kept across refreshes. The account shows *rooms and people you looked up*.
- **Limits.** A listing stops at 100,000 entries. Group expansion lists at most 500 members.
- **Removing an account** deletes its cache.

### Backups

`directory.sqlite` is deliberately **not** part of profile backups, and the backup manifest lists it under exclusions. It holds only server data that Aerio rebuilds on the next refresh, and an old copy would show colleagues who have since left or changed roles. After a restore, the cache is rebuilt by **Refresh now** or the daily refresh.

## Privacy and security

- Directory requests use the account's existing credentials in the main process. Tokens and passwords never reach the renderer.
- Every directory IPC call is validated and refused while the app is locked.
- Diagnostics record refresh outcomes and failures by account id. They do not record names or addresses from the directory.

## For developers

| Module | Role |
| --- | --- |
| `src/directory-types.ts` | Renderer contract (`window.aerio.directory`): entries, search requests/results, account state, cache freshness |
| `electron/directory/directory-backends.ts` | `GraphDirectoryBackend`, `GoogleDirectoryBackend`, `EwsDirectoryBackend`, and the permission/unavailable/service errors |
| `electron/exchange/ews-directory.ts` | Thin EWS helpers over `EwsClient.call()`: `resolveNames`, `expandDistributionList`, `getRoomLists`, `getRooms`, `findPeople` |
| `electron/directory/directory-store.ts` | `directory.sqlite`: entries, staging table, cache state, atomic commit/abort |
| `electron/directory/directory-service.ts` | Consent state, online lookup with offline fallback, ambiguity marking, refresh scheduling, grants |
| `electron/directory/directory-ipc.ts` | `directory:*` IPC with validation, app-lock enforcement, and the refresh timer |
| `src/components/RecipientDirectory.tsx`, `DirectoryPanel.tsx` | Composer sections, Contacts › Directory, and the scheduling assistant's room picker |

Tests (`electron/directory/directory.test.ts`, `src/components/RecipientDirectory.test.tsx`, `electron/preload-directory.test.ts`) use fake Graph and People API responses and the EWS fixture server (`electron/exchange/ews-fixture-server.ts`, which answers `ResolveNames`, `ExpandDL`, `GetRoomLists`, `GetRooms`, and `FindPeople`). They cover pagination, denied and missing permissions, ambiguous names, group and room addresses, group expansion, offline lookup, incremental caches, and an atomic refresh that fails midway.

The [live-provider matrix](live-provider-test-matrix.md#organization-directory-coverage) lists the Beta scenarios `DIR-01` to `DIR-04`. No live results have been recorded yet.
