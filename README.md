# Aerio

Aerio is a calm, modern desktop communications client for Windows. It supports multi-provider mail, writable Google and Microsoft Calendar and Contacts synchronization, connected Google Tasks and Microsoft To Do, and local Contacts, Tasks, and Notes.

Remaining release work and optional future features are tracked in [ROADMAP.md](ROADMAP.md).

## Real-mail alpha

- Gmail through the Gmail API; Outlook.com and Microsoft 365 through Microsoft Graph
- iCloud, Yahoo/AOL, Fastmail, Proton Mail Bridge, and custom-domain mail through IMAP/SMTP
- Multiple mixed-provider accounts and unified folders, with no hard-coded account limit
- Complete mailbox inventory, including Spam and Trash, followed by newest-first offline download
- Raw RFC 2822 messages, MIME bodies, and attachments stored locally
- Resumable sync checkpoints, Gmail History, Microsoft delta links, IMAP folder reconciliation, 15-second active/one-minute background polling, and manual pause/resume
- SQLite-backed folder views, infinite scrolling, and full-text offline search, including text extracted from PDF, Office, and text attachments
- An all-attachments workspace that filters attachments across accounts by name, sender, recipient, date, file type, and size, with open, save, and jump-to-message actions ([attachments workspace](docs/attachments-workspace.md))
- Single and multi-select Archive, read/unread, star, importance, move, label, and Trash actions
- Optimistic local changes with exact-state Undo, retry/backoff, and a durable provider operation queue
- Editable provider drafts with idle autosave, rich-text composition, recipient suggestions, signatures, forwarding attachments, scheduled delivery, ten-second Undo Send, SMTP delivery, and an offline Outbox
- QuickText snippets and whole-message templates (subject, sanitized HTML, and managed attachments) with search, editing, caret-preserving insertion, and backup/restore
- Rich composition with fonts, colors, alignment, tables, inline images sent as Content-ID parts, and sanitized HTML paste ([details](docs/rich-composition.md))
- Sender identities with provider-authorized aliases (Gmail send-as, Microsoft aliases, manual IMAP/shared-mailbox addresses), Reply-To, multiple sanitized HTML signatures, and per-identity defaults for new messages and replies ([details](docs/sender-identities.md))
- Mail merge: send one personalized copy per contact or pasted/CSV row with `{{firstName|there}}`-style variables and fallbacks, a per-recipient preview, single-To deliveries (no shared Cc/Bcc), per-minute and daily limits with rate-limit back-off, durable progress that resumes after a restart, and review of any send whose outcome is unknown instead of an automatic resend ([mail merge](docs/mail-merge.md))
- Persistent snooze/remind-later with automatic Inbox restoration, plus account-specific rules with Cc, header, attachment, size, age, importance, and folder conditions, “except if” exceptions, outgoing (Sent mail) rules, and optional Gmail filter / Outlook inbox rule upload ([mail rules](docs/mail-rules.md))
- User-defined Quick Actions that run a saved sequence of mail actions from the toolbar, context menu, command palette, or Ctrl+Shift+1–9, with run-time destination checks and step-by-step Undo ([Quick Actions](docs/mail-quick-actions.md))
- Per-account identity, synchronization, notification, OAuth, IMAP/SMTP, connection-test, and local-rebuild settings
- Optional cloud attachments: upload a file to Google Drive or OneDrive from the composer and insert a sharing link with a visible scope (anyone with the link, organization, or only the recipients; view or edit), with resumable uploads, cancellation, and a pre-send check for revoked or expired links ([cloud attachments](docs/cloud-attachments.md))
- Provider-side Gmail and Microsoft automatic replies (out of office) with schedules, audiences, read-back of the server state, and a reconnect path for missing permissions ([automatic replies](docs/automatic-replies.md))
- Privacy-redacted diagnostics, storage-integrity checks, and native new-mail notifications that open the relevant conversation
- OpenPGP mail (PGP/MIME): sign, encrypt, decrypt, and verify, with key generation, import and export, recipient key selection, fingerprint verification, and private keys protected by their passphrase plus OS secure storage. A message is never sent unprotected if signing or encryption fails ([OpenPGP mail](docs/openpgp-mail.md))
- Sanitized HTML; scripts and unsafe links are removed, remote images are blocked by default, and suspected tracking pixels stay blocked with an explanation even after remote images are permitted ([tracking protection](docs/tracking-protection.md))
- Dedicated message windows for provider mail; double-click a conversation to open or focus its window
- Read-only local archive or complete local deletion when disconnecting an account
- Writable Local Folders that never sync: import MBOX and EML archives (Thunderbird, Apple Mail, and folders of `.eml` files), keeping folder hierarchy, dates, read/starred flags, original MIME, and attachments. Imports show progress, can be paused, cancelled, and resumed after a restart, and hold duplicates (same Message-ID or identical content) for review. Messages can be copied or moved into Local Folders from any account. Outlook PST is not supported yet ([mail import and Local Folders](docs/mail-import-local-folders.md))
- Google and Microsoft Calendar synchronization with event creation, editing, deletion, recurrence, and configurable reminders
- CalDAV/CardDAV calendar and contact accounts (iCloud, Fastmail, Nextcloud, or any standards-based server) with `.well-known` discovery, read-only/shared collection detection, incremental `sync-collection` sync with ctag/ETag fallback, a durable offline write queue, and conflict review that never silently overwrites server changes ([CalDAV and CardDAV](docs/caldav-carddav.md))
- Scheduling assistant with provider free/busy (Google `freeBusy`, Microsoft Graph `getSchedule`), unknown-availability hatching, working hours, a second time zone, and suggested slots ([docs](docs/scheduling-assistant.md))
- Full repeat rules (intervals, weekdays, nth weekdays, yearly, end dates/counts), named time zones, all-day events, and this event / this and following / all events edits and deletes, plus a secondary time zone in week and day views; see [calendar recurrence and time zones](docs/calendar-recurrence-time-zones.md)
- Google Meet and Microsoft Teams meetings added from the event editor, kept through later edits, and joined with one click (https links on known meeting hosts open directly; others ask first); retried saves never create a second meeting, and Zoom/Webex have a connector boundary only; see [online meetings](docs/online-meetings.md)
- Writable Google and Microsoft provider Contacts plus editable local Contacts with multiple typed emails, phones, and addresses, birthdays, photos, and groups; distribution lists (local lists, Google contact groups, Outlook categories) that expand in To/Cc/Bcc (see [docs/rich-contacts.md](docs/rich-contacts.md)); portable backup and restore for local Contacts, lists, Tasks, Notes, and managed note attachments
- Google Tasks and Microsoft To Do lists/tasks with durable offline changes, conflict review, undo, native/local recurrence mapping, and separate connected-task backup/restore; see [provider task integration](docs/task-provider-integration.md)
- Optional local passphrase privacy lock at launch, when Aerio is sent to the tray, or on demand
- Opt-in AI assistance (off by default) for email summaries, drafting and rephrasing, suggested replies, and natural-language search, using Anthropic or any OpenAI-compatible server such as a local Ollama. API keys stay in OS secure storage, Settings shows exactly what each feature sends, and every result is a preview that you apply yourself ([AI assistance](docs/ai-assistance.md))

Tasks, Notes, and local Contacts are production local modules. Google Tasks and Microsoft To Do appear alongside local task lists and poll each minute when connected and authorized; cached intent survives offline use, permission changes and restart. Microsoft exposes native recurrence/priority/time zones and checklist items; Google recurrence and priority remain local metadata. Controlled adapter/SQLite/native-desktop checks pass, while hosted Tasks provider compatibility remains unverified. Chat is outside the v1 navigation until a secure transport is selected. Provider Calendar and Contacts data refreshes automatically every 15 minutes and can also be refreshed with **Sync now**. Refreshes use persisted Google sync tokens and Microsoft delta links, with an automatic full refresh when a provider expires a checkpoint. Calendar events can be created by double-clicking a day or time slot and edited after granting the event scope once.

## Connect an account

Open the real-mail workspace and choose **Add mail account**. The setup screen explains the requirements for each provider.

### Gmail

Aerio includes its public Google Desktop client ID and compiles its client secret into the Electron main process. It never proxies your mail through an Aerio server. Development builds read the secret from a git-ignored `.env.local`; official builds receive it from a GitHub Actions secret. If a custom build has no complete registration, the account screen retains a JSON-import fallback for developers.

Official builds use Aerio's built-in registration: choose Gmail and select **Connect Gmail**. The following steps are for developers configuring a separate registration:

1. Open the [Google Cloud Console](https://console.cloud.google.com/), create or select a project, and enable the **Gmail API**, **Google Calendar API**, **People API**, and **Google Tasks API**.
2. Configure the OAuth consent screen. For durable personal use, publish it as **In production** and add only the Google accounts you intend to use if Google requests test users. Refresh tokens issued while the app is in **Testing** normally expire after seven days.
3. Create **OAuth client ID → Desktop app** credentials and download the JSON file.
4. Put its `client_id` and `client_secret` into `.env.local` as `MAIN_VITE_GOOGLE_CLIENT_ID` and `MAIN_VITE_GOOGLE_CLIENT_SECRET`, then rebuild Aerio. Both values must belong to the same registration.
5. Choose Gmail and select **Connect Gmail**. Your normal browser completes Google sign-in and returns to Aerio through a temporary `127.0.0.1` callback.

Aerio requests Gmail modify access, Gmail basic-settings access (for automatic replies), read-only Calendar-list access, Google Calendar event read/write access, Calendar free/busy access (for the scheduling assistant), Contacts read/write access, and Tasks read/write access. It does not request permission to create or share calendars or permanently delete Gmail messages. Existing accounts connected by an older Aerio build can use **Enable editing** in Calendar/Contacts, **Connect Google Tasks** in Tasks, or **Account settings → Reconnect** to approve added scopes.

The first download is quota-bound. A mailbox with 100,000 messages can take roughly seven hours or more, depending on message size, retries, and Google’s per-user quota. Progress is persistent; quitting, losing connectivity, or pausing does not discard completed work.

### Outlook and Microsoft 365

Official builds use Aerio's built-in public-client registration: choose Microsoft and sign in. To configure a separate development registration:

1. Create an app registration in [Microsoft Entra](https://entra.microsoft.com/).
2. Enable public client flows and add the **Mobile and desktop applications** redirect URI `http://localhost`.
3. Set `MAIN_VITE_MICROSOFT_CLIENT_ID` to the new Application (client) ID and rebuild, then choose Microsoft and sign in. The browser requests delegated `User.Read`, `Mail.ReadWrite`, `Mail.Send`, `MailboxSettings.ReadWrite`, `Calendars.ReadWrite`, `Contacts.ReadWrite`, and `Tasks.ReadWrite` access. Existing connections can reconnect to grant added permissions; Tasks offers **Connect Microsoft To Do**. Background token refresh renews the existing grant without requesting new Tasks or mailbox-settings consent.

Aerio includes its Microsoft public-client application ID by default, because desktop application IDs are public identifiers rather than secrets. `MAIN_VITE_MICROSOFT_CLIENT_ID` can override it for a separate development registration.

Use an account type supported by the registration. Organization-managed tenants may require an administrator to approve the requested permissions.

### iCloud, Yahoo/AOL, and Fastmail

These providers normally reject the regular account password in desktop mail clients. Create an app-specific password in the provider’s security settings, then use the preset in Aerio:

- [Apple app-specific passwords and iCloud Mail server settings](https://support.apple.com/102525)
- [Yahoo third-party app passwords](https://help.yahoo.com/kb/account/confirm-delete-password-sln15241.html)
- [Fastmail app passwords and server settings](https://www.fastmail.help/hc/en-us/articles/1500000279921)

### Proton Mail and other providers

Proton Mail connects through the local [Proton Mail Bridge](https://proton.me/support/imap-smtp-and-pop3-setup); keep Bridge running and use the credentials it displays. For a custom domain or another provider, choose **Other IMAP/SMTP** and enter the TLS server settings supplied by the mail host.

## Local data and security

- OAuth refresh/access tokens and IMAP/SMTP passwords are encrypted with Electron `safeStorage` (Windows DPAPI) before they are written to disk.
- Tokens stay in Electron’s main process. The sandboxed renderer receives a narrow typed API and never receives credentials.
- Mail metadata and search indexes live in normalized SQLite tables using WAL mode. Provider calendars and contacts use a separate `productivity.sqlite` cache.
- Original `.eml` content is written atomically beneath Aerio’s application-data directory.
- Remote message images are represented by an isolated `aerio-image:` protocol and are fetched only after an explicit per-conversation choice.
- External HTTP(S) and `mailto:` links open in the system browser/mail handler rather than navigating Aerio.
- Mailbox files are protected by the Windows user account and disk encryption. Enable BitLocker if the device may be lost or shared.
- Settings can enable a scrypt-verified local app-lock passphrase. The privacy screen blocks workspace loading at launch, closes message windows when locked, and rate-limits failed attempts; it does not encrypt Aerio’s files.
- Notes can copy attachments up to 25 MB each into Aerio-managed storage, search them by filename, open or remove them, and clean up unreferenced copies.
- Settings can export and restore local Contacts, Tasks, Notes, and managed note attachments as a validated JSON backup (up to 100 MB of attachment data). Provider mail and cached provider data are intentionally excluded because they can be synchronized again. Local Folders mail can't be downloaded again and isn't in that JSON backup either. The full-profile backup below does include it, because it covers the mail database and the downloaded-message directory.
- Mail snippets and templates live in `mail-templates.sqlite`; their bodies are re-sanitized on every save and restore, and template attachments (up to 10 files and 20 MB per template) are copied into Aerio-managed `template-attachments` storage. Using a template authorizes only those managed files for the draft, which then stages its own copy, so editing or deleting a template never changes existing drafts. The composer’s template panel can export and restore templates by themselves (restore merges and renames name collisions), and the local-data backup also embeds them; restoring a local-data backup that contains templates replaces the local templates.
- Settings › Full profile backup takes scheduled or on-demand checksummed snapshots of the whole profile (mail cache, drafts, queued changes, rules, templates, local modules, and preferences), keeps the newest N, and restores after a preview by staging the copy and swapping it in atomically on restart, rolling back on failure. OAuth tokens, IMAP/SMTP passwords, and secure-storage data are never included, restored outgoing or scheduled sends are held for review, and accounts reauthorize; see [full-profile backup](docs/profile-backup.md).
- Restore rejects duplicate record identities and inconsistent attachment metadata. Failed attachment writes or database restores retain the existing records and files and remove newly staged attachments.

Application preferences live in `aerio-state.sqlite`. On first launch after this change, Aerio imports only appearance, customized profile, notification, startup, and tray preferences from the former workspace database when available; sample content and the old sample persona are neither loaded nor copied. The legacy database is left untouched.

Packaged Windows builds register sign-in startup with `--aerio-login` so the first window opens minimized; ordinary launches open normally. The startup choice does not register development builds with Windows. Desktop preference checks use isolated temporary profiles, and unit checks use mocked native notifications and login registration.

## Run from source

Requirements: Node.js 24 or newer and Windows 10/11.

```powershell
npm install
Copy-Item .env.example .env.local
# Replace the placeholders in .env.local with the Desktop OAuth registrations.
npm run dev
```

Only `MAIN_VITE_` variables are used, so OAuth client configuration is compiled into the Electron main process and is not exposed through the renderer API. Native-app client credentials identify the application but cannot be treated as confidential; user access and refresh tokens remain encrypted separately with Windows DPAPI.

Useful commands:

```powershell
npm run typecheck
npm test
npm run audit:buttons
npm run audit:context-menus
npm run test:desktop
npm run test:recovery # Build and run only the tray/quit/relaunch recovery audit
npm run test:backup # Build and run the real-file backup/restore audit
npm run test:app-lock # Build and check launch/tray locking and message-window closure
npm run test:preferences # Build and check desktop preferences/local data across quit and relaunch
npm run test:tasks # Build and run all four Google/Microsoft Tasks desktop audits
npm run test:microsoft-tasks # Build and run only the Microsoft consent/write/recovery audit
npm run test:imap # Disposable loopback IMAP/SMTP integration checks, TLS and STARTTLS
npm run test:live # Opt-in preconfigured account checks; see docs/live-provider-runner.md
npm run verify:artifacts # Verify packaged installers, portable executables, and update metadata
npm run verify:platform-config # Validate macOS/Linux configuration against the installed builder schema
npm run verify:platform-artifacts -- linux release x64 # Verify Linux artifacts on Linux; use mac on macOS
npm run test:platform:linux # Audit the packaged Linux executable in an isolated desktop/keyring session
npm run test:platform:linux:containers # Extract and audit the built AppImage and DEB executables
npm run test:platform:linux:desktop # Run all desktop audits under Xvfb and Openbox
npm run test:platform:mac # Audit the packaged app on a native macOS host
npm run test:platform:mac:containers # Audit extracted ZIP and read-only mounted DMG apps on macOS
npm run test:desktop:visible # Show Electron windows while debugging a failure
npm run build
npm run package:win
npm run package:mac # Experimental; run on macOS (DMG and ZIP)
npm run package:linux # Experimental; run on Linux (x64 AppImage and DEB)
```

Desktop tests run with every Electron window hidden by default. If an interaction fails, rerun the same suite with `npm run test:desktop:visible` to watch it in real time.

Windows packages are written to `release/`. They are unsigned development builds, so Windows may show a reputation warning.

## Architecture

The app uses Electron 43, React 19, TypeScript, Vite, and local SQLite databases:

- The renderer is sandboxed and has no Node.js access.
- The main process owns OAuth, OS dialogs, safe storage, external navigation, and a typed IPC boundary.
- A dedicated Node worker owns the normalized mail database, Gmail/Graph/IMAP synchronization, SMTP delivery, MIME parsing, full-text search, queued mutations, and drafts. Attachment text extraction runs in its own nested worker thread with a heap cap and per-file timeout.
- Main-process Google and Microsoft productivity connectors normalize Calendar and Contacts into an isolated SQLite cache. Failed refreshes retain the last good snapshot; disconnecting removes that account’s cached productivity data.
- Application preferences use their own small SQLite database; provider data and local Contacts/Tasks/Notes retain their existing dedicated stores.

Automated coverage includes provider data integrity, productivity connector normalization, incremental checkpoint fallback and atomic cache replacement, logical duplicate suppression, exact-state Undo, editable drafts, outgoing MIME, new-mail notification filtering, Microsoft delta pagination, mocked Gmail behavior, local-module badge logic, and pagination over a synthetic 100,000-thread mailbox. Static interaction-contract, WCAG, focus-management, and Playwright-driven Electron passes cover buttons, feature context menus, editing/link/image menus, profile management, dedicated message windows, cached Calendar/Contacts surfaces, bulk mail organization, account settings, module actions, account onboarding, and native window controls.

Live provider behavior is release-gated by the disposable-account scenarios in [`docs/live-provider-test-matrix.md`](docs/live-provider-test-matrix.md). Settings → Mail diagnostics checks database integrity and exports a privacy-redacted troubleshooting report; credentials, message bodies, raw mail, HTML, and attachment paths are excluded.

The longer-term provider boundaries and the reasoning behind local productivity data and deferred Chat are documented in [`docs/module-provider-strategy.md`](docs/module-provider-strategy.md).

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+K` | Search and command palette |
| `Ctrl+N` | New message, or account setup when real mail has no account |
| `Ctrl+1`…`Ctrl+5` | Switch between Mail, Calendar, Contacts, Tasks, and Notes |
| `Ctrl+L` | Lock Aerio when app lock is enabled |
| `Shift+F10` | Open the context menu for the focused item |
| `Shift+Enter` | Open the focused message in a separate window |
| `Esc` | Close the active overlay |

## Current limitations

- Multi-provider support is an alpha. Gmail has not been submitted for Google OAuth verification. Official builds include Google and Microsoft application IDs; production registration readiness and live-provider validation remain release tasks.
- Automated tests use mocked provider responses. Live validation requires real provider accounts, app registrations, or app passwords.
- IMAP has no universal standard for Archive or special folders. Aerio reports an error instead of guessing when a server does not advertise a required destination.
- IMAP can store multiple physical copies of the same message, but Aerio presents them as one logical conversation and keeps every location available for folder actions.
- Scheduled delivery, Undo Send, snooze, and rules are coordinated locally by Aerio. If Aerio is fully quit at a due time, the action resumes when it next starts; keeping it in the tray allows on-time processing, and Settings can start Aerio automatically after Windows sign-in.
- Delivery queue passes run one at a time, including after reconnection. Sends interrupted during a provider request are retained for review instead of automatically retried, because the provider may already have accepted the message.
- Waiting deliveries recheck their current due state before sending. Snooze expiry restores Inbox membership and creates its queued provider operation atomically, retaining the reminder if the local write fails.
- Offline drafts are queued until connectivity returns. Aerio detects simultaneous edits from two Aerio editors and provider-side Gmail or Microsoft changes made by another client, preserving the stale edit as a separate copy when requested.
- Google and Microsoft Calendar events and provider Contacts are writable after reconnection. New contacts remain local by default and can explicitly target a connected provider account. The Calendar window covers one year in the past through two years in the future and is maintained with per-calendar incremental checkpoints.
- A Google contact without a cached revision must be refreshed before editing; Aerio does not fetch a newer revision to authorize saving older editor contents.
- Google Keep and consumer Google Chat do not expose suitable general synchronization APIs. Aerio Notes remain local; the optional [OneNote adapter design](docs/onenote-adapter-design.md) is complete but not implemented. The [Chat proposal](docs/chat-implementation-proposal.md) recommends an independent Matrix connector with defined security and recovery gates; Chat remains unimplemented and outside v1 navigation.
- Windows is the established packaging target. Experimental Linux x64 AppImage/DEB and macOS Intel/Apple Silicon DMG/ZIP packaging, native secure-storage restarts, desktop checks and packaged-container launches pass in hosted CI. Linux evidence covers extracted containers; macOS evidence includes extracted ZIPs and read-only mounted DMGs. The [platform compatibility assessment](docs/platform-compatibility.md) records CI links and the limits of this evidence, including signed distribution and physical desktop interactions. The credential vault refuses Linux's weak storage fallback.
