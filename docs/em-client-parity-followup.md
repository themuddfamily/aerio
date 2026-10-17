# Additional eM Client parity evidence

Reviewed: 2026-10-17. Aerio baseline: commit `7bea9f9e9fcfcd22820bca42adc0b8f2046da5b9`, with no tracked changes at the start of this pass. This follow-up supports new roadmap items E31-E48; [E01-E30](em-client-parity.md) are historical and already complete.

## Target and method

The current installed package is `eMClient.20054CA46072C_11.0.1201.0_x64__veq4nz3ze5v72` under `C:\Program Files\WindowsApps`. REA 6.5.0 re-inspected its shipped assemblies without loading or executing application code. Main-assembly identity matches the earlier investigation: managed x64 CIL, .NET 10, SHA-256 and MVID in F0 below. The separate Program Files (x86) launcher has no CLI metadata and was not used to infer missing application features.

REA's summary-first managed inspections retained the original Evidence. Resource/member pages and an exported canonical bundle supplied the observations below. F0 uses `inspect_managed_artifact`; F1-F12 use `inspect_managed_members`. F3 selects exactly `MailClient.Protocols.Imap.ImapAccountConfiguration`; other member inspections cover their named assembly. Each reported complete metadata coverage within that scope. Tokens are build-local coordinates bound to SHA-256 and MVID.

**Evidence strengths:** decoded fields, method bodies, CIL call edges, and loaded literals establish shipped structures/code paths. Packaged form/resource names establish UI inventory only; their user-facing semantics are corroborated by official documentation. None of these observations proves runtime success, licensing availability, server compatibility, or complete feature coverage. The prior main-assembly member-budget limitation remains; this pass uses its resource inventory and smaller assemblies rather than claiming full main-assembly code coverage. No native disassembler session was opened.

Aerio gaps below are bounded findings from its current production contracts, renderer, stores, workers, and connectors. Proposed ordering, recovery, validation, and security details in [ROADMAP.md](../ROADMAP.md) are Aerio design requirements, not claims about eM Client behavior.

## Artifact identities

| Ref | Assembly | Canonical REA Evidence ID | SHA-256 | Module MVID |
| --- | --- | --- | --- | --- |
| F0 | `MailClient.dll` | `ev_ace88aed39c4cdbbb045706d05840f8585b6e43b8b520f336fb2d79759fc8421` | `fbac375683450c5e16b1a306d239e780f2ef1ec2208d1a86448bb44ec7c8bcb3` | `fc452afc-d418-49d3-b568-d439df42322f` |
| F1 | `MailClient.Storage.Mail.dll` | `ev_8d5c78db3f71d8155329d41da0691f235a2116ec8c38dfeef31dabeef43f3e6a` | `1e70c1f5d32147fadebb431d2fcaaf529fdb9c7660212243a4dc4e0f92b081a2` | `03291494-03ba-4f0a-9851-5ebe898dc0c2` |
| F2 | `MailClient.Storage.Classification.dll` | `ev_933c1d55ce541de415a9e988a1f4aa66c3b842d693de27e44fc63c3789793c49` | `63df639c0fd5cd37092d596ca25e4a24f81036c07064be37d7c3afe551ab0979` | `a20c25eb-b987-4d6f-8d25-7fb57b8524f2` |
| F3 | `MailClient.Protocols.Imap.dll` | `ev_91a44ca05d6466b82c14093f672d18a9a246356f8b09cfa76f9c89f0cb31a02a` | `b3f44b44ca8021e83f458c64906b956d8778f333a85c997151c13fedb7135e0e` | `928bbcf3-c00b-4e2c-864a-c2c0bd0478ec` |
| F4 | `MailClient.Protocols.Pop3.dll` | `ev_1365708eb6ad74ded38db5bf84ab375dac577267e3f3152fe3b6441fb9e22872` | `c0d58566ae4b7d642edf459604b09a8d01f0dc17879fb50b07973297d8cea62f` | `8e607cf8-8e79-460b-a8f8-59ef513ff421` |
| F5 | `MailClient.Protocols.Exchange.dll` | `ev_90c0a33ebf1a610d7c62dc28475ed2c15931e22267eaccc746594957eda4fe1c` | `a61c2bc14a2e7ffd07da3939762a43af52fc3d7123a31834bba36a1b6c478023` | `1412332e-f3aa-41e5-8b64-248b221beed1` |
| F6 | `MailClient.Protocols.OfflineAddressBook.dll` | `ev_736dbd229dfaeac0f0a3fcb12351185a34a2db90afcbeabaa9acd4f357d92b84` | `c7b4bbfbeb53f18187a7ca6958ba9a966097541c2c9d7edb3436ebb3fbe887bd` | `957fd895-4665-4873-af70-8aa9f72901f2` |
| F7 | `MailClient.Note.dll` | `ev_9483885e6d5b6dc85c1d937d2976ce64704b07488ea4b045f40d4bf2aeaab3bf` | `6cdb72a232448d0810d6c8d774997d8db8aac8d8460ca5d096b721dbe71649c6` | `153688b9-3393-4ffd-a90a-b521972deddd` |
| F8 | `MailClient.Protocols.CalDav.dll` | `ev_8519e618ce3d9838b090510dd95b2de8ff96267e06e48528838d3a3fab828644` | `935e5e081e4433bd666f5f5302b9f23ff31c1e0f1047e611d8c3dea56bac38dc` | `5b4bf285-1896-4b89-b69f-6f346e8bc322` |
| F9 | `MailClient.Schedule.dll` | `ev_21eaee6094a8dbd238c287e736ffae9d741d6e92815b4e7b3e29c1841368d789` | `b1ac467ba4abfeb99e6bd14b9e079a3a051e473d9ab3240227f2a2dbfd57fd2a` | `dcb34b85-09f5-41cf-bd6e-f63575af4d93` |
| F10 | `MailClient.Protocols.CloudStorage.dll` | `ev_e7eb3ba7ab04fea23d9337b92e9ed1c2bfaf4a90383d888e3833255f7491c2af` | `d650db8e69dad7ade02674a6a6d985577b451dc1c0de7122a7746e2423cdf074` | `48263b96-8e43-4f24-a281-132a1da004b5` |
| F11 | `MailClient.Protocols.OnlineMeeting.dll` | `ev_641ca5b1349653d933e1a8192fa0847f40b3d4cb32dce01ebc83fd9c3cd8c828` | `ed7540b9cf3100a77c806bfccda94cf5405c2cfc61a66bdaefd75d4c00c426cc` | `768d6883-271e-4b68-8d0c-a7577f7bf51e` |
| F12 | `MailClient.Import.VNote.dll` | `ev_37cbaf668468d2593616bfee959b86f57773bee0d6d700e2e6b2c357c422b4a8` | `18703772d9b5920f1f8e2ae6eb7225b50914fed8b89a220eed3bea7140480718` | `35928037-6165-4b29-8679-052a827a162c` |

The eM Client MCP executable is a native host with no admitted CLI metadata: `MailClient.Mcp.exe`, SHA-256 `0497a83f3edc4984fbbda132fb3c705d6ce142a8cabe44ad4fe54c55c6faf0a7`, Evidence `ev_0c708d1b360eca897444a41aea1530d64e5f88e50967a6b7fa8f1746d6de4956`. Its filename is not behavioral proof; E48 relies on the documented interface and F0's MCP configuration forms.

## Selected observations

| Ref | Exact observations |
| --- | --- |
| F0 | Resource view `ev_fa5d47498026393acc73a8ebf02504e3928cd7488886ea100f4ae2f656df9de2` exhausted all 503 resource rows from F0. Relevant names below are UI inventory, not decoded event handlers. |
| F1 | `MailClient.Storage.Mail.MailFlags.Pinned` (`0x0400004f`), `Query.ConversationSort.HasPinnedMessages` (`0x0400005c`), and `Query.MailSort.Pinned` (`0x0400007b`) establish dedicated pin state/sort fields, distinct from ordinary flags. |
| F2 | `DbMailClassificationsRepository.Add` (`0x0600003d`, body file offset 1412) calls SQLite command/parameter APIs and loads an INSERT into `ClassificationRules` with id, pattern, source, and classification columns. The body is present; tab semantics are documented in [email features][email]. |
| F3 | `ImapAccountConfiguration.get_DefaultOfflineSynchronizationMode` (`0x060002d6`), LimitedSyncEnabled getters/setters (`0x060002f1`/`0x060002f2`), and LimitedSyncWindow getters/setters (`0x060002f3`/`0x060002f4`) have CIL bodies. [Limited-time sync][limited-sync] and the [account FAQ][accounts] describe user controls. |
| F4 | `Pop3ReceiveCommand.Execute` (`0x0600003d`, file offset 3996) calls Connect, SendCommand, ReadLine, ReadMailStream, FlushReceivedMails, and Pop3Account.CheckUids. CheckUids/AddUid (`0x0600000d`/`0x0600000e`) have bodies. Configuration exposes LeaveMessagesOnServer, DeleteMessageInDays, and RemoveWhenDeleted. |
| F5 | ExchangeAccount.GetPublicFoldersAsync (`0x060000e6`/`0x060000e7`), ExchangeFolderSynchronizer.GetDelegatesAsync/UpdateDelegatesAsync (`0x060001e5`/`0x060001e6`), ExchangeAddressResolver.LookupAddressesAsync (`0x0600017b`), and ExchangeNoteSynchronizer conversion methods have bodies. This supports connector/delegation paths; live permissions are unknown. |
| F6 | `OabAccount.SynchronizeInt` (`0x0600000f`, offset 848) and `OabReader.ReadAllRecords` (`0x06000039`, offset 5203) have bodies. Exchange address lookup in F5 and [documented organization contacts][directory] corroborate the directory capability. |
| F7 | `NoteConvert.CreatevNoteFromNoteItem` (`0x06000010`), `CreatevJournalFromNoteItem` (`0x06000011`), and attachment conversion methods have bodies. Rich editing and server-side Notes are separately [documented][notes]. |
| F8 | `NoteItemSynchronizer.GetPayload` (`0x06000318`, offset 69724) calls NoteConvert.CreatevJournalFromNoteItem; CreateItem/ResolveConflict paths also have bodies. `TaskItemSynchronizer.GetPayload` (`0x06000351`, offset 81108) and CreateItem (`0x06000353`) use calendar components, TaskItem, and TaskComposer. Together with [documented task protocols][comparison], these support distinct DAV note/task routes. |
| F9 | `MailClient.Schedule.Task.TaskComposer` has start/time-zone, percent-complete, status, reminder, and attachment members. DismissReminder (`0x0600017f`, offset 37076) and SnoozeReminder (`0x06000180`, offset 37246) have bodies; [task editing help][tasks] corroborates dates, reminders, tags, and attachments. |
| F10 | OwnCloudCloudStorageProvider.CreateShareableLinkAsync (`0x06000090`) and DropboxCloudStorageProvider.CreateShareableLinkAsync (`0x06000310`) have bodies, plus provider-specific link paths. [Storage compatibility][cloud] corroborates Dropbox, ownCloud, and Nextcloud; the shared ownCloud type alone does not prove Nextcloud interoperability. |
| F11 | ZoomOnlineMeetingProvider.ScheduleOnlineMeetingAsync/DeleteOnlineMeetingAsync (`0x0600009b`/`0x0600009d`) and WebexOnlineMeetingProvider.ScheduleOnlineMeetingAsync/DeleteOnlineMeetingAsync (`0x06000128`/`0x06000125`) have bodies. Both services are [documented integrations][meetings]. |
| F12 | `MailClient.Import.VNote.VNoteImport.ImportStream` (`0x06000007`, offset 1016), ImportFile, and Import have bodies. This establishes a shipped vNote importer, not a tested format/interoperability guarantee. |

Relevant F0 resource names omit the common `MailClient.` prefix and `.resources` suffix:

| Resource | Token |
| --- | --- |
| UI.Controls.SettingsControls.ControlSettingsArchive | `0x280000dd` |
| UI.Forms.FormDeduplicatorResults / UI.Forms.wizardDeduplicator | `0x28000153` / `0x280001ce` |
| UI.Controls.SettingsControls.ControlSettingsClassification | `0x280000e3` |
| UI.Forms.FormFolderVisibility / UI.Forms.FormFolderProperties | `0x28000168` / `0x28000167` |
| UI.Controls.SettingsControls.ControlSettingsShortcuts | `0x28000104` |
| Protocols.Exchange.FormDelegatePermissions / Protocols.Exchange.FormPublicFolders | `0x2800000e` / `0x28000010` |
| UI.Forms.FormEditNote | `0x2800015d` |
| UI.Controls.SettingsControls.ControlSettingsMCP | `0x280000f1` |

## Gap ledger against current Aerio

Each row maps one open roadmap item to current source. Existing related functionality is called out to avoid reopening completed work.

| Task | eM Client basis | Aerio boundary |
| --- | --- | --- |
| E31 Age-based local archiving | F0; [archiving FAQ][accounts] | Age conditions already exist, but [mail-worker.ts](../electron/mail-worker.ts)'s rule application runs for newly synchronized mail and claims each message once. [MailAccountSettingsInput](../src/mail-types.ts) has no recurring archive policy. [Local Folders transfer](../electron/mail/local-folders.ts) runs immediately and queues Trash by thread; automatic archiving needs a durable job and message-level removal for mixed-age threads. |
| E32 Duplicate cleanup | F0; [Deduplicator documentation][menu] | [Mail import](../electron/mail/mail-import.ts) reviews duplicates during import and Contacts has merge; current [mail](../src/mail-types.ts), [productivity](../src/productivity-types.ts), and [task](../src/task-provider-types.ts) APIs expose no existing-item scanner/removal review. Logical IMAP deduplication and calendar-import duplicate handling are already present. |
| E33 Inbox tabs | F0/F2; [email features][email] | [MailQuery](../src/mail-types.ts) has folder/label/search filters without an inbox classification contract. [ConnectedMailView](../src/views/ConnectedMailView.tsx) has no classification tab flow. Message-local tags and provider contact/task categories do not supply it. |
| E34 Mail pinning | F1; [email features][email] | MailActionKind, MailMessageLocalData, and thread summaries in [mail-types.ts](../src/mail-types.ts) have no pin state. [Database](../electron/mail/database.ts) orders threads by last_date/id/account_id. Notes already support pins. |
| E35 Favorite folders/appearance | F0; [Favorites help][favorites], [email features][email] | [ConnectedMailView](../src/views/ConnectedMailView.tsx) limits user labels to the first 12, without a persisted favorites/order model. [Folder capabilities](../src/lib/mail-folders.ts) and [management](../electron/mail/folder-management.ts) restrict colors to Gmail. Folder CRUD and Gmail colors already exist. |
| E36 Offline policies | F3; [limited sync][limited-sync], [account FAQ][accounts] | [Account/folder contracts](../src/mail-types.ts) expose account syncEnabled but no folder download mode/date window. [Mail worker](../electron/mail-worker.ts) builds the complete mailbox inventory and downloads raw messages; storage reports totals without policy controls. |
| E37 Keymap editor | F0; [shortcuts][shortcuts] | [App.tsx](../src/App.tsx) hardcodes bindings. [Quick Actions](../src/lib/mail-quick-actions.ts) allow fixed Ctrl/Cmd+Shift+digit slots; [Settings](../src/types.ts) has no editable command bindings. |
| E38 POP3 | F4; [account FAQ][accounts] | [MailProviderId/ImapAccountInput/account APIs](../src/mail-types.ts) provide Gmail, Graph, IMAP/SMTP, and Local Folders without POP3, UIDL state, or server retention policy. |
| E39 Exchange/EWS | F5; [account FAQ][accounts] | [Microsoft mail](../electron/mail/microsoft-client.ts) uses Graph /me mailbox endpoints; [productivity](../electron/productivity/microsoft-connector.ts) uses Graph calendars/contacts. No EWS account/discovery route in the inspected production contracts/connectors. |
| E40 Delegation/public folders | F0/F5; [account FAQ][accounts] | [Mail contracts](../src/mail-types.ts) have no delegated owner/permission or public-folder model. [Microsoft client](../electron/mail/microsoft-client.ts) addresses the signed-in mailbox. Sender aliases and recognition of shared DAV collections already exist, without mailbox/delegation administration. |
| E41 Directory/OAB | F5/F6; [organization contacts][directory] | [Microsoft contacts](../electron/productivity/microsoft-connector.ts) synchronize personal contacts. [Recipient suggestions](../src/mail-types.ts) query cached data; no directory lookup/OAB refresh contract exists in the inspected connectors. |
| E42 Rich Notes | F0/F7; [Notes][notes] | [Note](../src/types.ts) stores a content string and [NotesView](../src/views/NotesView.tsx) edits it in a plain textarea. Attachments, folders, tags, colors, pinning, and archive already exist. |
| E43 Synced Notes/vNote import | F5/F7/F8/F12; [Notes][notes] | Notes use [local module storage](../electron/productivity/store.ts). [DAV service](../electron/productivity/dav-service.ts) synchronizes addressbooks and VEVENT calendars only. Discovery can name VJOURNAL but has no Notes consumer. [Interchange API](../src/interchange-types.ts) has calendar/contact files only; local Notes JSON backup already exists. |
| E44 Task fields/reminders | F9; [task editing][tasks] | [Local Task](../src/types.ts) and [TaskNativeFields](../src/task-provider-types.ts) lack task start/reminder/percent/category/attachment fields. Microsoft status and native recurrence already exist; [Microsoft mapping](../electron/productivity/microsoft-tasks-connector.ts) currently preserves status, priority, recurrence, due, and body. |
| E45 CalDAV tasks/task files | F8/F9; [protocol comparison][comparison], [export FAQ][accounts] | [TaskProvider](../src/task-provider-types.ts) is gmail or microsoft. [DAV routing](../electron/productivity/dav-service.ts) excludes task-only collections, while [ICS parser](../src/lib/ics.ts) and [interchange contracts](../src/interchange-types.ts) implement event/calendar files without VTODO task import/export. |
| E46 More cloud storage | F10; [storage list][cloud] | [CloudStorageProvider](../src/cloud-attachment-types.ts) permits google-drive and onedrive only. Their upload, sharing, resume, and link-check flows already exist. |
| E47 Zoom/Webex | F11; [meeting integrations][meetings] | [OnlineMeetingConnector](../electron/productivity/online-meetings.ts) reports these providers unavailable; [online-meetings.md](online-meetings.md) explicitly documents the placeholders. Google Meet/Teams creation and join already work. |
| E48 External MCP | F0; [MCP interface][mcp] | Bounded production-source/package inspection found no external MCP transport/server. [Main](../electron/main.ts) and [preload](../electron/preload.ts) expose internal Electron IPC. Existing opt-in [AI assistance](ai-assistance.md) does not expose Aerio to external clients. |

## Coverage and reuse

Answered for this planning pass: installed target identity, additional eM Client capabilities, corresponding Aerio source gaps, overlap with completed work, and actionable roadmap/check/documentation requirements. This is an additional-feature sample, not an exhaustive parity inventory.

Unresolved: target runtime behavior, edition entitlements, live provider scopes/authentication and interoperability, exact eM Client deduplication criteria, complete rich-note format semantics, and complete MCP host internals. Resource-only observations do not establish code execution. The roadmap's checks are future acceptance work; this documentation update does not implement those features.

Do not re-add broad tasks for translation, print, EML export, raw source/properties, mailbox rebuild, folder CRUD, Gmail colors, contact merge, mail import, existing calendar/contact interchange, or basic cloud/conference/AI integrations: these are already implemented. Use the narrower boundaries above.

Canonical Evidence was also exported during this pass to the local temporary file `aerio-em-client-parity-followup-20261017.json` (52 records). The table and selected observations here retain the identity/token anchors for review without committing the 97 MB bundle. Evidence IDs are references to that investigation, not remotely accessible URLs.

[email]: https://www.emclient.com/features-email
[accounts]: https://www.emclient.com/faq-getting-started
[menu]: https://www.emclient.com/webdocumentation/en/10.0/emclient/Content/Menu/Main%20menu.htm
[favorites]: https://www.emclient.com/webdocumentation/en/10.0/emclient/Content/Favorite%20Folders/About%20Favorite%20Folders.htm
[limited-sync]: https://www.emclient.com/blog/limited-time-sync-582
[shortcuts]: https://www.emclient.com/shortcuts
[directory]: https://www.emclient.com/em-client-with-gsuite
[notes]: https://www.emclient.com/features-notes
[tasks]: https://www.emclient.com/webdocumentation/en/10.0/emclient/Content/Tasks/Creating%20and%20Editing%20Tasks.htm
[comparison]: https://www.emclient.com/how-we-compare
[cloud]: https://www.emclient.com/cloud-storages
[meetings]: https://www.emclient.com/online-meetings-tools
[mcp]: https://www.emclient.com/mcp
