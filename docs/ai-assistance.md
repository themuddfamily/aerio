# Optional AI assistance

Aerio can use a large language model to summarize email, draft and rephrase
messages, suggest replies, and turn a plain-language request into a mail
search. The assistant is **off by default**. Manual tools run after you enable
AI and press their action button. Separately opting into automatic reply
suggestions allows displayed messages to be sent as described below.

## Features

| Feature | Where | What is sent |
| --- | --- | --- |
| Summarize emails | Message menu › **Summarize with AI…** | Subject, date, and plain-text body (first 12,000 characters). Sender name and address only when **Include sender details** is on. Never recipients, attachments, headers, or HTML. |
| Suggested replies | Message menu › **Suggest replies with AI…** | The same as Summarize. |
| Draft and rephrase | Composer toolbar ✨ button | Your instruction and the text currently in the composer. The email you are replying to is added only when you tick **Include the email I’m replying to**. |
| Natural-language search | ✨ button in the Mail search box | Only the words you type into the Ask AI box. No email content is sent. |
| Create mail rules | Mail rules › New rule › **Describe a rule with AI** | Your description and the supported rule format. No email content, account details, folder list, writing styles or saved rules. Names/addresses typed into the description are included. |

The same descriptions appear in Settings next to each feature switch and in
every AI dialog (`src/ai-assistant-types.ts`, `AI_FEATURE_DETAILS`). Each
feature can be switched off independently.

**Create mail rules (D02)** returns a validated, disabled local draft. A structured preview lists every condition, exception and action. **Use this draft** loads it into the editable rule form; enabling and **Save rule** are separate actions. AI cannot execute, activate, save or upload a rule. Unsupported actions, invalid comparisons/schedules, injected identities and unknown or ambiguous destination names are rejected. Folder names resolve locally within the selected account after generation. Cancel, close or change accounts to discard a pending generation. See [mail rules](mail-rules.md).

Translation (LibreTranslate) and the manual **Create meeting / task from email**
tools are separate and unchanged.

**Automatic task/event detection (D04)** has a separate off-by-default switch,
**Detect tasks and events when I open a message**. It also requires the Detect
tasks and events feature switch. Expanded messages send the same limited email
fields as summaries, plus the current date and local time zone, after a short
delay. Strictly validated suggestions contain only task/event titles, notes,
dates and times; the model cannot create anything. Ambiguous event times should
be omitted. Review task/event opens the normal editable creation form with
those fields prefilled. Check dates, destination calendar and attendees, then
press Create explicitly. Collapsing/navigating away cancels analysis. Turning
either switch off hides suggestions. Models can misinterpret dates; this is a
review aid rather than an authoritative schedule.

**Automatic reply suggestions (D05)** are separately off by default. Enable
**Suggest replies when I open a message** and save AI settings to opt in.
Expanded messages then request reply previews after a short delay. This sends
the same fields as manual reply suggestions; collapsing/navigating away cancels
the request and discards late results. Both the main AI switch and Suggested
replies feature switch must be enabled. Turning the setting off hides previews.
**Reply with this** opens an editable draft and never sends it automatically.

**Writing style per sending account (D03)** stores up to 2,000 characters of
user-approved tone and formatting preferences for each account in AI settings.
Draft generation uses the selected sending account; reply suggestions use the
message account. Styles are included in provider requests and can be edited or
cleared. Save AI settings to persist changes. For optional style learning,
paste selected examples of your own sent mail (up to 12,000 characters), press
Analyze, review/edit the result, then Use this style and Save. This never scans
Sent, fetches other messages, or saves a generated style automatically. Samples
are not persisted by Aerio. Analysis uses the saved provider/model and requires
the drafting feature to be enabled.

The summary dialog also offers **Whole conversation** (D06). It reads the cached
thread and sends chronological subject/date/plain-text excerpts from up to its
newest 100 messages, sharing a 48,000-character excerpt budget. Each message
gets a fair share; omitted text is marked, and the prompt reports coverage
limits. Sender details follow the existing setting; recipients, attachments,
HTML and raw headers remain excluded. This does not download uncached mail.
The wider scope is disclosed before the user presses Summarize. Switching
scope clears the old preview, and cancellation and feature switches still apply.

## Providers

- **Anthropic** — `POST https://api.anthropic.com/v1/messages` with the
  `x-api-key` and `anthropic-version: 2023-06-01` headers. The default model is
  `claude-sonnet-5-5`.
- **OpenAI-compatible** — any `/chat/completions` endpoint (OpenAI, Ollama,
  LM Studio, vLLM…). Enter the base URL, e.g. `http://localhost:11434/v1`; the
  API key is optional. HTTPS is required unless the server is on `localhost`,
  and URLs with credentials or query strings are refused.

Requests are made by the main process with `fetch` (no SDK), with
`redirect: 'error'`, a 60-second timeout, and an `AbortController` so the
**Cancel request** button stops the call. Provider errors (invalid key, rate
limits, missing models, outages, unreachable servers) are shown as short
messages; the key itself is never included.

## Key storage

Non-secret settings (enabled, provider, model, base URL, feature switches) are
stored in `ai-assistant.json` in the user-data folder. The API key is encrypted
with Electron `safeStorage` into `ai-assistant-key.dat`, guarded by the same
`assertSecureCredentialStorage` check as mail credentials, so it is refused on
Linux’s weak fallback backend. The key is never returned to the renderer;
Settings only learns whether one is saved. A local server that needs no key
works even when secure storage is unavailable.

## Safety model

Email content is attacker-controlled, so the assistant is built so that a
malicious message cannot make it do anything on its own:

1. **Untrusted data framing.** Email bodies, drafts, and search requests are
   wrapped in `<<<UNTRUSTED kind id>>> … <<<END UNTRUSTED id>>>` markers with a
   random id per request. Any `<<<`/`>>>` sequences in the content are
   replaced, and bidi-override, zero-width, and control characters are removed,
   so the content cannot close or forge a marker. The system prompt states that
   marked content is data and that instructions inside it must be ignored.
2. **No tools.** Requests never include tool definitions. The model can only
   return text.
3. **Plain-text output.** Responses are stripped of control and invisible
   characters, length-limited, and rendered as React text nodes — never as
   HTML. Inserting into the composer escapes the text first.
4. **Preview first.** Every result is a preview. Using it requires an explicit
   click: **Reply with this** opens an editable reply (it never sends),
   **Replace message text** / **Insert at cursor** edit the draft, and **Run
   search** fills the search box.
5. **Validated search.** A proposed search must parse with
   `src/lib/mail-search-query.ts`; invalid output is rejected. The query is
   shown in an editable field, revalidated as you edit, and only runs when you
   press **Run search**.
6. **Read-only backend.** The `ai:*` IPC handlers only read the selected
   message from the mail worker (`mail:thread`); they have no path to send,
   move, label, or delete mail.

These layers reduce risk but cannot make model *content* trustworthy: a
summary can still be wrong or reflect misleading text in the email. Review
generated text before using it.

## Code map

- `electron/mail/ai-provider.ts` — Anthropic and OpenAI-compatible clients,
  timeouts, cancellation, error mapping.
- `electron/mail/ai-prompts.ts` — prompt construction, untrusted framing,
  output sanitizing, reply and search parsing.
- `electron/mail/ai-assistant.ts` — settings and encrypted key storage, `ai:*`
  IPC handlers, per-request cancellation.
- `src/components/AiAssistantSettings.tsx`, `MailAiAssistDialog.tsx`,
  `MailAiComposeAssist.tsx`, `MailAiSearchDialog.tsx` — renderer UI;
  `src/lib/use-ai-assistant.ts` — status and cancellable request hooks.

Tests mock `fetch` and never contact a real provider.

## Not yet verified

- No live calls against Anthropic, OpenAI, or Ollama have been made; request
  and response shapes are covered by mocked tests only.
- Responses are not streamed; long generations appear when complete.
- Prompt-injection resistance is tested for delimiter forging and for the
  absence of any mutating path, not against a corpus of adversarial prompts on
  real models.
