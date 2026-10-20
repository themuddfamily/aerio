import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (!process.versions.electron) {
  const { default: binary } = await import('electron')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(binary, [fileURLToPath(import.meta.url)], { env, windowsHide: true, stdio: 'inherit' })
  const timeout = setTimeout(() => child.kill(), 15_000)
  child.once('exit', (code) => { clearTimeout(timeout); process.exitCode = code ?? 1 })
} else {
  const { app, Notification } = await import('electron')
  if (process.platform === 'win32') app.setAppUserModelId('com.aerio.desktop')
  void app.whenReady().then(async () => {
    let notice
    try {
      if (!Notification.isSupported()) { console.log(JSON.stringify({ audit: 'mail-notifications', skipped: 'Native notifications are unavailable' })); app.exit(0); return }
      const { tsImport } = await import('tsx/esm/api')
      const { MailNotificationService } = await tsImport('../electron/mail-notifications.ts', import.meta.url)
      const { defaultMailNotifications } = await tsImport('../src/lib/mail-notifications.ts', import.meta.url)
      const actions = []
      let resolveDelivery
      const delivered = new Promise((resolve) => { resolveDelivery = resolve })
      const service = new MailNotificationService({
        platform: process.platform,
        supported: () => true, enabled: () => true, locked: () => false, focused: () => false,
        preferences: () => ({ ...defaultMailNotifications(), actions: ['archive', 'open'], silent: true }),
        open: () => actions.push('open'), perform: async (command) => { actions.push(command) },
        create: (options) => {
          notice = new Notification(options)
          notice.once('show', () => resolveDelivery({ shown: true }))
          notice.once('failed', (_event, reason) => resolveDelivery({ shown: false, reason }))
          return notice
        }
      })
      service.show({ accountId: 'local-audit-fixture', threadId: 'local-audit-thread', count: 1, sender: 'Aerio notification audit', subject: 'Disposable local fixture; no real mail is changed' })
      const timer = setTimeout(() => resolveDelivery({ shown: false, reason: 'No native delivery event before timeout' }), 5000)
      const delivery = await delivered
      clearTimeout(timer)
      if (delivery.shown && ['win32', 'darwin'].includes(process.platform)) {
        assert.deepEqual(notice.actions.map((action) => action.text), ['Archive', 'Open message'])
        // This is a native-object binding smoke check, not an automated OS button click.
        notice.emit('action', { actionIndex: 0 })
        await Promise.resolve(); await Promise.resolve()
        assert.deepEqual(actions, ['archive'])
      }
      service.clear()
      console.log(JSON.stringify({ audit: 'mail-notifications', platform: process.platform, nativeDelivery: delivery, nativeActionBinding: delivery.shown && ['win32', 'darwin'].includes(process.platform), osButtonClickAutomated: false }))
      app.exit(delivery.shown ? 0 : 2)
    } catch (error) {
      notice?.close()
      console.error(error instanceof Error ? error.message : 'Notification audit failed')
      app.exit(1)
    }
  })
}
