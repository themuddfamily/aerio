import { FolderInput, Tag, Tags } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { MailAccountSummary, MailLabel, MailThreadSummary } from '../mail-types'
import Modal from './Modal'

export interface OrganizeRequest {
  accountId: string
  threadIds: string[]
  action: 'move' | 'label' | 'unlabel'
  labelId: string
}

interface MailOrganizeModalProps {
  mode: 'move' | 'label'
  items: MailThreadSummary[]
  accounts: MailAccountSummary[]
  labels: MailLabel[]
  onApply(requests: OrganizeRequest[]): Promise<void>
  onClose(): void
}

export default function MailOrganizeModal({ mode, items, accounts, labels, onApply, onClose }: MailOrganizeModalProps) {
  const groups = useMemo(() => [...new Set(items.map((item) => item.accountId))].map((accountId) => ({
    account: accounts.find((account) => account.id === accountId),
    accountId,
    threadIds: items.filter((item) => item.accountId === accountId).map((item) => item.id)
  })), [accounts, items])
  const targets = useMemo(() => Object.fromEntries(groups.map((group) => {
    const provider = group.account?.provider
    const providerLabels = labels.filter((label) => label.accountId === group.accountId)
    const values = mode === 'label'
      ? provider === 'gmail' ? providerLabels.filter((label) => label.type === 'user') : []
      : provider === 'gmail'
        ? [
            { accountId: group.accountId, id: 'INBOX', name: 'Inbox', type: 'system' as const },
            ...providerLabels.filter((label) => label.type === 'user'),
            { accountId: group.accountId, id: 'SPAM', name: 'Spam', type: 'system' as const },
            { accountId: group.accountId, id: 'TRASH', name: 'Trash', type: 'system' as const }
          ]
        : providerLabels.filter((label) => !/draft|sent|outbox/i.test(label.name))
    return [group.accountId, values]
  })), [groups, labels, mode])
  const [selection, setSelection] = useState<Record<string, string>>(() => Object.fromEntries(groups.map((group) => [group.accountId, targets[group.accountId]?.[0]?.id ?? ''])))
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setSelection(Object.fromEntries(groups.map((group) => [group.accountId, targets[group.accountId]?.[0]?.id ?? ''])))
  }, [groups, targets])

  const apply = async (action: OrganizeRequest['action']) => {
    const requests = groups.flatMap((group) => selection[group.accountId]
      ? [{ accountId: group.accountId, threadIds: group.threadIds, action, labelId: selection[group.accountId] }]
      : [])
    if (!requests.length) return
    setBusy(true)
    try {
      await onApply(requests)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return <Modal title={mode === 'move' ? 'Move conversations' : 'Manage labels'} subtitle={`${items.length.toLocaleString()} selected conversation${items.length === 1 ? '' : 's'}`} width="small" onClose={onClose}>
    <div className="organize-mail">
      {groups.map((group) => <section key={group.accountId}>
        <header><span className="account-dot" style={{ background: group.account?.color }} /><span><strong>{group.account?.displayName || group.account?.email || 'Mail account'}</strong><small>{group.threadIds.length} conversation{group.threadIds.length === 1 ? '' : 's'}</small></span></header>
        {targets[group.accountId]?.length ? <label className="field"><span>{mode === 'move' ? 'Destination' : 'Label'}</span><select value={selection[group.accountId]} onChange={(event) => setSelection((current) => ({ ...current, [group.accountId]: event.target.value }))}>{targets[group.accountId].map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}</select></label> : <p>{mode === 'label' ? 'This provider uses folders instead of independent labels.' : 'No destination folders are available.'}</p>}
      </section>)}
    </div>
    <footer className="modal-footer">
      <button className="button ghost" onClick={onClose}>Cancel</button>
      <span className="spacer" />
      {mode === 'label' && <button className="button ghost" disabled={busy || !Object.values(selection).some(Boolean)} onClick={() => void apply('unlabel')}><Tags size={15} /> Remove label</button>}
      <button className="button primary" disabled={busy || !Object.values(selection).some(Boolean)} onClick={() => void apply(mode === 'move' ? 'move' : 'label')}>{mode === 'move' ? <FolderInput size={15} /> : <Tag size={15} />} {busy ? 'Applying…' : mode === 'move' ? 'Move' : 'Apply label'}</button>
    </footer>
  </Modal>
}
