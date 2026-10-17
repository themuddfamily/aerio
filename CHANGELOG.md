# Changelog

## Unreleased

### Added

- Scheduling assistant in the event editor: a free/busy timeline for the organizer, required and optional attendees, and resources, using Google Calendar `freeBusy` or Microsoft Graph `getSchedule` depending on the organizer's calendar. Unavailable data (external domains, unshared calendars, permission gaps, provider errors) is hatched as unknown and never counted as free; Outlook working hours and your own working hours shape the next suggested slots; times show in your zone with an optional second zone. New Google connections request `calendar.freebusy`; older Google accounts are offered a reconnect from the assistant. See `docs/scheduling-assistant.md`.
- Calendar recurrence and time zones: every occurrence of a repeating local or imported event appears in month, week, day, and agenda views; a repeat editor covers intervals, weekdays, nth/last weekdays, yearly rules, and end dates or counts; rules Aerio cannot edit are kept read-only rather than dropped. Saving or deleting a repeating event asks for this event, this and following events, or all events, on local calendars, Google (recurringEventId/originalStartTime), and Microsoft (seriesMasterId/patternedRecurrence). Events keep named time zones and all-day dates, and week and day views can show a secondary time zone.
- Richer message composition: font, size, text and highlight color, strikethrough, alignment, numbered lists, tables, and inline images (insert, paste, or drop) in the composer. Pasted HTML is sanitized with a strict tag/attribute/CSS allowlist that strips Word and Office markup, remote images, scripts, and handlers; Ctrl+Shift+V pastes plain text. Inline images are embedded in the draft, survive autosave and reopening, and are sent as multipart/related Content-ID parts next to the plain-text alternative for Gmail, Microsoft, and SMTP. Rich signatures and templates now keep tables, fonts, colors, and safe inline styles when sent.
- Optional AI assistance, off by default: summarize an email or get suggested replies from its menu, draft or rephrase from the composer, and ask for a search in plain language. Works with the Anthropic Messages API or an OpenAI-compatible endpoint (including local Ollama). The API key is encrypted with OS secure storage and never reaches the renderer; Settings › AI assistance lists exactly what each feature sends and lets you turn features and sender details on or off. Email content is passed as delimited untrusted data, the model has no tools, output is shown as plain-text previews, and inserting text, opening a reply, or running a proposed search (validated by the search parser) always needs a click. Requests can be cancelled and time out after 60 seconds. Translation and manual meeting/task creation are unchanged.
- QuickText snippets and whole-message mail templates with subject, sanitized HTML, and managed attachments; search, edit, and insert them from the composer without losing the editor selection, and back them up with local data or as a standalone template file.
- Sender identities: Gmail send-as aliases and Microsoft mailbox aliases are discovered automatically, IMAP and shared-mailbox addresses can be added manually, and each identity has a Reply-To, a default flag, and separate HTML signatures for new messages and replies. The composer swaps only the marked signature block when From changes, drafts keep their identity and Reply-To, and provider send-as refusals keep the message as a failed draft with a clear explanation.
- Watch for replies: turn it on in the composer or from a sent message’s menu, with an optional deadline. Aerio matches replies by Message-ID references and the provider thread for the sending account, notifies from the background or tray when a recipient answers or the deadline passes without a reply, and lists active and past watches under Mail › Reply watches, where they can be cancelled.
- Full-profile backup and restore in Settings: daily, 3-day, or weekly snapshots (or on demand) of the mail cache, drafts, queued changes, rules, templates, local Tasks/Notes/Contacts, connected-task cache, and preferences, using SQLite's online backup API with per-file SHA-256 checksums and keep-N retention. Restore verifies and previews the backup, migrates and stages it, then swaps it in on restart with automatic rollback if the swap fails or is interrupted. Credentials are never included, restored outgoing and scheduled sends are held in Drafts for review, connected task writes wait for review, and accounts reauthorize.
- User-defined mail Quick Actions: save ordered sequences of mail actions (read, star, label, move, archive, Trash, and more) and run them on the selection from the toolbars, the conversation context menu, the command palette, or Ctrl+Shift+1–9. Steps use the queued operation pipeline with Undo; account-specific destinations are checked at run time and skipped or partly updated accounts are reported. Undo of several queued changes now reverts them newest first, and queued operations created in the same millisecond reach the provider in insertion order.

- Attachment-content search: text from PDF, Word, Excel, PowerPoint, and plain-text or HTML attachments is extracted on the device in an isolated worker with memory, time, and size limits and indexed with the message, so `attachment:` and ordinary searches find words inside attachments as well as their filenames. The reader notes attachments that can't be searched because they are password-protected, too large, or unreadable; indexing resumes incrementally and an account's extracted text is removed when the account is deleted.
- Cloud attachments (opt-in): share a file from the composer as a Google Drive (`drive.file`) or OneDrive (`Files.ReadWrite`) link instead of attaching it. The sharing scope (anyone with the link, people in the organization, or only the recipients; view or edit) is shown before upload, attachments over the provider limit get a "share as cloud link" offer, and ordinary attachments are unchanged. Uploads run in the main process in resumable chunks with progress and cancel, resume after a restart from an encrypted session record or are cleared when they can't, and links Aerio created are re-checked before sending so deleted files, removed permissions, and expired links are reported. The storage permission is added by an explicit reconnect that keeps existing grants.
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
