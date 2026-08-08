# Changelog

## 0.5.0 — 2026-08-08

### Added

- Unread message counts for every mail folder and connected account.
- Animated expansion and collapse for individual messages in a conversation.
- Recurring local tasks that schedule their next occurrence, plus user-created task lists.
- Configurable Calendar reminders and Microsoft Calendar event creation, editing, and deletion.
- Automatic Calendar and Contacts refresh every 15 minutes.
- Editable local Contacts alongside cached provider contacts.
- Create, edit, and delete Google and Microsoft provider contacts after reconnecting for write access.
- Validated export and restore for local Contacts, Tasks, and Notes.
- Real Help and What’s New panels, and Ctrl-K searches that reach the Mail view.

### Changed

- Chat is no longer shown in the v1 module rail while its transport and security model remain undecided.
- Tray settings now explain their relationship to scheduled sending, snooze, rules, and background synchronization.
- Draft saves detect stale Aerio editor revisions and offer to preserve the stale edit as a separate copy.

### Fixed

- Folder and account unread badges now use account-aware aggregate counts.
- Rapid consecutive draft saves now receive distinct, monotonic revision timestamps.
