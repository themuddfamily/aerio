# Keyboard shortcuts

Aerio's keyboard shortcuts come from one command registry, [`src/lib/keymap.ts`](../src/lib/keymap.ts). The app shell, Mail, the message editor, the Quick Action slots, menus, the command palette, the Help dialog, and this page all read their bindings from it. You can change any of them in **Settings → Keyboard shortcuts**.

## Platform defaults

Defaults use a portable primary modifier, written `Mod` in the registry: **Cmd** on macOS and **Ctrl** on Windows and Linux. A few commands have a different macOS default where the usual key is a macOS system shortcut. For example, Cmd+Q quits apps on macOS, so *Mark as read* uses Cmd+T there.

Shortcuts you record are stored the same way. Ctrl+E recorded on Windows is saved as `Mod+E`, so a profile restored on a Mac uses Cmd+E. Other modifiers are kept exactly as recorded.

## Editing shortcuts

In **Settings → Keyboard shortcuts** you can:

- **Search** by command name, area, or current key, such as "reply", "quick action", or "Ctrl+Shift".
- **Record** a new shortcut. Select the binding next to a command, then press the new combination. A lone modifier keeps recording going. **Escape** cancels, and **Tab** leaves the field as usual.
- **Resolve conflicts.** If the combination already belongs to a command that can run at the same time, Aerio names that command and asks before moving the shortcut. Global commands can clash with any area. Mail and message-editor commands never run together, so they can share a combination. Any conflicts left in saved settings are listed at the top of the section, and the affected rows are highlighted.
- **Clear** a command's shortcut, **reset** one command, or **Reset all** to restore every default.

Aerio refuses shortcuts that would break typing or keyboard navigation:

- Tab, Shift+Tab, the arrow keys, Home/End, Page Up/Down, Enter, Space, Escape, and Backspace without a modifier
- Shift+F10 (opens context menus)
- The platform's cut, copy, paste, select-all, undo, and redo shortcuts
- Alt+F4 and the Windows/Super key on Windows and Linux
- Cmd+Q, Cmd+H, Cmd+Option+H, Cmd+M, Cmd+W, Cmd+0, Cmd+=, Cmd+−, and Ctrl+Cmd+F on macOS

## Where shortcuts work

- **Everywhere** commands work in any module, including while a text field has focus, as long as the shortcut uses Ctrl, Alt, Cmd, or a function key.
- **Mail** commands work on the checked conversations, or the open conversation if nothing is checked. They are ignored while focus is in a text field, a dialog, or a menu, so the search box and composer never trigger them.
- **Message editor** commands work inside the composer, including after it is popped out into its own window.
- **Plain keys** never run while you type. A shortcut without Ctrl, Alt, or Cmd, such as Delete or a single letter, is ignored in inputs, text areas, and rich-text editors.
- **Fixed keys** can't be remapped. Escape closes the active panel or dialog. Arrow keys, Home/End, Enter, and Space move through and choose items in menus, lists, and the command palette. Shift+F10 or the context-menu key opens context menus.

Menus, context menus, toolbar tooltips, the command palette, the Quick Actions editor, and Help always show the current binding, or no binding if you cleared it. Context-menu items also expose it to assistive technology through `aria-keyshortcuts`.

## Quick Action slots

Saved [Quick Actions](mail-quick-actions.md) can still be assigned to slots 1–9. Each slot is a remappable command, *Run Quick Action in slot N*, and defaults to Ctrl/Cmd+Shift+N. Change the slot's key here. The Quick Actions editor shows the current key for each slot.

## Storage, migration, and backup

Only the commands you change are saved, under `keyboardShortcuts` in Aerio's preferences (`aerio-state.sqlite`). Any command you haven't changed picks up new defaults in later versions automatically. Saving a command's default shortcut again removes its saved override.

The main process validates saved changes each time preferences are loaded or saved. Unknown commands, invalid or duplicate shortcuts, and more than three shortcuts per command are dropped. Commands renamed in later versions are carried over to their new names. Preferences are part of the [full profile backup](profile-backup.md), so your shortcuts travel with a profile restore.

The message pop-out window, opened from a conversation, uses the defaults and has no remappable shortcuts of its own.

## Default shortcuts

This table is generated from the registry. `src/lib/keymap-doc.test.ts` fails if it gets out of date. To regenerate it, run `AERIO_WRITE_KEYMAP_DOC=1 npx vitest run src/lib/keymap-doc.test.ts`.

<!-- keymap:start -->

### General

| Command | Context | Windows and Linux | macOS | ID |
| --- | --- | --- | --- | --- |
| Search and run a command | Everywhere | <kbd>Ctrl+K</kbd> | <kbd>Cmd+K</kbd> | `app.commandPalette` |
| Open settings | Everywhere | <kbd>Ctrl+,</kbd> | <kbd>Cmd+,</kbd> | `app.settings` |
| Open help and keyboard shortcuts | Everywhere | <kbd>F1</kbd> | <kbd>F1</kbd> | `app.help` |
| Lock Aerio — Available while app lock is enabled. | Everywhere | <kbd>Ctrl+L</kbd> | <kbd>Cmd+L</kbd> | `app.lock` |
| Compose a new message | Everywhere | <kbd>Ctrl+N</kbd> | <kbd>Cmd+N</kbd> | `mail.compose` |

### Navigation

| Command | Context | Windows and Linux | macOS | ID |
| --- | --- | --- | --- | --- |
| Open Mail | Everywhere | <kbd>Ctrl+1</kbd> | <kbd>Cmd+1</kbd> | `module.mail` |
| Open Calendar | Everywhere | <kbd>Ctrl+2</kbd> | <kbd>Cmd+2</kbd> | `module.calendar` |
| Open Contacts | Everywhere | <kbd>Ctrl+3</kbd> | <kbd>Cmd+3</kbd> | `module.contacts` |
| Open Tasks | Everywhere | <kbd>Ctrl+4</kbd> | <kbd>Cmd+4</kbd> | `module.tasks` |
| Open Notes | Everywhere | <kbd>Ctrl+5</kbd> | <kbd>Cmd+5</kbd> | `module.notes` |
| Open Chat — Available while Chat is enabled. | Everywhere | <kbd>Ctrl+6</kbd> | <kbd>Cmd+6</kbd> | `module.chat` |

### Mail

| Command | Context | Windows and Linux | macOS | ID |
| --- | --- | --- | --- | --- |
| Reply | Mail | <kbd>Ctrl+R</kbd> | <kbd>Cmd+R</kbd> | `mail.reply` |
| Reply all | Mail | <kbd>Ctrl+Shift+R</kbd> | <kbd>Cmd+Shift+R</kbd> | `mail.replyAll` |
| Forward | Mail | <kbd>Ctrl+Shift+F</kbd> | <kbd>Cmd+Shift+F</kbd> | `mail.forward` |
| Mark as read — Cmd+Q quits on macOS, so macOS uses Cmd+T. | Mail | <kbd>Ctrl+Q</kbd> | <kbd>Cmd+T</kbd> | `mail.markRead` |
| Mark as unread | Mail | <kbd>Ctrl+U</kbd> | <kbd>Cmd+Shift+T</kbd> | `mail.markUnread` |
| Add or remove star | Mail | Not assigned | Not assigned | `mail.toggleStar` |
| Archive | Mail | <kbd>Ctrl+Shift+E</kbd> | <kbd>Cmd+Shift+E</kbd> | `mail.archive` |
| Move to Trash | Mail | <kbd>Del</kbd> | <kbd>Del</kbd> | `mail.trash` |
| Open conversation in new window | Mail | Not assigned | Not assigned | `mail.openWindow` |
| Check for new mail | Mail | <kbd>F5</kbd> | <kbd>F5</kbd> | `mail.refresh` |

### Message editor

| Command | Context | Windows and Linux | macOS | ID |
| --- | --- | --- | --- | --- |
| Send or schedule the message | Message editor | <kbd>Ctrl+Enter</kbd> | <kbd>Cmd+Enter</kbd> | `compose.send` |
| Save draft | Message editor | <kbd>Ctrl+S</kbd> | <kbd>Cmd+S</kbd> | `compose.saveDraft` |
| Paste as plain text | Message editor | <kbd>Ctrl+Shift+V</kbd> | <kbd>Cmd+Shift+V</kbd> | `compose.pastePlain` |

### Quick Actions

| Command | Context | Windows and Linux | macOS | ID |
| --- | --- | --- | --- | --- |
| Run Quick Action in slot 1 — Runs the saved Quick Action assigned to this slot. | Mail | <kbd>Ctrl+Shift+1</kbd> | <kbd>Cmd+Shift+1</kbd> | `quickAction.slot1` |
| Run Quick Action in slot 2 — Runs the saved Quick Action assigned to this slot. | Mail | <kbd>Ctrl+Shift+2</kbd> | <kbd>Cmd+Shift+2</kbd> | `quickAction.slot2` |
| Run Quick Action in slot 3 — Runs the saved Quick Action assigned to this slot. | Mail | <kbd>Ctrl+Shift+3</kbd> | <kbd>Cmd+Shift+3</kbd> | `quickAction.slot3` |
| Run Quick Action in slot 4 — Runs the saved Quick Action assigned to this slot. | Mail | <kbd>Ctrl+Shift+4</kbd> | <kbd>Cmd+Shift+4</kbd> | `quickAction.slot4` |
| Run Quick Action in slot 5 — Runs the saved Quick Action assigned to this slot. | Mail | <kbd>Ctrl+Shift+5</kbd> | <kbd>Cmd+Shift+5</kbd> | `quickAction.slot5` |
| Run Quick Action in slot 6 — Runs the saved Quick Action assigned to this slot. | Mail | <kbd>Ctrl+Shift+6</kbd> | <kbd>Cmd+Shift+6</kbd> | `quickAction.slot6` |
| Run Quick Action in slot 7 — Runs the saved Quick Action assigned to this slot. | Mail | <kbd>Ctrl+Shift+7</kbd> | <kbd>Cmd+Shift+7</kbd> | `quickAction.slot7` |
| Run Quick Action in slot 8 — Runs the saved Quick Action assigned to this slot. | Mail | <kbd>Ctrl+Shift+8</kbd> | <kbd>Cmd+Shift+8</kbd> | `quickAction.slot8` |
| Run Quick Action in slot 9 — Runs the saved Quick Action assigned to this slot. | Mail | <kbd>Ctrl+Shift+9</kbd> | <kbd>Cmd+Shift+9</kbd> | `quickAction.slot9` |

<!-- keymap:end -->
