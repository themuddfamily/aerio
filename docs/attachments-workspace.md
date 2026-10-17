# All-attachments workspace

**All attachments** in the Mail sidebar footer opens a cross-account list of every attachment in the offline cache, newest first. Each row shows the filename, size, file type, sender, subject, and date, and offers **Open**, **Save as**, and **Show original message** (the conversation's message window, focused on that message). The same actions are available from the row's context menu.

## Querying

[`attachment-index.ts`](../electron/mail/attachment-index.ts) reads the existing `gmail_attachments` metadata joined to messages, threads, and accounts; no schema changes or content extraction are involved. The renderer calls `mail.attachments.list(query)` (`mail:attachments:list` → worker `attachments:list`), and the query is normalized in both the main process and the worker: unknown fields and file types are dropped, text is trimmed to 200 characters, sizes must be non-negative, and pages hold 1–100 rows (50 by default).

| Filter | Behavior |
| --- | --- |
| Name | Case-insensitive substring of the filename; `%` and `_` are literal. |
| From / To or cc | Substring of the sender name and address, or of the To and Cc lists. |
| Account | One account or all accounts; **Include archived accounts** is on by default. |
| Type | PDF, documents, spreadsheets, presentations, images, archives, calendar invites, audio, video, or other. The extension decides first, then the MIME type, so `application/octet-stream` files are still classified. The same rules generate the SQL `CASE` expression and the TypeScript classifier, and a test keeps them in agreement. |
| Size | Under 100 KB, 100 KB – 1 MB, 1 – 10 MB, or over 10 MB. |
| Received after / before | Inclusive calendar dates against the message date. |

Results use a keyset cursor over `(message date, account, message, attachment)`, so pages stay stable while new mail arrives and ties on the same timestamp are not skipped or repeated. Trash and Spam are excluded, as in **All mail**. Provider copies of one message (the same Message-ID in one conversation, such as an IMAP message in two folders) appear once. Inline images with a Content-ID (logos and signature art) are hidden unless **Show inline images** is checked.

## Open, save, and availability

Open and save reuse the per-message `mail:attachment:open` and `mail:attachment:save` handlers, which extract the part from the stored raw message. Each row reports whether that original exists on disk; when it does not, Open and Save are disabled and the row says *Original not downloaded*, and the worker rejects extraction with "The original message is not available offline" instead of a file-system error.

Archived accounts keep their attachments, marked *Archived account*. Deleting an account cascades through its messages and attachment rows, and the open workspace reloads when the account list changes.

## Boundaries

Unit tests cover classification parity, filters, pagination across tied timestamps, invalid cursors, trash/spam/inline/duplicate exclusion, missing originals, archive and deletion, an 8,000-row paging check, IPC routing, and the workspace UI with a mocked desktop API. The inline-image rule is a heuristic: some clients set a Content-ID on ordinary image attachments, which then need **Show inline images**. Filtering scans the joined metadata without a dedicated index, which is fast at the tested scale but has not been measured against very large real mailboxes. Opening files with the operating system's default application was not exercised in a packaged build.
