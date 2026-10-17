import { useEffect, useState } from 'react'
import { buildRecipientLists, type RecipientList } from '../lib/distribution-lists'

// Loads distribution lists for the composer from the cached provider and local contact snapshots.
// The composer also runs in message windows that do not hold the main window's contact state.
export function useRecipientLists() {
  const [lists, setLists] = useState<RecipientList[]>([])
  useEffect(() => {
    const api = window.aerio?.productivity
    if (typeof api?.snapshot !== 'function' || typeof api.localSnapshot !== 'function') return
    let active = true
    void Promise.all([api.snapshot(), api.localSnapshot()]).then(([snapshot, local]) => {
      if (!active) return
      setLists(buildRecipientLists({ contacts: [...(local.contacts ?? []), ...snapshot.contacts], lists: local.contactLists, groups: snapshot.contactGroups }))
    }).catch(() => {
      // Lists are a convenience; plain recipient suggestions keep working without them.
    })
    return () => { active = false }
  }, [])
  return lists
}
