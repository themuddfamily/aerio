# Mail Quick Actions

A Quick Action is a named, ordered sequence of existing mail actions (mark
read/unread, star, importance, apply or remove a label, move to a folder or
label, archive, move to Inbox, Trash, or restore from Trash) that runs in one
step. Manage them from **Quick actions** in the Mail sidebar footer.

## Running

A Quick Action runs on the checked conversations, or on the open conversation
when nothing is checked. It can be started from:

- the selection toolbar and the reader toolbar, for actions marked
  **Show on the message and selection toolbars**;
- the conversation context menu (`Quick action: <name>`). Right-clicking a
  checked conversation runs it on the whole selection;
- an optional shortcut slot, 1 to 9, by default Ctrl+Shift+1 to Ctrl+Shift+9
  (Cmd+Shift on macOS). Each slot's key can be changed or cleared in
  Settings › Keyboard shortcuts ([keyboard shortcuts](keyboard-shortcuts.md)).
  Shortcuts are ignored while focus is in a text field, list box, or dialog,
  and each slot can belong to only one Quick Action;
- the command palette (Ctrl+K) while Mail is open (`Run quick action: <name>`).

## Behaviour

- **Queued mutations.** Each step becomes an ordinary operation in the durable
  provider queue (`gmail_operations`) with the usual ten-second Undo window,
  so local state changes immediately and offline runs are sent after
  reconnecting. Queue execution is ordered by `created_at` and then insertion
  order, so steps reach the provider in the order shown.
- **Undo.** The Undo toast reverts every queued step, newest first, so each
  step's snapshot restores onto the state it captured.
- **Account scope.** Steps without a destination work on any account. Label,
  remove-label, and move steps need the Quick Action to be scoped to one
  account; selections from other accounts are skipped and reported.
- **Run-time validation.** Before anything is applied to an account, Aerio
  checks that the account still exists, is not a read-only disconnected
  archive, matches the Quick Action's scope, and still has every destination
  label or folder (Gmail Inbox, Spam, and Trash are always valid). Labels are
  Gmail-only; folder providers can use move steps.
- **Partial failure.** Accounts are processed independently. If a step fails
  for an account, its remaining steps are not applied; earlier steps stay
  applied and can be undone. The result toast names each skipped or partly
  updated account, the failing step, and the reason.
- **Persistence.** Quick Actions are stored in the `mail_quick_actions` table
  of the local mail database (created idempotently) and are deleted with their
  account. Limits: 80-character names, 10 steps, 1,000 conversations per run.

## Known limits

- Provider failures after a step has been queued follow the normal queue
  behaviour: retries with backoff, then the failed step's local snapshot is
  restored. Later steps of the same run are not cancelled automatically, and a
  restored snapshot can overwrite their local effect until the next sync.
- Retries may let a later step reach the provider before an earlier failing
  step.
- Microsoft categories are not exposed as labels, so label steps are not
  available for Outlook or IMAP accounts.
- Snooze, reply, and forward are not available as steps.
