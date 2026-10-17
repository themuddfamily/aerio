# Rich contacts and distribution lists

Contacts keep every typed email address, phone number, postal address, website, birthday, nickname, photo, and group membership. Distribution lists can be typed or picked in the composer's To, Cc, and Bcc fields, and they expand to the members' addresses.

## Data model

`Contact` (`src/types.ts`) keeps its single-value fields (`email`, `phone`, `group`) as the primary values that older code reads. The full values live in the lists added for interchange (E26) and are extended here:

| Field | Meaning |
| --- | --- |
| `emails`, `phones`, `addresses`, `urls` | `ContactField[]`, each with an optional `type` label, a `preferred` flag, and structured address `parts` (PO box, extended, street, locality, region, postal code, country). |
| `groups` | Every group or category the contact belongs to. `group` holds the first one. |
| `birthday` | `YYYY-MM-DD`, or `--MM-DD` when the year is unknown. Free text from imports is kept as is. |
| `photo` | A `data:image/(png\|jpeg\|gif\|webp);base64,…` URL of at most 220,000 characters. The editor downsizes a picked picture to a 128 px JPEG. |

`src/lib/contact-fields.ts` normalizes the editor's lists (trimming, removing duplicates, keeping at most one preferred value and 50 values per kind). It derives the primary email, phone, and group from those lists. It also holds the photo and birthday bounds that IPC validation uses.

`SyncedContact` adds `groupIds` (Google `contactGroups/…` resource names) and `providerData`. `providerData` holds the raw provider entries for every field Aerio writes.

### Distribution lists

A local list (`ContactList`) has a name and members. A member links to a saved contact by `contactId` and always stores the address in use when it was added. Two things follow from that:

- If a contact is deleted, the list still has its address.
- A list can include people who are not saved contacts.

When a list is expanded, a linked contact's current primary address wins over the stored one. Lists are stored in the `local_contact_lists` table of `productivity.sqlite`. They are included in local data backups and validated by `validContactLists` (at most 10,000 lists and 5,000 members per list, each member a complete email address). A snapshot or backup without `contactLists` leaves the saved lists untouched.

`src/lib/distribution-lists.ts` combines three sources into one `RecipientList` view:

| Kind | Source | Membership | Rename and delete |
| --- | --- | --- | --- |
| Local list | `ContactList` | Saved contacts and other addresses | Yes |
| Google group | People API `contactGroups` (user groups, plus the Friends, Family, and Coworkers system groups) | Writable contacts from the same account, through `members:modify` | User groups only. System groups keep their names. |
| Outlook category | `categories` on Microsoft contacts | Writable contacts from the same account, by editing each contact's categories | Rename and delete rewrite each member's categories |

Members without an email address are counted as `unreachable` and reported when a list expands.

## Composer expansion

`useRecipientLists` loads lists from the cached provider and local snapshots. This also works in separate message windows.

While a recipient field is focused, lists whose names match the typed text appear above address suggestions. Each one shows its kind, member count, and the first members, and hovering shows every address. Picking a list replaces the typed fragment with the members' formatted addresses.

A list name typed in full expands when the field loses focus. Send also expands any remaining list names, then stops so the recipients can be reviewed. An address already in the field is not added twice. A toast reports how many recipients were added and how many members had no address.

## Provider mapping

### Google People

`electron/productivity/google-contacts.ts` reads these fields:

- `names`, `nicknames`, `emailAddresses`, `phoneNumbers`, `addresses`, `birthdays`, `urls`, `photos`, `organizations`, `biographies`, and `memberships`
- the contact group list (`contactGroups`), so contacts carry group names, not resource ids

An update sends only `googleUpdatePersonFields`. Fields outside that list are not sent, so Google leaves them untouched. Within each field that is sent, Aerio matches every edited value to the raw entry that held the same value and sends that entry back with the edited value and type. Unchanged values keep their labels, structured parts, and any other details Aerio does not model, such as phonetic names, organization departments, and address country codes. Output-only metadata is removed before sending. An unchanged name is sent back exactly as stored.

Group management uses `contactGroups` create, update (with the group etag), and delete (`deleteContacts=false`, so members stay in Google Contacts). Membership changes use `contactGroups/{id}/members:modify`. A membership change updates the person's etag, so Aerio re-reads the affected people with `people:batchGet` and caches the new revisions.

Photos are written with `updateContactPhoto` and removed with `deleteContactPhoto`. If a photo write fails, the other contact details are still saved. Google serves photos from `googleusercontent.com`, which the renderer's CSP does not load, so the main process fetches 128 px thumbnails during sync and caches them as data URLs:

- An unchanged photo URL reuses the cached image.
- At most 300 photos are fetched per sync.
- Each image must be under 160 KB and have an image content type.

### Microsoft Graph

`electron/productivity/microsoft-contacts.ts` reads each slot that Graph stores:

| Graph property | Aerio value |
| --- | --- |
| `emailAddresses` | Every email. Outlook stores up to three. |
| `mobilePhone` | Phone labeled `mobile` |
| `homePhones` | Phones labeled `home` |
| `businessPhones` | Phones labeled `work` |
| `homeAddress`, `businessAddress`, `otherAddress` | Addresses labeled `home`, `work`, and `other` |
| `birthday` | Birthday |
| `businessHomePage` | Website |
| `nickName` | Nickname |
| `middleName`, `title`, `generation` | Name parts |
| `categories` | Groups |

Writes map typed values back to those slots:

- Extra mobile numbers and unlabeled numbers go to `businessPhones`.
- Display names on email addresses are preserved.
- A year-less birthday leaves the stored birthday unchanged, because Graph cannot store one.
- A PATCH changes only the properties it sends.

`microsoftContactOverflow` counts values that have no Graph slot, and the editor warns that they are not saved to Outlook.

Limits on the Microsoft side:

- **Distribution lists.** Graph has no API for Outlook contact groups on personal contacts, so categories act as lists. Creating a category list requires at least one member. Renaming a category list does not rename the Outlook master category.
- **Contact folders.** `contactFolders` are containers, not memberships. Aerio syncs the default folder only.
- **Photos.** Contact photos need a separate binary endpoint and are not synchronized. The editor disables the photo picker for Microsoft contacts.

## Read-only sources and edit conflicts

Read-only provider contacts show no edit or delete actions, and the detail pane says how to enable editing. Read-only lists (provider editing not enabled) cannot be edited. Contacts that cannot be written are not offered as group members.

The editor sends the revision it opened with. If the cached contact has a different revision, the main process rejects the save before calling the provider (`contactEditConflict`), because a background sync has changed it in the meantime. Providers also reject stale writes:

- Google reports a stale etag as `400 FAILED_PRECONDITION`, or `409` for some group writes. Aerio shows this as "changed elsewhere; synchronize Contacts and merge your changes".
- Microsoft writes check `changeKey` before the PATCH, as they did before.

## Interchange

vCard import and export now carry every `CATEGORIES` value and embedded photos:

- vCard 4.0 uses `data:` URIs.
- vCard 3.0 uses `ENCODING=b;TYPE=…`.
- Linked photos and images over the photo bound are skipped.

## Coverage and unverified boundaries

These areas have unit tests:

- field normalization and validation
- list building, suggestion, and expansion
- Outlook category edit planning
- Google and Microsoft mapping, raw-entry merging, and photo caching
- Google group CRUD, membership, and conflict mapping (mocked)
- store persistence
- main-process IPC validation, edit conflicts, and group handlers
- the Contacts view editors and list flows
- composer expansion

These have not been verified:

- behavior against the live People and Graph APIs, including exact error texts, the handling of the `formattedValue`/`null` birthday payloads, and Graph's per-slot limits
- Google photo upload size limits
- the canvas photo resizing, which runs only in Electron
