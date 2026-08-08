import type { AppPreferences, Settings } from './types'

export const defaultSettings: Settings = {
  theme: 'system',
  density: 'comfortable',
  closeToTray: true,
  notifications: true,
  startModule: 'mail'
}

export function createDefaultPreferences(): AppPreferences {
  return { schemaVersion: 1, settings: { ...defaultSettings } }
}
