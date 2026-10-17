# Automatic replies

**Account settings → Automatic replies** reads and changes the out-of-office reply stored by the provider. Gmail uses `users.settings.vacation`; Microsoft uses `mailboxSettings.automaticRepliesSetting` in Microsoft Graph. The provider sends the replies, so they start, stop at the scheduled end, and can be turned off whether or not Aerio is running. Aerio stores no local copy: opening the section, saving, and turning replies off each finish with a fresh provider read, and the status line shows that server state (Off, On now, Scheduled, or Ended) with the time it was read.

## Settings by provider

| | Gmail | Microsoft |
| --- | --- | --- |
| Subject | Yes | No (Outlook has none) |
| Messages | One message for everyone who receives a reply | Separate replies for people inside and outside the organization |
| Audience | Everyone, or only contacts; Google Workspace domains also offer organization only (`restrictToDomain`). Consumer `gmail.com` accounts do not. | Outside the organization: nobody, only contacts, or anyone |
| Schedule | Optional start and/or end | A schedule needs both a start and an end; without one the reply is always on |
| Turn off now | Reads the resource and writes it back with `enableAutoReply: false`, keeping the message | `PATCH` with `status: disabled`, keeping the messages |

Messages are edited as plain text. Gmail receives `responseBodyPlainText`; Microsoft receives escaped HTML with line breaks. When the server reply contains richer formatting (links, bold, tables), Aerio shows its text and warns that saving from Aerio replaces the formatting. When a Gmail reply is restricted to both contacts and the domain, Aerio shows a warning and keeps only the domain restriction on save.

Input is validated in the main process before any provider request: the audience must be one the account supports, the end must follow the start, an enabled reply needs a message (and an outside-organization message on Microsoft unless outside replies are off), and an enabled reply cannot end in the past.

## Time zones

Start and end times are entered in the computer's time zone and sent as exact instants: Gmail epoch milliseconds, and Graph `dateTimeTimeZone` values written in `UTC`. Graph may report a schedule created in Outlook in the mailbox's Windows time zone (for example `Pacific Standard Time`). Aerio maps common Windows zones and any IANA zone to an IANA zone and converts with that zone's daylight-saving rules; an unrecognized zone is read as UTC with a warning. The mailbox time zone reported by Microsoft is shown beside the date fields. Exchange keeps stale schedule dates when replies are off or always on; Aerio ignores them unless the status is `scheduled`.

## Permissions and reconnecting

New connections request `https://www.googleapis.com/auth/gmail.settings.basic` (Google) and `MailboxSettings.ReadWrite` (Microsoft). Existing grants are not changed, and token refresh never asks for the new permissions:

- Gmail: the vacation setting is readable with the existing `gmail.modify` grant, so an older connection still shows the active reply. Saving needs `gmail.settings.basic`; without it, the form is read-only and explains the missing permission with a **Reconnect to grant permission** button. Google's consent screen lets a user leave the permission unchecked; Aerio checks the granted scopes again after reconnecting.
- Microsoft: an older connection has no mailbox-settings permission, so Aerio does not call Graph and instead explains that `MailboxSettings.ReadWrite` is needed and offers a reconnect. Organizations may require an administrator to approve it.
- Grants stored before Aerio recorded scopes are probed instead. A Gmail `403 insufficientPermissions` or a Graph `403` is reported the same way, with the reconnect path, rather than as a generic error.
- A Microsoft mailbox that Graph does not serve (for example on-premises Exchange, `MailboxNotEnabledForRESTAPI`) is reported as unsupported.

## IMAP accounts

IMAP and SMTP have no standard out-of-office API, so the section explains that replies must be set in the provider's webmail or server (for example a Sieve vacation rule). Aerio never sends automatic replies itself.

## Verification limits

Coverage comes from unit tests with mocked Gmail and Graph responses (`electron/mail/automatic-replies.test.ts`, `src/components/MailAutomaticRepliesSection.test.tsx`) and vault scope tests. Not yet verified against live accounts: Google consent-screen configuration and verification for the added sensitive scope, Microsoft personal (outlook.com) mailbox behaviour for audiences and schedules, Workspace-admin restrictions, and the exact error codes returned for revoked or admin-blocked consent.

Implementation: [`electron/mail/automatic-replies.ts`](../electron/mail/automatic-replies.ts), provider calls in [`gmail-client.ts`](../electron/mail/gmail-client.ts) and [`microsoft-client.ts`](../electron/mail/microsoft-client.ts), scopes in [`oauth-vault.ts`](../electron/mail/oauth-vault.ts), UI in [`src/components/MailAutomaticRepliesSection.tsx`](../src/components/MailAutomaticRepliesSection.tsx).
