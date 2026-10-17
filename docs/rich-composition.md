# Rich message composition

The composer edits HTML in a `contenteditable` body and always sends a
plain-text alternative (the editor's visible text) next to the HTML part.

## Formatting

The toolbar ([MailFormattingToolbar](../src/components/MailFormattingToolbar.tsx))
offers font family, size, bold/italic/underline/strikethrough, text and
highlight color, left/center/right alignment, bulleted and numbered lists,
links (`https:`, `http:`, `mailto:` only), tables (columns x rows, up to
20 x 100), inline images, and clear formatting. Font, size, and color commands
run with `styleWithCSS`, so they produce inline `style` declarations the
allowlist below keeps.

## Sanitization

One policy, in [mail-rich-text.ts](../src/lib/mail-rich-text.ts), is applied
twice:

- **On paste/drop** in the renderer ([mail-paste.ts](../src/lib/mail-paste.ts)),
  parsed inside an inert `<template>` so nothing loads while it is inspected.
- **On every outgoing message** in the main process
  ([outgoing-html.ts](../electron/mail/outgoing-html.ts), via `sanitize-html`),
  for sends, scheduled sends, and remote draft saves alike, so a tampered draft
  cannot bypass the renderer.

The policy allows formatting, list, table, heading, link, and image tags;
per-tag attributes such as `href`, `colspan`, `align`, and `width`; and on any
tag `style` and `dir`. `style` keeps only these properties with well-formed
values: `color`, `background-color`, `font-family`, `font-size`, `font-weight`,
`font-style`, `text-decoration(-line)`, `text-align`, `vertical-align`,
`border` and its sides/color/style/width, `border-collapse`, `padding` and its
sides, `width`, `height`, and `max-width`. A style containing `url(`,
`expression`, `javascript:`, escapes, comments, or at-rules is dropped whole.
Scripts, event handlers, forms, frames, SVG, classes, and ids never survive.

Pasting from Word or Outlook removes conditional comments, `<o:p>`, `mso-*`
declarations, generated list bullets, and the clipboard's
`StartFragment`/`EndFragment` wrapper. Press **Ctrl+Shift+V** to paste plain
text only.

The composer's marker attributes `data-aerio-signature`,
`data-aerio-signature-spacer`, and `data-aerio-quote` survive the outgoing
sanitizer so identity signature swapping keeps working on reopened drafts.
Pasted content has them removed so a copied signature cannot be mistaken for
the inserted one.

## Inline images

Insert (toolbar), paste, or drop PNG, JPEG, GIF, WebP, or BMP images up to
5 MB each. The image is embedded in the draft HTML as a `data:` URL marked with
`data-aerio-cid="<uuid>@aerio.local"`; because the HTML itself carries the
image, autosave, local reopening, and full-profile backups keep it without a
separate file. Embedded images count toward the 20 MB attachment limit.

When the MIME message is built, each embedded image becomes a part with that
Content-ID and `src` is rewritten to `cid:`:

```
multipart/mixed
├─ multipart/alternative
│  ├─ text/plain
│  └─ multipart/related; type="text/html"
│     ├─ text/html          (img src="cid:…")
│     └─ image/png          (Content-ID, Content-Disposition: inline)
└─ application/octet-stream (regular attachments)
```

Identical images are sent once. The same MIME is used for Gmail (`raw`),
Microsoft Graph (MIME send and draft save), IMAP draft append, and SMTP.

Images the message does not carry are removed from outgoing HTML: `https:`,
`http:`, `file:`, and foreign `cid:` sources, plus SVG data URLs. HTTPS images
in older templates or signatures are therefore not sent.

## Known gaps

- Recipient rendering in Gmail, Outlook, and Apple Mail and live provider
  delivery of multipart/related are covered by MIME parsing tests only.
- Reopening uses Aerio's local draft copy. Content-ID images in drafts or
  forwarded messages created by other clients are not converted back into
  editable embedded images.
- The HTML part is sent as 8-bit text without line folding; very long HTML
  lines rely on the provider accepting them.
- Images cannot be resized in the editor beyond the 100% width cap.
