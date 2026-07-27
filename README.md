# Aerio

Aerio is a calm, modern desktop email client for Windows. Version 0.2 adds an early real-Gmail workspace alongside the original local demo. The two workspaces stay separate, so you can explore the broader product preview without mixing sample content into a real inbox.

## Gmail alpha

- Multiple Google accounts and unified folders, with no hard-coded account limit
- Complete mailbox inventory, including Spam and Trash, followed by newest-first offline download
- Raw RFC 2822 messages, MIME bodies, and attachments stored locally
- Resumable sync checkpoints, Gmail History catch-up, adaptive foreground polling, and manual pause/resume
- SQLite-backed folder views, cursor pagination, and full-text offline search
- Archive, read/unread, star, importance, label, and Trash actions
- Optimistic local changes with a 10-second Undo window and a durable Gmail operation queue
- Gmail drafts with two-second idle autosave, threaded replies, attachment upload, and an offline Outbox
- Sanitized HTML; scripts and unsafe links are removed, and remote images are blocked by default
- Read-only local archive or complete local deletion when disconnecting an account

Calendar, Contacts, Tasks, Notes, and Chat are still demo modules. They do not read or modify Google data.

## Connect Gmail

Aerio uses your own Google OAuth client. It does not ship a shared secret or proxy your mail through an Aerio server.

1. Open the [Google Cloud Console](https://console.cloud.google.com/), create or select a project, and enable the **Gmail API**.
2. Configure the OAuth consent screen. For durable personal use, publish it as **In production** and add only the Google accounts you intend to use if Google requests test users. Refresh tokens issued while the app is in **Testing** normally expire after seven days.
3. Create **OAuth client ID → Desktop app** credentials and download the JSON file.
4. Run Aerio, switch the badge in the top bar from **Demo workspace** to **Real Gmail**, and choose **Import JSON**.
5. Select **Connect Gmail**. Your normal browser completes Google sign-in and returns to Aerio through a temporary `127.0.0.1` callback.

Aerio requests only `https://www.googleapis.com/auth/gmail.modify`. It does not request permanent-delete access, and the UI intentionally offers only Gmail Trash—not irreversible deletion.

The first download is quota-bound. A mailbox with 100,000 messages can take roughly seven hours or more, depending on message size, retries, and Google’s per-user quota. Progress is persistent; quitting, losing connectivity, or pausing does not discard completed work.

## Local data and security

- OAuth refresh/access tokens are encrypted with Electron `safeStorage` (Windows DPAPI) before they are written to disk.
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
npm run build
npm run package:win
```

Windows packages are written to `release/`. They are unsigned development builds, so Windows may show a reputation warning.

## Architecture

The app uses Electron 43, React 19, TypeScript, Vite, and two local SQLite paths:

- The renderer is sandboxed and has no Node.js access.
- The main process owns OAuth, OS dialogs, safe storage, external navigation, and a typed IPC boundary.
- A dedicated Node worker owns the normalized mail database, Gmail synchronization, MIME parsing, full-text search, queued mutations, and draft delivery.
- The original `sql.js` store remains isolated to the demo workspace.

Automated coverage includes database migration and backup, normalized mail behavior, optimistic Undo, archive/delete semantics, HTML sanitization, mocked Gmail API behavior, the existing demo domain tests, and pagination over a synthetic 100,000-thread mailbox.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+K` | Search and command palette |
| `Ctrl+N` | New message in the demo workspace |
| `Ctrl+1`…`Ctrl+6` | Switch between modules |
| `Esc` | Close the active overlay |

## Current limitations

- Gmail support is an alpha and has not been submitted for Google OAuth verification.
- The repository test suite uses mocked Gmail responses; live-account validation requires your own Desktop OAuth credentials.
- Scheduled send remains demo-only and is not presented as a real Gmail capability.
- Offline drafts are queued until connectivity returns, but conflict resolution with edits made simultaneously in another Gmail client is not yet implemented.
- Windows is the tested packaging target; macOS and Linux packaging are not configured.
