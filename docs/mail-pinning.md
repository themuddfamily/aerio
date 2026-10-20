# Pinned mail conversations

Pinning keeps a conversation at the top of the conversation list until it is
unpinned. Pins remain distinct from stars and importance. Verified writable IMAP
folders can synchronize a dedicated `$AerioPinned` keyword between Aerio
installations. Other providers and unsupported folders retain local pins.
This is Aerio-specific server storage, not a claim of native Outlook or eM Client pin interoperability.

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

Disconnected/read-only account archives can still be pinned locally. The reader
shows the pin synchronization scope for pinned conversations and for supported
IMAP conversations, including when a change is queued.

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
conversation as far as local pins are concerned. On supported IMAP folders,
the dedicated keyword reads back onto the new cached identity when the server
preserves keywords through the move.

## Relationship to stars and importance

Pins, stars, and importance are independent:

- Pinning never stars a conversation or marks it important, and starring,
  unstarring, or changing importance never pins or unpins it.
- Stars and importance are provider state: they are synchronized (Gmail
  `STARRED`/`IMPORTANT`, Outlook flags, IMAP `\Flagged`) and appear in the
  **Starred** and **Important** folders. Pins only affect list ordering and use
  a separate dedicated IMAP keyword where supported.
- Mail rules currently do not expose a Pin action.

## Storage, backup, and restore

Pins are stored in the mail database (`aerio.sqlite`, table `mail_pins`), so
they survive restarts and are included in profile backups. A backup preview
lists **Pinned conversations** with the number of pins it contains, and a
restore brings them back with the rest of the mail database. The undo
snapshots for recent pin changes (`mail_pin_operations`) are kept for seven
days.

Pin and unpin changes apply to the local ordering immediately. Unsupported
providers/folders record completed local operations. Supported IMAP conversations
also queue `pin`/`unpin` writes in the durable mail operation queue, preserving
its existing retry/backoff and interrupted-work recovery. Provider failure is
reported through the usual operation error. Final failure restores the prior
local snapshot without overwriting a newer local pin change.

## Verified IMAP keyword synchronization (D22)

- A folder must advertise either permanent custom keywords (`PERMANENTFLAGS \*`)
  or the dedicated `$AerioPinned` keyword and be writable. Unknown capability,
  read-only folders, missing UID identity, archived accounts and non-IMAP
  providers explicitly report local-only capability. Support is reported per
  conversation because its messages may span folders with different rights.
- Pin writes set only `$AerioPinned`; unpin removes only that keyword. The worker
  checks live folder capability and UIDVALIDITY before `UID STORE`, and verifies
  each affected UID with a flags fetch. A rejected STORE, missing readback or
  mismatched pin state remains a retryable operation failure.
- A conversation reads as pinned when any of its cached messages carries the
  dedicated keyword. Pin/unpin writes cover every currently cached message in
  the selected conversation. IMAP has no universal conversation-wide pin
  primitive; uncached copies may retain a keyword until synchronized and edited.
- Sync imports server pins and external unpins. Pending local pin operations
  take precedence until they settle; afterward server readback is authoritative.
  On first capability discovery, existing local pins queue a one-time upload
  instead of disappearing. Re-pinning preserves the local ordering timestamp;
  another installation establishes its own ordering timestamp on first readback.
- Undo cancels an unsent native write. After dispatch, Undo restores the exact
  local snapshot and queues compensating keyword writes, including mixed
  selections whose conversations had different prior pin states. Multi-message
  IMAP updates are not atomic; an exhausted failure may leave partial remote
  writes, which the next sync reads back explicitly.
- Gmail, Microsoft Graph, Exchange EWS, POP3 and Local Folders keep local pins.
  Fastmail's documented native Pin maps to starring, so Aerio does not pretend
  that mapping is an independent pin. No verified documented dedicated Graph/EWS
  native pin mapping was established during this change. Generic categories,
  follow-up flags and guessed Outlook extended-property IDs are not used.

Protocol sources reviewed on 20 October 2026:

- [IMAP4rev2, RFC 9051](https://www.rfc-editor.org/rfc/rfc9051.html): permanent
  keywords, mailbox read-only state, UIDVALIDITY, STORE and FETCH.
- [IMAP keyword registry, RFC 5788](https://www.rfc-editor.org/rfc/rfc5788): keyword
  registration and semantics. `$AerioPinned` is an Aerio-specific keyword, not a
  registered universal pin convention.
- [Fastmail native pins](https://www.fastmail.help/hc/en-us/articles/1500000280341-Pin-important-messages):
  native pins may appear as stars in other clients; Aerio keeps these separate.
- [Graph message resource](https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0)
  and [EWS Message schema](https://learn.microsoft.com/en-us/exchange/client-developer/web-service-reference/message-ex15websvcsotherref):
  no dedicated verified native pin mapping was identified. Exchange pin metadata
  remains a future evidence requirement rather than an inferred implementation.

Controlled tests cover capability checks, durable restart, external readback,
local-pending conflicts, exact Undo, failure recovery and newer-intent protection.
`npx tsx scripts/imap-pin-sync-audit.mjs` exercises a real disposable TLS IMAP
server: permanent-keyword detection, STORE/FETCH, queue restart, a second local
installation reading the pin, external unpin and star independence. This fixture
is protocol evidence; no customer-provider account was used.
