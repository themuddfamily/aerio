# Server-synchronized Notes and vNote import

Notes can live on this computer (**Local**) or in a notes folder on a server: a
CalDAV collection that stores journal entries (VJOURNAL), or an Exchange Notes
folder. Each note belongs to exactly one owner. Server notes synchronize in
both directions, keep working offline, and never overwrite a newer server
version without asking you. Notes never move between owners on their own;
copying and moving are always explicit. Notes can also be imported from vNote
(`.vnt`) files.

Local Notes, the [rich editor](rich-notes.md), and the local-data backup work
exactly as before.

## Supported servers

| Provider | Where notes come from | Discovery | Revisions |
| --- | --- | --- | --- |
| CalDAV (iCloud, Fastmail, Nextcloud, and other servers added in **Settings › Calendar and contacts accounts**) | Collections in the calendar home whose `supported-calendar-component-set` includes `VJOURNAL`: journal-only collections and mixed collections | `PROPFIND` on the calendar home, like [CalDAV discovery](caldav-carddav.md#discovery) | `sync-collection` (RFC 6578) or ctag + ETag comparison, through the existing DAV engine |
| On-premises Exchange (EWS, [Exchange accounts](exchange-ews.md)) | The `notes` distinguished folder, plus any other folder whose class starts with `IPF.StickyNote` | `GetFolder` and `FindFolder` (Deep) | `SyncFolderItems` with the folder's `SyncState`, `ChangeKey` per item |

- A collection that doesn't declare `supported-calendar-component-set` is
  treated as a calendar, so ordinary calendars never show up in Notes.
- In a **mixed** collection (events or tasks plus journal entries), only
  `VJOURNAL` objects become notes. Events and tasks stay with Calendar and
  Tasks. Notes remembers their ETags so it doesn't download them again, and it
  never edits them.
- Microsoft 365, Gmail, and IMAP accounts don't have server notes. Their notes
  are Local notes.
- The behavior of real servers hasn't been verified against live accounts yet.
  The fixtures follow RFC 5545, RFC 4791, RFC 6578, and Microsoft's EWS
  documentation.

## Owners in the sidebar

The Notes sidebar shows **Library** (All notes, Pinned, and Archive across
every owner), **Local** (your local folders), and one group per account that
has notes folders, with each folder's note count and a **Synchronize** button.
A cloud mark on a note card shows its state: synchronized, waiting to send, or
needing review. The editor toolbar shows the owner (for example
`Fastmail › Journal`) and the sync state.

- **Read-only folders** are detected from the DAV privilege set
  (`current-user-privilege-set` without `write`/`write-content`/`all`, or a
  subscribed collection) and from EWS `EffectiveRights` (`CreateContents` or
  `Modify` false). Their notes open read-only. You can still pin, color,
  archive, and copy them.
- **Local-only fields:** color, pinning, and archive aren't part of VJOURNAL or
  Exchange sticky notes in a portable way, so they're kept on this computer for
  server notes and never sent. The Exchange note color (`PidLidNoteColor`) is
  left exactly as it is on the server.

## Field mapping

| Aerio | CalDAV VJOURNAL | Exchange sticky note (`IPM.StickyNote`) |
| --- | --- | --- |
| Title | `SUMMARY`. If it's missing, the first line of the text is shown. | `Subject` |
| Plain text (`content`) | `DESCRIPTION`. Several are joined with a blank line. | `Body` with `BodyType="Text"` |
| Rich body (`html`) | `X-ALT-DESC;FMTTYPE=text/html` | `Body` with `BodyType="HTML"` |
| Tags | `CATEGORIES` | `Categories` |
| Attachments | Inline binary `ATTACH;VALUE=BINARY;ENCODING=BASE64` with `FMTTYPE` and `X-FILENAME` | `FileAttachment` (`GetAttachment`, `CreateAttachment`, `DeleteAttachment`) |
| Inline pictures | Binary `ATTACH` with `X-AERIO-ATTACHMENT-ID` and `X-AERIO-INLINE=TRUE`, referenced from the HTML as `cid:<id>` | `FileAttachment` with `ContentId=<id>` and `IsInline`, referenced as `cid:<id>` |
| Created / modified | `CREATED`, `LAST-MODIFIED` (or `DTSTAMP`) | `DateTimeCreated`, `LastModifiedTime` |
| vNote `CLASS` | `CLASS` | `Sensitivity` |

- Rich bodies from a server go through the same sanitizer as
  [rich notes](rich-notes.md#sanitization-in-both-processes). Scripts, styles,
  event handlers, remote pictures, and anything outside the allowlist are
  removed. `cid:` pictures become managed inline attachments, and `content` is
  recomputed from the sanitized HTML.
- If another client edited only the plain `DESCRIPTION` and left an older
  `X-ALT-DESC` behind, the plain text wins and the stale HTML is ignored.
- `ATTACH` by URI (a link to a file elsewhere) isn't downloaded. It's kept on
  the server copy untouched but isn't listed in Aerio.
- Inline pictures must be PNG, JPEG, GIF, WebP, or BMP (checked from the file's
  bytes). Anything else is listed as an ordinary attachment.
- Up to 15 MB of attachments per note are uploaded, because both protocols
  carry them inline in the request. A note with more stays in review with an
  explanation.

## Unknown server properties are preserved

- **CalDAV:** Aerio keeps the server's raw iCalendar text. An edit rewrites only
  the properties you changed (`SUMMARY`; `DESCRIPTION` with `X-ALT-DESC`;
  `CATEGORIES`; binary `ATTACH`) plus `LAST-MODIFIED` and `DTSTAMP`. Every
  other line is sent back byte for byte, including `X-` properties, `COLOR`,
  URI attachments, alarms, time zones, and other components.
- **Exchange:** `UpdateItem` sets or deletes only the changed fields
  (`item:Subject`, `item:Body`, `item:Categories`) and adds or removes only the
  changed attachments. Extended properties, such as the note color and window
  position Outlook stores, are never sent, so they stay as they are.

## Synchronization, offline changes, and restart

- Accounts synchronize 35 seconds after start, every 15 minutes, and on
  **Synchronize**. Queued changes are retried every minute and about two
  seconds after you stop typing.
- Every change is first saved in `server-notes.sqlite` and shown at once. It's
  then sent conditionally: CalDAV `PUT` with `If-Match` (and
  `If-None-Match: *` for new notes), and EWS with the cached `ChangeKey` and
  `ConflictResolution="NeverOverwrite"`. EWS deletes compare the `ChangeKey`
  first.
- Offline, timeouts, HTTP 5xx/429, and transient EWS codes keep the change
  queued, in order, with back-off from 30 seconds up to 30 minutes. The queue
  survives a restart.
- A new CalDAV note gets its address (`<uuid>.ics`) before the first attempt,
  so a retry after an unconfirmed attempt can never create a second copy.
- Several edits to one note before it's sent are combined into one write. A
  new note that's deleted before it was sent never reaches the server.

## Conflicts

A change the server refuses is never overwritten silently. Aerio reads the
server's current copy and lists the change under **Notes to review** in the
sidebar. Further edits to that note are blocked until you choose:

| Choice | Effect |
| --- | --- |
| **Keep mine** | Sends your version again against the server's current revision, still conditionally, so a newer change made meanwhile comes back to review. For CalDAV, your edits are applied on top of the server's new text, so properties the other client added are kept. If the note was deleted on the server, it's created again. |
| **Keep server** | Discards your change and shows the server version. |
| **Keep both** | Keeps the server version and saves yours as a new note titled "… (my copy)" in the same folder. |
| **Save mine to Local** | Discards the server-side change and saves your version as a Local note. This is the way out when the folder became read-only or was removed. |

Refused writes that aren't conflicts, such as a 403 on a folder that became
read-only, appear in the same list with **Send again** and **Discard my
change**.

## Copy and move between owners

Use **Copy to…** or **Move to…** in a note's context menu, or the move button
in the editor toolbar. Targets are Local folders and writable server folders
of any account.

- Pictures and attachments are copied with the note. Every owner gets its own
  copy of the files, so deleting a note in one place never removes another
  owner's files.
- **Move** creates the new copy first. The source is deleted only after the
  copy exists:
  - **Into a server folder:** after the server accepts the copy. If it can't be
    sent yet (for example, offline), the original is kept and Aerio says so.
    Moves between two server folders finish on their own once the copy is
    accepted.
  - **Into Local:** after the Local copy has been saved.
- A note in a read-only folder can be copied but not moved.

## Migration

Nothing moves automatically. Existing Local notes stay Local, and server notes
appear in their account's group after the first synchronization. To start
using a server folder, move notes there with **Move to…**. To stop using one,
move them to Local.

## vNote import

**Import vNote…** in the Notes sidebar reads `.vnt` files (vNote 1.1, as
exported by eM Client, Nokia/Sony phones, and IrMC tools) into a Local folder
or a writable server folder.

- A file may hold many `BEGIN:VNOTE … END:VNOTE` records. `BODY` can be
  plain, `QUOTED-PRINTABLE` (with soft line breaks), or `BASE64`, in any
  `CHARSET` the platform decodes (UTF-8, ISO-8859-x, Windows-125x, …).
  Undeclared non-UTF-8 text is read as Windows-1252.
- The title is `SUMMARY` when present, otherwise the first line of the body.
  `CATEGORIES` become tags, and `DCREATED` and `LAST-MODIFIED` set the dates.
  For server folders, `CLASS` maps to VJOURNAL `CLASS` or Exchange
  `Sensitivity`, and other `X-` properties are kept on the CalDAV journal
  entry. Local notes and Exchange have no place for `X-` properties, so
  they're dropped there.
- **Preview** shows the number of notes, each title and excerpt, records that
  can't be read (no `BODY`, unknown charset, unsupported version, missing
  `END:VNOTE`), and duplicates in the chosen folder. Changing the folder
  updates the duplicate check.
- **Duplicates** are notes with the same `X-IRMC-LUID` previously imported
  into that folder, or the same title and text. You can **skip** them,
  **replace** the existing notes' title and text, or **import copies**.
- Files up to 20 MB and 10,000 notes are accepted. Each note's text is limited
  to 1 MB.

## Account removal

Removing a CalDAV account (Settings › Calendar and contacts accounts) or
disconnecting an Exchange account removes its cached notes from Aerio. Nothing
is deleted on the server. If the account has notes, Aerio first says how many
and how many changes haven't been accepted by the server yet, and offers to
copy every note into Local Notes first. Copies include your unsent changes,
and they go into a Local folder named after the server folder and account. If
the copy fails, the account isn't removed.

## Backups

- **Full-profile backup** ([profile backup](profile-backup.md)) includes
  `server-notes.sqlite`: folders with sync states, the note cache (raw VJOURNAL
  text, ETags, and ChangeKeys), local color/pin/archive state, pending writes,
  and vNote import identities. Server note files are in `note-attachments/`,
  which is already backed up. On restore, accounts wait for sign-in, and queued
  note writes are **held** in review so an old change is never resent
  silently. Paths are rebased when restoring into another profile folder.
- **Local-data backup** (Settings › export/restore local data) remains the
  exact Aerio restore path for **Local** notes only. Server notes live on
  their server and come back by synchronizing. To include server notes in a
  local-data backup, copy them to Local first.

## For developers

| Module | Role |
| --- | --- |
| `src/server-notes-types.ts` | Contracts and `window.aerio.serverNotes` |
| `electron/productivity/server-notes-service.ts` | Cache projection, durable queue, conflicts, files, transfers, vNote import |
| `electron/productivity/server-notes-store.ts` | `server-notes.sqlite` and the profile-restore preparation |
| `electron/productivity/server-notes-adapter.ts` | Provider interface, typed errors, body normalization |
| `electron/productivity/dav-notes.ts` | VJOURNAL discovery, parsing, raw-text patching, and the CalDAV adapter |
| `electron/exchange/exchange-notes.ts` | The EWS sticky-note adapter |
| `electron/productivity/server-notes-ipc.ts`, `server-notes-setup.ts` | Validated IPC (refused while app-locked), timers, and wiring |
| `src/lib/vnote.ts` | vNote 1.1 parser |
| `src/lib/use-server-notes.ts`, `src/components/ServerNotesDialogs.tsx` | Renderer state and dialogs |

Tests: `vnote.test.ts`, `dav-notes.test.ts`, `server-notes-service.test.ts`
(CalDAV fixture: discovery, mixed routing, revisions/deletions, patching,
restart recovery, conflicts, attachments, transfers, vNote duplicates, account
removal, restore holds), `exchange-notes.test.ts` (EWS fixture: discovery,
SyncState, field-only updates with extended properties kept, attachments,
conflicts across a restart), `server-notes-store.test.ts`,
`server-notes-ipc.test.ts`, `preload-server-notes.test.ts`, and
`NotesServerNotes.test.tsx`.

## Limitations

- VJOURNAL recurrence and per-occurrence overrides aren't edited. Notes shows
  the first journal entry of a calendar object and keeps the rest unchanged.
- Server→Local moves wait for the Local copy to be saved while Aerio is
  running. If Aerio quits first, the server original simply stays, and nothing
  is lost.
- Two clients editing the same note aren't merged field by field. You choose a
  version in review.
- Exchange Notes folders of other mailboxes (delegates, public folders) aren't
  included.
