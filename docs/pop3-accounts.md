# POP3 accounts

A POP3 account downloads mail from a POP3 server into Aerio and sends mail through the account's SMTP server. Choose **Set up a POP3 account** under **Other email providers** when adding a mail account.

POP3 is a download protocol, not a synchronization protocol. The server offers one flat list of messages (the "maildrop"). It has no folders, it doesn't record read or starred state, and it can't learn what you did with a message after Aerio downloaded it. Aerio downloads each message once, keeps it on this computer, and manages everything after that locally: folders, read state, flags, drafts, sent mail and Trash. Use IMAP instead when the provider offers it and you want the same mailbox on several devices.

## Setting up

- **Account:** email address, optional display name, username (usually the email address) and password.
- **Incoming mail (POP3):** server, port and security.
  - **TLS** connects with implicit TLS, usually on port 995.
  - **STARTTLS** connects on port 110 and upgrades the connection with `STLS` before signing in. If the server doesn't offer `STLS`, or sends anything before the TLS handshake, Aerio stops without sending the password.
  - **None** is unencrypted. You have to tick **Allow an unencrypted connection** before Aerio will connect this way, and both the UI and the main process check this. With no encryption, every downloaded message (and the password, unless APOP is used) can be read on the network.
  - Certificates are always verified against the operating system's trust store. Invalid certificates can't be allowed for POP3.
- **Sign-in:** **Automatic** picks `AUTH PLAIN` when the server advertises it in `CAPA` and the connection is encrypted, otherwise `USER`/`PASS`. On an unencrypted connection it prefers `APOP` when the greeting offers it, because APOP never sends the password itself. You can also choose `USER/PASS`, `APOP` or `AUTH PLAIN` explicitly; a method the server doesn't support is reported, never silently replaced.
- **Outgoing mail (SMTP):** server, port and TLS or STARTTLS. POP3 accounts use the same SMTP sender and Outbox as IMAP accounts (see below).
- **Store downloaded mail in:** the account's own folders, or an existing Local Folders folder (see [Destinations](#destinations)).
- **Messages on the server:** the retention policy (see [Retention](#retention-what-happens-on-the-server)).

**Test connection** signs in to POP3, checks that the server supports `UIDL`, signs in to SMTP and reports the encryption, sign-in method and message count. It saves nothing and downloads nothing. **Connect POP3 account** runs the same test first and only then saves the account. The password is kept in Aerio's encrypted credential vault (OS secure storage), the same way as IMAP passwords. The non-secret settings live in the mail database.

All of these settings, the password included, can be changed later in **Account settings › POP3 and SMTP**. Changed server settings or a new password are tested before they're saved. A retention or destination change is saved without connecting. The section also shows how many messages Aerio has downloaded, how many are still on the server, how many it has removed from the server, and the result of the last check.

An address that's already connected (as IMAP or POP3) can't be added a second time. Remove the existing account first.

## The download model

Each check (on the normal polling schedule, or from **Check for mail**) is one POP3 session:

1. Connect, negotiate TLS, and sign in.
2. List the maildrop with `UIDL` (the server's unique id for each message) and `LIST` (sizes). A server without `UIDL` is refused: Aerio can't tell messages apart reliably without it.
3. Download, with `RETR`, every message whose UIDL Aerio hasn't recorded, oldest first.
4. Apply the retention policy (`DELE`), then `QUIT`.

**Exactly once.** Aerio keeps a durable checkpoint, the `pop3_uidls` table in the mail database: one row per UIDL with the message it became, when it was downloaded, and its server state (`stored`, `delete-pending`, `deleted`, or `skipped`). The message (its raw `.eml` file and database rows) and its checkpoint row are committed in **one database transaction**, and the message file is flushed to disk before that commit. A message is therefore either fully stored and recorded, or not stored at all:

- If Aerio quits, crashes or loses the connection in the middle of a message, that message isn't stored and is downloaded again next time. Messages already committed aren't downloaded again.
- The stored message id is derived from the account and the UIDL. Even a repeated download would replace the same message rather than add a copy.
- Message numbers change whenever messages are removed from the server; UIDLs don't. Aerio always works from the UIDL.
- Deleting a message in Aerio keeps its checkpoint, so it is never downloaded again while it remains on the server.
- When the server stops listing a UIDL (another client removed it), its row is kept and marked as no longer on the server.

**Failures.**

- A message the server refuses (`-ERR` on `RETR`) is skipped for this session and retried at the next check. The account settings show the note.
- A message larger than 64 MB isn't downloaded. It's recorded as skipped and left on the server, and it never counts as stored, so no retention policy removes it.
- A dropped connection, a timeout (30 seconds without a response) or a TLS failure ends the session. A server without `UIDL` or with duplicate UIDLs does too. Messages already stored are kept. Nothing is removed from the server, because removals only take effect on a successful `QUIT`.
- Wrong credentials are reported as "Authentication failed…" and the account asks for its password. A mailbox locked by another session (`[IN-USE]`) is reported separately.

The first download of an existing maildrop doesn't raise new-mail notifications. Later checks notify as usual, and incoming mail rules run on new POP3 mail as they do for other accounts.

## Destinations

**This account's own folders** (the default). Downloaded mail goes to the account's **Inbox** as unread. **Sent**, **Drafts** and **Trash** are kept by Aerio on this computer, because POP3 has none of them on the server:

- Folders you create under **Folders & labels** exist only in Aerio, like Local Folders. They work offline and nothing is sent to a server.
- Read/unread, star, move and Trash use the normal local pipeline with its Undo window, and complete without a network connection.
- Drafts are saved on this computer only. They are never uploaded.
- **Copy to…** within a POP3 account isn't offered as a server action. Move the message instead, or copy it to Local Folders.
- **Rebuild local mailbox** isn't available: once a message is downloaded it lives here, and Aerio never downloads it twice.

**A Local Folders folder.** Downloaded mail goes straight into an existing [Local Folders](mail-import-local-folders.md) folder as unread. It joins Local Folders' duplicate fingerprints, and the account's checkpoints still prevent downloading it again. This is useful when you're consolidating mail from an old client into one local tree. Sent copies and drafts still belong to the POP3 account. If the chosen folder is deleted, the next check stops with an explanation and downloads nothing until you choose another destination.

## Sending

Messages from a POP3 account go through the existing Outbox: undo send, scheduled send, offline queueing, sender identities, read and delivery receipt requests, OpenPGP and S/MIME all work the same way as for IMAP accounts. SMTP delivery uses the account's SMTP server and credentials. After a successful send, Aerio stores a copy of the sent message in the account's local **Sent** folder, because POP3 servers don't keep one. If storing that copy fails, the send is still reported as sent, since the message has already been delivered.

## Retention: what happens on the server

Nothing is removed from the server until the message is durably stored in Aerio. The order is always:

1. The message and its checkpoint are committed (and the file is synced to disk).
2. Each removal is recorded as `delete-pending`, and the database's write-ahead log is checkpointed to the database file. If that checkpoint can't complete, removals wait for the next session.
3. `DELE` is sent for each message to remove.
4. The removals become real only when the server answers `QUIT` with `+OK`. Only then are they recorded as `deleted`. If the session ends any other way, the server restores the messages (RFC 1939) and Aerio retries the removal at the next check.

The settings screen describes the effect of the chosen policy before you save it.

| Policy | Effect on the server |
| --- | --- |
| **Leave a copy on the server** (default), no other option | Nothing is ever removed. Other devices and webmail keep seeing everything; the server mailbox keeps growing until it's cleaned up elsewhere. |
| Leave a copy, plus **Remove from the server N days after download** | A message is removed N days after Aerio downloaded it, whatever you did with it in Aerio. The local copy stays. |
| Leave a copy, plus **Remove from the server when I delete a message in Aerio** | At the next check after a message is moved to Trash in Aerio (once its Undo window has passed), or deleted from Aerio entirely, it's removed from the server. A message restored from Trash before that check is kept on the server. Restoring it afterwards doesn't put it back. Moving a POP3 message to Local Folders (copy, then Trash) counts as deleting it from the account. |
| **Remove from the server after download** | Each message is removed in the same session that downloaded it, once it's stored. Other devices and webmail stop receiving those messages, and this computer holds the only copy, so keep [profile backups](profile-backup.md). |

The two "leave a copy" options can be combined. Messages that were skipped as too large, or that couldn't be downloaded, are never removed.

## Migrating from another mail client

POP3 servers don't record which client downloaded what, so Aerio can't know what Thunderbird, Outlook, eM Client, Apple Mail or another client already fetched. Plan the switch around where your existing mail is:

1. **Mail only in the old client** (it removed messages from the server after download, which is the usual POP3 default). Bring the old mail over with **Import mail** (MBOX, EML or Outlook PST/OST; see [Mail import and Local Folders](mail-import-local-folders.md)). Then add the POP3 account. Aerio downloads only what's still on the server, so the two don't overlap.
2. **Mail still on the server** (the old client used "leave a copy on the server"). Aerio's first check downloads everything still on the server. If you also import the old client's archive, messages that are in both places appear twice: once in the import and once from the server. To avoid this, either:
   - import only folders that are no longer on the server, such as Sent mail and your own folders, and let Aerio download the Inbox; or
   - import everything into Local Folders and choose that Local Folders folder as the POP3 destination. Duplicate review then shows identical copies.

   Either way, keep **Leave a copy on the server** until you've checked the result.
3. **Running both clients for a while.** Keep **Leave a copy on the server** in both clients, and don't enable a removal policy in either. With "remove after download" in either client, the other one misses those messages. Aerio's **Remove … when I delete a message in Aerio** only affects messages Aerio downloaded.
4. **Moving from Aerio's IMAP account to POP3** for the same address: remove the IMAP account first (keeping its mail as an offline archive if you like), then add the POP3 account.

Old clients' "already downloaded" lists (Thunderbird's `popstate.dat`, Outlook's `.pst` UID records) aren't imported. Their message ids belong to those clients and aren't reliable across servers.

## Backup, restore and removal

- The POP3 settings (without the password), the download checkpoints, and every downloaded message, local folder, draft and sent copy are stored in `aerio.sqlite` and the `mail` directory, so the full profile backup includes them. The backup preview counts **POP3 download checkpoints**. The password stays in `oauth-vault.dat`, which is never backed up.
- After a restore, the account asks for its password. Enter it in **Account settings › POP3 and SMTP**. The restored checkpoints mean messages that were already downloaded aren't downloaded again. Messages the server received after the backup was made are downloaded at the next check. A backup restored after Aerio had removed messages from the server can't bring back mail that arrived after the backup and was removed from the server since.
- **Disconnect account › delete** removes the account, its checkpoints and every message stored in its own folders. The server isn't changed, but mail that's no longer on the server can't be recovered. Messages delivered to a Local Folders folder stay there.

## Implementation

| Area | Module |
| --- | --- |
| POP3 client: TLS/STLS, CAPA, USER/PASS, APOP, AUTH PLAIN, STAT/UIDL/LIST/RETR/DELE/RSET/NOOP/QUIT, multi-line responses, dot-unstuffing, timeouts | `electron/mail/pop3-client.ts` |
| Download sessions, destinations, retention, sent copies | `electron/mail/pop3-sync.ts` |
| Settings and checkpoint tables (`pop3_accounts`, `pop3_uidls`) | `electron/mail/pop3-store.ts` (`MailDatabase.pop3`) |
| Input validation, client and SMTP configuration | `electron/mail/pop3-settings.ts` |
| Connection test and IPC (`mail:pop3:*`) | `electron/mail/pop3-ipc.ts` |
| Worker wiring (sync, local operations and drafts, Outbox Sent copy) | `electron/mail-worker.ts` |
| Contracts | `src/pop3-types.ts` |
| Setup form, settings section, retention explanations | `src/components/Pop3Account.tsx`, `src/lib/pop3.ts` |

No new dependency is used: the client is built on `node:net` and `node:tls`, and SMTP uses the existing Nodemailer sender.

### Verification

The test suite runs a disposable POP3 server (`electron/mail/pop3-test-server.ts`). It listens on loopback only, with implicit TLS or STLS using a certificate generated for the run by the `selfsigned` development dependency, and keeps an in-memory maildrop with RFC 1939 semantics (message numbers fixed per session, deletions applied only on `QUIT`). It can inject failures: a connection dropped mid-message, `-ERR` on one message, a server that stops responding, a locked mailbox, and a session dropped instead of answering `QUIT`. Tests cover:

- implicit TLS and STARTTLS, untrusted certificates, a missing `STLS`, TLS against a plaintext port, plaintext refusal and explicit opt-in;
- each sign-in method and wrong credentials, servers without `CAPA` or `UIDL`, dot-unstuffing and byte-exact messages, size limits and timeouts;
- UIDL stability across renumbering, restart with a reopened database, repeated checks, local deletion, a connection drop mid-download, a failed commit (rollback with no duplicate), and per-message failures;
- every retention policy, including the Undo window, restoring from Trash before removal, and `QUIT` failures that roll back deletions;
- the Local Folders destination, the IPC validation and app-lock checks, the vault, profile backup and restore, and the renderer forms.

The real mail worker is also exercised against the fake server: downloading, sending through the Outbox (Nodemailer's `smtp-server` verifies the SMTP half of the connection test over STARTTLS), and local drafts and folders.

These fixtures don't prove compatibility with every production POP3 server. Gmail's POP3 service, for example, applies its own "recent mode" and archive-on-download behaviour, and other servers have their own quirks. No live-provider validation has been recorded yet.
