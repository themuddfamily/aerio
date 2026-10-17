import { useEffect, useState } from 'react'
import type { MailListUnsubscribeInfo, MailMessageDetail, MailMessageRef, MailUnsubscribeMethod, MailUnsubscribeOption } from '../mail-types'
import Modal from './Modal'

const successMessage = { unsubscribed: 'Unsubscribe request accepted', opened: 'Unsubscribe page opened in your browser', queued: 'Unsubscribe email queued' }

/** Shows the list-unsubscribe destinations of an email and acts only when the user picks one explicitly. */
export default function MailUnsubscribeDialog({ message, messageRef, readOnly, onToast, onClose }: {
  message: MailMessageDetail; messageRef: MailMessageRef; readOnly: boolean; onToast(message: string): void; onClose(): void
}) {
  const [info, setInfo] = useState<MailListUnsubscribeInfo>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    window.aerio.mail.messageTools.unsubscribeInfo(messageRef)
      .then((value) => { if (active) setInfo(value) })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'The unsubscribe details could not be loaded') })
    return () => { active = false }
  }, [])

  const act = async (option: MailUnsubscribeOption, method: MailUnsubscribeMethod) => {
    setBusy(true); setError('')
    try {
      const result = await window.aerio.mail.messageTools.unsubscribe(messageRef, { url: option.url, method })
      onToast(`${successMessage[result.status]} (${result.destination})`)
      onClose()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unsubscribing failed') }
    finally { setBusy(false) }
  }

  return <Modal title="Unsubscribe from mailing list" subtitle={message.subject} width="small" closeEnabled={!busy} onClose={onClose}>
    <div className="form-stack message-tool-form message-unsubscribe">
      {!info && !error && <p role="status">Loading…</p>}
      {error && <p role="alert" className="message-tool-error">{error}</p>}
      {info && <>
        <p>{info.options.length ? `Choose how to unsubscribe${info.listId ? ` from ${info.listId}` : ''}. Nothing is sent until you choose an action.` : 'This email does not include a usable unsubscribe link from its sender.'}</p>
        {info.options.map((option) => <section key={option.url} className="message-unsubscribe-option" aria-label={`Unsubscribe through ${option.destination}`}>
          <h3>{option.kind === 'mailto' ? 'Send an unsubscribe email' : option.oneClick ? 'One-click unsubscribe' : 'Unsubscribe web page'}</h3>
          <dl className="message-properties">
            <div><dt>{option.kind === 'mailto' ? 'To' : 'Website'}</dt><dd>{option.destination}</dd></div>
            {option.kind === 'mailto' && option.mailto ? <div><dt>Subject</dt><dd>{option.mailto.subject || 'unsubscribe'}</dd></div> : <div><dt>Address</dt><dd>{option.url}</dd></div>}
          </dl>
          {option.kind === 'mailto' && <small>{readOnly ? 'This account is archived and cannot send email.' : 'Aerio sends this email from the account that received the message.'}</small>}
          {option.oneClick && <small>Aerio sends a single request to this website without cookies or account details.</small>}
          <div className="message-unsubscribe-actions">
            {option.oneClick && <button className="button primary" disabled={busy} onClick={() => void act(option, 'one-click')}>Unsubscribe</button>}
            {option.kind === 'https' && <button className={`button ${option.oneClick ? 'ghost' : 'primary'}`} disabled={busy} onClick={() => void act(option, 'browser')}>Open in browser</button>}
            {option.kind === 'mailto' && <button className="button primary" disabled={busy || readOnly} onClick={() => void act(option, 'mailto')}>Send unsubscribe email</button>}
          </div>
        </section>)}
        {info.warnings.length > 0 && <ul className="message-unsubscribe-warnings" aria-label="Unsubscribe header problems">{info.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
      </>}
    </div>
    <footer className="modal-footer"><span className="spacer" /><button className="button ghost" disabled={busy} onClick={onClose}>Close</button></footer>
  </Modal>
}
