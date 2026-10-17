# Automatic archiving into Local Folders

Automatic archiving moves old mail out of a connected account and into
[Local Folders](mail-import-local-folders.md) on a schedule. It is off until
you turn it on for an account, and each account has its own policy.

Archiving is different from the **Archive** button. **Archive** moves a
conversation to the provider's Archive folder (or removes Gmail's Inbox
label); the mail stays on the server. Automatic archiving copies messages to
this computer and then **removes them from the server**.

## Setting up a policy

Open the account's settings (right-click the account › **Account settings…**)
and find **Automatic archiving**.

| Setting | Choices |
| --- | --- |
| Archive automatically | Off by default. When on, a run starts on the schedule below. |
| Age | Messages *received* more than N days or N months ago. The received date is the server's arrival time (Gmail `internalDate`, Microsoft `receivedDateTime`, IMAP `INTERNALDATE`), not the Date header. Months are calendar months; 31 March minus one month is the last day of February. |
| How often | Every day, week, or month. |
| What to archive | The whole account, or only selected folders/labels. |
| Always keep on the server | Starred or flagged messages, unread messages, conversations pinned in Aerio, drafts, sent mail (each optional), and any folders you list. Messages in Trash or Spam are never archived. |
| Local Folders destination | A folder in Local Folders. **Create “Archive” folder** makes one if Local Folders is empty. |
| Subfolders | Optionally one folder for the account address, one per received year, and the message's original folder path, in that order, for example `Archive/me@example.com/2024/Projects/Clients`. Folders are created as needed and reused by later runs. |
| After the local copy is verified | **Move the server copy to Trash** (default) or **Delete the server copy permanently**. |

**Preview** lists how many messages would move right now, their total size,
the cutoff date, how many older messages are kept by each exclusion, and the
oldest 50 messages with their destination folder. Nothing is changed.

**Save archive policy** stores the settings. Turning the policy on for the
first time schedules a run immediately (within a minute); after that, runs
follow the chosen frequency from the last run. **Run now** starts a run with
the saved policy whether or not it is turned on.

## What a run does

Selection is per message, not per conversation: only messages older than the
cutoff move, so a conversation with recent replies keeps them on the server and
in the account's views. A pinned conversation is kept whole when pinned
conversations are excluded.

For every selected message, in received-date order:

1. **Copy.** The original MIME source stored offline is written byte for byte
   into the destination folder, with its attachments, received date, and read
   and starred state. Conversations are regrouped from their headers inside
   Local Folders.
2. **Verify.** The copy is read back from disk; its size and SHA-256 must match
   the original, and it must have at least as many attachments. A copy that
   does not verify is removed again and the message is reported as failed; its
   server copy is never touched.
3. **Remove from the server.** Verified copies are queued in groups of up to
   50 in Aerio's normal provider operation queue as a *message-level* removal:
   - Gmail: `messages.trash` for each message (never `threads.trash`).
   - Microsoft 365: a move of each message to Deleted Items, or
     `permanentDelete`.
   - IMAP: a UID `MOVE` to the server's Trash folder, or `\Deleted` and
     expunge of those UIDs.
   Removals retry with back-off like other queued changes. If the provider
   keeps refusing, the message's previous state is restored, it is reported as
   failed with the provider's reason, and the server copy stays (the Local
   Folders copy is also kept).
4. **Done.** The message now lives only in Local Folders (and, with **Move to
   Trash**, in the provider's Trash until it is emptied). After a permanent
   deletion, Aerio also drops its cached copy of the server message.

A message is re-checked just before it is copied. If it has meanwhile been
starred, marked unread, pinned, moved to a kept folder, Trash, or Spam, or
deleted, it is skipped.

Gmail permanent deletion needs full mailbox access (`https://mail.google.com/`),
which Aerio does not request, so Gmail policies always move to Trash; Gmail
empties Trash after 30 days.

## Progress, history, and failures

The section shows the last run, its outcome, and the next run. Each of the last
ten runs lists how many messages were archived, failed, skipped, or are still
in progress; **Details** shows every message with its state and the reason for
any failure or skip.

- **Full disk.** Before writing each copy Aerio checks that at least 64 MB
  would remain free on the disk holding the mail store; a write that fails with
  "no space left" (or a full mail database) has the same effect. The run is
  **paused** with an explanation, no server copies are removed for messages
  that were not copied, and the message being copied stays pending. Free some
  space and choose **Resume**; a paused run also retries automatically when the
  policy is next due.
- **Cancel** stops a run. Messages whose server removal was already queued
  finish normally; every other message keeps its server copy (a copy already
  verified in Local Folders stays there).
- A run that cannot start (for example, the destination folder was deleted or
  the account was disconnected) is recorded as failed with the reason, and the
  scheduler tries again at the next period.

## Restarts and duplicate-free resume

Every run is stored in the mail database as a job with one item per message,
moving through *pending → copied → server removal queued → done* (or *failed* /
*skipped*). A run interrupted by a crash, quitting Aerio, or a restart continues
on the next launch:

- A copy's Local Folders id is derived from the account, the source message id,
  the destination folder, and the SHA-256 of its content. A message whose copy
  was written just before the interruption is found, re-verified, and adopted
  instead of being copied again; an identical message already in the destination
  folder counts as archived too.
- A verified copy whose removal was not yet queued is queued exactly once; the
  item state and the queued operation are written in one transaction.
- A message is never added to two unfinished runs. If a server removal failed,
  the next run picks the message up again and reuses its existing Local Folders
  copy.

## When runs happen

Automatic archiving runs inside Aerio's background mail process, so it only
runs **while Aerio, or its tray/background process, is running**. Nothing runs
on a server and nothing happens while Aerio is fully closed. Aerio checks the
schedule when it starts and every minute while it runs: a run that became due
while Aerio was closed starts once on the next launch (missed runs are not
repeated), and messages that crossed the age cutoff in the meantime are picked
up even if no new mail arrived. Server removals need a connection and wait in
the operation queue while Aerio is offline.

## Local-only access and backups

Archived messages are no longer on the server, so they no longer appear in
webmail, phone apps, or other computers, and provider search no longer finds
them. In Aerio they are in **Local Folders**, where they can be read, searched,
replied to, forwarded, moved, and exported, offline.

Because Local Folders exist only on this computer, **back them up**. Aerio's
[profile backup](profile-backup.md) includes the mail database and the stored
original messages, so Local Folders, archive policies, and archive history are
all part of it. Without a backup, a disk failure or deleting Aerio's data loses
archived mail permanently. Restoring a profile backup pauses any run that was in
progress; choose **Resume** after reconnecting the account.

Disconnecting an account (keeping its local archive) or removing it stops its
policy; removing an account deletes its policy and history but never the mail
already in Local Folders.
