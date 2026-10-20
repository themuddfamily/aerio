import type { AppPreferences } from '../src/types'
import type { PortableSignatures, SettingsSyncBundle } from '../src/settings-sync-types'
import type { MailWorkerClient } from './mail/worker-client'
import type { SettingsSyncAdapter } from './settings-sync'
import { syncDigest } from './settings-sync-crypto'
import { normalizeMailNotifications } from '../src/lib/mail-notifications'
import { portablePreferences } from '../src/lib/settings-sync-preferences'
import { parseMailTemplateBackup, type MailTemplateStore } from './mail/template-store'
import { validatePortableSignatures } from './mail/settings-sync-signatures'
export function validateSettingsSyncBundle(value: unknown): SettingsSyncBundle {
  if (!value || typeof value !== 'object') throw new Error('Invalid synchronized settings snapshot.')
  const bundle = value as SettingsSyncBundle
  if (bundle.format !== 'aerio-settings-sync' || bundle.version !== 1) throw new Error('Unsupported synchronized settings snapshot version.')
  const templates = parseMailTemplateBackup(bundle.templates)
  if (!templates) throw new Error('Invalid synchronized templates or QuickText attachments.')
  return { format: 'aerio-settings-sync', version: 1, preferences: portablePreferences(bundle.preferences), signatures: validatePortableSignatures(bundle.signatures), templates: { ...templates, templates: [...templates.templates].sort((a, b) => a.id.localeCompare(b.id)), attachments: [...templates.attachments].sort((a, b) => a.id.localeCompare(b.id)) } }
}
export function settingsSyncAdapter(options: { load(): AppPreferences; save(preferences: AppPreferences): unknown; templates(): MailTemplateStore; worker(): Pick<MailWorkerClient, 'request'>; applied(preferences: AppPreferences): void }): SettingsSyncAdapter {
  return {
    validate: validateSettingsSyncBundle,
    capture: async () => validateSettingsSyncBundle({ format: 'aerio-settings-sync', version: 1, preferences: portablePreferences(options.load().settings), signatures: await options.worker().request<PortableSignatures>({ type: 'settings-sync:signatures-export' }), templates: options.templates().exportBackup() }),
    apply: async (input, guard, expected) => {
      guard?.assert()
      const bundle = validateSettingsSyncBundle(input)
      const beforePreferences = portablePreferences(options.load().settings)
      const templateSnapshot = () => validateSettingsSyncBundle({ ...bundle, templates: options.templates().exportBackup() }).templates
      const beforeTemplates = templateSnapshot()
      const unchanged = () => {
        guard?.assert()
        if (syncDigest(portablePreferences(options.load().settings)) !== syncDigest(beforePreferences) || syncDigest(templateSnapshot()) !== syncDigest(beforeTemplates)) throw new Error('Local synchronized settings changed during import.')
      }
      if (expected && (syncDigest(expected.preferences) !== syncDigest(beforePreferences) || syncDigest(expected.templates) !== syncDigest(beforeTemplates))) throw new Error('Local synchronized settings changed during import.')
      const signatures = await options.worker().request<PortableSignatures>({ type: 'settings-sync:signatures-export' })
      unchanged()
      if (expected && syncDigest(signatures) !== syncDigest(expected.signatures)) throw new Error('Local synchronized settings changed during import.')
      const prepared = options.templates().prepareRestore(bundle.templates, 'replace')
      let appliedSignatures: PortableSignatures | undefined
      let writtenPreferences: SettingsSyncBundle['preferences'] | undefined
      const merge = (preferences: SettingsSyncBundle['preferences']) => {
        const current = options.load()
        return { ...current, settings: { ...current.settings, ...preferences, mailNotifications: { ...normalizeMailNotifications(preferences.mailNotifications), accounts: current.settings.mailNotifications?.accounts ?? {} } } }
      }
      try {
        unchanged()
        const result = await options.worker().request<{ skippedAccounts: number; snapshot: PortableSignatures }>({ type: 'settings-sync:signatures-apply', payload: bundle.signatures, expected: signatures })
        appliedSignatures = result.snapshot
        unchanged()
        const next = merge(bundle.preferences)
        options.save(next)
        writtenPreferences = portablePreferences(next.settings)
        prepared.commit()
      } catch (error) {
        if (guard && !guard.available()) throw error
        prepared.rollback()
        // Compensation only replaces values still owned by this import. Machine-local
        // preferences are merged from the current state, and signatures use worker CAS.
        if (writtenPreferences && syncDigest(portablePreferences(options.load().settings)) === syncDigest(writtenPreferences)) options.save(merge(beforePreferences))
        if (appliedSignatures) {
          try { await options.worker().request({ type: 'settings-sync:signatures-apply', payload: signatures, expected: appliedSignatures }) } catch { /* A newer signature edit must survive compensation. */ }
        }
        throw error
      }
      const baseline = validateSettingsSyncBundle({ ...bundle, preferences: writtenPreferences!, signatures: appliedSignatures!, templates: options.templates().exportBackup() })
      try { options.applied(options.load()) } catch { /* Import succeeded; observer failures must not roll back stores. */ }
      return baseline
    }
  }
}
