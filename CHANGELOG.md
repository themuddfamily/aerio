# Changelog

## Unreleased

### Added

- Optional AI assistance, off by default: summarize an email or get suggested replies from its menu, draft or rephrase from the composer, and ask for a search in plain language. Works with the Anthropic Messages API or an OpenAI-compatible endpoint (including local Ollama). The API key is encrypted with OS secure storage and never reaches the renderer; Settings › AI assistance lists exactly what each feature sends and lets you turn features and sender details on or off. Email content is passed as delimited untrusted data, the model has no tools, output is shown as plain-text previews, and inserting text, opening a reply, or running a proposed search (validated by the search parser) always needs a click. Requests can be cancelled and time out after 60 seconds. Translation and manual meeting/task creation are unchanged.
- QuickText snippets and whole-message mail templates with subject, sanitized HTML, and managed attachments; search, edit, and insert them from the composer without losing the editor selection, and back them up with local data or as a standalone template file.
- Sender identities: Gmail send-as aliases and Microsoft mailbox aliases are discovered automatically, IMAP and shared-mailbox addresses can be added manually, and each identity has a Reply-To, a default flag, and separate HTML signatures for new messages and replies. The composer swaps only the marked signature block when From changes, drafts keep their identity and Reply-To, and provider send-as refusals keep the message as a failed draft with a clear explanation.
- Watch for replies: turn it on in the composer or from a sent message’s menu, with an optional deadline. Aerio matches replies by Message-ID references and the provider thread for the sending account, notifies from the background or tray when a recipient answers or the deadline passes without a reply, and lists active and past watches under Mail › Reply watches, where they can be cancelled.
- User-defined mail Quick Actions: save ordered sequences of mail actions (read, star, label, move, archive, Trash, and more) and run them on the selection from the toolbars, the conversation context menu, the command palette, or Ctrl+Shift+1–9. Steps use the queued operation pipeline with Undo; account-specific destinations are checked at run time and skipped or partly updated accounts are reported. Undo of several queued changes now reverts them newest first, and queued operations created in the same millisecond reach the provider in insertion order.

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
