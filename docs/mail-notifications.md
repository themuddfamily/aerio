# Mail notifications and configurable buttons

Open **Settings → Notifications**. The existing **Desktop notifications** switch remains the master switch. Mail controls below it apply to newly synced messages:

- **Mail preview:** sender and subject, sender only, or neither. No message body is included.
- **Silent new-mail notifications:** suppress native notification sounds.
- **Only notify when Aerio is in the background:** suppress new-mail notifications while any Aerio window is focused.
- **Quiet hours:** suppress new-mail notifications in an interval using the computer's local clock, including overnight intervals. The start is inclusive and end exclusive. Equal times disable the interval.
- **Notification buttons:** select up to three commands, change their order with **Move earlier**, or remove all buttons. Commands are Open message, Mark as read, Archive, Add star, and Move to Trash.
- **Categories:** notify for all current/future inbox categories, or select particular built-in/custom categories. A disabled inbox tab is classified into Primary, as in the inbox. Notifications are grouped by their effective category, so muting one category never exposes its messages in an allowed category's summary.
- **Accounts:** mute individual accounts. An account's own notification switch must also be enabled; these controls do not override a disabled account setting.

Calendar/task reminders, reply-watch notices and Chat retain their own controls. The new detailed controls concern new mail. Defaults preserve sender-and-subject previews, sounds and notifications while Aerio is focused; the default button is Open message. Preferences saved by earlier versions receive these defaults.

## Actions and platform behavior

The packaged Electron 43 runtime supports native notification buttons and the `action` event on **Windows and macOS**. Buttons are offered only for an individual conversation. A summary covering multiple messages opens the inbox and never offers a mutation that could unexpectedly act on the entire batch. Linux uses click-to-open notifications with this runtime; selecting buttons is harmless there, but the buttons are omitted.

On macOS the first button is the primary action; additional actions appear according to the system UI. A signed application and `NSUserNotificationAlertStyle: alert` are required. Aerio's macOS packaging sets that alert style. Windows delivery depends on native notification permission and the app identity/shortcut; Aerio uses its existing `com.aerio.desktop` identity. Operating-system notification/DND settings can suppress delivery.

Actions use Electron's native action API; Aerio adds no external protocol handler or arbitrary URL command surface. Each notification holds a copy of the trusted worker account/conversation reference and its displayed command order. The callback accepts only a valid button index, consumes the activation once, rechecks preferences and app lock, and sends the existing `mail:action` command through the ordinary worker queue. Archiving therefore also uses configured Archive-trigger rules. Offline actions queue through normal mail processing. Expired bindings (24 hours), evicted notifications, and callbacks from previous app sessions cannot change mail. Windows banner timeout retains its bounded in-memory binding for Action Center interaction while Aerio remains open. Reopening an old persisted notification after restart does not replay a mail-changing command. Closing Aerio removes the retained notifications.

Locking Aerio closes and revokes retained new-mail notifications. New notifications shown while locked contain only a generic count and an unlock prompt, with no sender/subject or mutation buttons. A lock racing an action prevents its worker request; no mutation is queued for automatic replay after unlock. Clicking a locked notification may bring Aerio's unlock screen forward.

No real mail is used by verification:

- `src/lib/mail-notifications.test.ts`: defaults, strict command normalization, privacy, account/category eligibility and quiet-hour boundaries.
- `electron/mail-notifications.test.ts`: ordered Windows/macOS bindings, Linux fallback, invalid indexes, single activation, expiry, focus/quiet filtering, lock revocation/races and failed operations.
- `src/components/MailNotificationSettings.test.tsx`: action ordering and editing preview, sound, focus, quiet hours, accounts and categories.
- `electron/main.test.ts`, `electron/mail-worker.test.ts`: persisted settings, actual main-to-worker action routing, silenced-rule handling and effective-category grouping.
- `node scripts/desktop-mail-notifications-audit.mjs`: native notification delivery and production action binding using a disposable local fixture. The audit emits an action on the native object to verify dispatch; it does **not** claim an automated OS button click. On the current Windows host, delivery and binding passed. Signed macOS interaction needs macOS validation.

The implementation follows the version-pinned official [Electron 43 notification API](https://github.com/electron/electron/blob/v43.7.7/docs/api/notification.md) and [notification action requirements](https://github.com/electron/electron/blob/v43.7.7/docs/api/structures/notification-action.md). Native buttons support the required behavior directly; custom Windows toast XML and external activation URLs are unnecessary.
