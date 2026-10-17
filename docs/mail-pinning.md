# Pinned mail conversations

Pinning keeps a conversation at the top of the conversation list until it is
unpinned. It is an Aerio-only organizing aid: pins are stored on this computer
and are never sent to Gmail, Microsoft 365, IMAP servers, or Local Folders
providers.

## Pinning and unpinning

- **Conversation context menu:** right-click a conversation (in the list, an
  expanded thread preview, or the reader) and choose **Pin to top** or
  **Unpin conversation**. Right-clicking a checked conversation applies the
  change to the whole selection.
- **Selection toolbar:** with conversations checked, **Pin** pins them all;
  when every checked conversation is already pinned the button becomes
  **Unpin**.
- **Reader toolbar:** **Pin** / **Unpin** next to **Star**.
- **Command palette (Ctrl+K / Cmd+K) while Mail is open:** **Pin selected
  conversations to the top** and **Unpin selected conversations** act on the
  checked conversations, or on the open conversation when nothing is checked.
- **Quick Actions:** a step can be **Pin to top** or **Unpin**.

Every pin change shows the usual Undo toast. Undo restores the exact state
captured before the change, so pinning a selection that already contained a
pinned conversation and then undoing leaves that conversation pinned in its
original position. After the toast is gone the change is reversed by pinning
or unpinning again.

Pins are local, so conversations in a disconnected, read-only account archive
can still be pinned and unpinned.

## Ordering

Every folder, label, search, and the **All accounts** (unified) view lists:

1. pinned conversations, most recently pinned first; then
2. every other conversation in the normal newest-first date order.

Pinned conversations are ordered by when they were pinned rather than by
their latest message, so a new reply in a pinned conversation, or new mail
arriving anywhere, never reshuffles the pinned group. A new conversation
always appears below the pinned group. Re-pinning an already pinned
conversation keeps its original position. The list shows a **Pinned** heading
above the pinned group and the usual date headings after it.

Pinning does not change which folder a conversation is in: a pinned
conversation that is archived, moved, or trashed stays pinned and is listed
first wherever it now appears. Unread counts and folder totals are unaffected.

### Pagination

The list cursor records the pin time (empty for unpinned rows) as well as the
date, thread id, and account id of the last row, and the database orders by
`(pinned_at, last_date, thread id, account id)` descending. Pages therefore
continue correctly whether a boundary falls inside the pinned group or after
it, without gaps or duplicates. Cursors issued by earlier Aerio versions,
which carry no pin time, continue in the unpinned part of the list.

## Scope and identity

A pin belongs to one account's conversation, identified by the account id and
the provider thread id (`mail_pins(account_id, thread_id)`). Two accounts that
happen to use the same thread id are pinned independently, including in the
unified view.

The pin is not attached to the cached copy of the conversation. When a resync
or a folder reconciliation removes the cached messages and downloads them
again under the same thread id, the conversation returns pinned. Removing an
account's downloaded data (**Disconnect account** › delete) removes its pins;
keeping it as a read-only archive keeps them.

Providers that assign a new thread id when a conversation moves (for example,
an IMAP server whose thread identity follows the folder) produce a different
conversation as far as Aerio is concerned; that conversation is not pinned.

## Relationship to stars and importance

Pins, stars, and importance are independent:

- Pinning never stars a conversation or marks it important, and starring,
  unstarring, or changing importance never pins or unpins it.
- Stars and importance are provider state: they are synchronized (Gmail
  `STARRED`/`IMPORTANT`, Outlook flags, IMAP `\Flagged`) and appear in the
  **Starred** and **Important** folders. Pins are local and only affect the
  order of the list.
- Mail rules cannot pin, because rules can run on the server where pins do
  not exist.

## Storage, backup, and restore

Pins are stored in the mail database (`aerio.sqlite`, table `mail_pins`), so
they survive restarts and are included in profile backups. A backup preview
lists **Pinned conversations** with the number of pins it contains, and a
restore brings them back with the rest of the mail database. The undo
snapshots for recent pin changes (`mail_pin_operations`) are kept for seven
days.

Pin and unpin changes are recorded in the mail operation log as `pin` and
`unpin` operations that are already complete. They are never placed in the
provider queue, and the mail worker refuses to send them to a provider even if
one were queued.
