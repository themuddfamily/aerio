# Duplicate cleanup

Settings › **Duplicate cleanup** › **Find duplicates…** scans the places you choose for duplicate mail, calendar events, and tasks. It only suggests groups. Nothing is removed until you review a group, choose the copy to keep, and select **Remove selected**. Every removal can be undone.

This complements the duplicate checks that already run elsewhere: mail import reviews duplicates before they reach Local Folders ([mail-import-local-folders.md](mail-import-local-folders.md)), IMAP shows one logical message once however many folders hold it, calendar import detects existing events, and Contacts has its own merge ([contact-merge.md](contact-merge.md)).

## Choosing what to scan

| Module | Scope | Notes |
| --- | --- | --- |
| Mail | One or more accounts (all folders) or specific folders and labels | A folder or label scope includes a message when it has one of the chosen labels. Trash, Spam, and Drafts are never scanned. |
| Calendar | One or more calendars | Google, Microsoft, CalDAV, and local calendars on this PC. |
| Tasks | One or more task lists | Google Tasks and Microsoft To Do lists, and local task lists on this PC. |

Read-only owners are shown but cannot be chosen, with the reason next to them, and are listed under **Not scanned** if they are requested anyway:

- archived mail accounts (reconnect the account to clean up its mail);
- calendars without write access (reconnect the account) and read-only CalDAV calendars;
- subscribed internet calendars;
- task accounts without Tasks write access, and lists that are read-only or have an unresolved list change.

## Matching criteria

Copies are only ever compared inside one place: one mail location, one calendar, or one task list. A group lists its reasons and a confidence.

### Mail

A mail *location* is a Gmail account as a whole, or one IMAP, Microsoft, or Local Folders folder.

| Reason | Rule | Confidence |
| --- | --- | --- |
| Same Message-ID | The normalized `Message-ID` header (case and angle brackets ignored) is the same in one location. | High when the content is also identical, otherwise medium with a note to compare the copies. |
| Identical content | The SHA-256 of the normalized raw message is the same. Normalization unfolds headers, collapses header whitespace, uses LF line endings, trims trailing spaces and blank lines, and leaves out headers added in transit or by a mail store (`Received`, `Return-Path`, `Delivered-To`, `X-Received`, `ARC-*`, `Authentication-Results`, `Received-SPF`, `X-Gm-*`, `X-Google-*`, `X-MS-Exchange-*`, `X-Apple-*`, `Status`, `X-UID`, `X-Mozilla-*`, and similar). | High |
| Same sender, subject, size, and time | Same sender address, subject (ignoring `Re:`/`Fwd:` prefixes), and size, with dates no more than 2 seconds apart, but a different or missing Message-ID. | Low, with a note |

What is never a duplicate:

- **Gmail labels.** A Gmail message with several labels is one record and appears under each label as a view. It is never compared with itself.
- **One message in several IMAP folders.** The same Message-ID in Inbox and Archive is one logical message stored in two places. Copies are only grouped when they are in the *same* folder.
- **Different attachments.** Attachments are hashed (SHA-256 of each decoded attachment); copies whose attachment sets differ are kept apart even when every header matches. When a copy has not been downloaded yet, attachments are compared by name, type, and size, and the group says so.
- Messages in different accounts, and messages in Trash, Spam, or Drafts.

Content is read only for messages that already share a Message-ID or a sender and subject in one location, so a scan stays fast on large mailboxes.

### Calendar events

| Reason | Rule |
| --- | --- |
| Same calendar UID and occurrence | Same iCalendar UID and the same `RECURRENCE-ID` (or original start) in one calendar. |
| Same details | Same title, start, end, location, and all-day flag (title and location ignore case and spacing; times are compared as instants). |

Both reasons together are high confidence; one alone is medium, and a group with a shared UID but different details carries a note.

Repeating events are compared as a whole **series**: the master with all its exceptions, or, for Google and Microsoft calendars that list a series as its instances, every instance. Two series match only when every occurrence matches. An exception is part of its series, so it is never offered as a duplicate of its own master, and a single event is never matched with one occurrence of a series.

### Tasks

Tasks match when they have the same title, due date, and notes (title and notes ignore case and spacing) in the same list **and** under the same parent. Subtasks are part of the comparison: a task with subtasks only matches a task with the same subtasks, and two subtasks are only compared when they have the same parent. Completion is shown in the comparison but does not prevent a match. Local tasks compare their checklist items the same way.

## Reviewing a group

Groups are listed on the left. The selected group shows its reasons, notes, and a side-by-side comparison; rows that differ are highlighted. For each group you can:

- choose **Keep** for the copy to keep. The suggestion is a copy that cannot be removed, otherwise the most complete copy (downloaded content, attachments, labels, notes, attendees, due dates), then the oldest;
- clear **Remove** for any copy you want to keep as well, or **Keep all**;
- **Skip group** to leave it out of this review;
- **Not duplicates** to remember that these copies are different. The decision is saved, and a group whose copies are all covered by it is not suggested again (a later, additional copy makes a new group). The scan summary counts groups hidden this way.

**Remove selected** removes the selected copies of every group that is not skipped.

## What removal does

Removal re-checks every copy, and the copy you keep, against the current data first. A copy that changed since the scan (a different mail sync revision or Trash state, an edited event, a task with new fields, provider revision, or subtasks) or that is gone is **skipped and reported** rather than removed. If the kept copy changed or is gone, nothing in that group is removed. Scan again to review the new state. Results are reported per copy: removed, skipped because it changed, kept because it cannot be removed, or failed with the provider's error. Other copies are still processed when one fails.

| Owner | Removal | Supported |
| --- | --- | --- |
| Gmail | Moves each duplicate *message* to Trash through the queued mail operation pipeline (`messages/{id}/trash`), so the kept copy in the same conversation stays put. | Yes |
| Microsoft 365 / Outlook.com, IMAP | Queued move to Deleted Items or Trash for the duplicate message only. | Yes |
| Local Folders | Moves the message to Trash in the local store. | Yes |
| Google and Microsoft calendars, CalDAV | Deletes the single event through the same calendar write path as the event editor (CalDAV deletes use the server ETag). | Single events. Repeating series are listed for review only, because undo could not recreate their exceptions; delete the extra series from the calendar. |
| Local calendars on this PC | Deletes the event, or every event of a series. | Yes, including series |
| Google Tasks, Microsoft To Do | Queues deletes through the task queue: subtasks first (deepest first), then the task. | Yes; read-only and assigned tasks are kept |
| Local tasks on this PC | Removes the task with its checklist. | Yes |

Read-only events (for example invitations organized by someone else) and assigned or read-only tasks stay in their group as copies that cannot be removed, with the reason shown.

## Recovery

Every removal is written to a local journal before anything else happens (the 100 most recent cleanups are kept). **Recent cleanups** in the same window lists them with **Undo**:

- **Mail** uses the existing mail undo: before the queued Trash move is sent (about 10 seconds) it is cancelled and the labels are restored; after that a matching message-level untrash is queued. If the provider can no longer find the message under its old id (IMAP and Microsoft give a moved message a new id once the next sync sees it in Trash), undo reports this and the messages can be restored from Trash as usual.
- **Calendar events** are recreated from the journal. Local events come back exactly. Provider and CalDAV events are created again with the same details, so they get a new id; online meeting links are not recreated.
- **Provider tasks** are restored with the task queue's undo, parents before subtasks. When the queue can no longer undo a delete, the task is created again from the journal, and its subtasks are recreated under it.
- **Local tasks** are put back in their original position.

Undo is reported per copy, and anything that could not be restored is listed as a warning on the cleanup. A partial removal (for example a subtask removed before its parent's delete failed) is journaled too, so it can be undone.

The journal and the "Not duplicates" decisions are stored in `productivity.sqlite` and are included in profile backups.
