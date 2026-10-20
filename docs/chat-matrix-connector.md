# Matrix chat connector

Status: implemented behind a closed gate (E30). Chat navigation stays hidden for normal users until hosted two-device interoperability evidence exists for the pinned SDK and Electron versions. The design and acceptance criteria are in [the Chat implementation proposal](chat-implementation-proposal.md); this document records what was built, how the gate works, and what is still unverified.

## What is implemented

- **Isolated SDK service.** `matrix-js-sdk` 43.0.0 with its Rust crypto (`@matrix-org/matrix-sdk-crypto-wasm`) runs in one hidden, sandboxed `WebContentsView` per account (`electron/chat/service-host.ts`, `electron/chat/service/`). It loads only the packaged bundle from the privileged `aerio-chat-service://` scheme, has no Node integration, denies permissions, popups, navigation and downloads, and its partition may reach only the selected homeserver origin. The SDK's IndexedDB crypto store is encrypted with a per-account 32-byte key the main process wraps with OS secure storage. Commands and replies are routed by sender webContents, never by an account ID in a payload.
- **Main-process orchestrator.** `electron/chat/chat-service.ts` owns the OS-wrapped vault (`chat-vault.dat`: tokens, cache and crypto-store keys; Linux `basic_text` and unavailable storage are refused), the AES-GCM sealed local cache (`chat.sqlite`), the durable outbox (transaction-ID reconciliation, restart review, never a plaintext fallback), timeline projection (edits, replies, reactions, redactions, gaps), encrypted media limits (25 MiB per file and the server limit, streamed size checks, random managed names), notification policy, 30-day/250 MiB retention defaults, clear-history and account removal. Chat files are excluded from profile backups.
- **Renderer IPC.** `electron/chat/chat-ipc.ts` registers the `chat:*` channels. Every handler refuses calls from a chat service webContents, refuses all commands while Aerio is locked (the service also checks), validates identifiers, actions, preference shapes and text lengths, and returns display data only. While the gate is closed only `chat:snapshot` answers, with the gate diagnostic. `electron/preload.ts` exposes the matching `window.aerio.chat` bridge.
- **Chat view.** `src/views/ChatView.tsx` provides the account sign-in (homeserver discovery shows the validated origin before a password is requested; the password is passed once and not kept), a room list with unread and invitation counts and an explicit encrypted/not-encrypted indicator, the timeline (undecryptable messages stay visible with the reason, never guessed text; older-history gaps; delivery states including review), a composer with replies, edits, reactions, deletion and attachments, local-history search, invitation accept/decline with the inviter's full Matrix ID, mute and preview controls, held-room resolution, emoji SAS verification, recovery setup (the key is shown once) and restore, device trust, and per-account preferences, retention, clear history and removal.
- **Notifications, lock and tray.** Chat notifications use the main-process `Notification` path with the global notification setting, mute, membership and per-room checkpoints. Bodies are omitted by default; previews need the account preference, a room that allows previews and an unlocked app. Clicking a notification opens Aerio, unlocks first if needed, then opens the room. Locking clears decrypted renderer state (the snapshot becomes empty and the view unmounts) and verification emoji. Tray mode keeps the service syncing; fully quitting stops it.

## The gate

`electron/chat/gate.ts` evaluates four checks; the Chat module appears in the rail only when the result is `enabled`.

| Check | How it passes |
| --- | --- |
| Secure credential storage | `safeStorage` is available with a strong backend (not Linux `basic_text`). Never waived. |
| Isolated chat service | The packaged service bundle and preload exist in this build. Never waived. |
| Encrypted crypto-store persistence | Recorded automatically by a runtime self-test in the real Electron: the service creates an encrypted Rust crypto store in a throwaway partition, reopens it with the same identity, and is refused with a different key. Stored in `chat-gate.json` per SDK and Electron version (`AERIO_CHAT_SELF_TEST=1` forces a rerun). Never waived. |
| Two-device interoperability | Requires recorded evidence (`interoperability` in `chat-gate.json`) of two-device verification and encrypted messaging against a configured hosted homeserver for this SDK and Electron version. The loopback fixture cannot supply it. |

`AERIO_CHAT_PREVIEW=1` is a developer opt-in that waives only the interoperability check. The view then shows a "Chat preview: hosted two-device interoperability is unverified" note. There is no user-facing setting for this; the proposal keeps Chat out of normal navigation until its acceptance gates pass.

**Current status: closed.** Only loopback-fixture and local Electron evidence exist. To open the gate, the following hosted evidence is still needed, for `matrix-js-sdk 43.0.0` and the shipped Electron version:

1. Password sign-in (and any other advertised login flow to be supported) against at least one real homeserver, with its versions and capabilities recorded.
2. Two Aerio devices (or Aerio plus another maintained client) completing emoji SAS verification of the same user, and cross-user verification.
3. Encrypted messages and an encrypted attachment exchanged in both directions, surviving a restart of each device.
4. Recovery-key setup on one device and history restore on a new device from server key backup.
5. Lost-response retry with the same transaction ID producing a single event on that server.

The opt-in [hosted acceptance harness](matrix-hosted-acceptance.md) now collects sanitized, version-bound release evidence only after its full hosted sequence passes. No hosted result has been recorded, and it never edits `chat-gate.json`. Ordinary automated tests never contact a real homeserver; hosted runs require explicitly configured disposable accounts.

## Automated evidence

- `electron/chat/service/runtime.test.ts`: real SDK 43 clients with in-memory Rust crypto against the loopback fixture (`electron/chat/test-homeserver.ts`): encrypted messaging between two users, lost-response retry without duplication, redaction, pagination, own-device emoji SAS verification, recovery setup and history restore on a new device from the recovery key (undecryptable text stays visible until the key is restored).
- `electron/chat/chat-service.test.ts`, `chat-store.test.ts`, `chat-vault.test.ts`, `outbox.test.ts`, `policy.test.ts`, `homeserver.test.ts`: orchestrator, sealed cache, vault refusal, outbox reconciliation, notification/retention/gate policy and discovery validation.
- `electron/chat/chat-ipc.test.ts`, `electron/chat/service-host.test.ts`, `electron/preload.test.ts`, `electron/main.test.ts`: IPC sender isolation, lock enforcement and validation; partition hardening, sender routing, crash handling and the self-test sequence; bridge channels; main-process wiring with lock and network forwarding.
- `src/views/ChatView.test.tsx`, `src/App.test.tsx`: the Chat view and the gated module rail.
- `npm run test:chat` (`scripts/desktop-chat-audit.mjs`): real Electron with a fresh profile. The service self-test records passing crypto-persistence evidence, Chat stays hidden and refuses commands without interoperability evidence, and the developer preview shows the labelled workspace and refuses insecure homeserver URLs. It contacts no homeserver.

### Key-backup restore fix

The history-restore test was previously skipped because `RustBackupManager` could not decrypt the backed-up session. Two causes were found. First, the fixture answered every `GET /room_keys/keys/...` with the full `{ rooms }` document, so the SDK's per-session downloader (`/room_keys/keys/{roomId}/{sessionId}`) received no `session_data` and failed reading `ephemeral`; the fixture now implements the spec's per-scope shapes, `version` checks (`M_WRONG_ROOM_KEYS_VERSION` on stale uploads), counts and etags. Second, the SDK starts its first backup upload after a random delay of up to 10 seconds, so a new device could restore before any keys were uploaded. Recovery setup now waits (bounded at 20 seconds) for the existing keys to reach the backup and reports `backupComplete`, so "recovery is set up" also means earlier history is backed up.

## Not implemented or unverified

- Hosted homeserver interoperability (see the gate above), SSO/OIDC login, room block/report actions and per-user block rules, typing and presence, room creation and direct-message start from Aerio, threads, calls and public directory browsing.
- A packaged-installer native audit of the chat service (the Electron audit runs the built app from source) and macOS/Linux chat evidence.
- Encrypted Chat export. Ordinary profile backups exclude Chat by design.
