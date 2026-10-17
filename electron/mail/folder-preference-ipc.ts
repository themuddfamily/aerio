import type { IpcMain } from 'electron'
import { MAIL_FOLDER_ICONS, type MailFolderAppearanceInput, type MailFolderIcon, type MailFolderPreferences, type MailFolderReference } from '../../src/mail-folder-preference-types'
import type { MailFolderPreferenceCommand } from './folder-preferences'

// Shape checks for renderer-supplied folder display preferences. The worker
// checks that the account and folder exist and applies provider rules
// (Gmail label colors stay on Gmail).
const MAX_FAVORITES = 1_000

const id = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !value || value.length > 1_000) throw new Error(`The ${label} is invalid`)
  return value
}

export function validateFolderPreferenceReference(accountId: unknown, labelId: unknown): MailFolderReference {
  return { accountId: id(accountId, 'account'), labelId: id(labelId, 'folder') }
}

export function validateFavoriteAlias(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error('The favorite name is invalid')
  const alias = value.trim()
  if (/[\u0000-\u001f\u007f]/.test(alias)) throw new Error('The favorite name cannot contain control characters')
  if (alias.length > 120) throw new Error('Use a favorite name of 120 characters or fewer')
  return alias || null
}

export function validateFavoriteOrder(value: unknown): MailFolderReference[] {
  if (!Array.isArray(value) || value.length > MAX_FAVORITES) throw new Error('The favorite order is invalid')
  const order = value.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('The favorite order is invalid')
    const reference = item as Partial<MailFolderReference>
    return validateFolderPreferenceReference(reference.accountId, reference.labelId)
  })
  if (new Set(order.map((item) => `${item.accountId}\u0000${item.labelId}`)).size !== order.length) throw new Error('A favorite is listed twice')
  return order
}

export function validateFolderAppearance(value: unknown): MailFolderAppearanceInput {
  if (!value || typeof value !== 'object') throw new Error('The folder appearance is invalid')
  const input = value as Record<string, unknown>
  const allowed = new Set(['accountId', 'labelId', 'icon', 'color', 'hidden'])
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error('The folder appearance is invalid')
  const result: MailFolderAppearanceInput = validateFolderPreferenceReference(input.accountId, input.labelId)
  if (input.icon !== undefined) {
    if (input.icon !== null && !MAIL_FOLDER_ICONS.includes(input.icon as MailFolderIcon)) throw new Error('Choose one of the folder icons')
    result.icon = input.icon as MailFolderIcon | null
  }
  if (input.color !== undefined) {
    if (input.color !== null && (typeof input.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(input.color))) throw new Error('Choose a valid color')
    result.color = typeof input.color === 'string' ? input.color.toLowerCase() : null
  }
  if (input.hidden !== undefined) {
    if (typeof input.hidden !== 'boolean') throw new Error('The folder visibility is invalid')
    result.hidden = input.hidden
  }
  return result
}

export function registerMailFolderPreferenceHandlers(ipcMain: Pick<IpcMain, 'handle'>, request: (command: MailFolderPreferenceCommand) => Promise<unknown>) {
  const send = async (command: MailFolderPreferenceCommand) => await request(command) as MailFolderPreferences
  ipcMain.handle('mail:folder-preferences:get', () => send({ type: 'folder-preferences:get' }))
  ipcMain.handle('mail:folder-preferences:add-favorite', (_event, accountId: unknown, labelId: unknown) =>
    send({ type: 'folder-preferences:add-favorite', payload: validateFolderPreferenceReference(accountId, labelId) }))
  ipcMain.handle('mail:folder-preferences:remove-favorite', (_event, accountId: unknown, labelId: unknown) =>
    send({ type: 'folder-preferences:remove-favorite', payload: validateFolderPreferenceReference(accountId, labelId) }))
  ipcMain.handle('mail:folder-preferences:reorder', (_event, order: unknown) =>
    send({ type: 'folder-preferences:reorder', payload: { order: validateFavoriteOrder(order) } }))
  ipcMain.handle('mail:folder-preferences:set-alias', (_event, accountId: unknown, labelId: unknown, alias: unknown) =>
    send({ type: 'folder-preferences:set-alias', payload: { ...validateFolderPreferenceReference(accountId, labelId), alias: validateFavoriteAlias(alias) } }))
  ipcMain.handle('mail:folder-preferences:set-appearance', (_event, input: unknown) =>
    send({ type: 'folder-preferences:set-appearance', payload: validateFolderAppearance(input) }))
}
