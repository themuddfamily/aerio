# Offline download and synchronization scope

By default Aerio downloads every message of every connected account, with its
attachments, so the whole mailbox opens and searches offline. For large
mailboxes or small disks you can choose, per account and per folder, how much
is stored on this computer and how far back synchronization reaches.

Changing these settings never deletes or changes mail on the server. It only
decides what Aerio keeps locally.

Local Folders and POP3 accounts keep all of their mail on this computer, so
they have no scope to configure and are never trimmed. On-premises Exchange
(EWS) accounts always download full offline content; their sync does not
support a scope yet, and the settings say so.

## Settings

### Account defaults

Open the account's settings (right-click the account › **Account settings…**)
and find **Offline download and sync scope**.

| Setting | Choices |
| --- | --- |
| Download | **Full offline content**: the original message (raw MIME) and every attachment. **Messages without attachments**: headers plus the text/HTML body; attachments download when you open or save them. **Headers only**: sender, recipients, subject, date and snippet; the body downloads when you open the message. |
| Synchronize | **All mail**, **Recent days** (1–3650), or **Recent months** (1–120). Mail received before the window is not downloaded. |

**Apply offline settings** saves the defaults, queues anything that is now
wanted but missing, frees anything that is no longer wanted, and starts a sync.
**Free space outside the scope** runs only the freeing step.

The section also reports what is available offline for the account: cached
messages with their full original, with only their body, with only headers,
how many cached messages are older than the window, and roughly how much disk
space they use. It says whether search covers the whole mailbox and why not.

### Folder overrides

Right-click a folder or label (or one of Inbox, Sent, Drafts, Spam and Trash
while a single account is selected) and choose **Offline settings…**. A folder
can override the download mode, the date window, or both; anything not
overridden follows the account default. **Use account default** removes the
override. Account settings list every override with a **Use default** button.

Inbox, Sent, Drafts, Spam and Trash overrides follow the folder's role, so an
Inbox override applies to Gmail's `INBOX` label, an IMAP server's INBOX and
Microsoft's Inbox alike.

### Load more and Load all

When the folder you are viewing is limited by a date window, the end of the
message list says from which date mail is synchronized and offers:

- **Load more** widens that folder's window by one more window length (30 days
  becomes 60, then 90…). The widening is kept until you change the folder's
  settings.
- **Load all** synchronizes all of that folder's mail for the next 24 hours.
  When the period ends, mail outside the normal window gives its bodies back
  again (see *Freeing space*).

In **All mail** and the other combined mailboxes the extension applies to the
whole account.

## Messages in several places

Gmail labels and IMAP copies put one message in several places. Each place has
its own policy; the message keeps the most complete content any of them asks
for. A message in Inbox (headers only, last 30 days) that also carries a label
set to full offline content is kept in full, and every IMAP copy of a message
(same Message-ID) keeps its content while any copy's folder wants it. A message
is outside the scope only when every place it is in excludes it.

## How each provider downloads

| | Full offline content | Without attachments | Headers only | Date window | Server search |
| --- | --- | --- | --- | --- | --- |
| Gmail | `messages.get?format=raw` | `format=full` (attachments stay references) | `format=metadata` | `messages.list?q=after:<epoch>`; widening lists `before:` the old start | `messages.list?q=` |
| Microsoft 365 | `/messages/{id}/$value` (MIME) | `$select` header fields plus `body`, and the attachment list without content | `$select` header fields | delta with `$filter=receivedDateTime ge …`; widening starts a new delta | `/me/messages?$search=` |
| IMAP | `FETCH BODY[]` | `FETCH BODYSTRUCTURE`, header fields, then only the text parts | `FETCH BODYSTRUCTURE` and header fields | `UID SEARCH SINCE` per folder (all UIDs are still listed, so deletions are seen) | `UID SEARCH TEXT` in each folder |

When folders of one account use different policies, Aerio first reads a
message's labels and date (one small request) and then downloads exactly what
its places ask for. When the whole account uses one mode with no window, it
downloads in that mode directly, as before.

New mail that arrives inside the window is downloaded in the chosen mode by the
regular incremental sync. Label and flag changes on cached messages only update
the labels; nothing is downloaded again.

## Opening mail that is not downloaded

- Opening a **header-only** message downloads its original while online and
  shows it as usual. Offline it shows **Not downloaded — connect to load**; if
  the download fails, the provider's error is shown instead.
- Opening or saving an **attachment** of a message stored without attachments
  downloads the original first. Viewing the source, exporting the message and
  forwarding its attachments do the same.
- What was downloaded on demand stays until the next time the scope narrows or
  the daily trim runs.

## Freeing space

When a scope narrows (a smaller window, a lighter mode, a removed override, a
**Load all** period ending, or a recent-days window moving forward one day),
Aerio reclaims what is no longer wanted:

- a message wanted *without attachments* loses its original file but keeps its
  text and attachment list;
- a message outside every window, or wanted as *headers only*, loses its
  original and its body text, but keeps its header row so the list stays
  complete and the message can still be opened (and downloaded) later.

Never trimmed: provider drafts, conversations with changes waiting in the
offline queue (moves, flags, labels not yet sent), mail in Local Folders and
POP3 accounts, and any copy another place still wants. Trimming never deletes
a message row or anything on the server. Moving forward of a recent-days window
is checked at most once a day per account, after a sync.

Interrupted downloads cannot leave a damaged original: each original is written
to a temporary file and moved into place only after it has been read back
successfully, and the message stays queued until it is stored. Temporary files
left by a crash are removed at the next start, and the download resumes from
the queue.

## Search

Search runs on this computer. It sees subjects, senders and recipients of every
cached message, bodies of messages stored with their body, and attachment text
of messages stored in full.

When a search is active and some of the searched accounts are not fully
downloaded, the search bar shows **Search covers downloaded mail only**, with
the reasons in its tooltip (mail outside the window, messages with only
headers, attachments not downloaded, a mailbox still downloading). For Gmail,
Microsoft 365 and IMAP accounts it offers **Search server**, which runs the
same words on the provider across the whole mailbox (up to 250 matches per
account), adds matches that were not cached as header rows, and lists the
matching conversations; **Show downloaded results** returns to the local search.
Archived accounts can't be searched on the server and say so.

## Tradeoffs

| | Disk | Network | Offline | Search |
| --- | --- | --- | --- | --- |
| Full offline content, all mail | Largest: every original and attachment | Downloads everything once, then only changes | Everything opens offline | Whole mailbox, including attachment text |
| Without attachments | Usually much smaller; attachments are often most of a mailbox | Bodies once; each attachment when opened | Text opens offline; attachments need a connection | Bodies and attachment names, not attachment text |
| Headers only | Smallest: one row per message | A small request per message; each body on open | Lists and headers offline; bodies need a connection | Subjects and people only; use Search server for the rest |
| Date window | Mail before the window is not stored (earlier cached rows remain as headers) | Inventory is limited to the window; Load more/Load all fetch older mail on request | Older mail needs a connection | Older mail only through Search server |

Mixed policies cost one extra small request per new message so each message's
places can be checked; uniform policies don't.

## Backups

Policies and folder overrides are stored in the mail database (`aerio.sqlite`)
and are included in profile backups; the backup preview counts them as
**Offline download policies**. What is cached is rebuilt by sync after a
restore.

## Limitations

- Gmail header-only messages do not list their attachments until opened
  (Gmail's metadata format has no MIME structure).
- Microsoft header-only messages fetched by a search may not know their
  folder's special role until the next sync.
- A Microsoft delta started with a window keeps that filter until the window
  widens, so mail moved into a folder from before the window is not listed by
  that delta.
- [Automatic archiving](automatic-archiving.md) and **Copy to Local Folders**
  need the original on this computer. A message stored without it is reported
  as not stored offline and its server copy is kept; open it once (or use full
  offline content for that folder) before archiving.
