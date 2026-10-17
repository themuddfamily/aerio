# Favorite folders and local folder appearance

Aerio's Mail sidebar lists every folder or label of your accounts, and lets
you pin the ones you use most into a **Favorites** section at the top. You can
also give folders a local icon and name color, and hide folders you never
open. All of these are **display preferences**: they change how folders look
in Aerio on this computer and are never sent to Gmail, Microsoft 365, IMAP
servers, or any other provider.

## Display preferences versus provider folder changes

| You do this | What changes | Where it is stored |
| --- | --- | --- |
| Add to / Remove from Favorites, reorder favorites | Only the Favorites section | Aerio's mail database |
| Rename favorite (alias) | Only the name shown in Favorites | Aerio's mail database |
| Folder appearance: icon, name color (non-Gmail) | Only the sidebar look | Aerio's mail database |
| Hide from sidebar / Show hidden folders | Only the sidebar folder tree | Aerio's mail database |
| Change a Gmail label color (Manage labels) | The label color **on Gmail** | Gmail (synchronized back to Aerio) |
| Create, rename, move, or delete a folder (Manage folders) | The folder **on the provider** | The provider; see [mail folder management](mail-folder-management.md) |

In particular:

- **Removing a favorite never deletes the folder** or its mail. The folder
  stays in the folder tree and on the server.
- **A favorite's alias is display-only.** The folder keeps its name on the
  server and everywhere else in Aerio (the folder tree, rules, Move to…).
- **Hiding a folder does not unsubscribe or delete it.** Mail in it is still
  synchronized and searchable, and it can still be chosen in Move to…,
  rules, and Quick Actions.
- **Gmail labels keep their synchronized Gmail colors.** Aerio does not store
  a separate local color for Gmail labels; change a label's color in
  **Folders & labels** and the change is made on Gmail through the existing
  label-color path. Icons and visibility are local for Gmail labels too.

## The folder tree

The **Folders** section (titled **Labels** when only Gmail accounts are
shown) lists the whole folder tree of the selected account, or of every
account in **All accounts**, grouped under each account's address. It
replaces the earlier list of the first twelve labels.

- Nested folders appear under their parents. Use the chevron next to a parent
  to collapse or expand it, or press **Right arrow** / **Left arrow** on the
  folder. In the unified view, click an account's heading to collapse its
  whole tree. Expanded/collapsed state is remembered in this window.
- When the visible tree has more than twelve folders, a **Filter folders**
  box appears. Filtering finds folders inside collapsed parents and shows the
  matches with their parent folders. Press **Escape** to clear it.
- Gmail accounts show user labels; Inbox, Sent, Trash, and the other system
  labels are in the **Mailboxes** group. IMAP and Microsoft accounts show
  their full folder tree, including system folders, so subfolders of Inbox
  can be reached.
- Local Folders keep their own **Local Folders** section and support the same
  favorites, icons, colors, and hiding.

A star after a folder name means the folder is in Favorites.

## Favorites

Right-click a folder in the folder tree or in Local Folders and choose **Add
to Favorites**, or use the star button next to a folder in **Folders &
labels**. Favorites from every account appear together at the top of the
sidebar, above **Mailboxes**, whichever account is selected. Clicking a
favorite opens that folder in its account.

- **Same-named folders** are told apart: when two favorites have the same
  name, each shows its account address (for different accounts) and its full
  path (for folders in the same account), for example “Projects
  me@work.example” and “Projects me@home.example”.
- **Reorder** by dragging a favorite to a new position, with **Alt+Up** /
  **Alt+Down** on a focused favorite, or with **Move up** / **Move down** in
  its context menu. The order is saved immediately and kept after restarting
  Aerio.
- **Rename favorite…** (favorite context menu) or **Folder appearance…**
  sets a display alias. Clear the alias to show the folder's own name again.
- **Remove from Favorites** (favorite or folder context menu, or the star
  button in Folders & labels) removes only the favorite.

## Folder appearance and visibility

Right-click a folder and choose **Folder appearance…** to choose:

- an **icon** from a fixed set (folder, inbox, star, flag, bookmark,
  briefcase, receipt, people, home, heart, archive, tag), or the default;
- a **name color** from a fixed palette, for folders that are not Gmail
  labels (IMAP, Microsoft 365, iCloud, Yahoo, Fastmail, Proton Bridge, and
  Local Folders);
- **Hide from the sidebar folder list**.

**Hide from sidebar** / **Show in sidebar** are also in the folder context
menu. Hiding a folder also hides its subfolders. When an account or Local
Folders has hidden folders, a **Show hidden folders (N)** button appears in
that section; turn it on to show them dimmed (with a crossed-out eye) so they
can be opened or shown again. The setting is remembered in this window.

## Renamed, moved, and deleted folders

Favorites and appearance are keyed by **account and provider folder id**,
never by name.

- **Gmail labels and Microsoft 365 folders** have ids that do not change when
  they are renamed, so favorites follow renames made anywhere. When Microsoft
  returns a new id for a moved folder, Aerio follows it.
- **IMAP folders** (including iCloud, Yahoo, Fastmail, and Proton Bridge) use
  the mailbox path as the id. A rename or move **through Aerio** updates the
  favorites and appearance of the folder and all of its subfolders together
  with messages, rules, and queued changes. A rename or move made **in another
  mail client** is reconciled on the next sync when it is unambiguous: exactly
  one folder (with its subfolders) disappeared and exactly one appeared, with
  either the same parent (a rename) or the same name (a move). Otherwise
  Aerio does not guess.
- **Local Folders** ids never change.
- A favorite's folder **deleted through Aerio** is removed from Favorites
  together with its appearance settings.
- A favorite whose folder is **missing after a sync** (deleted or renamed in
  another client in a way Aerio could not match) is **not pruned**. It stays
  in place, dimmed and labelled **Unavailable** with its last known name, and
  has a **Remove** button. Keeping it means a folder that reappears (for
  example, one briefly missing from a server listing or re-created with the
  same path or id) returns to its place automatically. A favorite whose
  account was removed is deleted with the account's local data.

## Storage and backup

Favorites (order, alias, last known name) and appearance (icon, color,
hidden) are stored in the `mail_folder_favorites` and
`mail_folder_appearance` tables of `aerio.sqlite`, so full-profile backups
include them and the backup preview counts **Favorite folders**. Removing an
account deletes its rows. The folder tree's expanded/collapsed state and the
**Show hidden folders** toggle are per-window conveniences kept in browser
storage; losing them only resets the tree to its default look.

## Verification

Automated tests cover:

- `electron/mail/folder-preferences.test.ts`: same-named folders in different
  accounts, order and aliases after reopening the database, removal without
  deleting the folder, IMAP renames and moves through Aerio (including
  subfolders) and from another client on the next sync, ambiguous changes and
  deleted folders kept as unavailable, stable Gmail ids, account removal,
  Gmail versus local colors, and profile backup and restore.
- `electron/mail/folder-preference-ipc.test.ts` and `electron/preload.test.ts`:
  IPC channels and input validation.
- `src/lib/mail-folder-preferences.test.ts`: disambiguation, stale favorites,
  color rules, collapse/hide/filter of the tree.
- `src/components/MailSidebarFolders.test.tsx`,
  `src/components/MailFolderManagerModal.test.tsx`, and
  `src/views/ConnectedMailView.test.tsx`: Favorites across accounts,
  drag-and-drop and keyboard reordering, unavailable favorites with Remove,
  the full filterable tree beyond twelve folders, hidden-folder toggle, and the
  appearance editor for Gmail and non-Gmail folders.
