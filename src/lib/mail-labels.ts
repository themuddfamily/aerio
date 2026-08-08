import type { MailLabel } from '../mail-types'

export interface VisibleMailLabel {
  id: string
  name: string
  color?: string
}

export function visibleMailLabels(accountId: string, labelIds: string[], availableLabels: MailLabel[]) {
  const labelsById = new Map(availableLabels
    .filter((label) => label.accountId === accountId)
    .map((label) => [label.id, label]))
  const seen = new Set<string>()
  const visible: VisibleMailLabel[] = []

  for (const id of labelIds) {
    const known = labelsById.get(id)
    const name = known?.type === 'user' ? known.name
      : id.startsWith('category:') ? id.slice('category:'.length)
        : id.startsWith('keyword:') ? id.slice('keyword:'.length)
          : undefined
    if (!name?.trim()) continue
    const key = name.trim().toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    visible.push({ id, name: name.trim(), color: known?.color })
  }

  return visible
}
