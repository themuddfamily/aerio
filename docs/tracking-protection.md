# Tracking-pixel protection

Aerio blocks every remote message image by default. Choosing **Load remote images** permits ordinary remote images for the open conversation, but images classified as suspected trackers stay blocked and are explained in the message.

## Classification

[`tracking-protection.ts`](../electron/mail/tracking-protection.ts) classifies each remote `<img>` while the mail worker sanitizes message HTML. It is lexical only: it reads the markup and URL text and never resolves, connects to, or fetches the image. An image is a suspected tracker when any of these apply:

| Reason | Signal |
| --- | --- |
| `tiny-dimensions` | Declared width and height are both 4px or less, or the only declared dimension is 1px or less. |
| `hidden-style` | Inline style hides it (`display:none`, `visibility:hidden`, `opacity:0`, or a zero/1px width, height, or max size). |
| `known-tracker-host` | The host is, or is a subdomain of, a short curated list of email open-tracking services. |
| `tracking-path` | The path looks like an open-tracking endpoint, such as `/wf/open`, `/track/open`, `/open.gif`, or `/e/o.gif`. |

The list is deliberately conservative so ordinary newsletter artwork remains governed by the user's image choice. Local `cid:` and `data:` images are not remote and are never classified.

## Rendering and reporting

[`message-security.ts`](../electron/mail/message-security.ts) replaces suspected trackers with a `remote-image-tracker` placeholder whose tooltip states the reasons, and never rewrites them to the `aerio-image://fetch/` proxy, so they cannot load regardless of the remote image choice. The sanitizer also returns a `remoteContent` report (remote image count and trackers grouped by host) on `MailMessageDetail`; the conversation view shows an expandable notice listing each host and reason.

## Image proxy and redirects

[`remote-image-fetch.ts`](../electron/mail/remote-image-fetch.ts) fetches approved images for the `aerio-image://fetch/` protocol without cookies and with manual redirects. Every hop is re-validated: non-web schemes, embedded credentials, local hostnames, private DNS answers, and suspected tracker URLs are refused, as are opaque or location-less redirects and chains longer than five redirects.

## Boundaries

Classification is heuristic and can miss trackers served from ordinary-looking URLs or flag a legitimate tiny image. Unit tests cover classification, allow/block choices, redirect validation with a mocked fetch, and the notice. Electron's `net.fetch` behavior for `redirect: 'manual'` against live servers is not exercised by the suite; if it returns opaque redirects, redirected images are refused rather than followed.
