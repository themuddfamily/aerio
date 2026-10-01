import { useEffect, useState } from 'react'
import type { MailThreadDetail } from '../mail-types'

export function useThreadExpansion(thread: MailThreadDetail | undefined, selectedId: string | undefined, select: (id: string | undefined) => void) {
  const [expanded, setExpanded] = useState<Set<string>>()
  useEffect(() => setExpanded(undefined), [thread?.accountId, thread?.id])
  return {
    isExpanded: (id: string) => expanded ? expanded.has(id) : selectedId === id,
    focus: (id: string) => { select(id); setExpanded(new Set([id])) },
    toggle: (id: string) => {
      select(id)
      setExpanded((current) => {
        const next = new Set(current ?? (selectedId ? [selectedId] : []))
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    },
    collapseAll: () => setExpanded(new Set()),
    expandAll: () => setExpanded(new Set(thread?.messages.map((message) => message.id) ?? []))
  }
}
