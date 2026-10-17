# Mail merge (personalized mass mail)

A mail merge turns one composed message into **one separate delivery per
recipient**, with variables filled in for each person. Open it from the
composer's **Mail merge** button (new messages only, not replies); running and
past merges are listed under **Mail › Mail merges**.

## Recipients

- **Contacts**: pick synced or local contacts (search, *Select shown*). Contacts
  without an email address are not offered.
- **Paste or CSV**: paste addresses separated by commas, semicolons, or new
  lines (`Name <address>` is understood), or paste/load a CSV whose header row
  has an email column. Recognised columns fill `firstName`, `lastName`, `name`,
  and `company` (Google, Outlook, and generic names such as *Given Name*,
  *Surname*, *Organization*); every other column becomes a custom variable.
  Anything already typed in the composer's To field is the starting list.
- Invalid addresses are left out, duplicates (case-insensitive) keep the first
  row, and a merge is limited to 5,000 recipients, 50 columns, and 1,000
  characters per value.

## Variables

`{{firstName}}`, `{{lastName}}`, `{{name}}`, `{{email}}`, `{{company}}`, and any
CSV column (`{{plan}}`). Names ignore case, spaces, and punctuation, so
`{{First Name}}`, `{{first_name}}`, and `{{firstName}}` are the same. Add a
fallback after a bar: `{{firstName|there}}`. A variable with neither a value
nor a fallback becomes empty; the preview and confirm step say which recipients
are affected.

Substitution is shared by the renderer preview and the mail worker
(`src/lib/mail-merge.ts`), so what you preview is what is sent:

- In the HTML body, values are HTML-escaped. A placeholder interrupted by
  formatting tags (`{{first<b>Name</b>}}`) is left unchanged rather than
  half-substituted. The HTML is then sanitized by the normal MIME builder.
- In the subject, CR/LF are removed from values and fallbacks, so a contact
  field cannot add a header. The To display name has quotes, angle brackets,
  backslashes, and line breaks removed.

## Privacy

Every delivery is built by `buildMergeDelivery` with exactly one To address and
empty Cc/Bcc, no thread or In-Reply-To, and is checked before submission. The
composer's Cc and Bcc fields are never used (the confirm step says how many are
ignored), and the IPC layer only forwards the shared message plus the recipient
list, never an address list for a single message.

## Limits and throttling

The confirm step shows the number of messages and conservative defaults per
account type, which can be lowered or raised up to a provider maximum:

| Account | Default per minute | Default daily cap | Maximum daily cap |
| --- | --- | --- | --- |
| Gmail (gmail.com) | 20 | 400 | 500 |
| Google Workspace | 20 | 1,500 | 2,000 |
| Outlook.com / Hotmail | 10 | 250 | 300 |
| Microsoft 365 | 20 | 2,000 | 10,000 |
| iCloud | 10 | 500 | 1,000 |
| Yahoo | 10 | 300 | 500 |
| Fastmail | 10 | 500 | 2,000 |
| Other IMAP/SMTP | 10 | 200 | 2,000 |

Per-minute is capped at 60. Submissions are spaced by the per-minute rate
whatever their outcome. The daily cap is a rolling 24-hour window per account,
counted across all merges (a small send log survives deleting a merge); when it
is reached the merge waits and resumes automatically. Rate-limit replies (HTTP
429, Gmail quota/rate 403s, SMTP 4xx, SMTP 5xx mentioning a sending limit)
return the recipient to the queue and back off 1, 2, 4… minutes up to an hour.

## Delivery states and restart recovery

Jobs and recipients live in the mail database (`mail_merge_jobs`,
`mail_merge_recipients`, `mail_merge_send_log`; created idempotently and
removed with their account). Attachments are copied into
`mail-merge/<job>/` so discarding the source draft does not affect the merge.

Before a delivery is handed to the provider its row is committed as `sending`.
Afterwards it becomes:

| Outcome | Recipient | Job |
| --- | --- | --- |
| Provider accepted it | `sent` | continues |
| Provider refused it (4xx other than 401/408/429, SMTP 5xx, recipient refused) | `failed` | continues; *Resend* re-queues it |
| Rate limited | back to `pending` | backs off |
| Nothing was submitted (credentials unavailable, account needs reconnecting, From address not allowed, attachment copy missing) | back to `pending` | `paused` with the reason; *Resume* after fixing it |
| Anything else (timeouts, dropped connections, 5xx after submission) | `ambiguous` | `needs-review` |

When the mail worker starts, rows still `sending` from a previous run become
`ambiguous`. An ambiguous recipient is **never retried automatically**, and
while any recipient is ambiguous the whole merge sends nothing else. The
progress view explains that the message may or may not have gone out; check the
Sent folder, then choose **Resend** (accepting a possible duplicate) or **Skip**
for each recipient, or for all of them at once. Mail shows a notice at startup
and when a merge enters review.

Restoring a [full-profile backup](profile-backup.md) treats every unsent
recipient of an unfinished merge the same way, because the backup may predate
deliveries made afterwards: they become `ambiguous`, the merge waits for review,
and they are counted with the held outgoing sends in the restore preview.

**Cancel remaining** marks every waiting recipient `cancelled`; a delivery
already handed to the provider still records its outcome. Finished, paused, or
cancelled merges can be removed.

## Not covered

- Live provider sending, real throttling responses, and packaged-app behaviour
  are not verified against real accounts; tests use the real SQLite store with
  scripted transports and mocked provider clients.
- The Gmail and Microsoft clients already retry 5xx responses internally. A
  server error after Gmail accepted a message could therefore duplicate that one
  delivery before the merge sees the error; the merge itself never retries an
  unknown outcome.
- Sent copies are synced once a merge finishes (or by normal polling); there is
  no per-recipient link to the Sent message.
- Variables are plain text; there is no conditional content or per-recipient
  attachment.
