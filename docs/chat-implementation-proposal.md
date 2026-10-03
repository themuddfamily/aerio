# Chat implementation proposal

Assessed: 2026-10-01. Status: proposal complete; Chat remains unavailable in Aerio. This is an implementation recommendation, not a newly enabled transport or a roadmap requirement to build Chat.

## Transport comparison and recommendation

Recommend an independent Matrix account connector for general personal and small-team messaging. Users connect an existing homeserver account; Aerio does not operate a messaging service or turn a mail account into a chat identity. Teams and Google Chat would be independent organization-oriented adapters if added later.

| Candidate | Identity and access | Security/history fit | Aerio cost and decision |
| --- | --- | --- | --- |
| Matrix | Separate homeserver user and device identity; explicit connection. | Standard rooms, timeline synchronization, encryption and device verification primitives. | Best candidate for a general connector; crypto persistence, recovery and interoperability must be proven. |
| Microsoft Teams through Graph | Delegated work/school identity; personal-account message sending is unsupported. | Microsoft-managed history and organization permissions; do not claim Aerio-controlled end-to-end encryption. | Useful enterprise adapter, unsuitable as the default consumer transport. |
| Google Chat API | Separate user/app authorization and per-method scopes. Bot participation differs from user-authorized access. | Google-managed spaces and messages; do not claim access to all a Gmail user's conversations. | Useful Workspace-oriented adapter; mail consent is insufficient. |
| Bespoke WebSocket service | Aerio would define users, devices, sessions, delivery and hosting. | Aerio would own encryption, federation/discovery alternatives, recovery and abuse design. | Reject for the first implementation: substantial new server and cryptographic responsibilities. |

Matrix's client-server specification defines user/device IDs, incremental sync, transaction identifiers, encrypted rooms, verification, media and event relationships. These are available building blocks, not guarantees of server compatibility or complete client security. [Matrix specification](https://spec.matrix.org/latest/client-server-api/)

Graph lists delegated `ChatMessage.Send` for work/school accounts and does not support personal-account chat sending. Application migration permissions are not a general background-send solution. [Microsoft chat sending](https://learn.microsoft.com/en-us/graph/api/chat-post-messages?view=graph-rest-1.0)

Google distinguishes user and app authentication, with method-specific scopes and different access. An app identity cannot stand in for a user's complete message history. [Google Chat authorization](https://developers.google.com/workspace/chat/authenticate-authorize)

## Initial feature boundary

Implement direct conversations and invited private rooms, text, replies, edits, redactions, reactions, encrypted attachments, history pagination, unread state, room mute/block/report actions, and verified-device onboarding. Preserve explicit encryption/trust indicators. Viewing an existing unencrypted room must identify it clearly; newly created private rooms default to encryption. Never silently downgrade a failed encrypted send to plaintext.

Calls, public directory browsing, bridges, bots, threads beyond basic replies, global presence discovery, and custom server hosting are deferred. Invitations require acceptance before downloading media. Typing, presence and read receipts default off and can be enabled independently; absence of presence is not evidence that a recipient is offline.

## Identity and connection

Create separate `ChatAccount` records keyed by transport, canonical homeserver origin and exact remote user ID. Store the provider device ID independently of the local account UUID. An email address, contact match, display name, or mail OAuth subject does not establish chat identity. Display full user identity on invitations and verification screens; names and avatars are untrusted presentation data.

Discover the homeserver from an explicit server/user input, validate HTTPS destinations and redirects, and display the resulting origin before authentication. Permit loopback HTTP only in automated fixtures. Do not send credentials to a discovery URL; authenticate only to the validated service. Private network addresses require deliberate server selection rather than arbitrary redirects or avatar links.

Support server-advertised compatible login methods through the SDK. Browser-based authorization uses an isolated browser callback with state/PKCE where that flow supports it; passwords go only to the selected homeserver and are never retained. Record capabilities and unsupported login methods honestly. Login flow support is an interoperability test requirement, not assumed from the server brand.

Reconnect the same device only while its crypto store is intact and correctly bound to the user/device. A lost crypto store creates an explicitly new device; do not silently reuse an old device ID with fresh keys. Pause on identity mismatch or unexpected security-state reset.

## Encryption and key storage

Use the maintained `matrix-js-sdk` with its Rust crypto implementation and public `CryptoApi`; do not implement ratchets or depend on legacy crypto internals. The SDK documents Rust initialization, cross-signing, secret storage and device verification. Pin a reviewed SDK release and dependency set during implementation. [SDK crypto guidance](https://github.com/matrix-org/matrix-js-sdk)

Proposed execution boundary: a dedicated packaged, hidden, sandboxed service webContents per connected account, with a persistent isolated storage partition for the SDK's browser storage. It loads only Aerio's signed/package-controlled service code, has no general Node integration, and never renders room HTML. Main owns OS-backed credential persistence and brokers only scoped startup secrets and structured service IPC. The visible renderer receives display snapshots and commands, never access tokens, session keys or arbitrary SDK objects.

The service may hold its own access token and crypto secrets in memory. Its network policy allows only the selected homeserver and explicitly validated authentication destinations; all other navigation, popups, downloads and external resources are blocked. Tokens must not appear in URLs, logs, crash breadcrumbs or backup JSON. Permission checks identify the service sender and account, rather than trusting an account ID in an IPC payload.

Before choosing this boundary permanently, run a packaging spike proving Rust/WASM initialization, persistent encrypted crypto-store support, per-account partition isolation, crash recovery and clean shutdown in the pinned Electron version. If the SDK cannot encrypt its persistent crypto secrets through its supported APIs, the implementation gate fails: use a supported storage/runtime alternative before enabling Chat. Never treat unencrypted IndexedDB plus a wrapped access token as encrypted key storage.

Generate a random per-account cache key, wrap it with OS-backed storage, and use authenticated encryption for local plaintext messages, drafts, search records and cached media. Bind ciphertext to account/record/schema identity as authenticated data. Crypto-store encryption uses supported SDK facilities with a separately wrapped key. Do not build a custom replacement crypto store by serializing opaque SDK state.

Electron's `safeStorage` uses platform-specific protection, and Linux can fall back to `basic_text`. Reject that backend and unavailable/unknown secure storage for persistent credentials or crypto keys. No plaintext fallback. Aerio's existing screen lock is not disk encryption; storage protection also does not protect against a compromised logged-in user or renderer/service execution. [Electron secure storage](https://www.electronjs.org/docs/latest/api/safe-storage)

Device verification must show a separate verified/unverified state, support SDK-provided interactive verification and own-device recovery, and warn when trusted identity changes. Require explicit resolution before sending to newly unverified devices; do not automatically trust an email match or an incoming key request. Key requests and outgoing encryption decisions remain SDK-owned. Recovery setup, verification cancellations, lost recovery material and partial backups get clear states without invented decryption promises.

## Local data and history

Keep Chat separate from `productivity.sqlite`, mail caches and local backups. Proposed `chat.sqlite` tables hold accounts, rooms/membership, encrypted events, event relationships, timeline gaps/cursors, encrypted drafts, outbox operations, media references, notification checkpoints and retention preferences. Each native identity is scoped to its account. Unique event IDs and local transaction IDs deduplicate display and delivery; display names never serve as keys.

Store immutable event records and derive edits/replies/reactions/redactions without rewriting the underlying identity. Validate sender, room, membership/permission context and relationship targets before applying an edit. Missing-target relationships wait for history instead of modifying an unrelated event. Redacted content disappears from derived search and notifications and is removed from locally retained decrypted copies; deletion cannot promise removal from other participants' devices or exports.

Run one ordered sync consumer per account. The SDK crypto store owns its own processing/cursors; Aerio's projection must tolerate replay by event ID. Persist a display batch and its projection checkpoint atomically. Do not pretend separate SQLite and SDK IndexedDB stores share a transaction. Restart/crash tests must prove that reprocessing fills gaps without duplicate display or lost key-processing events.

Paginate older history on demand and retain explicit timeline gaps. A failed page load does not mean the room has no earlier messages. Search covers decrypted, locally retained history only and explains that boundary. Undecryptable messages remain visible with a reason and recovery action; an older message must not be replaced by guessed text.

## Attachments

Initial Aerio policy: one file up to 25 MiB per message, also bounded by the server-advertised limit; measure actual bytes before encryption/upload. Encrypt attachments through the SDK and retain required ciphertext integrity metadata. Stage ciphertext and encrypted local metadata under random managed IDs, not sender filenames. No remote filename may choose a local path.

Fetch media only after user action or an explicit trusted-room preference. Translate validated native media identifiers through the connector; do not authenticate arbitrary URLs from a message. Enforce streamed size limits, ciphertext verification and bounded cache usage before decrypting. Treat thumbnails as separately protected media. Sanitize names/types and show failures rather than opening unverifiable content. Never automatically execute a downloaded file or render active HTML/SVG as a trusted page.

Upload success followed by failed message sending leaves a tracked orphan, not a delivered attachment. Cancellation prevents subsequent message dispatch; uncertain uploads are reconciled or retained for cleanup. A queued message retains the exact uploaded-media reference and encryption metadata across restart. Cleanup counts outbox references before removing files; server orphan deletion is capability-dependent and cannot be promised.

## Offline sending and multiple devices

Persist a local transaction ID, original room/user/device scope, intended encrypted draft, dependencies, and dispatch state before showing a pending local echo. Reuse the same scoped transaction for safe send reconciliation; never allocate another one merely because the response was lost. Verify the pinned SDK/server transaction behavior in the interoperability harness. Device logout or replacement invalidates automatic replay until scope and crypto state are reconciled.

Outbox states are `pending`, `running`, `sent`, `failed`, and `review`. Offline pending messages can be edited/cancelled; once dispatched, changes are separate edit/redaction operations against a confirmed event. Serialize dependent actions, refresh membership and trust before encryption/dispatch, and hold a room's writes after removal or key/trust failure. Keep other accounts progressing independently.

On restart, interrupted sends reconcile from their original transaction and synchronized event evidence. If that cannot prove acceptance or rejection, retain review rather than blindly duplicate. Sync echo and HTTP acceptance may arrive in either order; both resolve the same local item. Delivery labels distinguish accepted by server from read by a participant.

Other devices have independent outboxes and drafts. Sync confirmed events and supported account preferences, not unsent drafts by default. Verification state and keys follow SDK rules; a second device is not authorized simply because it uses the same user ID. Test a device offline during membership changes, lost keys, simultaneous edits, redaction before original history, and recovery after soft logout.

## Notifications, lock and retention

Use the existing main-process notification/tray infrastructure with Chat-specific routing. Default to generic notifications with no message body; optional previews require an unlocked application and a room privacy preference. Mute, account archive, membership, block rules and global notification settings all apply. Persist notification event checkpoints to avoid restart/history replay notifications. Clicking a notification unlocks before opening the scoped room/event.

Tray mode keeps the service syncing; fully quitting stops delivery and notifications until next launch. Do not promise background notifications when Aerio is closed. Locking clears decrypted visible/search previews and transient UI secrets and suppresses body notifications. The trusted service can keep receiving ciphertext; queued sending while locked must follow an explicit account preference and trust policy.

Default local retention is 30 days of decrypted history and a 250 MiB ciphertext/media cache per account, configurable separately from server retention. These are proposed Aerio defaults, not protocol guarantees. Never prune pending drafts/outbox, required relationship state or crypto sessions because ordinary history expires. Older messages can be requested again only if the server still has them and keys are recoverable.

Clear local history deletes derived searchable data/media references while keeping identity and required crypto state; explain that server history can resync. Remove account stops its service and purges its local secrets/cache. Device logout/revocation is a separate remote outcome that may fail offline; report that accurately. Room redaction and server retention are distinct from local purge and do not establish global erasure.

Ordinary local-productivity backup excludes Chat. If added, Chat export must be separately opt-in and passphrase-encrypted, distinguish portable history from recovery material, and never include reusable access tokens. Recovery uses supported encrypted key-backup mechanisms; copying Aerio's OS-bound vault to another machine is not a recovery design.

## Implementation sequence and acceptance evidence

1. SDK/runtime/storage spike: pinned dependency review, WASM packaging, secure crypto persistence, Linux fallback refusal, account isolation, lifecycle and crash recovery. Failure blocks UI enablement.
2. Connector and projection: controlled homeserver fixture, login/discovery validation, sync replay, pagination/gaps, encrypted caches, relationship validation, archive/purge and redacted diagnostics.
3. Encryption onboarding: two real SDK devices, verification/trust change, encrypted-room sending, missing keys/recovery, no plaintext downgrade and no secret exposure in IPC/logs/backups.
4. Outbox and media: offline/restart, lost response with same transaction, echo ordering, membership loss, simultaneous edits, upload cancellation/orphans, tampering/oversize/path rejection and dependent actions.
5. Native Electron UI audit: actual packaged service/preload/main boundaries, notifications, lock/tray/full quit, unread navigation, accessible controls, cache retention and account removal.
6. Opt-in interoperability evidence against a configured homeserver: server versions/capabilities, two-device verification, encrypted media and restart outcomes. A controlled fixture alone cannot establish hosted interoperability or secure recovery.

This proposal satisfies the roadmap's Chat design task. Chat stays out of v1 navigation until the implementation and acceptance gates pass. No signing, account-registration or publishing checklist is added to the Codex roadmap.
