# Aerio

Aerio is a calm, modern desktop communications client for Windows. It supports multi-provider mail, writable Google and Microsoft Calendar and Contacts synchronization, and local Contacts, Tasks, and Notes.

## Real-mail alpha

- Gmail through the Gmail API; Outlook.com and Microsoft 365 through Microsoft Graph
- iCloud, Yahoo/AOL, Fastmail, Proton Mail Bridge, and custom-domain mail through IMAP/SMTP
- Multiple mixed-provider accounts and unified folders, with no hard-coded account limit
- Complete mailbox inventory, including Spam and Trash, followed by newest-first offline download
- Raw RFC 2822 messages, MIME bodies, and attachments stored locally
- Resumable sync checkpoints, Gmail History, Microsoft delta links, IMAP folder reconciliation, 15-second active/one-minute background polling, and manual pause/resume
- SQLite-backed folder views, infinite scrolling, and full-text offline search
- Single and multi-select Archive, read/unread, star, importance, move, label, and Trash actions
- Optimistic local changes with exact-state Undo, retry/backoff, and a durable provider operation queue
- Editable provider drafts with idle autosave, rich-text composition, recipient suggestions, signatures, forwarding attachments, scheduled delivery, ten-second Undo Send, SMTP delivery, and an offline Outbox
- Persistent snooze/remind-later with automatic Inbox restoration, plus account-specific rules for sender, recipient, subject, and body filtering
- Per-account identity, synchronization, notification, OAuth, IMAP/SMTP, connection-test, and local-rebuild settings
- Privacy-redacted diagnostics, storage-integrity checks, and native new-mail notifications that open the relevant conversation
- Sanitized HTML; scripts and unsafe links are removed, and remote images are blocked by default
- Dedicated message windows for provider mail; double-click a conversation to open or focus its window
- Read-only local archive or complete local deletion when disconnecting an account
- Google and Microsoft Calendar synchronization with event creation, editing, deletion, recurrence, and configurable reminders
- Writable Google and Microsoft provider Contacts plus editable local Contacts, with portable backup and restore for local Contacts, Tasks, Notes, and managed note attachments
- Optional local passphrase privacy lock at launch, when Aerio is sent to the tray, or on demand

Tasks, Notes, and local Contacts are production local modules. Chat is outside the v1 navigation until a secure transport is selected. Provider Calendar and Contacts data refreshes automatically every 15 minutes and can also be refreshed with **Sync now**. Refreshes use persisted Google sync tokens and Microsoft delta links, with an automatic full refresh when a provider expires a checkpoint. Calendar events can be created by double-clicking a day or time slot and edited after granting the event scope once.

## Connect an account

Open the real-mail workspace and choose **Add mail account**. The setup screen explains the requirements for each provider.

### Gmail

Aerio includes its public Google Desktop client ID and compiles its client secret into the Electron main process. It never proxies your mail through an Aerio server. Development builds read the secret from a git-ignored `.env.local`; official builds receive it from a GitHub Actions secret. If a custom build has no complete registration, the account screen retains a JSON-import fallback for developers.

1. Open the [Google Cloud Console](https://console.cloud.google.com/), create or select a project, and enable the **Gmail API**, **Google Calendar API**, and **People API**.
2. Configure the OAuth consent screen. For durable personal use, publish it as **In production** and add only the Google accounts you intend to use if Google requests test users. Refresh tokens issued while the app is in **Testing** normally expire after seven days.
3. Create **OAuth client ID → Desktop app** credentials and download the JSON file.
4. Put its `client_secret` into `.env.local` as `MAIN_VITE_GOOGLE_CLIENT_SECRET`, then rebuild Aerio. The matching public client ID is already Aerio's default; `MAIN_VITE_GOOGLE_CLIENT_ID` can override it for a different registration.
5. Choose Gmail and select **Connect Gmail**. Your normal browser completes Google sign-in and returns to Aerio through a temporary `127.0.0.1` callback.

Aerio requests Gmail modify access, read-only Calendar-list access, Google Calendar event read/write access, and Contacts read/write access. It does not request permission to create or share calendars or permanently delete Gmail messages. Existing accounts connected by an older Aerio build must choose **Enable editing** in Calendar or Contacts (or **Account settings → Reconnect**) once to approve the added write scopes.

The first download is quota-bound. A mailbox with 100,000 messages can take roughly seven hours or more, depending on message size, retries, and Google’s per-user quota. Progress is persistent; quitting, losing connectivity, or pausing does not discard completed work.

### Outlook and Microsoft 365

1. Create an app registration in [Microsoft Entra](https://entra.microsoft.com/).
2. Enable public client flows and add the **Mobile and desktop applications** redirect URI `http://localhost`.
3. Aerio's public Application (client) ID is already included. Choose Microsoft and sign in. The browser requests delegated `User.Read`, `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, and `Contacts.ReadWrite` access. Existing connections must reconnect once to grant Calendar and Contacts editing.

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
- Settings can export and restore local Contacts, Tasks, Notes, and managed note attachments as a validated JSON backup (up to 100 MB of attachment data). Provider mail and cached provider data are intentionally excluded because they can be synchronized again.

Application preferences live in `aerio-state.sqlite`. On first launch after this change, Aerio imports only appearance, customized profile, notification, startup, and tray preferences from the former workspace database when available; sample content and the old sample persona are neither loaded nor copied. The legacy database is left untouched.

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
npm run test:desktop:visible # Show Electron windows while debugging a failure
npm run build
npm run package:win
```

Desktop tests run with every Electron window hidden by default. If an interaction fails, rerun the same suite with `npm run test:desktop:visible` to watch it in real time.

Windows packages are written to `release/`. They are unsigned development builds, so Windows may show a reputation warning.

## Architecture

The app uses Electron 43, React 19, TypeScript, Vite, and local SQLite databases:

- The renderer is sandboxed and has no Node.js access.
- The main process owns OAuth, OS dialogs, safe storage, external navigation, and a typed IPC boundary.
- A dedicated Node worker owns the normalized mail database, Gmail/Graph/IMAP synchronization, SMTP delivery, MIME parsing, full-text search, queued mutations, and drafts.
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

- Multi-provider support is an alpha. Gmail has not been submitted for Google OAuth verification, and Microsoft uses the app registration supplied by the user.
- Automated tests use mocked provider responses. Live validation requires real provider accounts, app registrations, or app passwords.
- IMAP has no universal standard for Archive or special folders. Aerio reports an error instead of guessing when a server does not advertise a required destination.
- IMAP can store multiple physical copies of the same message, but Aerio presents them as one logical conversation and keeps every location available for folder actions.
- Scheduled delivery, Undo Send, snooze, and rules are coordinated locally by Aerio. If Aerio is fully quit at a due time, the action resumes when it next starts; keeping it in the tray allows on-time processing, and Settings can start Aerio automatically after Windows sign-in.
- Offline drafts are queued until connectivity returns. Aerio detects and preserves simultaneous edits from two Aerio editors; provider-side revision conflict detection for edits made in another mail client remains future work.
- Google and Microsoft Calendar events and provider Contacts are writable after reconnection. New contacts remain local by default and can explicitly target a connected provider account. The Calendar window covers one year in the past through two years in the future and is maintained with per-calendar incremental checkpoints.
- Google Keep and consumer Google Chat do not expose suitable general synchronization APIs. Aerio Notes remain local, and Chat stays out of the v1 navigation until a transport and security model are defined.
- Windows is the tested packaging target; macOS and Linux packaging are not configured.
