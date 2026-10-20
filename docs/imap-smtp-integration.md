# Disposable IMAP/SMTP integration checks

Run `npm run test:imap` with Node 24 or newer. The command builds the production mail worker and runs `scripts/imap-smtp-integration.mjs` through the TypeScript loader. Both Windows build and release workflows run it.

Each scenario starts fresh in-memory IMAP and SMTP servers bound to `127.0.0.1` on operating-system-assigned ports. Certificates are generated for the run, credentials and addresses are fixtures, and the worker uses a temporary SQLite database and content directory. No account, Docker installation, external mail service, or system certificate change is required. The harness closes workers, sockets, and servers and deletes its temporary profile on success or failure.

The suite covers implicit TLS and STARTTLS independently:

- Rejecting an untrusted certificate and invalid credentials; all accepted authentication happens over encryption.
- Rejecting missing STARTTLS support without delivering mail or falling back to unencrypted authentication.
- Discovering Sent, Drafts, Trash, Archive, and Junk by special-use flags despite nonstandard names, while skipping nonselectable containers.
- Fetching inventory and raw MIME, changing read/star flags, moving to Archive and back, and replacing/deleting drafts on a server without UIDPLUS.
- SMTP envelope recipients, captured message bytes, temporary delivery rejection, and explicit retry.
- A real production worker synchronizing messages into SQLite, retaining cache after a server disconnect, reconnecting, importing incremental messages, and replacing identities when UIDVALIDITY changes and UIDs are reused.
- Creating, syncing, and renaming a folder through the worker, refusing to rename a special-use folder, rejecting an unconfirmed delete of a non-empty folder, and confirming that a guarded delete moves the message to Trash rather than expunging it (see [mail-folder-management.md](mail-folder-management.md)).
- Holding a rename-triggered background sync immediately before SELECT, deleting that mailbox through the worker, and verifying the real server rejects the stale SELECT. Inventory waits for the concurrent folder mutation and repeats against the updated topology before reporting completion, so the moved message is available in Trash. Ordinary provider failures remain errors; repeated concurrent mutations stop after three inventory attempts with an explicit refresh error.
- Saving, replacing, and deleting a draft through the worker; preserving cached messages and an overdue offline scheduled send across worker shutdown/restart; delivering once when connectivity resumes.

The fixture uses [Hoodiecrow's in-memory IMAP server](https://github.com/andris9/hoodiecrow) and [Nodemailer's SMTP server](https://nodemailer.com/extras/smtp-server), only as development dependencies. Hoodiecrow is an unmaintained test server; its legacy argument-parser dependency is overridden with a patched `minimist`. It is never packaged in Aerio or exposed outside loopback. New protocols or provider quirks should still receive focused unit tests and live-provider validation; these fixtures do not prove compatibility with every production server.

The integration checks exposed two initialization/identity gaps: a new account's persisted provider state starts as `{}`, so IMAP folder and Microsoft delta maps must be initialized explicitly; an IMAP draft must retain a real server UID instead of a fabricated identifier. Aerio now appends before deleting the old draft and can look up the new UID by its unique Message-ID. Outgoing MIME includes a unique Message-ID and Date so this lookup works even when APPEND provides no UID.

Sync failures include at most 64 synthetic fixture command/status records, with bounded folder names and server failure text. Diagnostics omit authentication arguments, message literals, headers, bodies and SMTP envelopes.
