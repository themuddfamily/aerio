import { useCallback, useEffect, useRef, useState } from 'react'
import type { MailCategoryCounts, MailCategoryId, MailInboxTab, MailInboxTabsConfig } from '../mail-category-types'
import { enabledInboxTabs, inboxTabKeyTarget, inboxTabShortcutTarget, inboxTabsActive } from '../lib/mail-categories'

/**
 * Loads the inbox tab configuration and per-tab counts for the current
 * account scope ('all' sums every account). Counts reload whenever mail
 * changes. Without the categories API (older test doubles) tabs stay off.
 */
export function useInboxCategories(onToast: (message: string) => void, accountId: string) {
  const api = window.aerio.mail.categories
  const [config, setConfig] = useState<MailInboxTabsConfig>()
  const [counts, setCounts] = useState<MailCategoryCounts>({})
  const countRequest = useRef(0)
  const toast = useRef(onToast)
  useEffect(() => { toast.current = onToast }, [onToast])

  const loadTabs = useCallback(async () => {
    if (!api) return
    try { setConfig(await api.tabs()) } catch (error) { toast.current(error instanceof Error ? error.message : 'Inbox tabs could not be loaded') }
  }, [api])

  const loadCounts = useCallback(async () => {
    if (!api) return
    const request = ++countRequest.current
    try {
      const next = await api.counts(accountId === 'all' ? undefined : [accountId])
      if (request === countRequest.current) setCounts(next)
    } catch {
      // Counts are decoration; the list itself reports load failures.
    }
  }, [accountId, api])

  useEffect(() => { void loadTabs() }, [loadTabs])
  useEffect(() => { void loadCounts() }, [loadCounts])
  useEffect(() => window.aerio.mail.onEvent((event) => {
    if (event.type !== 'mail-changed') return
    void loadCounts()
    // Settings changes (tabs or rules) are announced as changes in every account.
    if (!event.payload.threadIds) void loadTabs()
  }), [loadCounts, loadTabs])

  return {
    available: Boolean(api),
    config,
    tabs: config ? enabledInboxTabs(config) : [],
    active: inboxTabsActive(config),
    counts,
    reload: async () => { await Promise.all([loadTabs(), loadCounts()]) }
  }
}

interface InboxCategoryTabsProps {
  tabs: MailInboxTab[]
  selected: MailCategoryId
  counts: MailCategoryCounts
  onSelect(id: MailCategoryId): void
}

const unreadLabel = (count: number) => count > 999 ? '999+' : count.toLocaleString()

/**
 * Inbox tab strip: a tablist with a roving tabindex (Left/Right/Home/End move
 * between tabs and select them), plus Alt+Left/Alt+Right and Alt+1–9 from
 * anywhere outside a text field or dialog.
 */
export default function InboxCategoryTabs({ tabs, selected, counts, onSelect }: InboxCategoryTabsProps) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const index = Math.max(0, tabs.findIndex((tab) => tab.id === selected))

  const choose = useCallback((next: number, focus: boolean) => {
    const tab = tabs[next]
    if (!tab) return
    onSelect(tab.id)
    if (focus) buttons.current[next]?.focus()
  }, [onSelect, tabs])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      const target = event.target instanceof HTMLElement ? event.target : undefined
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      const next = inboxTabShortcutTarget(event, index, tabs.length)
      if (next === undefined) return
      event.preventDefault()
      choose(next, false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [choose, index, tabs.length])

  return <div className="inbox-category-tabs" role="tablist" aria-label="Inbox categories">
    {tabs.map((tab, position) => {
      const unread = counts[tab.id]?.unread ?? 0
      const active = position === index
      return <button
        key={tab.id}
        ref={(element) => { buttons.current[position] = element }}
        type="button"
        role="tab"
        id={`inbox-tab-${tab.id.replace(':', '-')}`}
        aria-selected={active}
        aria-controls="mail-message-list"
        tabIndex={active ? 0 : -1}
        className={`inbox-category-tab ${active ? 'active' : ''}`}
        title={`${tab.name}${unread ? ` · ${unread.toLocaleString()} unread` : ''} (Alt+${position + 1})`}
        onClick={() => choose(position, false)}
        onKeyDown={(event) => {
          const next = inboxTabKeyTarget(event.key, position, tabs.length)
          if (next === undefined) return
          event.preventDefault()
          choose(next, true)
        }}
      >
        <span>{tab.name}</span>
        {unread > 0 && <span className="inbox-category-count" aria-label={`${unread.toLocaleString()} unread`}>{unreadLabel(unread)}</span>}
      </button>
    })}
  </div>
}
