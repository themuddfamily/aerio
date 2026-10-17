# Mailing-list unsubscribe

Aerio reads a message's `List-Unsubscribe` (RFC 2369) and `List-Unsubscribe-Post` (RFC 8058) headers and offers an explicit **Unsubscribe from list…** action in the message options menu of the mail view and the separate message window.

## Behaviour

- Metadata is parsed on demand from the original headers that Aerio already stores for every Gmail, Microsoft, and IMAP message (`mail:source`). No schema change is involved, and opening a message or the unsubscribe dialog never contacts the list.
- The dialog shows each destination before anything is sent: the website host and full HTTPS address, or the recipient address and subject of an unsubscribe email, plus the `List-Id` when present.
- **One-click** (HTTPS URI and a `List-Unsubscribe-Post: List-Unsubscribe=One-Click` header): Aerio sends a single `POST` with the body `List-Unsubscribe=One-Click`, no cookies or credentials, a 30-second timeout, and `redirect: 'manual'`. Redirects are reported as failures rather than followed; non-2xx responses and network errors are shown in the dialog.
- **Open in browser**: any HTTPS URI can instead be opened in the system browser.
- **Unsubscribe email** (`mailto:`): Aerio queues a message from the receiving account to the listed address(es) using the mailto `subject` and `body` (defaulting to "unsubscribe"). Archived accounts cannot send. The message goes through the normal outgoing queue.
- The main process re-reads the headers for every action and only accepts a URI that the message itself advertises, so the renderer cannot direct a request elsewhere.

## Rejected input

Entries are ignored, with an explanation in the dialog, when the header is malformed (not angle-bracketed), the URI is plain HTTP or another unsupported scheme, contains credentials, exceeds 2,048 characters, or a mailto address is invalid or badly encoded. A second `List-Unsubscribe` header is ignored. A malformed `List-Unsubscribe-Post` header disables one-click. One-click requests are refused for `localhost`, `.local`/`.internal` names, private, loopback, and link-local IP literals, and host names that resolve to such addresses.

## Limits

- DKIM coverage of the unsubscribe headers (which RFC 8058 requires senders to provide) is not verified; Aerio relies on the user seeing the destination before acting.
- The private-address check resolves DNS before the request but does not pin the address used by the request itself.
- Behaviour against live list servers has not been verified; coverage comes from unit tests with mocked network, DNS, browser, and send dependencies.

Implementation: [`electron/mail/list-unsubscribe.ts`](../electron/mail/list-unsubscribe.ts), IPC in [`electron/mail/message-tools.ts`](../electron/mail/message-tools.ts), UI in [`src/components/MailUnsubscribeDialog.tsx`](../src/components/MailUnsubscribeDialog.tsx).
