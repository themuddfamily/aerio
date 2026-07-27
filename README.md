# Aerio

Aerio is a calm, modern desktop communications and productivity client for Windows. This first release is an offline, interactive product preview: it includes realistic demo accounts and a complete local workflow without asking for email credentials or sending data across the network.

## What’s included

- Unified mail with folders, search, filters, triage actions, attachments, drafts, replies, signatures, and scheduled-send UI
- Month, week, day, and agenda calendars with editable recurring events
- Contacts, groups, favourites, notes, and recent communication context
- Tasks with lists, priorities, due dates, recurrence, subtasks, completion, and drag ordering
- Searchable, tagged notes with pinning, archiving, and autosave
- Local chat conversations, attachments, reactions, presence, and simulated replies
- Light/dark themes, compact mode, custom title bar, system tray, native notifications, keyboard shortcuts, and local SQLite persistence

All demo changes are saved to Aerio’s application-data directory. Use **Settings → Reset demo data** to return to the original sample workspace.

## Run from source

Requirements: Node.js 22 or newer and Windows 10/11.

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

Windows packages are written to `release/`. The current packages are unsigned development builds, so Windows may show a reputation warning.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+K` | Search and command palette |
| `Ctrl+N` | New message |
| `Ctrl+1`…`Ctrl+6` | Switch between modules |
| `Esc` | Close the active overlay |

## Architecture

Aerio uses Electron, React, TypeScript, Vite, and SQLite via `sql.js`. The renderer is sandboxed and has no Node.js access. A small typed preload bridge exposes approved desktop operations, while local persistence remains in the main process.

The domain types and mail-provider interface are deliberately provider-neutral. The demo provider can later be replaced with Gmail, Microsoft Graph, or IMAP/SMTP adapters without coupling provider credentials or synchronization logic to the interface.

## Current limitations

- Demo accounts do not connect to real email providers or send messages.
- Attachments are referenced locally and are not uploaded.
- Calling and video controls are illustrative.
- Windows is the tested packaging target; macOS packaging is not configured yet.
