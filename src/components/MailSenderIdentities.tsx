import { Pencil, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MailAccountSummary } from '../mail-types'
import type { MailSenderIdentity, MailSignature } from '../mail-identity-types'

interface MailSenderIdentitiesProps {
  account: MailAccountSummary
  onToast(message: string): void
}

interface IdentityEdit {
  name: string
  replyTo: string
  newSignatureId: string
  replySignatureId: string
  /** Send as / on behalf of a shared mailbox (Exchange, Microsoft 365; E40). */
  delegation: '' | 'send-as' | 'send-on-behalf'
}

const friendlyError = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') || fallback : fallback
const splitList = (value: string) => value.split(/[,;]/).map((item) => item.trim()).filter(Boolean)
const editFor = (identity: MailSenderIdentity): IdentityEdit => ({
  name: identity.name,
  replyTo: identity.replyTo.join(', '),
  newSignatureId: identity.newSignatureId ?? '',
  replySignatureId: identity.replySignatureId ?? '',
  delegation: identity.delegation ?? ''
})
const statusText: Record<MailSenderIdentity['status'], string> = { verified: 'Authorized', pending: 'Verification pending', unverified: 'Not verified by provider' }
const sourceText: Record<MailSenderIdentity['source'], string> = { primary: 'Account address', gmail: 'Gmail send-as', microsoft: 'Microsoft alias', manual: 'Added in Aerio' }

/** Account-settings section for From identities, Reply-To defaults, and HTML signatures. */
export default function MailSenderIdentities({ account, onToast }: MailSenderIdentitiesProps) {
  const api = window.aerio.mail.identities
  const [identities, setIdentities] = useState<MailSenderIdentity[]>([])
  const [signatures, setSignatures] = useState<MailSignature[]>([])
  const [edits, setEdits] = useState<Record<string, IdentityEdit>>({})
  const [busy, setBusy] = useState<string>()
  const [newAlias, setNewAlias] = useState({ email: '', name: '' })
  const [editingSignature, setEditingSignature] = useState<{ id?: string; name: string; html: string; session: number }>()
  const signatureEditor = useRef<HTMLDivElement | null>(null)
  const session = useRef(0)

  const load = useCallback(async () => {
    const [loaded, loadedSignatures] = await Promise.all([api.list([account.id]), api.signatures.list()])
    setIdentities(loaded)
    setSignatures(loadedSignatures)
    setEdits(Object.fromEntries(loaded.map((identity) => [identity.id, editFor(identity)])))
  }, [account.id, api])

  useEffect(() => {
    void load().catch((error) => onToast(friendlyError(error, 'Sender addresses could not be loaded')))
  }, [load, onToast])

  const run = async (key: string, action: () => Promise<unknown>, success: string, failure: string) => {
    setBusy(key)
    try {
      await action()
      await load()
      onToast(success)
    } catch (error) {
      onToast(friendlyError(error, failure))
    } finally {
      setBusy(undefined)
    }
  }

  const saveIdentity = (identity: MailSenderIdentity, changes: Partial<{ isDefault: boolean }> = {}) => {
    const edit = edits[identity.id] ?? editFor(identity)
    return run(identity.id, () => api.save({
      id: identity.id,
      accountId: account.id,
      email: identity.email,
      name: edit.name,
      replyTo: splitList(edit.replyTo),
      newSignatureId: edit.newSignatureId,
      replySignatureId: edit.replySignatureId,
      ...(delegationAvailable(identity) ? { delegation: edit.delegation || null } : {}),
      ...changes
    }), changes.isDefault ? `${identity.email} is now the default From address` : 'Sender address saved', 'Sender address could not be saved')
  }

  const delegationAvailable = (identity: MailSenderIdentity) => identity.source === 'manual' && (account.provider === 'exchange' || account.provider === 'microsoft')
  const update = (id: string, changes: Partial<IdentityEdit>) => setEdits((current) => ({ ...current, [id]: { ...current[id], ...changes } }))
  const dirty = (identity: MailSenderIdentity) => {
    const edit = edits[identity.id]
    return Boolean(edit) && JSON.stringify({ ...edit, replyTo: splitList(edit.replyTo).join(', ') }) !== JSON.stringify(editFor(identity))
  }

  const bindSignatureEditor = useCallback((element: HTMLDivElement | null) => {
    signatureEditor.current = element
    if (element) element.innerHTML = editingSignature?.html ?? ''
    // Rebinding only when a new editing session starts keeps the caret while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingSignature?.session])

  const saveSignature = () => {
    if (!editingSignature) return
    const html = signatureEditor.current?.innerHTML ?? editingSignature.html
    return run('signature', async () => {
      await api.signatures.save({ id: editingSignature.id, name: editingSignature.name, html })
      setEditingSignature(undefined)
    }, 'Signature saved', 'Signature could not be saved')
  }

  const signatureOptions = <>
    <option value="">{account.signature.trim() ? 'Account signature (primary only)' : 'No signature'}</option>
    {signatures.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
  </>

  return <>
    <section className="sender-identities">
      <h3>From addresses</h3>
      <p>Choose which addresses this account may send as, their Reply-To, and the signatures used for new messages and replies.</p>
      {identities.map((identity) => {
        const edit = edits[identity.id] ?? editFor(identity)
        return <div className="sender-identity" key={identity.id}>
          <div className="sender-identity-head">
            <strong>{identity.email}</strong>
            <small>{sourceText[identity.source]} · {statusText[identity.status]}{identity.delegation ? ` · ${identity.delegation === 'send-as' ? 'Send as' : 'Send on behalf'}` : ''}</small>
            <label className="sender-default"><input type="radio" name={`default-${account.id}`} checked={identity.isDefault} disabled={Boolean(busy)} onChange={() => void saveIdentity(identity, { isDefault: true })} /> Default</label>
          </div>
          <div className="sender-identity-fields">
            <label className="field"><span>Sender name</span><input aria-label={`Sender name for ${identity.email}`} value={edit.name} readOnly={identity.source === 'primary'} title={identity.source === 'primary' ? 'Edit the account display name above' : undefined} onChange={(event) => update(identity.id, { name: event.target.value })} /></label>
            <label className="field"><span>Reply-To</span><input aria-label={`Reply-To for ${identity.email}`} value={edit.replyTo} placeholder="Optional" onChange={(event) => update(identity.id, { replyTo: event.target.value })} /></label>
            <label className="field"><span>New messages</span><select aria-label={`New-message signature for ${identity.email}`} value={edit.newSignatureId} onChange={(event) => update(identity.id, { newSignatureId: event.target.value })}>{signatureOptions}</select></label>
            <label className="field"><span>Replies and forwards</span><select aria-label={`Reply signature for ${identity.email}`} value={edit.replySignatureId} onChange={(event) => update(identity.id, { replySignatureId: event.target.value })}>{signatureOptions}</select></label>
            {delegationAvailable(identity) && <label className="field"><span>Shared mailbox</span><select aria-label={`Sending mode for ${identity.email}`} value={edit.delegation} onChange={(event) => update(identity.id, { delegation: event.target.value as IdentityEdit['delegation'] })}>
              <option value="">Alias of this account</option>
              <option value="send-as">Send as (From: this mailbox)</option>
              <option value="send-on-behalf">Send on behalf (Sender: you)</option>
            </select></label>}
          </div>
          <div className="settings-actions">
            {dirty(identity) && <button className="button ghost small" disabled={Boolean(busy)} onClick={() => void saveIdentity(identity)}><Save size={14} /> Save</button>}
            {identity.source === 'manual' && <button className="button ghost small danger-subtle" disabled={Boolean(busy)} onClick={() => {
              if (window.confirm(`Remove ${identity.email} from this account's From addresses?`)) void run(identity.id, () => api.delete(identity.id), 'Sender address removed', 'Sender address could not be removed')
            }}><Trash2 size={14} /> Remove</button>}
          </div>
        </div>
      })}
      <div className="sender-identity-add">
        <input aria-label="Alias email address" placeholder={account.provider === 'microsoft' ? 'Alias or shared mailbox address' : 'Alias address'} value={newAlias.email} onChange={(event) => setNewAlias((current) => ({ ...current, email: event.target.value }))} />
        <input aria-label="Alias sender name" placeholder="Sender name" value={newAlias.name} onChange={(event) => setNewAlias((current) => ({ ...current, name: event.target.value }))} />
        <button className="button ghost small" disabled={Boolean(busy) || !newAlias.email.trim()} onClick={() => void run('add', async () => {
          await api.save({ accountId: account.id, email: newAlias.email.trim(), name: newAlias.name.trim() || account.displayName })
          setNewAlias({ email: '', name: '' })
        }, 'Sender address added', 'Sender address could not be added')}><Plus size={14} /> Add address</button>
      </div>
      <p>{account.provider === 'gmail'
        ? 'Gmail aliases come from Gmail settings → Accounts → “Send mail as”. Aerio refuses to send from an address Gmail has not verified.'
        : account.provider === 'microsoft'
          ? 'Mailbox aliases are detected automatically. Add shared or send-as mailboxes manually; Microsoft decides at send time whether you have permission.'
          : 'Add aliases your mail server allows you to send as. The server decides at send time; a refused address keeps the message as a draft.'}</p>
      {(account.provider === 'gmail' || account.provider === 'microsoft') && <div><button className="button ghost small" disabled={Boolean(busy)} onClick={() => void run('refresh', () => api.refresh(account.id), 'Sender addresses refreshed', 'Sender addresses could not be refreshed')}><RefreshCw size={14} /> {busy === 'refresh' ? 'Checking…' : 'Refresh from provider'}</button></div>}
    </section>
    <section className="signature-library">
      <h3>Signatures</h3>
      <p>Signatures are shared by all accounts. Images must be HTTPS or embedded; scripts and styles are removed.</p>
      {signatures.map((item) => <div className="signature-item" key={item.id}>
        <span><strong>{item.name}</strong><small>{item.text.split('\n')[0] || 'Empty signature'}</small></span>
        <button className="icon-button" aria-label={`Edit ${item.name}`} disabled={Boolean(busy)} onClick={() => setEditingSignature({ id: item.id, name: item.name, html: item.html, session: ++session.current })}><Pencil size={14} /></button>
        <button className="icon-button" aria-label={`Delete ${item.name}`} disabled={Boolean(busy)} onClick={() => {
          if (window.confirm(`Delete the signature “${item.name}”? Addresses using it will fall back to no signature.`)) void run('signature', () => api.signatures.delete(item.id), 'Signature deleted', 'Signature could not be deleted')
        }}><Trash2 size={14} /></button>
      </div>)}
      {editingSignature
        ? <div className="signature-editor">
          <label className="field"><span>Name</span><input aria-label="Signature name" value={editingSignature.name} onChange={(event) => setEditingSignature((current) => current && { ...current, name: event.target.value })} /></label>
          <div ref={bindSignatureEditor} className="signature-editor-body" contentEditable suppressContentEditableWarning role="textbox" aria-label="Signature content" aria-multiline="true" />
          <div className="settings-actions">
            <button className="button ghost small" onClick={() => setEditingSignature(undefined)}><X size={14} /> Cancel</button>
            <button className="button primary small" disabled={Boolean(busy) || !editingSignature.name.trim()} onClick={() => void saveSignature()}><Save size={14} /> Save signature</button>
          </div>
        </div>
        : <div><button className="button ghost small" disabled={Boolean(busy)} onClick={() => setEditingSignature({ name: '', html: '', session: ++session.current })}><Plus size={14} /> New signature</button></div>}
    </section>
  </>
}
