# Sender identities and signatures

Each mail account has one or more **sender identities** (From addresses). The
account's own address is always the primary identity
(`<accountId>:primary`); aliases are stored next to it in the mail database
(`mail_sender_identities`) and are removed with the account.

## Where identities come from

| Provider | Discovery | Authorization check |
| --- | --- | --- |
| Gmail | `users.settings.sendAs.list` (readable with the existing `gmail.modify` scope). Gmail signatures are imported as managed HTML signatures named `<address> (Gmail)` and re-imported on every refresh. | Aerio refuses to send from an alias Gmail still reports as `pending`, or from a manually added address Gmail does not list, because Gmail would silently rewrite the From to the primary address. |
| Microsoft | `GET /me?$select=mail,proxyAddresses` (`User.Read`). Proxy-address aliases are listed as **not verified by provider**, because sending from an alias depends on the tenant's `SendFromAliasEnabled` setting. Shared and send-as mailboxes cannot be listed with delegated mail scopes and are added manually. | Graph decides at send time. `ErrorSendAsDenied`/`ErrorSendOnBehalfOfDenied` or a sender-related 403 becomes a clear error. |
| IMAP/SMTP | Manual only. | The SMTP server decides. The alias is also used as the SMTP envelope sender; 550/551/553/554 sender rejections become a clear error. |

Gmail and Microsoft addresses are discovered automatically the first time the
composer opens while online; afterwards use **Account settings → From
addresses → Refresh from provider**. A refresh replaces provider-sourced rows
but keeps local choices (default identity, Reply-To overrides, signature
assignments). A manually added address that the provider later reports becomes
provider-managed.

When the provider refuses an alias, the message stays in the Outbox as a
**failed draft** with the explanation; nothing is resent from a different
address.

## Reply-To and defaults

- Every identity can carry a default Reply-To list (Gmail's `replyToAddress` is
  imported when the local value is empty). The composer pre-fills it, replaces
  it when the From identity changes, and keeps any Reply-To the user typed.
- One identity per account is the default From for new messages. Replies and
  forwards use the identity whose address received the original message, and
  otherwise the default.
- Each identity has separate signatures for new messages and for replies and
  forwards. Without an assignment, the primary identity falls back to the
  legacy plain-text account signature; aliases fall back to no signature.

## Signatures in the composer

Signatures are a shared library (`mail_signatures`), sanitized with the same
allow-list as templates (`sanitizeTemplateHtml`) on every save and import. The
composer inserts a signature as a single marked block:

```html
<div data-aerio-signature-spacer=""><br></div>
<div data-aerio-signature="<signature id>">-- <br>…signature HTML…</div>
```

Changing the From identity or the toolbar's signature picker swaps only that
block, so the message body and forwarded content (`data-aerio-quote`) are never
duplicated or removed. Without a block, a new signature is inserted above
quoted content, or at the end. When identities finish loading after the
composer opened, the default signature replaces the initial account signature
only if the user has not edited that block, and applying it does not create a
draft.

## Drafts

`MailDraftInput.fromIdentityId` (omitted for the primary address) and
`MailDraftInput.replyTo` are stored in `mail_draft_senders`, keyed by draft and
deleted with it. Reopened drafts restore both; the From picker is limited to the
draft's own account because the provider draft lives there. Remote draft saves
use the alias as From even before a provider confirms it; only delivery
enforces authorization. A draft whose identity was deleted saves with the
primary address but fails delivery with a prompt to choose another From
address.

## Limits and known gaps

- 200 identities per account, 10 Reply-To addresses, 500 signatures, 1 MB of
  signature HTML.
- The outgoing MIME sanitizer still drops images, tables, and font markup (see
  E03), so rich signature formatting beyond basic text styles and links is
  simplified when sent.
- Microsoft shared-mailbox permissions and Gmail alias verification have unit
  coverage against recorded API shapes only; they have not been exercised
  against live tenants.
