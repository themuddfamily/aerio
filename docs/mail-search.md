# Mail search and saved searches

Aerio searches the offline SQLite FTS5 index (`gmail_fts`) that every connected
account populates during sync. The Mail search box accepts a small query
language, and any search can be saved to the sidebar.

## Query syntax

| Input | Meaning |
| --- | --- |
| `invoice report` | Both words (prefix match), in the same message. Adjacent terms are joined with AND. |
| `"quarterly report"` | Exact phrase. |
| `invoice OR receipt` | Either term. |
| `invoice AND paid` | Explicit AND (same as a space). |
| `NOT paid`, `-paid` | Exclude. |
| `(invoice OR receipt) -paid` | Parentheses group terms. |
| `from:ada`, `to:grace`, `cc:`, `subject:`, `body:`, `attachment:` (`file:`, `filename:`) | Limit a term, phrase, or group to one field, e.g. `subject:(launch OR release)`. `attachment:` matches attachment filenames and their extracted text. |

- Operators must be uppercase. Lowercase `and`, `or`, and `not` are ordinary words.
- Precedence is NOT, then AND, then OR, so `a OR b c` means `a OR (b AND c)`.
- A NOT at the top level removes any conversation containing a matching
  message, so a search such as `-newsletter` works on its own. Inside
  parentheses, NOT is evaluated per message and must sit next to a term to
  include, e.g. `(invoice -paid) OR refund`.
- Unknown prefixes such as `re:status` are searched as ordinary words.
- Limits: 1,000 characters, 64 terms, and 16 levels of parentheses.

Invalid input, such as an unclosed quote, unbalanced parentheses, a dangling
operator, or `a OR -b`, shows a message under the search box and the list stops
loading until the search is fixed.

### Safety

`src/lib/mail-search-query.ts` tokenizes the input, builds a Boolean AST, and
compiles it to FTS5 syntax in which every user word is re-quoted (`"word"*` or
`"exact phrase"`), so raw FTS operators or SQL in the box are treated as text.
The compiled strings are only ever bound as statement parameters in
`MailDatabase.listThreads`; they are never interpolated into SQL.

## Attachment contents

Aerio extracts text from attachments on the device and adds it to the same
FTS row as the message, in the `attachment_names` column after the filenames.
So `attachment:budget` finds a file named `budget.xlsx` or a PDF that mentions
"budget", and an unscoped search such as `budget` also matches attachment
text, as it already did for filenames. `body:` and the other field prefixes
never match attachment text.

| Type | What is indexed |
| --- | --- |
| PDF | Text drawn on each page and in form XObjects, including embedded fonts mapped through ToUnicode CMaps. Scanned (image-only) pages produce no text; no OCR is done. |
| Word (`.docx`, `.docm`, `.dotx`) | Body, headers, footers, footnotes, endnotes, and comments. |
| Excel (`.xlsx`, `.xlsm`) | Shared and inline cell strings (no number cells or formulas). |
| PowerPoint (`.pptx`, `.pptm`) | Slide text and speaker notes, in slide order. |
| Text | `text/*` (except RTF), `.txt`, `.csv`, `.md`, `.json`, `.xml`, `.ics`, `.vcf`, and similar, as UTF-8, UTF-16 (with a BOM), or Windows-1252; HTML has its markup removed. |

Legacy binary Office files (`.doc`, `.xls`, `.ppt`), RTF, images, and archives
are not indexed.

### Pipeline and limits

- `electron/mail/attachment-text-indexer.ts` runs in the mail worker. Each pass reads
  up to 25 attachments that have no result from the current extractor version,
  newest mail first, re-parses each message's stored raw MIME once, and saves
  one result per attachment in `mail_attachment_text`. It runs after
  initialization and whenever a synced message has attachments.
- Parsing happens in a separate worker thread
  (`attachment-extract-worker.ts`, started by `attachment-extract-runner.ts`)
  with a 256 MB old-generation heap cap and a 15-second timeout per attachment.
  A hung, crashing, or out-of-memory parser is terminated and the next
  attachment starts a fresh worker. The parser thread receives only the bytes,
  with no database or network access.
- Each parser is bounded too: attachments over 25 MB aren't read; zip entries
  and PDF streams together may inflate at most 64 MB (decompression bombs stop
  there); archives with more than 5,000 entries are rejected; and at most
  200,000 characters per attachment and 1,000,000 per message go into the
  index.
- The PDF reader is a small built-in parser, not a renderer, so no new
  dependency was added. Text order follows the content stream and can differ
  from the visual layout. Glyph-name encodings without a ToUnicode map fall
  back to Windows-1252, and composite fonts without one are skipped rather than
  indexed as garbage.

### Status, reindexing, and removal

Each attachment ends in one of these states, stored with a short reason and
shown on the attachment card in the reader (hover for details; a note such as
"Password-protected" appears next to the size when a supported file couldn't
be indexed):

`pending`, `indexed` (optionally truncated), `empty` (no text, e.g. a scanned
PDF), `unsupported`, `encrypted` (password-protected PDF or Office file),
`too-large`, `timeout`, `memory-limit`, or `failed` (damaged, or the raw
message is no longer stored offline).

Results aren't retried on their own. Raising
`ATTACHMENT_TEXT_EXTRACTOR_VERSION` in `attachment-text-types.ts` marks every
older result pending, so the next pass re-extracts everything. A re-downloaded
message keeps its results when the attachment id and size are unchanged; a
changed attachment drops its old text immediately and is extracted again.

Deleting a message deletes its extracted text. Deleting an account cancels
any extraction in progress for it, stops new work for it, and removes all of
its extracted text with the account's search rows. Results are only written if
the attachment still exists, so a parse that finishes after a deletion never
brings the text back. Archiving an account keeps its index.

## Saved searches

Use the bookmark button in the search box to save the current search. A saved
search stores its name, query, account scope (one account or all accounts),
mailbox, optional label, and advanced filters in the local
`mail_saved_searches` table, so it survives restarts. Deleting an account
removes its saved searches.

Saved searches appear under **Saved searches** in the Mail sidebar. Opening one
restores its whole scope, and the results reload as new mail is indexed. Right-click
a saved search to edit it, replace it with the current search, or delete it.
