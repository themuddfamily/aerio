# IceWarp TeamChat (D12)

Choose **IceWarp TeamChat** in Chat and enter your server's HTTPS base URL. Connect using a TeamChat API token, or enter your username and password to obtain a token through the documented login endpoint. Passwords are used for that exchange only; the verified token is stored in Aerio's OS-encrypted provider chat vault. Single sign-on/MFA deployments may require an administrator-issued token. Aerio does not bypass server authentication policy or accept invalid TLS certificates.

The adapter uses IceWarp's official [TeamChat user API](https://wwwcdn.icewarp.com/docs/teamchat-api.html): `auth.test`, `iwauthentication.login.plain`, `channels.list`, `channels.info`, `channels.userPermissions`, `threads.list`, `threads.comments` and `chat.postMessage`. This is separate from the server administration API. Your server/reverse proxy must expose `/teamchatapi/` over HTTPS and permit these operations.

- Active joined rooms, paged root posts, threaded comments and text sending are supported. The shared chat runtime polls for updates and offers encrypted local cached history offline.
- Before sending, Aerio checks current membership and write permission. Messages cannot impersonate another user. Account identities include the server, and room resources are bound to the connected account/server.
- Direct conversations, uploads/downloads, reactions, presence, audio/video calls and read markers are unavailable in this adapter. Attachments appear as placeholders. Use IceWarp for those features.
- IceWarp does not document a client-generated message id for posting. Lost or invalid send confirmations show uncertain delivery for manual review; Aerio does not retry them automatically. Confirm the room history before sending again.
- Removing an account revokes a token obtained by Aerio. A manually supplied token is left intact because it may be shared with another client. Removing local credentials does not delete server messages.

Requests use fixed documented methods on the configured HTTPS server, JSON bodies rather than token-bearing URLs, no redirects, a twenty-second timeout and a four-megabyte response limit. Raw provider error bodies and credentials are not shown in errors. Server authorization, permission and throttling errors map to the shared reconnect/backoff behavior. App lock hides cached chat and prevents new operations.

Tests verify request/response schemas against official examples, authentication and password minimization, cross-server/account rejection, room/history mapping, permission changes and uncertain delivery. A live deployment requires IceWarp server credentials; deterministic tests do not claim live-server interoperability evidence.
