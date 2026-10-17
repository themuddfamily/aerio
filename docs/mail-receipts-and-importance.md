# Receipts and outgoing importance

Aerio can mark outgoing mail as high or low importance, ask for read and
delivery receipts, and answer read-receipt requests on incoming mail. A receipt
is only a report from the recipient's mail app or a mail server. It does not
prove that a message was delivered to an inbox, or that anyone read it, and
Aerio's wording never says that it does.

## Outgoing choices

The composer's flag button opens **Importance and receipts**. The choices are
stored with the draft (`MailDraftInput.sendOptions`, column
`gmail_drafts.send_options_json`). They survive autosave, reopening, offline
queueing, scheduled send, and Undo send. Unknown or default values are dropped
by `normalizeSendOptions` in `src/lib/mail-send-options.ts`, both in the main
process and in the database.

| Choice | MIME header (all providers) | Gmail | Microsoft Graph | IMAP/SMTP |
| --- | --- | --- | --- | --- |
| High / low importance | `Importance: High/Low`, `X-Priority: 1/5` | Header in raw MIME | `importance` set with PATCH on the draft | Header |
| Read receipt | `Disposition-Notification-To: <sender>` | Header only. The recipient's app decides | `isReadReceiptRequested` | Header |
| Delivery receipt | `Return-Receipt-To: <sender>` (legacy) | **Unsupported.** The option is disabled and dropped when sending | `isDeliveryReceiptRequested` | SMTP DSN `NOTIFY=SUCCESS,FAILURE,DELAY`, only if the server advertises DSN |

Microsoft's MIME upload does not reliably map these headers to message
properties. So when a non-default option is set, Aerio PATCHes the Graph
properties after creating the draft. A direct send with options goes through a
staged draft and `/send` rather than `/sendMail`.

## Incoming read-receipt requests

**Settings → Read receipts** offers *Never send*, *Ask me* (the default), and
*Always send*. The main process reads the policy from stored preferences. The
renderer can never supply it.

- **Never:** requests are ignored, and an explicit send is refused.
- **Ask:** the expanded message shows the request with *Send receipt* and
  *Don’t send*. Nothing is sent without that click.
- **Always:** a receipt goes out when the message is first expanded. As RFC 8098
  §2.1 requires, Aerio still asks instead when:
  - the message is junk or deleted,
  - the message is `Auto-Submitted`,
  - the request names more than one address, or
  - the request address differs from `Return-Path` (or `From`).

  Aerio also asks when it is offline.

Each message is answered at most once. Answers are kept in
`mail_receipt_responses`, and a sent receipt is never sent again. A failed
automatic send is not retried on its own. The user can retry it. Requests on
the account's own messages, and on receipts themselves, are ignored. Receipts
are RFC 8098 `multipart/report` MDNs with the `displayed` disposition.

## Returned receipts

When an incoming message is a `multipart/report` of type
`disposition-notification` (read receipt) or `delivery-status` (DSN), the
message shows a summary. Aerio matches the report to the synced sent message by
`Original-Message-ID`, or by the `Message-ID` in the returned headers, and
shows that message's subject. The summary always notes that the report is not
proof of delivery or reading.

## Not verified against live providers

The unit tests use mocks for every provider path. These behaviors have not yet
been checked against live services:

- whether Gmail keeps the receipt headers;
- whether Graph accepts the PATCH on MIME-created drafts;
- how Exchange-generated receipts arrive through `$value`;
- real SMTP servers' DSN behavior.
