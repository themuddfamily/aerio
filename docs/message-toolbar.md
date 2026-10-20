# Custom message toolbar

Use **Customize message toolbar** (the sliders icon in a message reader) to choose which conversation commands appear and reorder them with the up/down buttons. Save the toolbar to apply the layout. **Restore defaults** restores all available commands before saving; clearing every checkbox leaves the customization button accessible. Hidden commands remain available in message menus and keyboard shortcuts. Quick Action buttons remain configured in Quick Actions.

The saved order applies to the main Mail reader and detached message windows immediately, including other open windows, and persists across restarts and profile backups. Reply, Reply all, Forward, read/unread, archive/inbox, trash/restore and star/unstar share the layout. Pin/unpin appears in the main reader, where conversation pinning is supported. Existing account restrictions, busy states and read-only protections still control each action; toolbar customization remains available for read-only accounts.

Settings store only known command IDs. The dedicated settings update patches the latest application preferences, preserving unrelated settings. Failed saves retain the draft editor and show an error without broadcasting a successful change.

Validation: `npx vitest run electron/message-toolbar.test.ts src/components/MessageToolbar.test.tsx src/views/ConnectedMailView.test.tsx src/views/MessageWindow.test.tsx` and `npm run typecheck`.
