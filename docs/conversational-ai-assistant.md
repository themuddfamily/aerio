# Conversational AI assistant (D01)

Enable AI assistance and **Conversational assistant** in Settings, then open **AI assistant** in the app rail. It works with the configured Anthropic or OpenAI-compatible model. Ask follow-up questions in one conversation; the model can choose several bounded read tools before answering. A model must reliably follow JSON instructions. Unsupported or malformed model output stops the turn without applying changes.

- Mail and web tools start **off**. Mail access requires selecting up to five active accounts. Changing account/tool scope clears the previous context on the next message.
- Mail searches use Aerio's existing query parser, selected accounts and supported folders. A search returns at most 20 conversations. The model receives subject/date/state and server-generated references. Sender addresses are included only with **Include sender details** enabled.
- Reading requires a reference observed by a previous search. It sends up to three newest cached plain-text messages, 4,000 characters each, with subject/date. Recipients, attachments, headers and HTML are excluded. The assistant cannot download arbitrary attachments or read other accounts.
- Folder listing exposes bounded names and anonymous account aliases. Shared/owner folders and Drafts/Sent/Outbox destinations are excluded. References are minted in the main process; the model cannot supply database identities.
- Web research uses a separate optional **Brave Search token** in AI settings. An appropriate Brave Search LLM Context subscription is required. With web enabled, enter and review **Public search query for this message** before sending. Only that exact text goes to Brave's fixed HTTPS API; extracted public-page content then goes to the configured model. The main process ignores model-proposed query alternatives, including mail text injected into a tool argument. No query is derived from mail, tool output or the model. The field clears after Send, requiring a new user-entered query for every turn. Avoid private search terms. Review source links and claims.
- Public research retrieves indexed page excerpts and citations. It can research topics and follow up on findings using the query you enter. Include a public URL or `site:` in that field to narrow a search. The model may use the approved query up to twice in a turn and must ask you to edit it for different research. It does not control an interactive browser, sign into sites, or fetch arbitrary URLs. Only validated public HTTPS citation links are displayed.

The token is encrypted separately with operating-system credential storage. It is never returned to the renderer, included in model prompts, or saved in portable AI settings. Removing the token disables web research while leaving model credentials intact.

## Reviewing mail organization

Ask the assistant to find mail and propose an organization action. It can propose mark read/unread, add/remove star, archive, move to Trash, label or move to a folder. There are no tools for sending/forwarding mail, permanent deletion, arbitrary commands, or automatic recurring rules.

**A proposal never performs a change.** The preview shows the exact conversations and accounts. Edit the action, deselect targets and choose an observed folder if necessary. Tick **I reviewed this action and these conversations**, then press **Apply reviewed changes**. Editing clears that acknowledgement. Move/label destinations must belong to the selected conversations' account. The main process separately validates the review against the proposal, current account availability and current folder availability before calling the normal mail action queue.

Proposals are limited to 20 observed conversations, expire after ten minutes and can be used once. At most ten outstanding proposals are kept. Clearing, locking, changing scope or saving AI settings invalidates old proposals. Account groups are queued separately; the result reports successful conversation count and failed groups. Failed groups are not retried automatically. Use normal mail undo where the action supports it.

## Limits, cancellation and data lifetime

Each turn has a two-minute deadline, at most eight model steps and at most two web lookups. Each web request has a twenty-second deadline, a one-megabyte response limit and at most five sources. Conversation context keeps the latest twenty messages, sends the latest sixteen, and bounds retained tool data to twelve outputs / 45,000 serialized characters. Up to 100 observed mail and folder references are retained per conversation. Ask narrower questions or clear the conversation when limits are reached.

**Cancel request** aborts provider/web requests and discards late results. Read-only worker queries already underway may finish, but cannot apply changes. Applying reviewed changes is a separate action: a queued mail action cannot be cancelled by cancelling an AI turn. App lock clears assistant memory and stops a pending turn. Closing the dialog cancels a turn; reopening in the same unlocked app session preserves completed conversation context. Clear, app restart or saving AI settings removes this transient history. No conversation-history file is written by Aerio. Providers may retain requests under their own policies.

Subjects, mail bodies, folder names and public web excerpts are treated as untrusted data in a randomly delimited tool-data block, separate from conversation instructions. Strict tool/action validation, account scopes, observed references and the separate review endpoint enforce the actual boundaries even if a model follows injected text. This does not guarantee factual answers or prevent a model from proposing an inappropriate change: review all proposals and public search terms carefully.

## Integration evidence

- Brave's official [LLM Context API](https://api-dashboard.search.brave.com/api-reference/ai/llm_context/get) defines the fixed `GET /res/v1/llm/context` endpoint, `grounding.generic` excerpts, bounds and search controls. [Authentication](https://api-dashboard.search.brave.com/documentation/guides/authentication) specifies the `X-Subscription-Token` header.
- Anthropic's [guardrail guidance](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks) informs separation of third-party text from instructions; application validation and user review remain mandatory.
- Deterministic tests exercise actual HTTP request construction and response parsing with mocked provider responses. Live Brave/model calls require user credentials and are not claimed by those tests.
- `node scripts/desktop-ai-conversation-audit.mjs` launches native Electron with a disposable local compatible model server and profile. It verifies the rail launcher, actual preload/main HTTP calls, multi-turn context, default tool scopes and Clear. It uses no live model/search credentials.
