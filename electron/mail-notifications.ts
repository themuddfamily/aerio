import type { NotificationConstructorOptions } from 'electron'
import type { MailNotificationAction, MailNotificationPayload, MailNotificationPreferences } from '../src/mail-notification-types'
import { MAIL_NOTIFICATION_ACTION_LABELS, mailNotificationAllowed, mailNotificationText, mailQuietHours } from '../src/lib/mail-notifications'

interface NativeNotification {
  on(event: string, listener: (...args: any[]) => void): unknown
  show(): void
  close?(): void
}
export interface MailNotificationDependencies {
  platform: NodeJS.Platform
  create(options: NotificationConstructorOptions): NativeNotification
  supported(): boolean
  enabled(): boolean
  preferences(): MailNotificationPreferences
  locked(): boolean
  focused(): boolean
  icon?: string
  open(payload: MailNotificationPayload): void
  perform(action: Exclude<MailNotificationAction, 'open'>, payload: MailNotificationPayload): Promise<void>
  failed?(error: unknown): void
  now?(): Date
}

/** Native events close over a trusted worker reference; no URLs or command strings can mutate mail. */
export class MailNotificationService {
  private readonly active = new Set<{ notification: NativeNotification; revoke(): void }>()
  constructor(private readonly dependencies: MailNotificationDependencies) {}
  clear() {
    for (const entry of this.active) { entry.revoke(); entry.notification.close?.() }
    this.active.clear()
  }
  show(input: MailNotificationPayload) {
    const deps = this.dependencies
    const preferences = deps.preferences()
    const now = deps.now?.() ?? new Date()
    if (!deps.supported() || !deps.enabled() || !mailNotificationAllowed(preferences, input) || mailQuietHours(preferences, now) || (preferences.onlyWhenUnfocused && deps.focused())) return
    if (!input.accountId || !Number.isSafeInteger(input.count) || input.count < 1) return
    const payload = { ...input }
    const locked = deps.locked()
    const commands = !locked && payload.count === 1 && payload.threadId && ['darwin', 'win32'].includes(deps.platform) ? [...preferences.actions] : []
    const notification = deps.create({ ...mailNotificationText(preferences, payload, locked), icon: deps.icon, silent: preferences.silent, ...(commands.length ? { actions: commands.map((command) => ({ type: 'button', text: MAIL_NOTIFICATION_ACTION_LABELS[command] })) } : {}) })
    let consumed = false
    const entry = { notification, revoke: () => { consumed = true } }
    const activate = (command: MailNotificationAction) => {
      if (consumed || (deps.now?.() ?? new Date()).getTime() - now.getTime() > 24 * 60 * 60_000) return
      consumed = true
      if (command === 'open') { deps.open(payload); return }
      if (deps.locked()) { deps.open(payload); return }
      if (!deps.enabled() || !mailNotificationAllowed(deps.preferences(), payload) || !payload.threadId || payload.count !== 1) return
      void Promise.resolve().then(() => { if (!deps.locked()) return deps.perform(command, payload) }).catch((error) => deps.failed?.(error))
    }
    notification.on('click', () => activate('open'))
    notification.on('action', (details: { actionIndex?: unknown } | undefined, legacyIndex?: number) => {
      const index = details?.actionIndex ?? legacyIndex
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= commands.length) return
      activate(commands[index])
    })
    // Windows may emit close when only the banner timed out; keep its bounded
    // binding alive while the notification remains in Action Center.
    notification.on('close', () => { if (deps.platform !== 'win32') this.active.delete(entry) })
    notification.on('failed', () => { consumed = true; this.active.delete(entry) })
    this.active.add(entry)
    while (this.active.size > 50) {
      const oldest = this.active.values().next().value!
      oldest.revoke(); oldest.notification.close?.(); this.active.delete(oldest)
    }
    notification.show()
  }
}
