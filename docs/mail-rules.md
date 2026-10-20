# Mail rules: local, outgoing, and server-side

Open **Mail rules** from a message’s **Create rule from email…** command. Every rule belongs to one account and has conditions, optional "except if" exceptions, and actions. Each rule runs in exactly one place, and the rule list shows which:

- **On this computer** (the default). Aerio applies the rule while it is running, including from the tray.
- **On the server.** The rule is uploaded as a Gmail filter or an Outlook inbox rule. From then on, Aerio no longer runs it locally, so the same message is never processed by both copies.

## Conditions and exceptions

### Ready-made rule library

Choose **Rule library** in the Mail rules window to start with highlighting a sender, filing newsletters, organizing receipts and invoices, collecting attachments, archiving older mail, flagging large messages, filing sent project mail, or reading routine notifications.

Each starter opens in the normal editor as a disabled draft for the first available account. You can change the account, name, incoming/outgoing trigger, every condition, exceptions, and every action. Guidance explains the values to fill in; sender/project starters require your own text, and filing starters require a destination from the chosen account. Selecting a starter does not save or run anything. Enable and save it when ready. Archiving older mail includes an exception for important messages and is intended for **Run on existing Inbox**.

Starters create independent local rules. Server compatibility and uploading work as usual after saving; the library does not bypass provider limitations.

| Field | Comparisons | Notes |
| --- | --- | --- |
| From, To or Cc, Cc, Subject, Message body | contains, equals, starts with, ends with | Case-insensitive. "Equals" on From/To/Cc matches the address, the display name, or the full recipient. |
| Header | contains, equals, starts with, ends with | Needs a header name, such as `List-Id`. Headers are read from the stored raw message only when a rule needs them. |
| Has attachments | is yes / no | |
| Size (KB) | more than / less than | Uses the provider's message size. |
| Age (days) | older than / newer than | Mostly useful with **Run on existing mail**. New mail is usually a few minutes old. |
| Importance | is high / normal / low | Taken from the `Importance`, `Priority`, or `X-Priority` header, otherwise from the provider's Important label. |
| Folder or label | is | Exact folder or label id. |
| Inbox category | is | The inbox tab the conversation is in when the rule runs (a turned-off tab counts as Primary). See [inbox categories](inbox-categories.md). |

Conditions use **all** or **any**. The rule is skipped when **any** exception matches. When information is missing (for example, a header in a message whose raw file is gone), the condition does not match.

Rules saved before this release keep their stored format. They read as incoming, locally executed rules with no exceptions. The database adds the `exceptions_json`, `trigger_mode`, `execution` and `server_rule_id` columns with `PRAGMA table_info` checks.

## Incoming, outgoing, and Archive rules

**Apply to** chooses the trigger:

- **New mail I receive** (incoming): newly synced messages that aren't drafts and aren't Sent-only. A Gmail message you send to yourself carries both Inbox and Sent, so it is processed once as incoming and once as outgoing.
- **Mail I send** (outgoing): newly synced Sent copies. This covers mail sent from Aerio, which picks up its Sent copy on the sync after delivery, and mail sent from other clients. "Run on existing mail" for an outgoing rule looks at Sent conversations instead of the Inbox.
- **Mail I archive** (archive): an explicit **Archive** action in Aerio for your own mailbox, including bulk selection and quick actions. Conditions and exceptions match each selected conversation's newest message before Archive changes its labels, so a source-folder condition still works. Matching actions run once per conversation after the archive operation is successfully queued. Archiving again is a new event and can run the rule again; it does not use the incoming/outgoing once-per-message ledger.

Archive rules are local. Snoozing, rule-generated Archive actions, automatic archiving policies, provider sync, and archiving in another client do not fire this trigger. Shared/delegated mailbox actions do not run rules belonging to your own mailbox. This prevents recursive rules and keeps the trigger independent of the automatic archiving policy. **Run on existing Archive** evaluates current archived conversations (excluding Inbox, Sent, Drafts, Trash and Spam) without requiring a new Archive action. Undoing the original archive does not undo separate rule actions.

Rule actions only add or remove labels, set the inbox category (**Set inbox category**, local classification that never replaces a manual move and queues nothing for the provider), or move, star, mark, or trash messages. They never send or forward mail, and rule-generated Archive actions do not fire Archive rules, so a rule can't trigger itself or another rule.

### Each message is processed once

Before any action runs, the worker claims every new message in `mail_rule_processed`, keyed by account, trigger, and normalized Message-ID (or the provider id when there is none). A message that was already claimed is skipped. This covers:

- a resync or overlapping Gmail history pass that reports the same message again;
- an IMAP move, which gives the moved copy a new local id but keeps its Message-ID;
- a message whose copy appears in a second folder.

Entries are pruned after 180 days. **Run on existing mail** is an explicit, manual action and does not consult the ledger.

## Server rules

| | Gmail | Microsoft 365 / Outlook |
| --- | --- | --- |
| API | `users.settings.filters` (list, create, delete) | Graph `me/mailFolders/inbox/messageRules` (list, create, PATCH, delete) |
| Required scope | `gmail.settings.basic` | `MailboxSettings.ReadWrite` |
| Update | Filters are immutable. Aerio creates the replacement first, then deletes the old filter, and removes the new one again if that delete fails. | In place with PATCH. A rule deleted in Outlook is recreated. |
| Turn off | Not possible. Delete the filter instead. | `isEnabled`, mirrored onto the linked Aerio rule |
| Outgoing rules | Not supported | Not supported |
| Archive trigger | Local only | Local only |
| Unsupported | Starts/ends with (except an ends-with-`@domain` sender), Subject/body equals, headers other than `List-Id`, age, folder/label conditions, low or normal importance, Microsoft folders as targets, custom inbox tabs | Starts/ends with, "no attachments", age, folder conditions, inbox category conditions and actions, flagging (star), more than one move, mixing condition kinds in an "any" rule, repeating a condition kind in an "all" rule, mixing exception kinds |
| Approximate (uploaded with a caveat) | Word-based matching, body words that also match the subject, `is:important`, inbox category → `category:` search and "Categorize as" | Display-name senders → `senderContains`, Cc → `recipientContains` (which also matches To), headers → `headerContains` (searches all headers) |

The editor shows a **Server compatibility** panel for Gmail and Microsoft accounts. It lists every condition, exception, or action that can't map to a server rule (these block the upload) or that maps only approximately. The same check runs again in the main process before any request is sent.

- **Upload** with the cloud button on a rule. Aerio sends the provider rule, then marks the local rule `execution: 'server'` with the provider's id. If linking fails locally, the new server copy is deleted again, so an unlinked duplicate never runs.
- **Edit** a server rule normally. Saving pushes the change to the provider. If that push fails, the toast says so; the provider keeps running the previous version.
- **Server rules** in the footer lists everything stored on the provider, including filters and rules created elsewhere. Removing a rule that Aerio uploaded turns the Aerio rule back into a local rule, switched off, so nothing starts running locally without your say-so.
- The renderer can't set `execution` or `serverRuleId`. Saving a rule keeps the stored values, and only the server-rule handlers change them.

### Permissions

New sign-ins and reconnects request `gmail.settings.basic` or `MailboxSettings.ReadWrite`; automatic replies need the same scopes. Accounts connected earlier keep working for mail. Token refresh never adds the new scope; only an interactive reconnect does. `electron/mail/mail-settings-scopes.ts` holds the scope constants (automatic replies imports them too) and `mailSettingsScopeStatus`, which `OAuthVault.mailSettingsAccess` applies to the stored grant. Without the scope, capabilities report `permission: 'missing'` with an explanation, and the rules window offers **Reconnect account**. A legacy grant with no recorded scope list is tried anyway. In every case, a provider 403 that isn't rate limiting is reported the same way.

IMAP providers report server rules as unsupported. ManageSieve is not implemented.

## Verification

- `src/lib/mail-rules.test.ts`: conditions, exceptions, importance, triggers, validation.
- `src/lib/mail-server-rules.test.ts`: Gmail and Graph mappings, unsupported and approximate reporting, descriptions.
- `electron/mail/server-rules.test.ts`: provider requests with mocked HTTP (create/replace/rollback, Archive lookup, PATCH/recreate, paging, permission failures).
- `electron/mail/server-rule-ipc.test.ts`: validation, execution ownership, link/unlink, rollback.
- `electron/mail/rule-ledger.test.ts`: ledger de-duplication, schema migration, trigger and execution filtering against real SQLite.
- `electron/mail/mail-settings-scopes.test.ts`, `electron/mail/oauth-vault.test.ts`: scope detection and refresh behavior.
- `electron/mail-worker.test.ts`: outgoing processing and ledger skips during sync.
- `src/components/MailRulesModal.test.tsx`: editor and server-rule UI.
- `src/lib/mail-rule-library.test.ts`, `src/components/MailRuleLibrary.test.tsx`: independent starter drafts, real matcher behavior, editable starter save flow, account destination filtering, and unavailable accounts.

Not yet validated against live accounts:

- Gmail's acceptance of the generated `query`/`negatedQuery` strings (including `{}` OR groups and `larger:`/`smaller:` in bytes).
- Whether Graph treats exceptions of different kinds as OR. Aerio blocks that case rather than guess.
- Graph `withinSizeRange` boundaries.
- Microsoft's returned scope string format.
