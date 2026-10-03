# OneNote adapter design

Assessed: 2026-10-01. Status: design complete; adapter not implemented. This document defines an optional connected Notes adapter. It does not change local notes or claim hosted Microsoft compatibility.

## Decision and first release boundary

Use Microsoft Graph v1.0 with delegated consent and a separate provider-note model. First deliver notebook/section navigation, cached page reading, safe previews, resource downloads, and explicit copy to/from local notes. Add writes only for a tested, conservative content subset. Arbitrary rich OneNote pages remain readable with an Open in OneNote action; the plain text editor must never overwrite them.

The initial connector targets selected notebooks reachable through `/me/onenote` on the global Microsoft service. Explicit group/site discovery, notebook/section administration, moves, ink editing, collaboration presence, and complete OneNote layout editing are outside this adapter's first release. Section groups are navigated recursively and sections are selected by identity, never created implicitly by a folder name.

Graph supports personal and organizational notebooks through delegated access. Its current overview explicitly excludes app-only authentication, despite application permissions still appearing in individual endpoint tables. Aerio should follow the overview and use its existing interactive Microsoft OAuth flow. [API overview](https://learn.microsoft.com/en-us/graph/api/resources/onenote-api-overview?view=graph-rest-1.0)

## Compatibility with current Aerio data

`src/types.ts` defines local `Note` with `folder`, plain string `content`, tags, pinned/archive state, color, timestamps, and optional attachments. `src/views/NotesView.tsx` edits content in a textarea and searches that string. `electron/productivity/store.ts` stores the local notes array in `local_module_state`; this is not a provider cache. `electron/main.ts` manages attachment copies and local backup validation.

Keep this format and its existing IPC intact. Connected notes get a separate view/state/service, following the connected Tasks boundary rather than adding provider IDs to local records. Display Local notes and each connected Microsoft account separately. Names are presentation labels; duplicate section names remain distinct.

| Local concept | OneNote adapter treatment |
| --- | --- |
| Folder | Section selection on export; retain notebook/group hierarchy in connected navigation. |
| Content | Escaped plain text on export; extracted text on import, explicitly a conversion. |
| Tags, color, pinned, archived | Aerio-only overlay keyed to provider page; never imply these change OneNote tags, colors, or deletion. |
| Attachments | Explicit resource conversion with availability and size checks. |
| Note ID | Local UUID stays local; copies receive a new UUID, with optional provenance. |
| Updated timestamp | Keep remote modification time and local edit time separately. |

Copying a page to local notes shows which formatting and unsupported objects will be omitted, retains extracted text and selected downloadable attachments, and leaves the original page intact. An unavailable attachment prevents a requested complete copy; offer an explicitly labeled text-only copy instead. Exporting a local note creates a new page in a selected section, keeps the local note, and displays the result's native identity. Repeating export is a new copy, not silent bidirectional linking.

## Adapter, persistence, and ownership

Proposed files: `src/note-provider-types.ts`, `electron/productivity/onenote-connector.ts`, `note-store.ts`, `note-sync-engine.ts`, `note-service.ts`, `note-backup.ts`, and a connected Notes panel. Reuse OAuth/account lifecycle and queue design patterns from Tasks; do not reuse task field normalization or task tables.

The contract exposes `listNotebooks`, `listSectionGroups(parent)`, `listSections(parent)`, `listPages(section)`, `getPageContent`, `downloadResource`, `createPage`, `patchPage`, and `deletePage`. Read results include explicit capability flags; writes receive the editor's original baseline and return native identity plus a fresh snapshot. HTTP errors distinguish denied consent, inaccessible content, conflict/review, throttling, and uncertain acceptance.

Proposed separate SQLite tables:

| Table | Required data/invariants |
| --- | --- |
| `note_containers` | Account/root/kind/native ID uniqueness, local UUID, parent identity, display name, cached capabilities. Validate hierarchy and cycles. |
| `note_pages` | Account/root/native ID uniqueness, local UUID, section, title, remote timestamp, raw HTML hash, extraction version, content classification, fetched time, validated OneNote link. |
| `note_content` | Original provider HTML, sanitized preview, extracted search text, generated element IDs, fingerprint; replace atomically. |
| `note_resources` | Account/page/native resource identity, name/type/size/hash, managed relative file ID, pending/available/blocked state, references from snapshots and operations. |
| `note_overlays` | Aerio tags/color/pinned/archived; never included in provider patches. |
| `note_operations` | Local operation ID, target/parent IDs, exact baseline, intended field changes, attachment references, predecessor, outcome and review reason. |
| `note_sync_runs` | Selected roots, generation, completed collection inventory, errors and refresh times. No fabricated delta cursor. |

Main process owns credentials, provider HTTP, SQLite, and files. Renderer receives structured snapshots and opaque resource IDs, never bearer tokens or arbitrary filesystem paths. Restored accounts remain cached/read-only until an actual matching account and Notes grant are available. Archive disables network work and keeps the cache; deleting the account purges only its connected data and unreferenced resources.

## Consent and reads

Request `Notes.Read` for reading and `Notes.ReadWrite` when enabling writes; examine the actually stored grant, independently of Mail and Tasks. An omitted token-refresh scope retains the previous grant; background refresh must not request broader scopes. Do not request `.All` merely to make a failed request succeed. The list endpoint documents these delegated permissions and global-service availability. [List pages](https://learn.microsoft.com/en-us/graph/api/onenote-list-pages?view=graph-rest-1.0)

Build requests from validated IDs under `https://graph.microsoft.com/v1.0/me/onenote`. Traverse notebook sections and nested section groups with bounded depth and cycle detection. Follow every validated `@odata.nextLink`, including child collections; reject foreign hosts, roots, repeated links, and excessive traversal. Page listing defaults to 20 results and permits at most 100 per requested page. [Page pagination](https://learn.microsoft.com/en-us/graph/api/onenote-list-pages?view=graph-rest-1.0)

Fetch `/pages/{id}/content?includeIDs=true` when opening a page and before constructing an edit baseline. Resources are identified from page HTML and downloaded individually through `/resources/{id}/$value`; there is no resource collection inventory. Generated element IDs identify patch targets. [Content, hierarchy, and resources](https://learn.microsoft.com/en-us/graph/onenote-get-content)

Poll only selected notebooks, with manual refresh and coalesced foreground/reconnect runs. Start with a one-minute metadata refresh interval and bounded concurrency of two reads per account; tune against throttling evidence. Fetch changed/open page bodies lazily, and periodically revalidate cached bodies even when timestamps are unchanged. These are Aerio design choices. Do not assume OneNote provides the To Do delta contract or Graph subscriptions: neither is established by the reviewed OneNote endpoints.

Commit a collection generation only after all of its pages succeed. An interrupted scan or 403 never establishes deletion; retain its last good cache. A missing page becomes unavailable only after a complete inventory and a direct identity check, with permission loss distinguished where possible. Keep edit baselines and pending operations independent of refresh snapshots.

## HTML conversion and safe rendering

Preserve the original returned HTML as inert data. Parse it with a maintained HTML parser, extract text for search, and generate a separate sanitized preview. Remove scripts, handlers, forms, active objects, embedded frames, external styles, and unsafe links. Replace image/file URLs with opaque managed resource references; rendering must trigger no external requests. A sandboxed preview has no preload, Node access, or navigation privileges. User-activated validated links go through the existing main-process external-link policy.

Classify content as `plain-editable`, `rich-readonly`, or `unavailable`. The writable classifier initially accepts a single simple text block with paragraphs/line breaks and no resources, rich formatting, tables, drawings, positioned containers, or unknown semantics. Unknown markup fails closed. Escaping protects `<`, `>`, `&`, and quotes; preserve newlines and whitespace intentionally. Local Markdown remains literal text unless a later separately tested conversion is introduced.

Create uses a complete HTML document with escaped title and paragraphs. OneNote normalizes input HTML into a supported subset, so success requires rereading the result and comparing semantic text, not expecting identical HTML bytes. [Page creation and HTML conversion](https://learn.microsoft.com/en-us/graph/onenote-create-page)

For an editable page, construct targeted content PATCH commands against IDs from the original fetched content. Never reconstruct the whole body from extracted text. A title-only patch must leave rich content untouched; enable it only after its targeting is covered by fixtures. Generated IDs can change after writes, so reread before another operation. PATCH uses an array of commands and returns 204 without the updated page. [Update endpoint](https://learn.microsoft.com/en-us/graph/api/page-update?view=graph-rest-1.0), [Target IDs and supported actions](https://learn.microsoft.com/en-us/graph/onenote-update-page)

## Attachments and limits

Upload binary data through multipart content with a Presentation HTML part and named binary parts, using attachment object references. Never supply arbitrary remote URLs for the service to fetch. Microsoft's Graph documentation specifies a 4 MB request limit and at most six multipart parts including Presentation; the larger underlying OneNote limits are not usable through this Graph adapter. [Images, files, and request limits](https://learn.microsoft.com/en-us/graph/onenote-images-files)

Aerio policy: reject serialized uploads above 3 MiB including headers, boundaries, HTML and binary bytes, and allow at most five binary parts in one create. Preflight the actual request bytes. Local notes allow 25 MiB per file and 50 attachments, so export must identify unsupported files/counts before queueing. Do not silently omit files, split one note into multiple pages, or advertise upload sessions without an established OneNote contract. Initial rich-page attachment mutation is disabled; export creates a new page with supported attachments.

Download policy: stream into staged files, enforce 25 MiB per resource and a bounded cache quota, validate actual received size and MIME metadata, and name files with random IDs inside an account-specific managed directory. HTML resource URLs may use historical OneNote hosts; parse supported resource identities and construct Graph requests instead of forwarding tokens to those URLs. Unknown URLs remain unavailable. Never automatically open executable content. Renderer open requests resolve opaque IDs to owned managed files in main.

A missing/oversized resource remains visible with a reason. Cache cleanup counts references from pages, undo history, and queued operations before deleting files. Committing content/resources and rolling back failed staging must preserve the previous snapshot.

## Writes, offline recovery, and conflicts

Use durable intent states `pending`, `running`, `succeeded`, `failed`, and `review`. Queue exact original fingerprints, semantic content, generated target IDs, and owned resource hashes. Serialize dependent operations per page; an unrelated remote refresh never rebases an editor's original baseline. Only a known successful predecessor may update its own dependent baseline.

Before dispatch, verify account state, actual Notes grant, current resource access and content classification. Fetch the current content and compare a conservative fingerprint of metadata plus raw HTML to the original. If it differs, hold for review with local and remote copies. A raw-HTML-only difference may produce a false conflict, which is preferable to discarding unsupported content.

The reviewed update endpoint does not document an `If-Match` contract. Treat preflight snapshot comparison as best effort: another client can edit between GET and PATCH. Never send a locally invented hash as an ETag or claim atomic conflict prevention. Default existing-page destructive editing/deletion to disabled until hosted conditional-write behavior is established; the initial usable path is read/copy/create. A future snapshot-only edit mode must state this limitation explicitly. [Update request contract](https://learn.microsoft.com/en-us/graph/api/page-update?view=graph-rest-1.0)

After any accepted write, reread and persist the actual provider result. A timeout, interrupted `running` operation, or local commit failure after acceptance becomes `review`; do not automatically replay it. Retry safe reads with bounded backoff and `Retry-After`; mutations require evidence they were rejected before dispatching again. Review can match a lost create only against an exact native candidate in the original section, excluding previously known/claimed pages; ambiguous title/text matches are insufficient. No server idempotency support is assumed.

Undo cancels unsent intent locally. Undo of confirmed writes is a new operation against that result's baseline. Unknown outcomes have no automatic undo. Rich deletion restoration cannot promise lossless fidelity through HTML export; retain a recovery snapshot, and keep destructive remote actions outside initial scope.

## Backup and implementation acceptance

Use a separate versioned connected-notes backup including selected topology, raw inert HTML, extraction version, overlays, resource bytes/hashes, baselines, and operation history. Exclude OAuth credentials and absolute paths. Validate identities, hierarchy, references, lengths, total bytes, filenames, and hashes before staging files and an atomic database transaction. Preserve the existing local backup contract and its 100 MiB attachment budget. Connected backup restore adopts a separately documented aggregate budget and changes all pending/running mutations to review; it never dispatches merely because the network is available.

Implementation order and automated evidence:

1. Types, migrations and read adapter: pagination, duplicate names, nested groups, malicious links, permission failures, full-scan rollback, and account isolation.
2. HTML/resource boundary: Unicode/whitespace, dangerous markup, unsupported layouts, inert previews, oversized/truncated files, traversal attempts, and staged-file rollback.
3. Read UI and explicit conversions: local notes untouched, text-only copy labels, attachment refusal, selection/search, cached offline reads, and exact Notes grant handling.
4. Create queue and restricted patches: normalized HTML results, original-baseline conflicts, generated-ID changes, throttling, lost responses, restart review, undo and backup holds. Rich content preservation fixtures must pass before enabling any targeted edit.
5. Controlled real-Electron audit: native OAuth state/PKCE, readonly/denied/absent grant, IPC/SQLite/files, offline/relaunch, conversion, create review and account archive/purge. Opt-in provider evidence can later establish hosted behavior; fixtures cannot establish conditional-write safety.

The roadmap assessment is satisfied by this design. It does not add an implementation milestone or manual account/publishing tasks to the Codex roadmap. Hosted OneNote behavior, tenant restrictions, and atomic conditional writes remain unverified.
