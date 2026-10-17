# Mail import and Local Folders

**Local Folders** is a pseudo-account (provider id `local`, account id `local-folders`) whose folders exist only in Aerio's local mail store. It has no server, no credentials and no synchronization. It holds imported mail archives and messages copied out of other accounts, including disconnected-account archives. It appears in the account list and gets its own **Local Folders** folder tree in the Mail sidebar. Create it from **Import mail** in the sidebar footer, or let the first import create it.

## Folders and messages

- Folders can be created, renamed, nested, moved and deleted through **Folders & labels**. The folder manager does this without a network connection, and nothing is ever sent to a server. Folder ids (`folder:local-<uuid>`) never change, so renaming or moving a folder only rewrites stored display paths (`Parent/Child`). Names may not contain `/`; nesting uses the parent setting.
- Deleting a non-empty folder needs the same confirmation as provider folders. Its messages go to Trash rather than being destroyed, and the folder must have no subfolders and no pending changes.
- Read/unread, star, move between Local Folders, Trash/restore and Quick Action steps use the normal local operation pipeline, with the usual Undo window. When the window passes, the queued change is marked done without a provider request, offline included.
- Local Folders can't send mail. Compose, reply and forward only offer server accounts, Local Folders messages never send or prompt for read receipts, and **Check for mail**/**Rebuild** do nothing for this account.
- **Copy/Move to Local Folders**: select conversations in another account and choose **Local Folders** in the selection toolbar. Aerio copies the original downloaded MIME source byte for byte, keeping headers, date, attachments, and read and starred state. Copying the same message into the same folder twice is skipped. **Move** copies first, then queues the source account's normal undoable Trash action, and only when every message in the selection was downloaded and copied. Offline archives can be copied but not moved. Copying within Local Folders uses **Copy to…** in the message tools.
- **Remove Local Folders…** in the account's context menu permanently deletes the account and every message stored in it.

## Importing

Open **Import mail** from the sidebar footer, the Local Folders sidebar group, or the account context menu.

- **Choose MBOX or EML files…** accepts `.mbox`/`.mbx`, extensionless mbox files and `.eml` files. **Choose a folder…** imports a whole directory tree.
- Folder hierarchy is retained under the chosen destination (the top level by default):
  - a chosen directory becomes a folder and its subdirectories become subfolders;
  - each mbox file becomes a folder named after the file, without its extension;
  - Thunderbird `Name.sbd/` directories nest their mailboxes under `Name`, and `.msf` index files are ignored;
  - Apple Mail `Name.mbox/mbox` exports become `Name`;
  - EML files land in the folder for their directory, and loose EML files go into **Imported messages**.

  An existing folder with the same name at the same level is reused, so re-running or resuming an import merges into the same folders. Inside a directory, extensionless files are imported only if they begin with an mbox `From ` line.
- **MBOX parsing** streams the file in 256 KB chunks and buffers one message at a time, never more than the per-message limit, so multi-gigabyte archives use bounded memory. A message starts at a `From ` line that follows a blank line (or the start of the file) and carries an envelope sender plus a date. Unquoted body lines such as "From the desk of…" therefore stay in their message. **mboxrd** (the default, used by Thunderbird, Apple Mail and Gmail Takeout) removes one `>` from every `>…>From ` line. **mboxo** only unquotes `>From `, which is inherently ambiguous for bodies that really began with `>From`. mboxcl/mboxcl2 `Content-Length` framing isn't interpreted. Such files are read with the From_ line rule, which is correct unless a body contains an unquoted `From ` line after a blank line.
- **Preserved data**: the original MIME source (after mbox unquoting) is stored unchanged as the message's `.eml`, so headers, multipart structure and attachments stay intact and attachments are indexed for the attachment workspace and search.
  - **Dates** come from the `Date` header, then the mbox envelope date, then the EML file's modification time.
  - **Flags** are read from `Status`/`X-Status` (R = read, F = flagged/starred, D = deleted) and from Thunderbird's `X-Mozilla-Status` (read, replied, marked, expunged). Messages Thunderbird marked expunged but hadn't compacted away yet are skipped, so deleted mail isn't brought back. Messages with no read information are imported as read, so an archive doesn't flood unread counts; an explicit unread flag is kept.
  - **Threads** are keyed by the first `References` entry, then `In-Reply-To`, then `Message-ID`.
- **Limits**: 64 MB per message (larger messages are listed as failed without being buffered), 50,000 files per import, and 24 directory levels. An import pauses itself with a message when less than 512 MB of disk space is free.
- **Duplicate review** (the default) checks every message against everything already in Local Folders. A message with an identical SHA-256 content hash is reported as an identical copy. One with the same `Message-ID` but different content is reported separately, as it may be an edited or re-sent copy. Duplicates are held, not imported. **Review** lists them with the existing message, and **Import selected** or **Discard selected** settles them. Importing a held duplicate re-reads it from the original file and refuses if the file changed since the scan. **Import everything** skips the check.
- **Outlook PST/OST and .msg files are not supported.** Choosing one shows an explicit explanation and nothing is imported from it; the rest of the selection still imports. To bring Outlook mail in, move it to an IMAP account in Outlook, or convert the PST to MBOX (for example with `readpst`) and import the MBOX files. Apple Mail `.emlx` files are also rejected; use Mailbox › Export Mailbox instead.

## Progress, cancellation and restart recovery

Imports run in the mail worker thread, off the UI and main threads, one job at a time, yielding between messages so mail stays responsive. Messages go through the same parse-and-store path as synchronized mail.

- The dialog shows each job's progress (bytes processed), current file, and the imported, duplicate, failed and skipped counts as they change.
- **Pause** stops after the current message and **Resume** continues from the saved position. **Cancel** ends the job; messages already imported stay in Local Folders.
- After every message, the job's cursor (source file index plus the byte offset of the next mbox message) is saved together with its counters. If Aerio quits or crashes during an import, the job is shown as **Interrupted** on the next start and continues from its cursor when resumed. Jobs that were still waiting in the queue start automatically.
- Message ids are derived from the job and the message's position in its source. A message stored just before a crash, but before the cursor moved, is therefore recognized when it is read again and not stored a second time.
- Failed and held items stay listed under **Details**/**Review** until the job is removed from the list.

## Existing export and archives

Single-message **Save as .eml** export and read-only disconnected-account archives are unchanged. Archived messages can additionally be copied into Local Folders, where they become writable.

## Storage and backup

Local Folders messages live in the normal mail store (`aerio.sqlite` and `mail/local-folders/`), alongside synchronized mail. Unlike provider mail, they **cannot be downloaded again**. The Settings local-data backup doesn't include mail, so keep the original archive files, or back up Aerio's application-data directory, if the imported mail matters.

## Implementation

| Area | Module |
| --- | --- |
| Streaming mbox reader, quoting, byte-range re-read | `electron/mail/mbox.ts` |
| Header/flag/date/thread metadata without full parsing | `electron/mail/import-headers.ts` |
| Source planning, job runner, duplicate review | `electron/mail/mail-import.ts` |
| Folder tree, fingerprints, jobs/items tables, local operation completion | `electron/mail/local-mail-store.ts` (`MailDatabase.localMail`) |
| Copy/move into Local Folders | `electron/mail/local-folders.ts` |
| Dialogs, approved-path checks and IPC validation | `electron/mail/mail-import-ipc.ts` |
| Renderer dialogs and sidebar tree | `src/components/MailLocalFolders.tsx` |

The new tables `local_mail_fingerprints`, `mail_import_jobs` and `mail_import_items` are created idempotently. Only paths returned by Aerio's own open dialog in the current session can be imported. Tests generate their MBOX/EML fixtures (`electron/mail/mail-import.fixtures.ts`), so no real mail is checked in.

### Verification boundaries

Unit and integration tests cover the mbox splitting and quoting rules across chunk sizes, CRLF input, resume offsets, oversized messages and non-mbox input. They also cover Thunderbird/Apple Mail/EML hierarchy planning, flag/date/attachment/MIME retention, duplicate review, pause/resume/cancel, crash replay, disk-space pause, folder management, local operations, copy/move, IPC validation and the renderer dialogs. The tests don't import real-world exports from Thunderbird, Apple Mail, Gmail Takeout or other clients, and real archives at multi-gigabyte scale are unverified. PST support is not implemented.
