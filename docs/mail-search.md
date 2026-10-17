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
| `from:ada`, `to:grace`, `cc:`, `subject:`, `body:`, `attachment:` (`file:`, `filename:`) | Limit a term, phrase, or group to one field, e.g. `subject:(launch OR release)`. |

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

## Saved searches

Use the bookmark button in the search box to save the current search. A saved
search stores its name, query, account scope (one account or all accounts),
mailbox, optional label, and advanced filters in the local
`mail_saved_searches` table, so it survives restarts. Deleting an account
removes its saved searches.

Saved searches appear under **Saved searches** in the Mail sidebar. Opening one
restores its whole scope, and the results reload as new mail is indexed. Right-click
a saved search to edit it, replace it with the current search, or delete it.
