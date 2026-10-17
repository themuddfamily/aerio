# eM Client feature parity evidence

Reviewed: 2026-10-17. Aerio baseline: version 0.5.0, commit `e7696cc0886f06017a0a33b24f40a45b4f82aa09`. This comparison supports E01-E30 in [ROADMAP.md](../ROADMAP.md).

## Scope and confidence

The installed Windows package is `eMClient.20054CA46072C_11.0.1201.0_x64__veq4nz3ze5v72`, located beneath `C:\Program Files\WindowsApps`. REA 6.5.0 identified its main `MailClient.dll` as x64 managed CIL targeting .NET 10, with complete identity metadata. The separate `C:\Program Files (x86)\eM Client\MailClient.exe` is a native launcher/updater; its lack of CLI metadata does not describe the packaged application.

Evidence has three distinct strengths:

- **Static code:** REA decoded metadata, signatures, file-backed CIL anchors, call edges, and selected SQL literals from the shipped assemblies listed below. These observations establish implemented structures and code paths. They do not establish that a path ran successfully.
- **UI inventory:** main-assembly embedded resource names establish packaged controls/forms. Names alone do not prove behavior; the comparison pairs these with code from smaller assemblies or official product documentation.
- **Documented capability:** official eM Client pages corroborate user-facing semantics. Their descriptions may cover different editions or services; the older compose help is explicitly version 10. Licensing, live-provider compatibility, and runtime behavior were not tested.

Aerio gaps are bounded source findings from current contracts, renderer controls, database schemas, main-process services, and provider connectors under `src/` and `electron/`. A gap can mean a missing capability or a specific extension of an existing feature. Proposed persistence, security, recovery, and acceptance details in the roadmap are Aerio design requirements.

Main-assembly member decoding exceeded REA's 64 MiB metadata representation budget (`ev_abbb1a519ad224e64c0c3c8c7af0436aa72fea6a8a388542ec8f823ca5170d90`); this is unavailable coverage. Smaller assemblies supplied the usable code evidence. Oversized complete MCP replies for Mail, Security, Schedule, and CalDAV were retained by REA and read through summary/type/method/call-edge views; they were not treated as truncated complete analyses. No native disassembler session was opened.

## REA artifact identities

R0 uses `inspect_managed_artifact`; R2-R15 use `inspect_managed_members`. All listed observations reported complete metadata coverage for their selected scope. R4 selects PGPEncryptor/SecurityManager, R5 ListUnsubscribeHelper/ReceiptMail, R8 ItipProcessor/RecurrenceRuleComposer/EventComposer/Attendee, and R9 AddressBookMultigetCommand/FreebusyCommand/SyncCollectionCommand. Other member observations cover their assembly. Tokens below are build-local and require the corresponding SHA-256 and MVID.

| Ref | Shipped assembly | Canonical REA Evidence ID | SHA-256 | Module MVID |
| --- | --- | --- | --- | --- |
| R0 | `MailClient.dll` | `ev_ace88aed39c4cdbbb045706d05840f8585b6e43b8b520f336fb2d79759fc8421` | `fbac375683450c5e16b1a306d239e780f2ef1ec2208d1a86448bb44ec7c8bcb3` | `fc452afc-d418-49d3-b568-d439df42322f` |
| R2 | `MailClient.Storage.Snippet.dll` | `ev_08f5bc6d2d9ce15b48c729017e547825f11c8654ecc0adcec3abb861606ae8be` | `f4cb26cba1df8a6de24e65df537a41b5d3f8aa4109173567b65b18e044725ddc` | `69a8b9ad-d458-45af-a8a4-85cbb67b10ac` |
| R3 | `MailClient.Storage.Template.dll` | `ev_8a2d8ed417886f183bb994d4c37af9d99f86cf1f7d1528520f04a09cb9cf6219` | `e8147a341cfaba5c83bd2a9273c65ecf4d15ed42282135ad5a057d2604cbc679` | `4bb817f2-7e48-49c0-abbb-0028c0a96ff1` |
| R4 | `MailClient.Security.dll` | `ev_43203318903bcd673eba2baa72b56c186b7866a47da1a93c2b01a54149a3d35a` | `7c0518a3756b0050706ce2c2362373f6c247292f4198ff17865ccac8cf51bc32` | `fa0fe007-da69-412a-994e-ad1547a9d118` |
| R5 | `MailClient.Mail.dll` | `ev_d031b5cf716f078e367d0b3ac07badcc18f855d388724b8e9738bfaa793d6a1e` | `20b909d5cfa9bad342904bca7e95cb8601a871d802ba3097ea44a670ec368e5c` | `30a6efb7-c5be-4723-9708-c765ad830a69` |
| R6 | `MailClient.Storage.IndexedAttachment.dll` | `ev_a3d31c69956ef00c9fb00fa7e6ba19f718c711e4955fafcb01ae7f5097c8eefa` | `9097fd98fc51fa2ff1b5220fd7e3897199cea81773c1c22a36f3e4dd3b4381f4` | `7a986173-1251-47a2-8730-0a4977bcd1fc` |
| R7 | `MailClient.Storage.AttachmentIndexer.dll` | `ev_9d3366b701d105a7f4ca991ec7543135ab7b26b1ad25c23ee479e33c16c19fcf` | `c8df0d0261f209a4625512a323ac8390d420c57f464decf0cbe67c111926dd73` | `3dc31337-a5a4-400b-96bf-5d00e1077c02` |
| R8 | `MailClient.Schedule.dll` | `ev_9b66b90a22805d118868de5d3c93f530fc3655c04a2fc045e3165ed25d067696` | `b1ac467ba4abfeb99e6bd14b9e079a3a051e473d9ab3240227f2a2dbfd57fd2a` | `dcb34b85-09f5-41cf-bd6e-f63575af4d93` |
| R9 | `MailClient.Protocols.CalDav.dll` | `ev_7b968dda476b8e74d98d8e02ddbb8ce2c5eeff4b0e1ade88ef2eeee3deddb76e` | `935e5e081e4433bd666f5f5302b9f23ff31c1e0f1047e611d8c3dea56bac38dc` | `5b4bf285-1896-4b89-b69f-6f346e8bc322` |
| R10 | `MailClient.Contact.dll` | `ev_83a8e541669f6c9ce77bd812adc39ca066d2a6bb80a12cfbcf487af774855ad8` | `2b5af20733adaf69fbbefa49cd5f1a7713f0408ec2187ce6fdeb2147fbaca62f` | `4ca690e1-7d2f-410f-a619-fb901b2afa7b` |
| R11 | `MailClient.QuickActions.dll` | `ev_012593b1e9af959a16e5856eabe01e187ecadddb0e814e550c0b251c6b50e4ca` | `6922909491d1fa3b1acb253318f8f36fe1f00dfd8936ed91f84cced627a92b5c` | `62805926-e6dc-4864-8456-2413776eb9e6` |
| R12 | `MailClient.Import.Mbox.dll` | `ev_9ffbdb089807004601a2fd7f6a32723785f8977bb153f5155632ff3a961f3cea` | `229d8c1d35fdb282d8d1188e7c963b5cc2ed19690c4215aa44b3849daf5b556f` | `caa8f3a5-140c-42a9-86a4-48d2117ee01d` |
| R13 | `MailClient.Import.Pst.dll` | `ev_4ece28b17742c8954b9aeff01f0cc18a423f1ec3ba1eb66008397f18d3771efe` | `ffbf3f7902624dc98525af747d88cff0b66cb1436a70d0ad7d18829a46afcaad` | `60927ab7-f938-4797-bac4-3a5a72d1c9b2` |
| R14 | `MailClient.Import.Ics.dll` | `ev_0af3879855e83ec882685e2c2c030e4fedf5aef406aaee3b13745506717802ec` | `86dc396bec65bd30164971d51257abcc9949fd529076c1dd86ea9d4c488f527b` | `08f2b794-5458-4b75-8c07-5fec1441b62a` |
| R15 | `MailClient.Import.Vcf.dll` | `ev_05fc8a62935963c48dba1fcf446bf98314c50089aff8d7632e86a884fbe18736` | `c94e97f44a633abc2ed7c58ef54651f4c55a45639625f76422c7579d153f3308` | `78d2066f-678c-41d2-bfa8-dbe0342b58de` |

**R1: main-assembly resource inventory.** `inspect_analysis_view` Evidence `ev_92b406813d8dd66724211136ef699badb685284a2f06ef97bfdd58667e6c4189`, parent R0, returned all 503 resource rows. The following are inventory observations, with the common `MailClient.` prefix and `.resources` suffix omitted:

| Resource | Metadata token |
| --- | --- |
| DbBackup.FormBackup | `0x28000002` |
| UI.Controls.SettingsControls.ControlSettingsAIFeatures | `0x280000da` |
| UI.Controls.SettingsControls.ControlSettingsArchive | `0x280000dd` |
| UI.Controls.SettingsControls.ControlSettingsCloudStorage | `0x280000e4` |
| UI.Controls.SettingsControls.ControlSettingsQuickText | `0x280000fe` |
| UI.Controls.SettingsControls.ControlSettingsTemplatesSignatures | `0x2800010d` |
| UI.Controls.SettingsControls.ControlSettingsTimeZones | `0x2800010f` |
| UI.Controls.SettingsControls.ControlSettingsWatchForReply | `0x28000112` |
| UI.Forms.FormAliases | `0x28000139` |
| UI.Forms.FormAutomaticReplies | `0x2800013d` |
| UI.Forms.FormDistributionList | `0x28000154` |
| UI.Forms.FormFreeBusy | `0x28000169` |
| UI.Forms.FormManageCertificates | `0x28000183` |
| UI.Forms.formNewFolder | `0x28000187` |
| UI.Forms.FormSearchFolder | `0x2800019a` |
| UI.Forms.FormSnippets | `0x280001ab` |
| UI.Forms.wizardDeduplicator | `0x280001ce` |

## Selected code observations

| Ref | Exact observed members and relationships |
| --- | --- |
| R2 | `MailClient.Storage.Snippet.Data.DbSnippetRepository.AddSnippet` (`0x06000036`) calls SQLite command/parameter APIs. Its loaded SQL includes a Snippets insert with body, styles, account, and alias columns; `UpdateSnippetBody` is `0x0600003a`. |
| R3 | `MailClient.Storage.Template.Data.DbTemplateRepository.AddTemplate` (`0x06000037`), `AddAttachment` (`0x0600003a`), and `LoadBodyAndStyles` (`0x06000057`) have CIL bodies. Loaded SQL stores template subject, font/style fields, and separate body/styles content. |
| R4 | `MailClient.Security.PGPEncryptor.EncryptMessage` (`0x06000140`) calls recipient-key selection and BouncyCastle OpenPGP encrypted/compressed/literal data generators. `DecryptMessage` (`0x06000148`), `GenerateKeyPair` (`0x0600014a`), and `VerifySignature` (`0x06000151`) have bodies. SecurityManager exposes valid signing/encryption certificate selection; these members alone do not prove complete S/MIME UI or interoperability. |
| R5 | `MailClient.Mail.ListUnsubscribeHelper.TryGetListUnsubscribeUri` (`0x060000d4`) parses URI collections and inspects schemes; `OneClickUnsubscribeAsync` is `0x060000d5`. `ReceiptMail.BuildStructure` (`0x060001e5`) constructs MIME parts. |
| R6/R7 | `DbIndexedAttachmentRepository.AddIndexedContent` (`0x06000022`, R6) writes through SQLite; loaded SQL inserts content into IndexedAttachmentIndex. R7 exposes `BaseAttachmentIndexer.ProcessFullTextExtraction` (`0x06000040`) and `ItemIndexer.ExtractText` (`0x0600007c`). Extractor format coverage and runtime success remain unverified. |
| R8 | `ItipProcessor.ProcessReply` (`0x060002c9`) accesses calendar UID, sequence, store objects, and attendees; request/cancel/counter/response creation paths also have bodies. RecurrenceRuleComposer has Until/Count and exception/override recurrence IDs. EventComposer has start/end time-zone accessors; Attendee has role/status/RSVP methods. |
| R9 | `AddressBookMultigetCommand..ctor` (`0x06000177`) constructs a DAV report through XmlWriter. `FreebusyCommand.Prepare` (`0x060001a5`) composes calendar data. SyncCollectionCommand is also present in the selected code scope. |
| R10 | `MailClient.Contact.ContactComposer.get_Members` (`0x06000045`) and `get_Addresses` (`0x0600004d`) expose richer contact collections; ContactConvert contains email, telephone, and address conversion paths. |
| R11 | `MailClient.QuickActions.ActionBlock.AddAction` (`0x06000018`), `QuickAction.GetActionsJson` (`0x0600006e`), `VerifyActions` (`0x0600006f`), and `GetActionBlocks` (`0x06000071`) have bodies. This supports stored action composition, with macro behavior corroborated by the email feature page. |
| R12-R15 | MboxImport.Import/ImportNext (`0x06000004`/`0x06000005`, R12), the PST importer member inventory (R13), IcsImport (R14), and VcfImport.ImportFromStream (`0x06000009`, R15) establish shipped importer implementations. Import accuracy and malformed-file handling were not exercised. |

## Gap ledger

The E-numbers match the roadmap. Links in the Aerio column identify the implementation boundary, rather than relying only on feature names found by text search.

| Task | eM Client evidence | Aerio's current boundary |
| --- | --- | --- |
| E01 QuickText/templates | R1-R3; [email features][email] | [Composer](../src/components/MailComposeModal.tsx) and [MailDraftInput](../src/mail-types.ts) have no reusable snippet/template store or picker. |
| E02 Identities/signatures | R1 FormAliases and template/signature settings; [compose help][compose] | Implemented: [sender identities](sender-identities.md) with Gmail send-as/Microsoft alias discovery, manual aliases, Reply-To, an HTML signature library, per-identity new/reply defaults, marked signature blocks in the [composer](../src/components/MailComposeModal.tsx), and identity/Reply-To on drafts. Live provider permission behavior is unverified. |
| E03 Rich composition | R3 style/attachment storage; [compose help][compose] documents images and tables | Composer has basic formatting and forces text/plain paste; [outgoing sanitizer](../electron/mail/mime-builder.ts) omits image/table/style markup. Incoming rich HTML rendering is already supported. |
| E04 Personalized mass mail | [compose help][compose] and [email features][email] | One draft produces one send with To/Cc/Bcc. No recipient expansion, variables, or per-recipient batch state exists in [mail-worker.ts](../electron/mail-worker.ts). |
| E05 Watch for replies | R1 WatchForReply settings; [compose help][compose] | [Mail contracts](../src/mail-types.ts) and [database](../electron/mail/database.ts) persist snooze and scheduled delivery, without outgoing reply watches. |
| E06 Receipts/importance | R5 receipt construction; [compose help][compose] | Draft fields and MIME builder omit receipt requests, receipt policy, and outgoing importance. Existing incoming importance actions are separate. |
| E07 OpenPGP | R4 encryption/key/verification code; [encryption overview][encryption] | MIME builder sends ordinary MIME; no cryptographic draft fields, key store, or verification UI. |
| E08 S/MIME | R4 certificate selection and R1 certificate forms, corroborated by [vendor comparison][comparison] | Same ordinary-MIME boundary; existing OAuth secure storage and app lock do not supply mail certificates or content encryption. |
| E09 Tracking protection extension | [email features][email] and [vendor comparison][comparison] | [message-security.ts](../electron/mail/message-security.ts) already blocks remote images and marks tiny blocked placeholders with a tracker CSS class. Permitting remote images enables them all; there is no separate tracker policy or explanation. |
| E10 Unsubscribe | R5 URI parsing/one-click entry point | [Message detail/tools contracts](../src/mail-types.ts) do not expose list-unsubscribe metadata or a corresponding action. Existing external-link handling is not a list-management flow. |
| E11 Saved searches | R1 FormSearchFolder; [vendor comparison][comparison] | [MailSearchFiltersPanel](../src/components/MailSearchFiltersPanel.tsx) is implemented. Database search converts whitespace-separated terms to quoted prefixes joined by AND; no saved-query entity or Boolean query parser exists. |
| E12 Attachment workspace | R6 attachment repository and R1 indexed-attachment views; [email features][email] | [ConnectedMailView](../src/views/ConnectedMailView.tsx) exposes attachments within a selected message, without a global attachment surface. |
| E13 Attachment content index | R6/R7 content SQL and extraction methods | FTS in [database.ts](../electron/mail/database.ts) indexes message text and attachment names, without an extracted attachment-content pipeline. |
| E14 Folder/label lifecycle | R1 new-folder/properties forms; documented in [folder help][folders] | [MailDesktopApi](../src/mail-types.ts) lists destinations; [MailOrganizeModal](../src/components/MailOrganizeModal.tsx) moves/applies existing destinations. No create/rename/delete folder API. |
| E15 Advanced/server rules | R1 rule manager/library; [email features][email] and [vendor comparison][comparison] | Local rules add Cc, header, attachment, size, age, importance, and folder conditions, “except if” exceptions, and an outgoing (Sent) trigger with a once-per-message ledger. Gmail filters and Outlook inbox rules can be listed, uploaded, updated, toggled (Outlook), and removed, with unsupported-mapping and permission reporting ([mail rules](mail-rules.md)). Live-provider validation is pending. |
| E16 Quick Action macros | R11 and [email features][email] | [App command palette](../src/App.tsx) and message buttons trigger individual operations. No persisted user-defined action sequence exists. |
| E17 Out-of-office | R1 FormAutomaticReplies; [vendor comparison][comparison] | [Account settings](../src/components/MailAccountSettingsModal.tsx) and Gmail/Microsoft clients have no automatic-reply configuration flow. |
| E18 Mail import/local folders | R12/R13; R1 import wizard; [vendor import help][imports] | Provider IDs are Gmail/Microsoft/IMAP. There is single-message export and read-only disconnected-account archiving, without a mail importer or independent writable local-mail provider. |
| E19 Full-profile backups | R1 backup forms; [vendor comparison][comparison] | [Main-process backup](../electron/main.ts) covers local modules/managed note files; [connected-task backup](task-provider-integration.md) is separate. Mail, drafts, rules, and a consistent full profile are outside these backups. |
| E20 Cloud attachments | R1 cloud settings; [email features][email] | Mail drafts contain local attachment paths. No cloud picker/upload/share connector or grant-management flow exists. |
| E21 CalDAV/CardDAV | R9 DAV report/sync code; [calendar help][calendar-help] | [ProductivityProvider](../src/productivity-types.ts) permits Gmail/Microsoft only. IMAP-backed services have no calendar/contact adapter. |
| E22 Invitation lifecycle | R8 iTIP processing; [calendar features][calendar] | Existing event creation can send attendee emails to providers. [CalendarEvent](../src/types.ts) stores attendees as strings, while [ProductivityDesktopApi](../src/productivity-types.ts) exposes event CRUD without RSVP/response APIs or incoming invitation handling. |
| E23 Scheduling assistant | R9 FreebusyCommand, R1 FormFreeBusy; [calendar features][calendar] | Google/Microsoft connectors expose no availability lookup; [CalendarView](../src/views/CalendarView.tsx) has no scheduling assistant. |
| E24 Recurrence/zones | R8 recurrence/exception/time-zone members; R1 zone settings | CalendarEvent has only none/daily/weekly/monthly recurrence. Editor uses local datetime inputs; [Microsoft writer](../electron/productivity/microsoft-connector.ts) normalizes to UTC and does not retain named-zone/exception editing semantics. |
| E25 Conferences | R1 online-meeting settings; [calendar features][calendar] | Event location/description are editable strings. [Google](../electron/productivity/google-connector.ts) and Microsoft event writers have no conference creation/lifecycle contract. |
| E26 ICS/vCard/CSV/internet calendars | R14/R15 import code; R1 export wizard; [vendor comparison][comparison] | Calendar/contact APIs expose CRUD and local JSON backups, without file interchange, contact field mapping, or internet calendar subscriptions. |
| E27 Rich contacts/lists | R10 collections and R1 FormDistributionList; [contacts features][contacts] | [Contact](../src/types.ts) has one email, one phone, and one group string. [ContactsView](../src/views/ContactsView.tsx) has group filters, without distribution-list membership or group CRUD; provider mappers take first email/phone values. |
| E28 Contact merge/history | R1 deduplicator and communication/attachment history controls; [contacts features][contacts] | Contacts have editing, favorites, and groups. No merge preview or contact-level mail/attachment history query is exposed. Mail conversation deduplication already exists separately. |
| E29 AI assistance | R1 AI controls; [email features][email] | Existing translation and manual create-meeting/task actions do not supply summarization, generated replies, or natural-language search. No mail AI provider/settings contract exists. |
| E30 Chat implementation | R1 Matrix/chat controls; [chat features][chat] documents Matrix support | [Chat proposal](chat-implementation-proposal.md) is complete; [App](../src/App.tsx) has no enabled Chat workspace or connector. The new task implements the proposal and preserves its gates. |

## Existing capabilities deliberately retained

The current source already implements scheduled delivery, Undo Send, snooze, offline mail search, recipient suggestions, basic rich text/signatures, local rules, account-specific notifications, message windows, categories, linked notes, translation, print, EML export, save-all-attachments, and copy to an existing folder in the same account. Creating tasks, rules, and provider calendar events from mail is also implemented in [MailMessageTools](../src/components/MailMessageTools.tsx).

Writable Google/Microsoft Calendar and Contacts, basic recurrence/reminders, Google Tasks, and Microsoft To Do are implemented, including durable task queues and recovery. The existing completed roadmap items remain unchanged. The older provider catalog/strategy prose is less current than the active contracts and connector implementations and was not used to classify these as missing.

## Remaining evidence limits

This is a feature-planning comparison, not an exhaustive audit of eM Client or a runtime compatibility claim. UI-only observations are identified above and corroborated with vendor documentation. Exact editor behavior, mass-mail recovery, tracker classification, server-rule mappings, full backup contents, conference provider behavior, and encrypted-mail interoperability remain unobserved in this investigation. The roadmap makes their Aerio acceptance criteria explicit instead of borrowing unverified behavior.

The artifact identities and selected observations are recorded here for later review. REA Evidence IDs identify records from this analysis session; full canonical payloads are retained in that session, not embedded in this Markdown document.

[email]: https://www.emclient.com/features-email
[compose]: https://www.emclient.com/webdocumentation/en/10.0/emclient/Content/E-mail/Composing%20Email.htm
[comparison]: https://www.emclient.com/how-we-compare
[encryption]: https://www.emclient.com/email-encryption
[calendar]: https://www.emclient.com/features-calendar
[calendar-help]: https://www.emclient.com/webdocumentation/en/10.0/emclient/Content/Calendar/About%20Calendar.htm
[contacts]: https://www.emclient.com/features-contacts
[chat]: https://www.emclient.com/features-chat
[folders]: https://www.emclient.com/webdocumentation/en/10.0/emclient/Content/Getting%20Started/Main%20screen%20Interface.htm
[imports]: https://www.emclient.com/webdocumentation/en/10.0/emclient/Content/Getting%20Started/Import/Import%20from%20Outlook.htm

