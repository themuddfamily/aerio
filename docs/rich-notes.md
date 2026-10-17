# Rich Notes

Notes are edited in a rich editor with headings, lists, links, tables, and
inline pictures. Plain-text notes from earlier versions open unchanged and
keep working everywhere. This page describes the editor, the stored format
(which server-synchronized Notes build on), picture storage, and backup
compatibility.

## Formatting

The editor ([NoteRichEditor](../src/components/NoteRichEditor.tsx)) reuses the
mail composer's toolbar ([MailFormattingToolbar](../src/components/MailFormattingToolbar.tsx)):
font, size, bold/italic/underline/strikethrough, text and highlight color,
alignment, bulleted and numbered lists, links (`https:`, `http:`, `mailto:`
only), tables (columns x rows, up to 20 x 100), pictures, and clear
formatting. Notes add a **Style** menu: Paragraph, Heading 1–3, Quote, and
Preformatted.

- Links are edited in place; **Ctrl+click** (**Cmd+click** on macOS) opens one
  in the default browser.
- Whitespace shows exactly as typed (`white-space: pre-wrap`), so spacing and
  blank lines in plain notes look the same as before.
- Folders, tags, colors, pinning, archive, duplicate, and delete work as
  before. Word counts, list previews, and **Copy note text** use the note's
  plain text.

### Paste and drop

Pasted HTML goes through the composer's sanitizer
([mail-paste.ts](../src/lib/mail-paste.ts), policy in
[mail-rich-text.ts](../src/lib/mail-rich-text.ts)) inside an inert
`<template>`. Scripts, styles, frames, forms, SVG, event handlers, classes,
ids, `javascript:` and other non-web links, and Word/Office markup are
removed. Remote and `file:` pictures are dropped and never fetched. Embedded
`data:` pictures are kept and stored as managed pictures (below). Indentation
and line breaks in the clipboard's HTML source are collapsed as a browser
would display them, except inside preformatted blocks.
**Ctrl+Shift+V** pastes plain text only. Image files can be pasted or dropped;
dropping other files asks you to use the paperclip.

## Stored format

A note ([Note](../src/types.ts)) keeps these body fields:

| Field | Meaning |
| --- | --- |
| `content` | Plain text. For a rich note, the plain-text projection of `html`. Search, previews, word counts, and older Aerio versions read it. |
| `html` | Optional. The sanitized rich body. If it's missing, the note is plain text. |
| `attachments[].inline` | `true` for a picture shown in the body. These aren't listed as file attachments. |

`html` is an HTML fragment (no `<html>`/`<body>`) limited to the composer
allowlist: the tags `a b blockquote br caption code col colgroup div em font
h1–h6 hr i img li ol p pre s small span strike strong sub sup table tbody td
tfoot th thead tr u ul`, the per-tag attributes in `RICH_TEXT_ATTRIBUTES`,
plus `style` (allowlisted CSS properties only) and `dir` on any tag. Pictures
are never embedded and never carry `src`:

```html
<img data-aerio-note-image="3f1c…-uuid" alt="Diagram">
```

The stored form may use either `<img …>` or `<img … />`, and readers must
accept both. `data-aerio-note-image` is the `id` of an `inline: true` entry in the same
note's `attachments`. That entry holds the name, size, real MIME type
(`image/png`, `image/jpeg`, `image/gif`, `image/webp`, or `image/bmp`), and the
managed file path. Stable ids, not paths or data URLs, link the body to its
files, so a body survives moving between machines.

The plain-text projection ([note-rich-text.ts](../src/lib/note-rich-text.ts),
`noteHtmlToText`) turns block boundaries (`div`, `p`, headings, list items,
table rows, quotes, …) into line breaks, `<br>` into a line break, and
separates table cells with a tab. It decodes entities and keeps whitespace as
typed. Pictures and markup add no text. The main process recomputes `content`
from `html` on every save and restore, so search always matches what the rich
body shows.

### Migration from plain text

Nothing is rewritten when Aerio is upgraded. A plain note is shown through
`plainTextToNoteHtml`, which puts one `<div>` per line (`<div><br></div>` for
an empty line) and escapes markup characters. This conversion is lossless:
`noteHtmlToText(plainTextToNoteHtml(text)) === text` for any text, including
leading spaces, tabs, blank lines, and literal `<`, `&`, or entity-like text.
The note gains `html` only when it's first edited.

### Sanitization in both processes

The renderer sanitizes a body when it loads it into the editor and every time
it serializes it ([note-editor-html.ts](../src/lib/note-editor-html.ts)). The
main process sanitizes it again with `sanitize-html` before storing
([note-rich-body.ts](../electron/productivity/note-rich-body.ts)), using the
same allowlist. Both passes remove every `src` from pictures and drop any
picture whose id isn't one of the note's inline attachments.

## Picture storage

Pictures (PNG, JPEG, GIF, WebP, or BMP, up to 5 MB each) can be inserted from
the toolbar, pasted, or dropped. The editor shows a picture straight away,
then sends it once over IPC (`productivity:note-image-save`). The main
process decodes it and identifies the type from the file's leading bytes (the
declared type and file name aren't trusted). It writes the file to the
existing note-attachment store (`<userData>/note-attachments/<uuid>.<ext>`,
mode 0600) and returns the inline attachment record. The body then references
the picture's id.

When a note is shown, each picture is read back as a data URL
(`productivity:note-image-read`, managed paths only, content-sniffed) and kept
only in the editor's DOM. It is stripped before the body is saved. While Aerio
is app-locked, both calls are refused.

A note can hold up to 200 inline pictures, plus the existing 50 file
attachments. Deleting a picture from the body removes its attachment entry,
and the existing cleanup then deletes the managed file on the next save.
Duplicated notes share picture files the same way they share file
attachments. A file is deleted only when no note references it any more.

## Backup compatibility

- **Portable local-data backup** (Settings › export/restore local data,
  `aerio-local-data` schema version 2): inline pictures are ordinary entries in
  the backup's `attachments` archive (base64), with the same id, name, size, and
  MIME type, inside the existing 100 MB attachment limit. Restore writes each
  one to a new managed file, keeps its id and `inline` flag, and keeps `html`
  unchanged. Pictures therefore come back on another machine, and the main
  process re-sanitizes the body and recomputes `content`. If a picture is
  missing from the archive, only that picture is dropped from the body.
- **Old backups** (schema 1, or schema 2 written before rich notes) have only
  `content`. They restore as plain notes and display unchanged.
- **Older Aerio versions** reading a new backup ignore `html` and see
  `content`, the full text. Inline pictures show up there as ordinary file
  attachments. Older versions accept at most 50 attachments per note, so a
  note with more than 50 files and pictures combined won't restore there.
- **Full-profile backup** ([profile backup](profile-backup.md)) already covers
  the local module database and the `note-attachments` directory, so rich
  bodies and pictures are included without changes.

## Server-synchronized notes

Notes in CalDAV VJOURNAL collections and Exchange Notes folders
([server-synchronized Notes](server-notes.md)) use this same format and
editor. On the server, the sanitized `html` is stored as `X-ALT-DESC` (CalDAV)
or an HTML `Body` (Exchange). Each `data-aerio-note-image="<id>"` becomes
`src="cid:<id>"`, and the picture travels as an attachment that carries the
same id (`X-AERIO-ATTACHMENT-ID` or the EWS `ContentId`). Coming back, `cid:`
pictures are turned into managed inline attachments again, and the body goes
through the main-process sanitizer above. Server notes own separate copies of
their picture files in `note-attachments`. Copying or moving a note between
Local and a server folder copies its files, so the local cleanup and the
server-notes cleanup never delete each other's files.

## Limits

- The 5 MB per-picture limit matches composer inline images. Larger images can
  still be added as file attachments with the paperclip.
- Undo after deleting a picture can't bring back a file that a save has
  already removed. Insert the picture again instead.
- If Aerio exits after a picture is stored but before the note is saved (the
  save is debounced by about 350 ms), that picture's file stays in the store
  without a reference.
- There is no checklist block or image resizing handle. Pictures scale to the
  editor width.
