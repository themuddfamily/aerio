# Changelog

## Unreleased

### Added

- QuickText snippets and whole-message mail templates with subject, sanitized HTML, and managed attachments; search, edit, and insert them from the composer without losing the editor selection, and back them up with local data or as a standalone template file.
- Watch for replies: turn it on in the composer or from a sent message’s menu, with an optional deadline. Aerio matches replies by Message-ID references and the provider thread for the sending account, notifies from the background or tray when a recipient answers or the deadline passes without a reply, and lists active and past watches under Mail › Reply watches, where they can be cancelled.
- Advanced mail rules: Cc, header, attachment, size, age, importance, and folder/label conditions; “except if” exceptions; and outgoing rules that run on new Sent mail. A per-message ledger keyed by Message-ID makes sure a message is never processed twice, including after resyncs and IMAP folder moves. Existing rules keep their stored format and behavior.
- Server rules: upload a rule as a Gmail filter (`users.settings.filters`) or an Outlook inbox rule (Graph `messageRules`), list, update, turn off (Outlook), or remove provider rules, and see which conditions or actions can't map to the server. An uploaded rule runs only on the server. Accounts without the new `gmail.settings.basic` or `MailboxSettings.ReadWrite` permission are asked to reconnect.

### Changed

- Incoming rules no longer run on new drafts or Sent-only copies; use an outgoing rule for sent mail. “Equals” on To or Cc now also matches a single recipient’s address or name.

## 0.5.0 — 2026-08-08

### Added

- Unread message counts for every mail folder and connected account.
- Animated expansion and collapse for individual messages in a conversation.
- Recurring local tasks that schedule their next occurrence, plus user-created task lists.
- Configurable Calendar reminders and Microsoft Calendar event creation, editing, and deletion.
- Automatic Calendar and Contacts refresh every 15 minutes.
- Editable local Contacts alongside cached provider contacts.
- Create, edit, and delete Google and Microsoft provider contacts after reconnecting for write access.
- Incremental Google Calendar/People sync tokens and Microsoft Calendar/Contacts delta links with expired-cursor recovery.
- Validated export and restore for local Contacts, Tasks, and Notes.
- Managed Notes attachments with safe local copies, open/remove controls, search, cleanup, and portable backup/restore.
- An optional local passphrase app lock at launch, on tray close, or on demand with Ctrl-L.
- Real Help and What’s New panels, and Ctrl-K searches that reach the Mail view.

### Changed

- Chat is no longer shown in the v1 module rail while its transport and security model remain undecided.
- Tray settings now explain their relationship to scheduled sending, snooze, rules, and background synchronization.
- Draft saves detect stale Aerio editor revisions and Gmail or Microsoft drafts changed by another client, then offer to preserve the stale edit as a separate copy.

### Fixed

- Folder and account unread badges now use account-aware aggregate counts.
- Rapid consecutive draft saves now receive distinct, monotonic revision timestamps.
