import { useCallback, useEffect, useState } from 'react'
import type { MailUnifiedView, MailUnifiedViewsSnapshot } from '../mail-unified-view-types'

export function useMailUnifiedViews(onToast: (message: string) => void) {
  const api = window.aerio.mail.unifiedViews
  const [snapshot, setSnapshot] = useState<MailUnifiedViewsSnapshot>({ views: [] })
  const [loaded, setLoaded] = useState(!api)
  const reload = useCallback(async () => {
    if (!api) return
    try { setSnapshot(await api.snapshot()); setLoaded(true) }
    catch (error) { onToast(error instanceof Error ? error.message : 'Unified views could not be loaded') }
  }, [api, onToast])
  useEffect(() => { void reload(); return api?.onChanged((next) => { setSnapshot(next); setLoaded(true) }) }, [api, reload])
  const select = useCallback(async (id?: string) => {
    if (!api) return
    const previous = snapshot
    setSnapshot((current) => ({ ...current, selectedId: id }))
    try { setSnapshot(await api.select(id)) }
    catch (error) { setSnapshot(previous); onToast(error instanceof Error ? error.message : 'Unified view could not be selected') }
  }, [api, onToast, snapshot])
  const save = useCallback(async (view: Omit<MailUnifiedView, 'id'> & { id?: string }) => {
    if (!api) throw new Error('Unified views are unavailable')
    setSnapshot(await api.save(view))
  }, [api])
  const remove = useCallback(async (id: string) => {
    if (!api) throw new Error('Unified views are unavailable')
    setSnapshot(await api.remove(id))
  }, [api])
  return { ...snapshot, loaded, available: Boolean(api), select, save, remove, reload }
}
