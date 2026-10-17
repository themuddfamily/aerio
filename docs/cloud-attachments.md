# Cloud attachments

The composer can upload a file to the sending account's **Google Drive** (Gmail accounts) or **OneDrive** (Microsoft accounts) and insert a sharing link instead of attaching the file. Ordinary attachments are unchanged and remain the default; IMAP accounts have no storage connector and only offer ordinary attachments.

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

If any link fails, a confirmation lists the problems and asks whether to send anyway. Links Aerio did not create, and checks that fail because of the network, are not reported and never block sending. Scheduled messages are checked when they are scheduled, not again at delivery time.

## Backups

`cloud-uploads.dat` is not part of profile backups: it holds only transient upload sessions and link metadata tied to this device's secure storage.

## Verification status

Coverage comes from unit tests with mocked `fetch` (`electron/mail/cloud-attachments.test.ts`): chunked Drive and OneDrive uploads, recipient/anyone/organization sharing, refused shares and cleanup, cancellation, retry after a dropped chunk, resume after a restart from a persisted session, expired sessions and changed files, link verification for each problem, and encrypted state. Vault tests cover the opt-in scope requests, and composer tests (`src/components/MailCloudAttachments.test.tsx`) cover consent, the scope summary, insertion, the oversize offer, progress, cancel, resume and the pre-send check. Not yet verified against live accounts: Google consent-screen configuration for `drive.file`, Drive's `DELETE` on an unfinished resumable session, OneDrive personal versus work behaviour of `invite` links, tenant policies on anonymous links, and exact provider error codes for admin-blocked sharing. Drive files have no link expiry unless an administrator sets one, so "expired" is mainly reachable on OneDrive.

Implementation: [`electron/mail/cloud-attachments.ts`](../electron/mail/cloud-attachments.ts), opt-in scopes in [`oauth-vault.ts`](../electron/mail/oauth-vault.ts), UI in [`src/components/MailCloudAttachments.tsx`](../src/components/MailCloudAttachments.tsx), link helpers in [`src/lib/cloud-attachments.ts`](../src/lib/cloud-attachments.ts).
