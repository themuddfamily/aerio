# Provider strategy beyond mail

Aerio treats each module as its own capability. Connecting a mail account never silently claims that the provider also supplies Tasks, Notes, or Chat.

## Current data boundaries

- Application settings and profile preferences live in `aerio-state.sqlite`; no sample workspace is loaded at runtime.
- Provider Calendar and Contacts snapshots live in `productivity.sqlite`, keyed by account and provider.
- Google People and Microsoft Graph contact writes update those caches immediately and use provider revisions where available to avoid overwriting a newer contact blindly.
- Provider refreshes persist per-calendar event cursors and address-book cursors; expired Google sync tokens and Microsoft delta links fall back to an atomic full refresh.
- Production local Contacts, Tasks, and Notes also live in `productivity.sqlite`, but in separate local records with no provider identity.
- Chat has no storage, fake transport, or v1 navigation entry.

This split keeps provider caches, local production data, and application preferences independent and gives future connectors a stable boundary.

## Tasks: local-first, then provider adapters

The production baseline is an empty, persistent local task list. Google Tasks and Microsoft To Do are planned as independent adapters behind the provider capability contract.

Recurring local tasks now schedule their next occurrence and local custom lists are supported. Before either remote adapter is enabled, the task model still needs:

1. stable local, provider, and remote identifiers;
2. per-record revision/checkpoint metadata;
3. explicit conflict handling for edits made in two clients;
4. provider-aware recurrence and subtask normalization;
5. offline mutation queues with visible failures and exact-state undo.

The first remote milestone should be one provider end to end, including create, update, complete, delete, incremental refresh, and revoked-scope recovery. A second adapter should reuse that contract rather than add provider checks to the React view.

## Notes: local is the product baseline

Aerio Notes are production local data, not disguised provider notes. Google Keep has no suitable general synchronization API. Microsoft OneNote has an API, but its page/section/HTML model is materially different from Aerio’s current plain note model.

Local-data export/import, full-content search, and managed attachments are implemented for Notes. Attachments are copied into Aerio storage, limited to 25 MB each, included in validated backups, and deleted when no note references them. The next Notes milestone is an optional application lock. A OneNote adapter can be evaluated later as an explicit connector with a documented conversion model; it should not redefine the local format.

## Chat: choose a transport before building UI promises

Email connectivity does not imply chat connectivity. Google Chat and Microsoft Teams also require service- and organization-specific permissions that do not fit a general consumer mail connector.

Before remote Chat is enabled, choose a supported transport and settle:

- identity and account discovery;
- end-to-end encryption and key storage;
- message history, edits, deletion, reactions, and attachments;
- presence, notifications, calls, abuse controls, and retention;
- multi-device conflict and offline behavior.

Matrix is a plausible open-protocol candidate, while Teams or Google Chat would be separate enterprise connectors. No transport should be selected or presented as supported until those requirements and the intended user audience are agreed.

## Capability rule

`src/providers/provider.ts` is the source of truth for what each connection can do now. UI code should branch on capabilities, never infer Calendar, Contacts, Tasks, Notes, or Chat support merely from an email address or an IMAP connection.
