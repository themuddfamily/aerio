# Aerio

Aerio is a calm, modern desktop email client for Windows. Version 0.3 adds a multi-provider real-mail workspace alongside the original local demo. The workspaces stay separate, so sample content never mixes with a real inbox.

## Real-mail alpha

- Gmail through the Gmail API; Outlook.com and Microsoft 365 through Microsoft Graph
- iCloud, Yahoo/AOL, Fastmail, Proton Mail Bridge, and custom-domain mail through IMAP/SMTP
- Multiple mixed-provider accounts and unified folders, with no hard-coded account limit
- Complete mailbox inventory, including Spam and Trash, followed by newest-first offline download
- Raw RFC 2822 messages, MIME bodies, and attachments stored locally
- Resumable sync checkpoints, Gmail History, Microsoft delta links, IMAP folder reconciliation, adaptive polling, and manual pause/resume
- SQLite-backed folder views, cursor pagination, and full-text offline search
- Archive, read/unread, star, importance, label, and Trash actions
- Optimistic local changes with a 10-second Undo window and a durable provider operation queue
- Provider drafts with two-second idle autosave, threaded replies, attachments, SMTP delivery, and an offline Outbox
- Sanitized HTML; scripts and unsafe links are removed, and remote images are blocked by default
- Read-only local archive or complete local deletion when disconnecting an account

Calendar, Contacts, Tasks, Notes, and Chat are still demo modules. They do not read or modify Google data.

## Connect an account

Open the real-mail workspace and choose **Add mail account**. The setup screen explains the requirements for each provider.

### Gmail

Aerio uses your own Google OAuth client. It does not ship a shared secret or proxy your mail through an Aerio server.

1. Open the [Google Cloud Console](https://console.cloud.google.com/), create or select a project, and enable the **Gmail API**.
2. Configure the OAuth consent screen. For durable personal use, publish it as **In production** and add only the Google accounts you intend to use if Google requests test users. Refresh tokens issued while the app is in **Testing** normally expire after seven days.
3. Create **OAuth client ID → Desktop app** credentials and download the JSON file.
4. Run Aerio, switch the badge in the top bar from **Demo workspace** to **Real mail**, choose Gmail, and import the JSON.
5. Select **Connect Gmail**. Your normal browser completes Google sign-in and returns to Aerio through a temporary `127.0.0.1` callback.

Aerio requests only `https://www.googleapis.com/auth/gmail.modify`. It does not request permanent-delete access, and the UI intentionally offers only Gmail Trash—not irreversible deletion.

The first download is quota-bound. A mailbox with 100,000 messages can take roughly seven hours or more, depending on message size, retries, and Google’s per-user quota. Progress is persistent; quitting, losing connectivity, or pausing does not discard completed work.

### Outlook and Microsoft 365

1. Create an app registration in [Microsoft Entra](https://entra.microsoft.com/).
2. Enable public client flows and add the **Mobile and desktop applications** redirect URI `http://localhost`.
3. Copy the Application (client) ID into Aerio. Browser sign-in requests delegated `User.Read`, `Mail.ReadWrite`, and `Mail.Send` access.

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
- Mail metadata and search indexes live in normalized SQLite tables using WAL mode.
- Original `.eml` content is written atomically beneath Aerio’s application-data directory.
- Remote message images are represented by an isolated `aerio-image:` protocol and are fetched only after an explicit per-conversation choice.
- External HTTP(S) and `mailto:` links open in the system browser/mail handler rather than navigating Aerio.
- Mailbox files are protected by the Windows user account and disk encryption. Enable BitLocker if the device may be lost or shared.

Before the v0.2 schema is created, an existing v0.1 database is preserved as `aerio.sqlite.v0.1.bak`. Demo state moves to its own `aerio-demo.sqlite` file.

## Run from source

Requirements: Node.js 24 or newer and Windows 10/11.

```powershell
npm install
npm run dev
```

Useful commands:

```powershell
npm run typecheck
npm test
npm run audit:buttons
npm run audit:context-menus
npm run test:desktop
npm run build
npm run package:win
```

Windows packages are written to `release/`. They are unsigned development builds, so Windows may show a reputation warning.

## Architecture

The app uses Electron 43, React 19, TypeScript, Vite, and two local SQLite paths:

- The renderer is sandboxed and has no Node.js access.
- The main process owns OAuth, OS dialogs, safe storage, external navigation, and a typed IPC boundary.
- A dedicated Node worker owns the normalized mail database, Gmail/Graph/IMAP synchronization, SMTP delivery, MIME parsing, full-text search, queued mutations, and drafts.
- The original `sql.js` store remains isolated to the demo workspace.

Automated coverage includes database migration and backup, normalized mail behavior, provider preset validation, Microsoft delta pagination, optimistic Undo, archive/delete semantics, HTML sanitization, mocked Gmail API behavior, the existing demo domain tests, and pagination over a synthetic 100,000-thread mailbox. Static interaction-contract audits and Playwright-driven Electron passes cover buttons, feature context menus, editing/link/image menus, module actions, account onboarding, and native window controls.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+K` | Search and command palette |
| `Ctrl+N` | New message, or account setup when real mail has no account |
| `Ctrl+1`…`Ctrl+6` | Switch between modules |
| `Shift+F10` | Open the context menu for the focused item |
| `Esc` | Close the active overlay |

## Current limitations

- Multi-provider support is an alpha. Gmail has not been submitted for Google OAuth verification, and Microsoft uses the app registration supplied by the user.
- Automated tests use mocked provider responses. Live validation requires real provider accounts, app registrations, or app passwords.
- IMAP has no universal standard for Archive or special folders. Aerio reports an error instead of guessing when a server does not advertise a required destination.
- IMAP mailboxes that expose the same message in multiple physical folders may show separate offline copies.
- Scheduled send remains demo-only and is not presented as a real Gmail capability.
- Offline drafts are queued until connectivity returns, but conflict resolution with edits made simultaneously in another client is not yet implemented.
- Windows is the tested packaging target; macOS and Linux packaging are not configured.
