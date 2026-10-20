# Microsoft Teams chat (D08)

Teams is a separate provider workspace in Chat. It uses documented Microsoft Graph v1.0 delegated APIs in Microsoft's global cloud. Matrix keeps its own service process, encryption, storage and readiness gate. Connecting Teams does not enable Matrix or provide Matrix end-to-end encryption for Teams messages.

## Connection and permissions

Configure Aerio's existing Microsoft OAuth application/client ID, then choose **Chat → Microsoft Teams → Connect account**. Sign in with a work or school account that has Teams access. Personal Microsoft accounts are unsupported by these Teams Graph APIs. Reconnect performs interactive consent and verifies the same Graph user identity. The OAuth vault refreshes tokens; expired/revoked access requires reconnect. Removing a Chat connection purges its separate local chat cache/secret, without removing a Microsoft mail connection or revoking shared Microsoft consent.

Chat connection explicitly requests `Chat.ReadWrite` and `ChatMessage.Send`. Mail-only authorization does not request Teams scopes. The optional **Include joined-team channels** checkbox additionally requests `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Read.All`, and `ChannelMessage.Send`. Tenant policies can require administrator consent. Missing scopes and permission errors are shown instead of pretending the connection is ready.

## Supported behavior and limits

- Lists visible existing one-to-one/group/meeting chats; lists joined-team channels only after optional consent. Existing conversations only: creating chats/teams/channels, calls, presence and meeting control are outside this connector.
- Loads paginated chat messages, channel posts and explicit channel replies; sends plain text to the selected conversation/thread. Provider HTML is converted to text. Attachments/cards have a placeholder; uploading/downloading, reactions, edits and deletions are not exposed.
- Chat unread activity is an indicator derived from Graph last activity/read metadata, not an exact unread message count. **Mark read on server** uses Graph's chat read-marker action when tenant metadata is available. Channel read markers/unread counts are unavailable here.
- Polls room activity and the active message page every 30 seconds while unlocked/online. This is polling, not webhook/push delivery. Notifications use new chat activity after an initial baseline; joined-team channel listing does not supply an activity timestamp, so background channel notifications are not promised. Generic notifications are the default; room names require an explicit account preference.
- Honors provider Retry-After with a persisted account cooldown (up to 24 hours). No automatic sending or retries: uncertain sends remain **Delivery uncertain** after restart; check Teams before resending. Successful replies appear when the conversation reloads. Drafts remain in the editor after failed sends and are not persisted across app restart.
- Graph pagination is restricted to the same trusted Graph resource endpoint, redirects are disabled, responses are bounded, and room enumeration stops after 100 pages per collection. Teams shared-channel membership can omit host teams from `/me/joinedTeams`; this connector does not claim every shared channel is discoverable.

## Local storage and isolation

The main process owns provider credentials and all network calls. `provider-chat:*` IPC validates arguments and denies Matrix isolated-service access. Chat locks redact snapshots, reject operations/results, suppress notifications and stop polling. Account generations prevent late network requests from resurrecting removed or replaced connections. Locking does not cancel an already dispatched server send; its confirmation/uncertain outcome is retained encrypted.

`provider-chat-vault.dat` uses OS secure storage. The separate SQLite cache seals account/room/message/outbox payloads with per-account AES-GCM keys. Structural record identifiers, provider names, send-state labels and timestamps remain database metadata. Latest loaded pages are cached for offline reading; pagination pages are not retained. Cache pages and send records inactive for 30 days are removed on startup (this is not a strict per-message age policy). These files are excluded from profile backup/import. Removing an account deletes its cache and encryption key. No provider tokens are returned by the renderer API.

## Connector extension seam

`src/provider-chat-types.ts` defines renderer-safe contracts. `electron/chat/providers/adapter.ts` defines main-process adapter methods and typed auth/permission/rate-limit/network/rejected/uncertain failures. Register adapters in `initializeProviderChat` in `electron/main.ts`; descriptors supply connection fields and explicit availability. Each adapter must namespace `remoteUserId` by server/workspace where identifiers are not globally unique and validate pagination/remote resources. Runtime supplies a durable client-request UUID to sends; use it only when the provider documents idempotency. Provider-specific support must remain explicit in capabilities and documentation.

## Validation

Controlled fixtures cover consent, pagination, chat/channel mapping, safe text, send/reply/read endpoints, 401/403/429/server/network failures, encrypted offline cache, lock/removal races, cooldown restart, uncertain-send restart, IPC validation and provider workspace behavior. No live Teams account/tenant was available; tenant consent, real notification delivery and real send/read round trips still require account-backed validation. No live-provider evidence is claimed.

Official API references: [list chats](https://learn.microsoft.com/en-us/graph/api/chat-list?view=graph-rest-1.0), [chat messages](https://learn.microsoft.com/en-us/graph/api/chat-list-messages?view=graph-rest-1.0), [send chat message](https://learn.microsoft.com/en-us/graph/api/chat-post-messages?view=graph-rest-1.0), [mark chat read](https://learn.microsoft.com/en-us/graph/api/chat-markchatreadforuser?view=graph-rest-1.0), [joined teams](https://learn.microsoft.com/en-us/graph/api/user-list-joinedteams?view=graph-rest-1.0), [channels](https://learn.microsoft.com/en-us/graph/api/channel-list?view=graph-rest-1.0), [channel messages](https://learn.microsoft.com/en-us/graph/api/channel-list-messages?view=graph-rest-1.0), [channel replies](https://learn.microsoft.com/en-us/graph/api/chatmessage-list-replies?view=graph-rest-1.0), [send channel messages/replies](https://learn.microsoft.com/en-us/graph/api/chatmessage-post?view=graph-rest-1.0).
