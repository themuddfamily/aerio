# Cloud attachments

The composer can upload a file to the sending account's **Google Drive** (Gmail accounts) or **OneDrive** (Microsoft accounts), or to a separately connected **Dropbox**, **ownCloud** or **Nextcloud** account, and insert a sharing link instead of attaching the file. Ordinary attachments are unchanged and remain the default. Connected storage accounts work from any mail account, including IMAP; an account with no storage of its own and no connected storage account only offers ordinary attachments.

Open it with the cloud button in the composer footer, or from the notice that appears when the known attachment sizes exceed what the mail provider usually accepts (Gmail 25 MB; Microsoft about 3 MB, because Aerio sends Microsoft mail as one MIME request to Graph, which is capped near 4 MB after base64 encoding). The notice offers the largest attachments; the file stays attached until its link has been inserted, then the attachment is removed.

## Sharing scope

Before anything is uploaded the panel shows who will be able to open the file and whether they can view or edit, for example "Only ada@example.com can edit after signing in to a Google account". Nothing is shared until **Upload and insert link** is clicked.

| Audience | Google Drive | OneDrive |
| --- | --- | --- |
| Anyone with the link | `permissions.create` `type: anyone`, `allowFileDiscovery: false` | `createLink` `scope: anonymous` |
| People in my organization | Not offered (Drive needs the Workspace domain name) | `createLink` `scope: organization` |
| Only the message recipients | One `type: user` permission per To/Cc/Bcc address, `sendNotificationEmail=false` | `invite` with `requireSignIn: true`, `sendInvitation: false` |

View maps to Drive `reader` / OneDrive `read` or `view`; edit maps to `writer` / `write` or `edit`. Provider refusals are explained instead of shown raw: Workspace admins that block "anyone" links, tenants that disable anonymous OneDrive links, personal Microsoft accounts (no organization), and Drive recipients without a Google account (Drive will not share with them without sending Google's own email, so Aerio asks you to choose a link instead). When sharing fails the just-uploaded file is deleted so no unshared copy is left behind.

The link is inserted at the caret, or above the signature when there is no caret, as a plain `<a href>` followed by the provider, size and scope in parentheses. The outgoing sanitizer in `mime-builder.ts` already allows that; the `data-aerio-cloud-link` marker that styles it as a chip in the composer is stripped on send.

## Permissions (opt-in)

Nothing changes for an account until the user opts in. The first time the panel opens for an account without the storage permission it explains what is needed, and **Connect Google Drive / OneDrive** runs an interactive reconnect for that account that adds one scope to the existing grant:

- Google: `https://www.googleapis.com/auth/drive.file`, which covers only files Aerio creates or opens; Aerio cannot list or read the rest of the Drive. The request uses `include_granted_scopes=true`.
- Microsoft: `Files.ReadWrite`. Files go to an `Aerio attachments` folder in the user's OneDrive. Work or school tenants may require administrator consent.

Existing mail, calendar, contacts and task grants are kept. Silent token refresh never asks for the new scope, and once granted, later ordinary reconnects request it again so a reconnect cannot quietly drop it. Grants stored before Aerio tracked scopes count as not connected. A provider `403` that names missing scopes is reported as a permission problem with the same connect path. Tokens stay in the main process; the renderer receives only status, progress and the finished link.

## Uploads, cancellation and recovery

Uploads run in the main process in 5 MiB chunks (a multiple of Drive's 256 KiB and OneDrive's 320 KiB units): a Drive resumable session (`uploadType=resumable`) or a OneDrive `createUploadSession`. The panel shows progress and a **Cancel upload** button. Cancelling aborts the transfer, sends `DELETE` to the session URL, and removes the file if it had already finished uploading; nothing is shared.

Only files the user picked in a file dialog (or that Aerio staged, such as forwarded attachments) can be uploaded. A dropped connection or a provider `5xx` mid-upload asks the provider for the confirmed offset and continues, up to two times per chunk. If the upload still fails, or Aerio quits, the session is kept in `cloud-uploads.dat` in the profile folder. That file is encrypted with OS secure storage because session URLs are short-lived upload capabilities; when secure storage is unavailable nothing is written and uploads simply cannot resume. The next time the panel opens for that account it lists **Interrupted uploads** with **Resume** and **Discard**:

- Resume asks the provider for the confirmed byte (Drive `Content-Range: bytes */size`, OneDrive `GET` on the upload URL's `nextExpectedRanges`) and continues from there, then shares and inserts the link.
- An expired session (past its expiry, or a `404`/`410` from the provider), a source file whose size or modified time changed, or a lost permission clears the stored state and asks you to start again.

## Expired links and revoked permissions

Aerio remembers the links it created (file id, permission ids and URL; the 500 most recent). When you send a message that contains cloud links, Aerio checks each one first:

- deleted or trashed file → "deleted"
- the permission Aerio created was removed → "revoked"
- the link or permission has an expiry in the past → "expired"
- Aerio can no longer read the file (for example the storage grant was revoked) → "permission-denied"

If any link fails, a confirmation lists the problems and asks whether to send anyway. Links Aerio did not create, and checks that fail because of the network, are not reported and never block sending. Scheduled messages are checked when they are scheduled, not again at delivery time. The check finds links by the composer marker, so a draft reopened from a copy the provider synced back (which went through the outgoing sanitizer) is not checked.

## Connected storage accounts: Dropbox, ownCloud and Nextcloud

Settings › **Cloud storage accounts** connects storage that is not tied to a mail account. Each account connects, refreshes and disconnects on its own, and can be used from any composer: when there is more than one place to store a file, the cloud panel has a **Store in** choice (the mail account's own Drive or OneDrive comes first). Aerio uploads only into an `Aerio attachments` folder and never lists or reads other files. The Settings section and the cloud panel both show what each account allows (link password, expiry date, editing, and whether large uploads resume) together with plain-language notes such as "The server requires a password on every public link", and **Check again** re-reads it.

### Dropbox setup

Dropbox uses OAuth 2 authorization code with PKCE (S256) and `token_access_type=offline`, so there is no app secret. A build can include an app key through `MAIN_VITE_DROPBOX_APP_KEY` (validated like the other OAuth settings in `oauth-config.ts`); otherwise Settings asks for one:

1. In the Dropbox App Console create a **Scoped access** app with **App folder** or **Full Dropbox** access.
2. Under Permissions enable `account_info.read`, `files.metadata.read`, `files.content.write`, `sharing.read` and `sharing.write` (Aerio requests exactly these).
3. Add the redirect URI `http://localhost:53134/dropbox`. Dropbox only accepts registered redirect URIs, so the loopback port is fixed; if another program holds it, sign-in explains that.
4. Paste the app key in Settings and choose **Connect Dropbox**. Sign-in opens in the browser; the callback page is the same one used for Google and Microsoft.

The refresh token is kept in `cloud-storage-credentials.dat`, encrypted with OS secure storage exactly like DAV app passwords (`DavCredentialVault`); short-lived access tokens are renewed from it and stay in memory. If Dropbox revokes the grant the account shows **Sign-in needed** and **Sign in again** reconnects the same account.

### ownCloud and Nextcloud setup

Enter the server address, user name and an **app password** (Personal settings › Security › Devices & sessions on Nextcloud, Personal › Security on ownCloud). HTTPS is required except for a server on this computer, credentials in the URL are refused, and a pasted WebDAV or login URL is trimmed to the server root. Aerio checks the password with `ocs/v1.php/cloud/user` (which also gives the user id used in WebDAV paths, which can differ from the login name) and reads `ocs/v1.php/cloud/capabilities` before keeping anything. The app password goes to `cloud-storage-credentials.dat` (OS secure storage); the server, user name and discovered capabilities go to `cloud-storage-accounts.json`. Connecting the same server and user again replaces the password and keeps the account. Disconnecting does not revoke the app password on the server, because the same password may also be used for CalDAV/CardDAV; revoke it in the server's security settings if it is no longer needed.

### Sharing-capability comparison

| | Google Drive | OneDrive | Dropbox | Nextcloud | ownCloud |
| --- | --- | --- | --- | --- | --- |
| Account | The Gmail account (`drive.file`) | The Microsoft account (`Files.ReadWrite`) | Separate, OAuth 2 PKCE | Separate, app password | Separate, app password |
| Anyone with the link | `type: anyone` | `scope: anonymous` | `audience: public`, `requested_visibility: public` | OCS share `shareType=3` | OCS share `shareType=3` |
| Organization / team | Not offered | `scope: organization` | `audience: team` (Business only) | Not offered | Not offered |
| Only people with access | Recipients only (`type: user`) | Recipients only (`invite`) | `audience: no_one` | Not offered | Not offered |
| Edit access | `writer` | `write` | Not offered (file links are view-only) | `permissions=3` when public uploads are allowed | `permissions=3` when public uploads are allowed |
| Link password | No | No | `link_password` with `requested_visibility: password` (Plus, Professional, Business) | `password`; Required when `files_sharing.public.password.enforced` | `password`; Required when enforced (also `enforced_for.read_only`) |
| Expiry date | Admin-set only | Reported when set | `expires` (Plus, Professional, Business) | `expireDate`; Required with a maximum when `expire_date.enforced` | Same as Nextcloud |
| Large uploads | Resumable session | Upload session | `upload_session/start`, `append_v2`, `finish` | Chunked upload v2 (Nextcloud 26+ with `dav.chunking`) | One streamed `PUT` |
| Pre-send check | `files.get` + permission | item + permission | `files/get_metadata` + `sharing/get_shared_link_metadata` | `PROPFIND` + `GET shares/{id}` | Same as Nextcloud |
| Turn a link off from Aerio | No (use Drive) | No (use OneDrive) | `sharing/revoke_shared_link` | `DELETE shares/{id}` | `DELETE shares/{id}` |

The composer only offers what the account allows: audiences it cannot create are hidden, **Can edit** disappears for view-only accounts, and password and **Expires on** fields appear when available and are marked required when the server enforces them (the date picker is limited to the enforced maximum). The main process checks the same rules again before uploading anything, so a renderer cannot request a password on Dropbox Basic or skip an enforced password. If the administrator changed the rules since Aerio last checked, the server's own refusal is shown ("Nextcloud refused the link: Expiration date is enforced"), the unshared upload is deleted, and **Check again** picks up the new rules. Dropbox refusals are explained for plans without password/expiry, invalid settings, team link policies and unverified email addresses. The link password is kept only inside the encrypted upload record until the link exists; it is never stored with the link, returned to the renderer, or shown in the inserted text, which says "with a password" instead.

### Uploads, resume and cancellation

Uploads use the same 5 MiB chunks, progress, cancel, and encrypted `cloud-uploads.dat` session record as Drive and OneDrive. Each acknowledged chunk is written to the record, so after a restart **Interrupted uploads** resumes from it:

- **Dropbox** starts an empty upload session, appends chunks with `append_v2`, and commits with `finish` (`mode: add`, `autorename: true`). Dropbox has no progress query, so resume sends an empty append at the saved offset; an `incorrect_offset` answer supplies the right one. A dropped connection or `5xx`/`429` retries from that offset up to two times per chunk. Sessions are assumed to last 48 hours; `not_found` or `closed` clears the record. Dropbox has no call to discard an unfinished session, so a cancelled one simply expires.
- **Nextcloud** (26 or later with `dav.chunking`) uses chunked upload v2: `MKCOL remote.php/dav/uploads/<user>/<id>` with a `Destination` header, numbered chunk `PUT`s with `OC-Total-Length`, and `MOVE …/.file` to assemble. Resume lists the chunk folder with `PROPFIND` and continues after the last complete consecutive chunk. Cancel and Discard `DELETE` the chunk folder; a folder the server already cleaned up (Nextcloud removes stale ones after about a day) clears the record.
- **ownCloud**, and Nextcloud servers without chunked upload v2, get one streamed `PUT` with `Content-Length`; a dropped connection or `5xx` restarts it from the beginning (up to two times), and Resume after a restart also starts again.

Aerio first creates `Aerio attachments` with `MKCOL` and picks `name (2).ext` when a file of that name exists. A `507` is reported as full storage, `413` as a file too large for the server, and a `401` marks the account **Sign-in needed** while keeping the interrupted upload for later.

### Expired, revoked and deleted links

Links created in a connected account are re-checked before sending like Drive and OneDrive links: a deleted file is "deleted", a missing shared link or share is "revoked", an expiry date in the past is "expired", and credentials that stopped working are "permission-denied". Settings › Cloud storage accounts › **Links** lists the links Aerio created in that account (newest first) with **Turn off link**, which revokes it on the provider (a link that is already gone counts as revoked) and drops it from the pre-send check.

### Disconnect

**Disconnect** aborts running uploads for that account, discards unfinished Nextcloud chunk folders, revokes the Dropbox token (`auth/token/revoke`), deletes the account's secret from secure storage, removes the account, and removes its interrupted uploads and link records from `cloud-uploads.dat`. Links that were already sent keep working; turn them off first if they should stop. All storage IPC is refused while Aerio is locked.

## Backups

`cloud-uploads.dat` is not part of profile backups: it holds only transient upload sessions and link metadata tied to this device's secure storage. `cloud-storage-accounts.json` and `cloud-storage-credentials.dat` are also left out, so after restoring a profile on another computer connected storage accounts are connected again from Settings.

## Verification status

Coverage comes from unit tests with mocked `fetch` (`electron/mail/cloud-attachments.test.ts`): chunked Drive and OneDrive uploads, recipient/anyone/organization sharing, refused shares and cleanup, cancellation, retry after a dropped chunk, resume after a restart from a persisted session, expired sessions and changed files, link verification for each problem, and encrypted state. Vault tests cover the opt-in scope requests, and composer tests (`src/components/MailCloudAttachments.test.tsx`) cover consent, the scope summary, insertion, the oversize offer, progress, cancel, resume and the pre-send check. Not yet verified against live accounts: Google consent-screen configuration for `drive.file`, Drive's `DELETE` on an unfinished resumable session, OneDrive personal versus work behaviour of `invite` links, tenant policies on anonymous links, and exact provider error codes for admin-blocked sharing. Drive files have no link expiry unless an administrator sets one, so "expired" is mainly reachable on OneDrive.

Connected storage accounts are covered by connector fixtures: in-process fake Dropbox and ownCloud/Nextcloud HTTP servers on 127.0.0.1 (`electron/mail/cloud-storage-fixtures.ts`) driven through the real connectors and service (`electron/mail/cloud-linked-storage.test.ts`). They cover PKCE sign-in (the fake server verifies the S256 challenge), refresh-token renewal after a restart, secrets kept out of the plain registry, plan and team-policy capabilities, OCS capability parsing, wrong app passwords and revoked passwords (Sign-in needed), Dropbox upload sessions and Nextcloud chunked upload v2 byte-for-byte, dropped connections mid-chunk, resume after a restart without resending acknowledged bytes, an expired chunk folder, the ownCloud single-PUT fallback and its restart, cancellation with chunk-folder cleanup, enforced password/expiry/maximum-days and view-only rules before upload, server refusals with cleanup, Dropbox audience/password/expiry settings, expired/revoked/deleted pre-send checks, revoking links, disconnect clearing tokens, secrets, sessions and links, and storage IPC validation and app-lock refusal. Settings and composer tests (`src/components/CloudStorageAccountsSection.test.tsx`, `src/components/MailCloudAttachments.test.tsx`) cover the app-key and sign-in flow, the capability display, links and revoke, disconnect confirmation, the Store in choice, and required password and expiry fields.

Not yet verified against live services (scenario `CLOUD-02` in the [live-provider test matrix](live-provider-test-matrix.md); no live evidence is recorded): Dropbox's acceptance of the fixed loopback redirect, the real upload-session lifetime, exact `error_summary` strings for plan and team-policy refusals, and whether `get_shared_link_metadata` answers the owner for password-protected links; Nextcloud's chunked-upload v2 availability by version (Aerio assumes 26+) and S3-backed minimum chunk sizes; ownCloud 10 versus oCIS behaviour (oCIS uses TUS and a different share API and is not supported); and how "allow public uploads" governs editing of single-file links on each server.

Implementation: [`electron/mail/cloud-attachments.ts`](../electron/mail/cloud-attachments.ts), opt-in scopes in [`oauth-vault.ts`](../electron/mail/oauth-vault.ts), connected storage in [`cloud-linked-storage.ts`](../electron/mail/cloud-linked-storage.ts), [`cloud-dropbox.ts`](../electron/mail/cloud-dropbox.ts), [`cloud-ocs.ts`](../electron/mail/cloud-ocs.ts) and [`cloud-storage-accounts.ts`](../electron/mail/cloud-storage-accounts.ts), UI in [`src/components/MailCloudAttachments.tsx`](../src/components/MailCloudAttachments.tsx) and [`src/components/CloudStorageAccountsSection.tsx`](../src/components/CloudStorageAccountsSection.tsx), link helpers in [`src/lib/cloud-attachments.ts`](../src/lib/cloud-attachments.ts).
