import { ArrowDown, ArrowUp, Settings2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { messageToolbarCommands, messageToolbarLabels, normalizeMessageToolbar, type MessageToolbarCommand } from '../lib/message-toolbar'
import Modal from './Modal'

export default function MessageToolbar({ commands, onToast }: { commands: Partial<Record<MessageToolbarCommand, ReactNode>>; onToast(message: string): void }) {
  const [layout, setLayout] = useState<MessageToolbarCommand[]>(() => normalizeMessageToolbar(undefined))
  const [draft, setDraft] = useState<MessageToolbarCommand[]>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const api = window.aerio.messageToolbar
    if (!api) return
    let active = true
    void api.get().then((value) => { if (active) setLayout(normalizeMessageToolbar(value)) }).catch(() => { if (active) onToast('Message toolbar preferences could not be loaded.') })
    const unsubscribe = api.onChange((value) => { if (active) setLayout(normalizeMessageToolbar(value)) })
    return () => { active = false; unsubscribe() }
  }, [])
  const save = async () => {
    if (!draft) return
    setBusy(true); setError('')
    try {
      if (!window.aerio.messageToolbar) throw new Error('Toolbar settings are unavailable. Restart Aerio after updating.')
      const saved = await window.aerio.messageToolbar.set(draft)
      setLayout(normalizeMessageToolbar(saved)); setDraft(undefined)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Toolbar settings could not be saved.') }
    finally { setBusy(false) }
  }
  const move = (command: MessageToolbarCommand, direction: -1 | 1) => {
    if (!draft) return
    const next = [...draft], index = next.indexOf(command), target = index + direction
    if (index < 0 || target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    setDraft(next)
  }
  return <>
    {layout.map((command) => commands[command] && <span className="custom-message-toolbar-command" key={command} data-toolbar-command={command}>{commands[command]}</span>)}
    <button className="icon-button" aria-label="Customize message toolbar" title="Customize message toolbar" onClick={() => { setDraft([...layout]); setError('') }}><Settings2 size={16} /></button>
    {draft && <Modal title="Customize message toolbar" subtitle="Choose commands and their order for all message readers." width="small" onClose={() => { if (!busy) setDraft(undefined) }} closeEnabled={!busy}>
      <p>Hidden commands remain available in message menus. Pinning is available in the main Mail reader.</p>
      <ol className="message-toolbar-editor">{[...draft, ...messageToolbarCommands.filter((command) => !draft.includes(command))].map((command) => {
        const index = draft.indexOf(command)
        return <li key={command}>
          <label><input type="checkbox" disabled={busy} checked={index >= 0} onChange={(event) => setDraft(event.target.checked ? [...draft, command] : draft.filter((item) => item !== command))} />{messageToolbarLabels[command]}</label>
          <button className="icon-button" disabled={busy || index <= 0} aria-label={`Move ${messageToolbarLabels[command]} up`} onClick={() => move(command, -1)}><ArrowUp size={15} /></button>
          <button className="icon-button" disabled={busy || index < 0 || index === draft.length - 1} aria-label={`Move ${messageToolbarLabels[command]} down`} onClick={() => move(command, 1)}><ArrowDown size={15} /></button>
        </li>
      })}</ol>
      {error && <p role="alert">{error}</p>}
      <footer className="modal-footer"><button className="button ghost" disabled={busy} onClick={() => setDraft([...messageToolbarCommands])}>Restore defaults</button><span className="spacer" /><button className="button primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save toolbar'}</button></footer>
    </Modal>}
  </>
}
