# Contact merge and communication history

Contacts › **Find duplicates** suggests contacts that are probably the same person. Nothing is merged until you review a pair and confirm it. The contact pane also shows the messages and attachments you exchanged with the contact, read from the offline mail cache.

## Ownership

Every contact has one owner: the local address book on this PC, or one provider account (a Google or Microsoft account). The detail pane shows it as **Stored in**. Ownership decides what can be done with a pair:

| Pair | Action |
| --- | --- |
| Two local contacts | Merge |
| Two contacts of the same provider account | Merge, through the provider's write paths. Both must be writable (provider editing enabled). |
| Contacts of different owners (local and Google, two Google accounts, Google and Microsoft) | Link on this PC. Provider records are never merged across accounts. |

A link is a local association. Linked contacts are listed in each other's detail pane, and their addresses are combined in the communication history. Links can be removed with **Unlink**.

## Duplicate detection

`src/lib/contact-duplicates.ts` scores pairs that share an email address, a phone number, or a full name. It does not compare every pair, so it stays fast on large address books.

| Signal | Score | Notes |
| --- | --- | --- |
| Same email address | +0.70 | Compared case-insensitively over every typed address. Dots in the local part are ignored for `gmail.com` and `googlemail.com` only. Plus tags (`ada+news@…`) are never removed, because they can route mail differently. |
| Same phone number | +0.45 | Digits only. A leading `+` or `00` marks a country code, a national trunk `0` is dropped, and extensions are ignored. A national number matches an international one only when it has at least 8 digits and is the tail of the other. Numbers under 7 digits are not compared. |
| Same name | +0.35 | Same words in any order, ignoring case, accents, punctuation, and honorifics (`Lovelace, Ada` = `ada lovelace`). |
| Similar name | +0.20 | Initials (`A. Lovelace`) and small typos. |
| Names differ | −0.30 | A shared email or phone with clearly different names. This is typical of family or team addresses. |

Confidence is **high** at 0.9 or more, **medium** at 0.6 or more, and **low** below that. Pairs under 0.35 are not shown. A name match alone is shown only for full names (two or more words) and only as low confidence. Each suggestion lists its reasons.

Some pairs are not suggested:

- pairs you marked **Not duplicates**
- pairs you already linked
- pairs from a value shared by more than 50 contacts, such as a help desk address

Read-only provider pairs are shown, but cannot be merged until provider editing is enabled.

## Merge preview

The preview lets you pick the **record to keep**, which is the survivor. The survivor keeps its identity: its id, provider resource id, revision, raw provider data, and color. The other record is merged away.

For each single-value field (name, company, job title, nickname, birthday, photo, notes), you choose which record's value to keep. The choice is asked only when both records have different values. Otherwise the value that exists is kept. Conflicting notes default to **Both**, which keeps both texts. Structured name parts follow the chosen name.

Multi-value fields are always combined (`src/lib/contact-merge.ts`):

- emails, phones, addresses, and websites keep every distinct value with its type label and structured address parts
- the survivor's primary values stay primary
- groups and categories are combined
- local favourites are kept if either record was a favourite

The same normalization as the contact editor applies, including the limit of 50 values per kind.

Before anything is written, the preview warns about provider limits:

- Outlook stores at most three email addresses and one mobile number.
- Microsoft contact photos are not synchronized.
- Google group memberships are changed separately (see below).
- The duplicate is deleted from the provider.

Local distribution-list members that referred to the merged-away contact are moved to the survivor. They always keep their address.

## Writing a merge

**Local merges** are applied in the renderer, which owns the local address book. The renderer replaces the survivor and removes the other record, and the main process journals the originals.

**Provider merges** run in the main process (`electron/productivity/contact-merge.ts`):

1. Both contacts are re-read from the stored snapshot. They must belong to the same account and provider, both must be writable, and both must still have the revisions the preview was built from. Otherwise the merge stops before writing ("changed since you opened it").
2. The survivor is updated through the same connector call as the contact editor, so Google etags and Microsoft `changeKey` checks apply, and unmodelled provider details on the survivor are kept.
3. Google: the survivor joins the merged-away contact's writable contact groups with `members:modify`, because memberships are not part of a person update. `My Contacts` and read-only groups are skipped and reported. Microsoft categories are written as part of the update.
4. The journal entry is saved.
5. The duplicate is deleted. If this fails, the merge is still journaled with a warning, so it can be undone or the duplicate can be deleted by hand.

## Undo journal

Every merge is stored in `contact_merge_journal` in `productivity.sqlite`, which is part of the full-profile backup. An entry holds the survivor and the other record as they were before the merge, the saved survivor, the moved list members, and the Google groups the survivor joined. The 100 most recent entries are kept. They are listed under **Recent merges** in Find duplicates, each with **Undo**.

Undo refuses to run if the survivor has changed since the merge: a different local value, or a different provider revision. Otherwise it does the following:

- **Local:** restores both original records with their original ids and moves the list members back.
- **Provider:** writes the survivor's original values back with a revision-checked update, and removes it from the groups it joined. If the duplicate was deleted, it is recreated from its snapshot, including the photo for Google, and rejoins its writable Google groups. List members move to the recreated contact.

Limits of provider undo:

- A recreated contact gets a **new provider id**.
- The provider's creation date, edit history, and fields Aerio does not model are lost. On the survivor, those fields are not touched by the merge.
- Provider-side links to the old id are not restored, such as calendar attendees or shared contact references.
- Values beyond Outlook's slots were never stored, so they cannot come back.

Removing an account (archive or delete) removes that account's journal entries, links, and dismissals, together with its synchronized contacts. Links and dismissals live in `contact_associations`. Local data backups (`aerio-local-data` files) do not include the journal or the links. Full-profile backups do.

## Communication history

The contact pane lists cached messages sent by or to any of the contact's addresses, and those of its linked contacts. A new mail-worker command does the search (`contacts:history`, `electron/mail/contact-history.ts`):

- **Matching** is exact: the sender address, or any To or Cc entry stored as a bare address or as `Name <address>`. A substring never matches (`bada@` is not `ada@`).
- **Excluded** are Trash, Spam, and duplicate provider copies of one message, the same as in the attachments workspace.
- **Order and paging:** newest first, with keyset pagination on (date, account, message id), so ties do not repeat or skip messages. **Load more** fetches 20 at a time.
- **Each row** shows whether the contact sent it or received it, the account, an *archived* label for archived accounts, and the attachment count. Clicking a row opens the message window.
- **Accounts:** checkboxes choose which mail accounts are searched. Deleted accounts are gone from the list and their messages disappear by cascade. Archived accounts keep their offline mail. Imported Local Folders are stored as their own mail account, so their messages are included and can be deselected the same way.

The **Attachments** tab reuses the E12 attachment index (`mail:attachments:list`) with a new `participants` filter that uses the same exact address matching. Attachments whose original message is not stored offline are labelled. Clicking an attachment opens its message.

## Coverage and unverified boundaries

These areas have unit tests:

- normalization, scoring, and false-positive guards: shared family addresses, single first names, plus tags, short phone numbers, and non-Gmail dots
- ownership and read-only blocking, dismissal and link skipping, and scale on 3,000 contacts
- field preservation and choices in merges, provider identity retention, warnings, and list relinking
- provider merge orchestration against a real `ProductivityStore` with a fake connector: revision, ownership, and permission rejections, group transfer, failed deletes, undo with recreation, and conflict refusal
- journal limits and account removal
- IPC validation, preload channels, and worker routing
- the history SQL: exact matching, Trash and Spam, tied-timestamp keyset paging, account selection, and archived and deleted accounts
- the Contacts view flows

These have not been verified:

- behavior against the live People and Graph APIs, such as whether `members:modify` succeeds right after a person update, and recreate behavior for every field
- history performance on very large mailboxes: there is no dedicated address index, so recipient matching scans `to_json` and `cc_json`
- contacts that the E21 CardDAV work adds, which will need their own owner rules when they land
