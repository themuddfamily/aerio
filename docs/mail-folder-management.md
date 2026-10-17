# Mail folder and label management

Open **Folders & labels** from the Mail sidebar footer, or right-click a sidebar label and choose **Manage folders and labels…**. Folders and labels can be created, renamed, nested, and deleted, and Gmail labels can also be recolored. Every change is made on the provider first; Aerio then re-reads the provider's folder list. Folder changes are never applied optimistically or queued offline, because messages can't be filed into a folder until the provider has assigned it an id. When the app is offline, it refuses the change and nothing is altered.

The **Color** column below is the provider's own folder color. Favorites, display aliases, local icons and name colors for non-Gmail folders, and hiding folders from the sidebar are Aerio-only display preferences that never change the provider folder; see [favorite folders and local folder appearance](favorite-folders.md). The star button next to each folder in **Folders & labels** adds it to or removes it from Favorites without contacting the provider.

| Provider | API | Nesting | Color | When a folder is deleted |
| --- | --- | --- | --- | --- |
| Gmail | `users.labels` create/patch/delete | By name (`Parent/Child`); renaming a parent also renames its children | Fixed Gmail palette only | The label is removed; its messages stay in All Mail |
| Microsoft 365 / Outlook | Graph `mailFolders` create, `childFolders`, PATCH, `move`, DELETE | `parentMailFolderId` | Not supported | Graph DELETE (Outlook keeps the folder in Deleted Items) |
| IMAP providers | `CREATE` / `RENAME` / `DELETE` via ImapFlow | Server hierarchy delimiter and namespace prefix | Not supported | Messages are first moved to the special-use Trash, then the folder is deleted, but only if it is verified empty |
| Local Folders | Local database only; works offline and nothing reaches a server | `parentId`, stable ids, `/` not allowed in names | Not supported | Messages move to Trash and the folder is removed (see [mail import and Local Folders](mail-import-local-folders.md)) |

## Safety rules

- System folders and labels can't be renamed or deleted. These are Inbox, Sent, Drafts, Trash, Junk, Archive, Gmail system and category labels, and Microsoft well-known folders. They can still serve as parents where the provider allows it.
- Names are checked locally before the request is sent: blank names, control characters, `/` in Gmail names, the IMAP delimiter, `*`/`%`, the reserved name Inbox, and case-insensitive duplicates among sibling folders are all rejected. Conflicts reported by the provider (Gmail/Graph 409, IMAP `ALREADYEXISTS`) come back as readable errors.
- **Deleting a non-empty folder requires explicit confirmation.** The dialog shows the cached message and conversation counts, plus where the messages will go, and the delete button stays disabled until the checkbox is ticked. The worker also checks the provider's live count (Gmail `messagesTotal`, Graph `totalItemCount`, IMAP `STATUS`). If the provider reports messages that Aerio's cache didn't know about, the worker refuses the delete and the dialog asks for confirmation again with the provider's count.
- A folder can't be deleted while it has subfolders, or while queued or running mail operations target it or have messages in it. The user has to wait for those operations to finish or undo them first.
- An IMAP delete moves messages to Trash and then re-checks `STATUS`. If any messages remain, or if the server exposes no Trash folder, the folder is kept and nothing is expunged.

## Preserving queued work and selections

On IMAP, a folder's id is its path, so a rename or move changes the ids of the folder and all of its subfolders. Aerio rewrites these references for the old ids:

- cached message labels and `remote_folder_id`
- inventory items
- the `label_id` and undo snapshots of queued and running operations
- rule actions
- per-folder UIDVALIDITY checkpoints
- favorites and local folder appearance ([details](favorite-folders.md#renamed-moved-and-deleted-folders))

Undoing an operation that was queued before the rename therefore restores the new ids, not stale ones. Messages in a renamed IMAP folder are re-indexed by the sync that follows, and their local ids follow the new path. If the renamed or deleted folder was open in the sidebar, it stays selected under its new id, or the selection is cleared if it was deleted.

## Failures and recovery

Each provider request is recorded in `mail_folder_operations` as `running` and then marked `succeeded` or `failed`. If a request fails, the cached messages and labels are left untouched. If the provider reports a conflict (404 or `NONEXISTENT`), Aerio refreshes the folder list so the next attempt starts from the server's current state. If Aerio closes while a request is in progress, the next start marks that row `interrupted` and re-reads the account's folders from the provider, which remains the source of truth. A delete interrupted after the IMAP messages were moved leaves an empty folder and the messages in Trash.

## Verification

- Unit tests: `src/lib/mail-folders.test.ts`, `electron/mail/folder-management.test.ts` (which uses a real SQLite database with fake providers), `electron/mail/folder-clients.test.ts`, and `src/components/MailFolderManagerModal.test.tsx`.
- `npm run test:imap` uses a real worker against the loopback Hoodiecrow server to create, sync, and rename a folder. It also refuses to rename a special-use folder, rejects an unconfirmed delete of a non-empty folder, and confirms that the guarded delete leaves the message in Trash.
- Gmail and Microsoft Graph behavior is covered only with mocked HTTP. Their live behavior has not been validated against real accounts: Graph's Deleted Items semantics for folder DELETE, the folder id returned by `move`, and Gmail palette acceptance.
