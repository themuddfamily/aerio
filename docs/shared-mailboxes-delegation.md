# Shared mailboxes, delegation, and public folders

Exchange Server (EWS) and Microsoft 365 (Microsoft Graph) accounts can open other mailboxes next to their own:

- **Shared mailboxes**, such as `sales@` or `support@`, that an administrator granted you.
- **Delegated mailboxes**: another person's mailbox, or some of its folders, that the owner shared with you as a delegate.
- **Exchange public folders** (Exchange Server only).

You can also send **as** a shared mailbox or **on behalf of** its owner. On Exchange Server, you can manage the delegates of your own mailbox.

Everything is in **Settings › Mail account › Shared mailboxes & public folders**.

## Setting up access on the server

Aerio never grants permissions itself. It uses the permissions the server reports.

| What you want | Exchange Server | Microsoft 365 |
| --- | --- | --- |
| Read and file mail in a shared mailbox | Full Access (`Add-MailboxPermission -AccessRights FullAccess`) | Full Access in the Microsoft 365 admin center |
| Work in only some folders of a colleague's mailbox | The owner adds you as a delegate (Outlook › Delegate Access, or **Manage delegates** in Aerio) or shares folders with a permission level | Folder permissions set in Outlook |
| Send **as** the mailbox (From = mailbox) | Send As (`Add-ADPermission -ExtendedRights "Send As"`) | Send As in the admin center |
| Send **on behalf of** the owner (From = owner, Sender = you) | Send on Behalf (`Set-Mailbox -GrantSendOnBehalfTo`), or delegate access | Send on Behalf in the admin center |
| Public folders | Public folder client permissions (`Add-PublicFolderClientPermission`) | Not available through Graph |

Microsoft 365 accounts need the delegated Graph permissions `Mail.ReadWrite.Shared`, `Mail.Send.Shared`, and `Calendars.ReadWrite.Shared`. New connections request them. An account connected before this release gets them after **Reconnect** in its settings; until then, Graph answers 403 and Aerio reports the mailbox as having no access.

## Adding a mailbox

1. Open **Settings › Mail account › Shared mailboxes & public folders**.
2. Enter the mailbox address and an optional name for the sidebar. Choose **Shared mailbox** or **Another person's mailbox (delegate)**, and choose how to send from it:
   - **Do not send from this mailbox**
   - **Send as** (From: the mailbox)
   - **Send on behalf** (From: the mailbox, Sender: you)
3. Choose **Add mailbox**. Aerio first checks which folders it can open. If it can open none, the mailbox is not added, and Aerio says whether the address does not exist or you have no permission.

On Exchange Server, **Find my mailboxes** asks the Autodiscover service on the server you already connect to. It lists the mailboxes the server reports in `AlternativeMailbox` entries (delegate and team/shared mailboxes, including automapped ones), and you add each with **Add**. Microsoft Graph cannot list shared mailboxes with delegated permissions, so on Microsoft 365 you enter the address.

The mailbox appears in the sidebar's folder tree under its name, with its folders below it. A badge shows the access: **Shared**, **Delegate**, or **Public** when you can change items, **Read-only**, or **Access removed**. Mail from other mailboxes never appears in your unified Inbox, Sent, or Trash. Open the mailbox's folders to read it.

## Effective permissions

Aerio decides what you may do per folder:

- **Exchange Server** reports `EffectiveRights` for every folder (`GetFolder`/`FindFolder`). A folder is **Can edit** when it has both `CreateContents` and `Modify`. It is **Read-only** when it has only `Read`, as for the Reviewer permission level. It is **No access** when `Read` is false or the folder refuses access.
- **Microsoft Graph** does not report folder rights. Folders start as **Can edit**. When Graph refuses a change with 403, the folder becomes **Read-only** and stays that way until you remove and add the mailbox again. Calendars report `canEdit`, which Aerio shows directly.

**Permissions** next to each mailbox in settings lists every folder Aerio found (mail, calendar, contacts, tasks, notes) with your access.

Read-only folders can be read and searched. Reply and forward still work, because they send from your own account. Mark read/unread, flag, importance, move, archive, trash, snooze, and quick actions are disabled in the toolbar and menus. The reader shows why. The mail worker enforces the same rules. A rule or quick action that reaches a read-only folder is refused with an explanation, and the messages are put back as they were.

Moving messages works only between folders of the same mailbox. **Trash**, **Archive**, **Move to Inbox**, and **Junk** use that mailbox's own Deleted Items, Archive, Inbox, and Junk Email folders. Aerio does not move or copy messages between your mailbox and another mailbox. Forward them instead.

If Exchange or Graph refuses a change Aerio expected to work, for example because the owner lowered your permission, Aerio checks the mailbox again:

- If the mailbox is still readable, the folder becomes **Read-only**, the change fails with the server's reason, and the messages are put back as they were.
- If the mailbox is no longer readable, access was removed. See the next section.

## When access is removed

When the server answers `ErrorAccessDenied`, `ErrorNonExistentMailbox`, or (Graph) 403 or 404 for the whole mailbox, Aerio:

- marks the mailbox **Access removed** in settings and the sidebar, with the reason (no permission, or the mailbox no longer exists).
- stops synchronizing it. Background syncs skip it, and **Check access again** retries.
- **holds** its queued changes instead of retrying or dropping them. They are listed under **N changes are on hold**. **Send again** is possible once access is back. **Discard** puts the messages back as they were before the change.
- keeps the cached mail **read-only** until you choose **Remove**, which deletes the mailbox's local copy, its held changes, and the send-as/on-behalf From address created for it. Nothing changes on the server.

When one mailbox or folder fails, the others keep synchronizing. A folder that refuses access during a sync is marked **No access**, and the mailbox shows which folders could not be read.

## Sending as or on behalf

Choosing **Send as** or **Send on behalf** for a mailbox creates a From address for it in **From addresses**. There you can also switch an added address of an Exchange or Microsoft 365 account to **Send as** or **Send on behalf**.

| Mode | From | Sender | Exchange (EWS) | Microsoft 365 (Graph) |
| --- | --- | --- | --- | --- |
| Send as | the shared mailbox | (none) | `CreateItem` with `<t:From>` and the MIME From | Staged draft with `from`, then `send` |
| Send on behalf | the owner | you | `CreateItem` with `<t:Sender>` and `<t:From>`, plus a `Sender:` header | Staged draft with `from` and `sender`, then `send` |

On Exchange Server, the sent copy is saved in the **owner's Sent Items** (`SavedItemFolderId` with the owner's mailbox) when that folder is writable for you. Otherwise, or if Exchange refuses that folder, it is saved in your own Sent Items. Graph always saves the copy in your own Sent Items. An administrator can also keep a copy in the shared mailbox (`MessageCopyForSentAsEnabled`, `MessageCopyForSendOnBehalfEnabled`).

If the server refuses (`ErrorSendAsDenied`, `ErrorAccessDenied`, or Graph 403), nothing is sent and the draft stays with an explanation of which permission is missing. A staged Graph draft is deleted. Sending from a mailbox whose access was removed is refused before contacting the server.

## Public folders (Exchange Server)

**Browse public folders** shows the public folder tree one level at a time (`FindFolder` under `publicfoldersroot`, then under each folder), with each folder's type and your access. **Show in Aerio** subscribes a folder:

- **Mail public folders** appear in the sidebar under **Public Folders**, read-only or writable per their rights. EWS cannot synchronize public folders incrementally, so on every sync Aerio lists each subscribed folder with `FindItem` and compares ChangeKeys with the cache. Large public folders take longer than mailbox folders.
- **Calendar and contacts public folders** appear in Calendar and Contacts as **read-only** sources, listed the same way.

Exchange 2013 and later keep public folders in public folder mailboxes. Every public folder request carries the `X-AnchorMailbox` and `X-PublicFolderMailbox` headers with the hierarchy mailbox from Autodiscover (`PublicFolderInformation/SmtpAddress`). If Autodiscover does not report one, Aerio uses your own address, and Exchange routes the request to the default public folder mailbox. Unsubscribing removes the folder's local copy. Removing the last subscription removes **Public Folders** from the sidebar.

## Delegated calendars and contacts

On Exchange Server, the Calendar and Contacts folders of every attached mailbox you can read appear in Calendar and Contacts as "*Mailbox* – Calendar" and "*Mailbox* – Contacts". They use the existing Exchange Calendar/Contacts connector, with the same ChangeKey checks, offline queue, and conflict review. They can be edited only when the folder is writable for you (Editor or Author). Otherwise they are read-only. Microsoft 365 shared calendars are shown with their access in **Permissions**, but are not added to Calendar yet.

## Managing delegates of your mailbox (Exchange Server)

**Manage delegates of my mailbox** reads your delegates with `GetDelegate` and lets you:

- add a delegate (`AddDelegate`) with a permission level for **Calendar**, **Tasks**, **Inbox**, **Contacts**, and **Notes**:
  - **None**
  - **Reviewer**: read
  - **Author**: create and change their own items
  - **Editor**: change everything
- choose whether the delegate **receives copies of meeting-related messages** and **can see your private items**.
- change a delegate (`UpdateDelegate`) or remove one (`RemoveDelegate`).
- choose who receives meeting requests sent to you (`DeliverMeetingRequests`):
  - **My delegates only, but send me a copy for information**
  - **My delegates and me**
  - **My delegates only**
  - **Only me**

Custom permission sets made in Outlook are shown as Reviewer. Saving one replaces it with the level you choose. If the server does not support delegate management through EWS, Aerio says so instead of showing the editor. Microsoft Graph has no delegate API, so for Microsoft 365, manage delegates in Outlook or the admin center.

## How it is stored

Every cached folder, message, sync checkpoint, and queued change belongs to a **mailbox owner**:

- `primary`: the account's own mailbox
- `mbx-<hash of the address>`: a shared or delegated mailbox
- `public`: the public folder tree

Other owners' folders are labels named `owner:<owner>:<folder id>`, and their message and conversation ids include the owner. Two folders called "Inbox" therefore never collide, and synchronizing your own mailbox never touches another owner's cache. The `aerio.sqlite` migration adds `owner_id` (default `primary`) to labels, messages, the download inventory, and the action queue. Rows that existed before stay with your own mailbox. Owners and their folders, rights, and checkpoints are in `mail_mailbox_owners` and `mail_mailbox_owner_folders`. They are removed with the account and included in profile backups.

## Limitations

- Behavior against real servers has not been verified yet. See the [live-provider matrix](live-provider-test-matrix.md#shared-mailboxes-delegation-and-public-folders-coverage).
- Messages cannot be moved or copied between your mailbox and another mailbox or public folder.
- Folders cannot be created, renamed, or deleted in other mailboxes or public folders from Aerio.
- Public folders are listed in full on each sync, not incrementally. Public calendars and contacts are read-only, even when the folder is writable.
- Public folder requests use the hierarchy mailbox for routing. Content in other public folder mailboxes relies on Exchange's proxying.
- Microsoft Graph reports no folder rights, so a read-only shared folder is discovered by the first refused change. Graph shared calendars are not added to Calendar.
- Graph saves sent-as and on-behalf messages in your own Sent Items.
- Exchange Online public folders and delegate management are not available through Graph.
