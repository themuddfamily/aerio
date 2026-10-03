import type { ProviderTask, ProviderTaskInput, TaskFieldPatch } from '../../src/task-provider-types'

export const providerTaskFields = (remote: ProviderTask): ProviderTaskInput => ({ title: remote.title, notes: remote.notes, due: remote.due, completed: remote.completed, ...(remote.native ? { native: structuredClone(remote.native) } : {}) })

/** Native edits merge individual fields; a null recurrence is an explicit clear. */
export function applyTaskFields(input: ProviderTaskInput, patch: TaskFieldPatch): ProviderTaskInput {
  const value = structuredClone(input)
  for (const [key, changed] of Object.entries(patch)) {
    if (changed === undefined || key === 'native') continue
    ;(value as unknown as Record<string, unknown>)[key] = changed === null ? undefined : changed
  }
  if (patch.native !== undefined) value.native = { ...value.native, ...structuredClone(patch.native) }
  // An edited plain note supersedes the cached rich body. Explicit rich-body
  // restoration (undo) is retained and checked against the plain note at write.
  if (patch.notes !== undefined && patch.notes !== input.notes && !patch.native?.body && value.native) delete value.native.body
  return value
}
