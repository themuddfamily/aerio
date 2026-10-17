import type { CreateMailFolderInput, DeleteMailFolderInput, UpdateMailFolderInput } from '../../src/mail-types'

// Shape checks for renderer-supplied folder requests before they reach the
// worker; provider-aware rules (names, nesting, colors) are enforced there.
const id = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !value || value.length > 1_000) throw new Error(`The ${label} is invalid`)
  return value
}
const name = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new Error('Enter a folder name')
  return value.trim()
}
const color = (value: unknown) => {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error('Choose a valid color')
  return value.toLowerCase()
}

export function validateCreateFolder(input: CreateMailFolderInput): CreateMailFolderInput {
  if (!input || typeof input !== 'object') throw new Error('The folder request is invalid')
  return {
    accountId: id(input.accountId, 'account'),
    name: name(input.name),
    ...(input.parentId !== undefined ? { parentId: id(input.parentId, 'parent folder') } : {}),
    ...(input.color !== undefined ? { color: color(input.color) } : {})
  }
}

export function validateUpdateFolder(input: UpdateMailFolderInput): UpdateMailFolderInput {
  if (!input || typeof input !== 'object') throw new Error('The folder request is invalid')
  return {
    accountId: id(input.accountId, 'account'),
    labelId: id(input.labelId, 'folder'),
    ...(input.name !== undefined ? { name: name(input.name) } : {}),
    ...(input.parentId !== undefined ? { parentId: input.parentId === null ? null : id(input.parentId, 'parent folder') } : {}),
    ...(input.color !== undefined ? { color: color(input.color) } : {})
  }
}

export function validateDeleteFolder(input: DeleteMailFolderInput): DeleteMailFolderInput {
  if (!input || typeof input !== 'object') throw new Error('The folder request is invalid')
  if (input.confirmNonEmpty !== undefined && typeof input.confirmNonEmpty !== 'boolean') throw new Error('The deletion confirmation is invalid')
  return { accountId: id(input.accountId, 'account'), labelId: id(input.labelId, 'folder'), confirmNonEmpty: input.confirmNonEmpty === true }
}

export function validateFolderReference(accountId: unknown, labelId: unknown) {
  return { accountId: id(accountId, 'account'), labelId: id(labelId, 'folder') }
}
