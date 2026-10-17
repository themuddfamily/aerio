# External automation through MCP

Aerio can expose your mail to AI assistants and scripts on the same computer
through the [Model Context Protocol](https://modelcontextprotocol.io) (MCP).
An MCP client such as Claude Desktop starts Aerio's **stdio bridge**, which
talks MCP on stdin/stdout and forwards each tool call to the running Aerio app
over an authenticated local channel. Nothing listens on the network.

It is **off by default**. Turning it on gives read access only; changing mail,
sending, and moving to Trash are separate opt-ins.

```
MCP client ──stdio (JSON-RPC 2.0)──▶ bridge ──named pipe / unix socket + token──▶ Aerio main process
                                                                                 └─ mail database, operation queue, drafts, Outbox
```

## Installation

1. Open **Settings › External automation (MCP)** and turn on **Enable automation bridge**.
   Aerio starts listening on a per-profile local endpoint:
   - Windows: a named pipe, `\\.\pipe\aerio-mcp-<profile hash>`.
   - macOS and Linux: a unix domain socket, `mcp.sock` in the profile folder
     (mode `0600`), or `aerio-mcp-<profile hash>.sock` in the temporary folder
     when the profile path is too long for a socket name.
2. Choose capabilities and accounts (see [Access controls](#access-controls)).
3. Enter a client name (for example "Claude Desktop") and select **Issue client token**.
   Aerio shows the client configuration once, including the token. Copy it now:
   Aerio stores only a SHA-256 hash of the token and cannot show it again.
4. Paste the configuration into your MCP client and restart the client.

Aerio must be running (it can be in the tray) for tools to work. The bridge is
started by the MCP client, not by you.

### How the bridge is started

| Installation | Command |
| --- | --- |
| Installed Aerio | the Aerio executable with `--mcp`, for example `C:\Program Files\Aerio\Aerio.exe --mcp` |
| Development checkout | `node dist-electron/mcp/bridge.js` after `npm run build` (or `npm run build:mcp-bridge`) |

`Aerio --mcp` runs only the bridge: it does not take the app's single-instance
lock, open a window, or open any profile database, and it exits when the client
closes stdin. The standalone `bridge.js` (built by `vite.mcp-bridge.config.ts`)
needs Node 24 and has no dependencies.

The bridge reads:

- `AERIO_MCP_TOKEN` (required): the client token. It is read from the
  environment only, so it never appears in process listings.
- `AERIO_MCP_ENDPOINT` (or `--endpoint=<path>`): the local endpoint. `Aerio --mcp`
  derives it from the profile folder when it is not set; the standalone script
  requires it. Settings always includes it in the generated configuration.

## Client configuration

Settings generates both formats with the token and endpoint filled in.

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "aerio": {
      "command": "C:\\Program Files\\Aerio\\Aerio.exe",
      "args": ["--mcp"],
      "env": {
        "AERIO_MCP_TOKEN": "aerio_mcp_…",
        "AERIO_MCP_ENDPOINT": "\\\\.\\pipe\\aerio-mcp-…"
      }
    }
  }
}
```

**Generic `mcpServers`** (clients that want an explicit transport type):

```json
{
  "mcpServers": {
    "aerio": {
      "type": "stdio",
      "command": "C:\\Program Files\\Aerio\\Aerio.exe",
      "args": ["--mcp"],
      "env": { "AERIO_MCP_TOKEN": "aerio_mcp_…", "AERIO_MCP_ENDPOINT": "\\\\.\\pipe\\aerio-mcp-…" }
    }
  }
}
```

Issue one client per application so each can be revoked on its own.

## Protocol

The bridge implements MCP over the stdio transport itself (no SDK dependency):

- JSON-RPC 2.0, one message per line on stdin/stdout; diagnostics go to stderr.
- Lifecycle: `initialize` (version negotiation), `notifications/initialized`, and `ping`.
  Supported protocol versions are `2025-06-18`, `2025-03-26`, and `2024-11-05`;
  a supported request is echoed and anything else is answered with `2025-06-18`.
- Tools: `tools/list` with JSON Schema `inputSchema`, `title`, and annotations
  (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`),
  cursor pagination (`nextCursor`), and `notifications/tools/list_changed`
  when capabilities change; `tools/call` returns text content and, for
  `2025-06-18`, `structuredContent`.
- Errors: `-32700` parse error, `-32600` invalid request, `-32601` method not
  found, `-32602` invalid params (unknown tool, or arguments that fail the
  schema, with the problems in `error.data.details`), `-32603` internal error,
  and `-32002` for tool requests before `initialize`. Batches are answered as
  arrays for clients that send them.
- Refusals and failures inside a valid call are tool results with `isError: true`
  and `structuredContent.error.code`:

| Code | Meaning |
| --- | --- |
| `app-not-running` | Aerio is closed, quitting, or the bridge is turned off in Settings. |
| `unauthorized` | Missing, unknown, or revoked token. |
| `locked` | Aerio is locked. Nothing is read or changed; unlock Aerio and retry. |
| `capability-disabled` | The tool's capability (write, send, delete) is off. |
| `account-not-allowed` | The account is outside the configured scope (unknown accounts look the same). |
| `not-found`, `too-large`, `conflict`, `already-sent`, `timeout`, `failed` | As named; `failed` carries Aerio's own error message. |

When Aerio is not reachable, `tools/list` still returns the full tool catalog
so a client can show what exists; calls then report `app-not-running`.

## Tools

All ids come from earlier results: account ids from `list_accounts`, conversation
ids from `search_mail`, message and attachment ids from `get_conversation` or
`get_message`, and draft ids from `create_draft`.

### Read (on whenever the bridge is enabled)

| Tool | Effect |
| --- | --- |
| `list_accounts` | Account names, addresses, providers, and sync status (scoped accounts only). |
| `list_folders` | Mailbox views (`inbox`, `sent`, `archive`, …) and provider folders/labels. |
| `search_mail` | Aerio's [search syntax](mail-search.md) over the offline index, with `folder`/`folderId`, `unread`, `flagged`, `hasAttachments`, `dateFrom`/`dateTo`, `pageSize` (≤ 50), and `cursor`. Cursors only work with the search that produced them. |
| `get_conversation` | Every message: headers, plain-text body (truncated to `maxBodyChars`, default 20,000), optional sanitized HTML, and attachment metadata. Remote content stays blocked. |
| `get_message` | One message from a conversation, same fields. |
| `get_attachment` | One attachment as base64 (`structuredContent.data` plus an embedded resource or image block), refused above `maxBytes` (default 5 MB, at most 10 MB). |
| `open_in_aerio` | Opens the conversation, optionally at one message, in an Aerio message window. |

### Write (Allow changes)

| Tool | Effect |
| --- | --- |
| `mark_read` | Marks conversations read or unread. |
| `flag` | Flags (stars) or unflags conversations. |
| `move` | Moves conversations to a folder or label from `list_folders`. |
| `archive` | Archives conversations. |
| `create_draft` | Creates a draft (synchronized to the provider's Drafts); `replyToConversationId` threads it as a reply. Nothing is sent. |
| `update_draft` | Replaces recipients, subject, or body of an unsent draft; omitted fields and existing attachments are kept. |

Write actions go through Aerio's mail operation queue, exactly like the same
action in the app: they appear immediately, synchronize in the background,
and have the usual short undo window in Aerio.

### Send (Allow sending)

| Tool | Effect |
| --- | --- |
| `send_draft` | Sends a draft through Aerio's normal send path: draft validation, OpenPGP/S/MIME checks (never falling back to plaintext), the Outbox, and the undo-send window. |

`send_draft` requires an `idempotencyKey` (8–200 characters). Aerio claims the
key atomically before sending, so retries and concurrent calls with the same key
send at most once:

- the same key and draft again returns the first result with `duplicate: true`;
- the same key while the first send is still being queued, or with a different
  draft, is refused with `conflict`;
- a draft that is already queued, scheduled, or sent is refused with
  `already-sent`, whatever the key;
- if Aerio refuses the draft before queuing it (for example an unfinished
  address), the key is released so the corrected draft can be sent with it.

Keys are kept per client for 30 days.

### Delete (Allow moving to Trash)

| Tool | Effect |
| --- | --- |
| `trash_message` | Moves conversations to Trash, like Delete in Aerio. Providers may empty Trash later. |

## Access controls

- **Off by default.** While off, nothing listens; enabling creates the endpoint
  and disabling closes it and disconnects every client.
- **Capabilities.** Read is implied. Write, send, and delete are separate toggles;
  Settings lists every tool's effect under its capability. Disabled tools are
  removed from `tools/list` and refused if called anyway.
- **Account scope.** All accounts, or only selected ones. Out-of-scope accounts,
  their conversations, and their drafts are indistinguishable from ones that do
  not exist. An empty selection exposes nothing.
- **Clients and revocation.** Each client has its own random 256-bit token
  (`aerio_mcp_…`), stored only as a SHA-256 hash in `mcp-automation.sqlite`.
  Settings lists clients with when they were issued, when they were last used,
  and whether one is connected now. **Revoke** deletes the hash and closes the
  client's connections at once; requests already in flight are answered
  `unauthorized`. Every request re-checks that its client still exists.
- **App lock.** While Aerio is locked every tool call returns `locked` without
  reading or changing anything, and automation settings cannot be changed.
  Tool definitions (which contain no mail data) stay listable.
- **Shutdown.** Quitting Aerio closes the endpoint; the bridge keeps running and
  answers `app-not-running` until Aerio starts again, then reconnects on the
  next call.
- **Local only.** Windows named pipes and unix sockets are not reachable from
  the network. On Windows other local accounts can open the pipe, so the token
  is what authorizes a client; on macOS and Linux the socket is also limited to
  your user.

## Diagnostics and privacy

The bridge writes to stderr, and Aerio writes `mcp-*` events to its diagnostic
log, recording only tool names, client ids, argument **names**, outcomes, error
codes, and durations. Argument values, message content, subjects, addresses,
attachment data, and tokens are never logged; error reasons are scrubbed of
addresses, quoted text, and long encoded runs (`electron/mcp/redact.ts`).

## Backups

Full profile backups include the automation choices (capabilities and account
scope) but never client token hashes or the send ledger. A restored profile
starts with the bridge **off** and no clients, so restoring never re-opens
external access; turn it on and issue new tokens if you still want it.

## Limits

- Drafts created through MCP have no attachments; `update_draft` keeps the
  attachments a draft already has. Add files in Aerio's composer.
- `trash_message`, `archive`, `move`, `mark_read`, and `flag` act on whole
  conversations, matching Aerio's own actions.
- Search covers what Aerio has synchronized into its offline index.
- Each bridge connection runs at most 16 calls at once; more are refused until earlier
  calls finish.

## Code map

| Part | File |
| --- | --- |
| Tool catalog and JSON Schema validation | `electron/mcp/tools.ts` |
| MCP / JSON-RPC server core | `electron/mcp/protocol.ts` |
| Stdio bridge (standalone entry and `--mcp`) | `electron/mcp/bridge.ts`, `electron/mcp/bridge-runtime.ts`, `electron/mcp/bridge-mode.ts` |
| Local channel (endpoint, framing, client) | `electron/mcp/channel.ts` |
| Main-process listener | `electron/mcp/server.ts` |
| Tool execution through mail services | `electron/mcp/service.ts` |
| Settings, tokens, idempotency ledger | `electron/mcp/store.ts` |
| IPC and wiring | `electron/mcp/automation-ipc.ts`, `electron/main.ts`, `electron/preload.ts` |
| Settings UI | `src/components/McpAutomationSection.tsx` |
