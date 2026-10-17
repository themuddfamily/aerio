# Full-profile backup and restore

Settings → **Full profile backup** creates verified snapshots of one Aerio profile on demand or on a schedule (daily, every 3 days, or weekly), keeps the newest *N* (1–50, default 7), and can restore any of them after showing a preview. The engine is `electron/profile-backup.ts`. The list of what gets backed up is `electron/profile-backup-layout.ts`. IPC handlers and the scheduler are in `electron/profile-backup-tools.ts`, and the UI is `src/components/ProfileBackupSection.tsx`.

The older portable JSON backups still work. Settings › Local data backup covers Tasks, Notes, Contacts, and templates, and the Tasks sidebar has connected-task backups. Those are file exports for moving data elsewhere. A full-profile backup is a recovery snapshot for an Aerio installation.

## What is included

The layout is an allowlist. Only these profile entries are copied:

| Entry | Contents |
| --- | --- |
| `aerio-state.sqlite` | Application preferences (the app-lock verifier is removed) |
| `aerio.sqlite` | Mail accounts (metadata only), folders/labels, cached messages, the search index, drafts, outgoing/scheduled sends, queued mail changes, the folder-change journal, snoozes, rules, Quick Actions, saved searches, read-receipt history, reply watches |
| `message-local.sqlite` | Per-message categories, display preferences, and links to notes/tasks |
| `mail-templates.sqlite` | QuickText snippets and templates |
| `productivity.sqlite` | Local Tasks, Notes, and Contacts, local calendars and internet-calendar subscriptions, plus the provider calendar/contact cache |
| `provider-tasks.sqlite` | The connected-task cache, durable task/list operations, and resolution history |
| `dav.sqlite` | CalDAV/CardDAV accounts (no passwords), discovered collections with sync tokens and ctags, the resource cache with ETags, and pending writes |
| `mcp-automation.sqlite` | [External automation (MCP)](mcp-automation.md) capability and account-scope choices (client token hashes and the send idempotency ledger are removed) |
| `mail/` | Downloaded `.eml` files and staged draft attachments |
| `note-attachments/`, `template-attachments/` | Managed attachment copies |

Writable local mail folders (roadmap E18) don't exist yet. When they're added, their database or folder has to be added to the layout.

### Never included

- `oauth-vault.dat`: OAuth access and refresh tokens, IMAP/SMTP passwords, and the secure-storage (DPAPI/Keychain/libsecret) encryption around them. The engine also refuses any file with this name inside a managed folder, and rejects any manifest that lists one.
- `openpgp-keyring.dat`: OpenPGP public keys and passphrase-protected private keys, wrapped with the same secure storage. It is on the same forbidden list and stays as it is on the device during a restore. Export keys from Settings › OpenPGP keys to move them ([OpenPGP mail](openpgp-mail.md)).
- `smime-certificates.dat`: S/MIME certificates, trust choices, sender defaults, and passphrase-protected private keys, wrapped with the same secure storage. It is on the forbidden list and stays as it is on the device during a restore. Export a password-protected PKCS#12 from Settings › S/MIME certificates to move your certificate ([S/MIME mail](smime-mail.md)).
- `dav-credentials.dat`: CalDAV/CardDAV app passwords encrypted with OS secure storage. On restore, DAV accounts ask for the password again, and writes that were still queued are held for review instead of being sent.
- The app-lock passphrase verifier. Backups delete it under `secure_delete` and `VACUUM`, so the bytes don't survive in free pages. On restore, the current device keeps its own app lock, or keeps having none.
- Diagnostic logs, window bounds, update caches, `profile-backup.json` (the schedule itself), and earlier restore staging or rollback copies.

## Backup format and consistency

Each backup is a folder named `aerio-profile-<UTC timestamp>` that contains `manifest.json` and `data/`. Backups are first written to a `.partial-*` folder and renamed only once every file and the manifest are complete. An interrupted backup therefore never looks like a valid one, and retention removes leftover partial folders.

Each database is copied with SQLite's online backup API (`node:sqlite` `backup()`), with every page copied in one step on Node's thread pool. The copy is a single read transaction, so it's consistent even while the mail worker keeps writing, and the Electron main thread isn't blocked. When the runtime lacks `backup()`, Aerio falls back to `VACUUM INTO`. Copies are switched to rollback-journal mode and checked with `PRAGMA integrity_check` before they're hashed. Each database is consistent on its own, but different databases are snapshotted one after another, not at the same instant. Managed files are copied after the databases. A message file that's deleted in between is skipped, and the mail store's existing missing-raw-file recovery downloads it again.

The manifest records the format and schema version, the Aerio version, the trigger (manual or scheduled), the source profile path, and the size and SHA-256 of every database and file. It also contains a SHA-256 digest of the manifest itself. File paths must be relative, `/`-separated, contain no `.` or `..` segments, sit under a listed managed folder, and not repeat (case-insensitively).

Retention only deletes folders whose manifest is valid. Unrelated or corrupt folders in the backup directory are never removed. The backup folder can't be inside one of Aerio's managed folders.

## Restore

1. **Preview** fully re-hashes the backup and checks each database's integrity. It then shows counts: accounts, cached messages, drafts, sends that will be held, queued mail changes, rules, saved searches, reply watches, templates, local Tasks/Notes/Contacts, connected tasks, and pending task writes. Warnings cover held sends, reauthorization, a different source profile folder, an older format, and databases missing from the backup. The main process only restores a folder that passed preview in this session.
2. **Staging** copies the backup into `<profile>/.profile-restore/staging`, hashing as it copies. This verifies the staged bytes themselves, not just the source, so corruption after preview is still caught. Then, on the staged copies only:
   - If the backup came from a different profile folder, absolute managed paths are rebased in every text column of ordinary tables. Both raw and JSON-escaped forms are handled. Full-text index and shadow tables are skipped.
   - Each store is opened with its normal constructor (`MailDatabase`, `ProductivityStore`, `InterchangeStore`, `MessageLocalStore`, `MailTemplateStore`, `TaskStore`). This applies every idempotent schema upgrade, so an older backup is migrated before it can replace anything. A failed migration aborts the restore, and live data is untouched.
   - **Queued sends are held.** Drafts in `queued`, `send-pending` (undo window), `scheduled`, or `syncing` become `failed`. They get the error *"Held after restoring a profile backup. Review this message and send it again if it is still needed."* and their delivery time is cleared, so the worker's due-send query can never pick them up. Ordinary local drafts stay drafts.
   - **Unfinished mail merges are held.** Every `pending` or `sending` recipient of a running, paused, or in-review [mail merge](mail-merge.md) becomes `ambiguous` and its merge waits for review, since the backup may predate deliveries made later. These recipients are counted with the held sends.
   - **Connected task writes are held.** `provider-tasks.sqlite` goes through the connected-task backup round trip, so every active task and list operation becomes `review`/`restored-write` and checkpoints are cleared. This matches [connected-task restore](task-provider-integration.md#connected-task-backups).
   - **Accounts need reauthorization.** Every active account is set to `needs-auth` with an explanatory error. At the next launch, Aerio's normal recovery verifies each one with this device's vault. Accounts whose credentials are still present resume on their own; the others show *Reconnect*.
   - Queued mailbox-state operations (read/star/label/move/archive/trash) are restored as queued. They're idempotent label changes and represent intent the user already expressed.
   - The current device's `app_lock` row is copied into the staged preferences database.
   - External automation restarts **off** with no issued MCP clients, so a restore never re-opens external access by itself.
   - A journal (`restore.json`, state `staged`) is written atomically, and Aerio relaunches with `app.relaunch()` and `app.quit()`, so every store and the mail worker close normally.
3. **Swap** runs at the very start of the next launch, before any profile database opens. The journal moves to `swapping` and records which entries didn't exist. Then each entry is renamed aside into `rollback/`, along with its `-wal`/`-shm`/`-journal` sidecars, so a stale write-ahead log can never be replayed onto a different database, and the staged copy is renamed into place. Windows sharing violations (`EBUSY`/`EPERM`/`EACCES`) are retried for about 5 seconds.
   - If anything fails, every original is put back, and the journal records `rolled-back` with the reason.
   - If Aerio crashes or loses power mid-swap, the next launch finds `swapping` and runs the same idempotent rollback. Entries that didn't exist before are removed, and every saved original is restored.
4. **Finalize** runs after every store has opened on the restored data. It deletes the staging and rollback copies and keeps `last-restore.json`, which Settings shows (held sends, held task writes, reauthorization, or the rollback reason) until it's dismissed. If startup fails before this point, the rollback copy stays in `.profile-restore/rollback` for manual recovery.

Restores replace the whole profile. A database missing from the backup is created empty. Credentials (`oauth-vault.dat`) stay exactly as they are on the device.

## Tests

- `electron/profile-backup.test.ts` covers:
  - manifest and checksum creation, the vault exclusion, the scrubbed verifier bytes, and the absence of sidecars
  - a consistent snapshot while another connection holds an uncommitted write
  - rejecting backup folders inside managed data, and cleaning up partial output after a failure
  - checksum, missing-file, edited-manifest, unsafe-path, forbidden-name, and newer-schema rejection
  - preview counts and warnings
  - retention with partial and foreign folders
  - stage then swap, including stale sidecar replacement
  - corruption found during staging
  - rollback when the swap fails partway
  - recovery after a crash mid-swap (the profile is captured on disk at the failure point and relaunched)
  - path rebasing
  - schedule due, retry, and validation logic
- `electron/profile-backup-layout.test.ts` uses the real stores to cover:
  - a full backup and preview of mail, drafts, queued work, rules, templates, local modules, and connected tasks
  - restore with scheduled, undo-window, and outbox sends held (and `queuedDrafts()` empty after reopening), accounts in `needs-auth`, task writes under `restored-write` review, and the device's newer app lock kept
  - no app lock carried onto a device without one
  - an older mail schema migrated in staging, with its queued send held, restored into a different profile folder
- `electron/profile-backup-tools.test.ts` covers the IPC layer: retention, refusal while locked, refusing unpreviewed restores, relaunch, and scheduled runs.
- `src/components/ProfileBackupSection.test.tsx` covers the Settings UI.

## Not yet verified

- There is no native Electron audit yet that runs `app.relaunch()` and the startup swap end to end. Unit tests call the same functions directly.
- Restoring across operating systems is untested. Rebased paths keep the source platform's separators.
- Very large mail caches are untested. The manifest lists every cached file, and staging needs free space equal to the backup size inside the profile volume.
- Backups aren't encrypted. They hold mail content and should be stored on protected or encrypted media.
