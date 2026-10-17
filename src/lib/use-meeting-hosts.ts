import { useEffect, useState } from 'react'
import type { MeetingHostAccount } from '../meeting-host-types'

// Zoom and Webex connection status (E47), kept current while mounted. Empty when the bridge is unavailable.
export function useMeetingHosts(): MeetingHostAccount[] {
  const api = typeof window === 'undefined' ? undefined : window.aerio?.meetingHosts
  const [accounts, setAccounts] = useState<MeetingHostAccount[]>([])
  useEffect(() => {
    if (!api) return
    let active = true
    void api.status().then((snapshot) => { if (active) setAccounts(snapshot.accounts) }).catch(() => undefined)
    const unsubscribe = api.onChanged((snapshot) => { if (active) setAccounts(snapshot.accounts) })
    return () => { active = false; unsubscribe() }
  }, [api])
  return accounts
}
