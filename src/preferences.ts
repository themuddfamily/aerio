import type { AppPreferences, Settings } from './types'

export const defaultSettings: Settings = {
  theme: 'system',
  density: 'comfortable',
  closeToTray: true,
  launchAtLogin: false,
  notifications: true,
  startModule: 'mail'
}

export function createDefaultPreferences(): AppPreferences {
  return { schemaVersion: 1, settings: { ...defaultSettings } }
}
