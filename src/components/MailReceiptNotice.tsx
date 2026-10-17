import { MailCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { MailReceiptInfo, MailReceiptReportInfo } from '../mail-types'

interface MailReceiptNoticeProps {
  accountId: string
  messageId: string
}

const dispositionText: Record<string, string> = {
  displayed: 'reported that the message was displayed',
  deleted: 'reported that the message was deleted without being displayed',
  dispatched: 'reported that the message was forwarded or printed',
  processed: 'reported that the message was processed automatically'
}
const actionText: Record<string, string> = {
  delivered: 'delivered',
  failed: 'could not be delivered',
  delayed: 'is delayed',
  relayed: 'was relayed to a server that may not report back',
  expanded: 'was delivered to a list'
}

export function receiptReportSummary(report: MailReceiptReportInfo) {
  const original = report.originalSubject ? `“${report.originalSubject}”` : 'a message you sent'
  if (report.kind === 'read') {
    const who = report.reporter || 'The recipient'
    return `${who} ${dispositionText[report.disposition ?? ''] ?? 'returned a read receipt'} for ${original}.`
  }
  const outcomes = report.recipients.map((item) => `${item.recipient} ${actionText[item.action ?? ''] ?? `reported “${item.action ?? 'unknown'}”`}`)
  return `Delivery report for ${original}: ${outcomes.join('; ') || 'no recipient details'}.`
}

// Shows returned receipts and asks before answering a read-receipt request.
export default function MailReceiptNotice({ accountId, messageId }: MailReceiptNoticeProps) {
  const [info, setInfo] = useState<MailReceiptInfo>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setInfo(undefined)
    void window.aerio?.mail?.receipts?.inspect(accountId, messageId).then((value) => {
      if (active) setInfo(value)
    }).catch(() => undefined)
    return () => { active = false }
  }, [accountId, messageId])

  const respond = async (decision: 'send' | 'decline') => {
    const receipts = window.aerio.mail.receipts
    if (!receipts) return
    setBusy(true)
    setError('')
    try {
      setInfo(await receipts.respond(accountId, messageId, decision))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') : 'The read receipt could not be sent')
    } finally {
      setBusy(false)
    }
  }

  const request = info?.request
  const report = info?.report
  if (!report && (!request || request.status === 'suppressed')) return null
  return (
    <div className="mail-receipt-notice" role="status">
      <MailCheck size={15} aria-hidden="true" />
      <div>
        {report && <p>
          {receiptReportSummary(report)}
          <small> {report.kind === 'read'
            ? 'Read receipts are optional and come from the recipient’s mail app; they do not prove the message was read.'
            : 'Delivery reports describe what one server observed; they do not prove the message reached the inbox or was read.'}
          {!report.originalSubject && report.originalMessageId ? ' The original message is not in your synced mail.' : ''}</small>
        </p>}
        {request && (request.status === 'pending' || request.status === 'failed') && <p>
          <span>The sender asked for a read receipt at {request.notifyTo}.</span>
          {request.reason && <small> {request.reason}</small>}
          {request.status === 'failed' && request.error && <small className="diagnostic-error"> Last attempt failed: {request.error}</small>}
          <span className="mail-receipt-actions">
            <button type="button" disabled={busy} onClick={() => void respond('send')}>{request.status === 'failed' ? 'Try again' : 'Send receipt'}</button>
            {request.status === 'pending' && <button type="button" disabled={busy} onClick={() => void respond('decline')}>Don’t send</button>}
          </span>
        </p>}
        {request?.status === 'sent' && <p><small>Read receipt {request.automatic ? 'sent automatically' : 'sent'} to {request.notifyTo}.</small></p>}
        {request?.status === 'declined' && <p><small>You chose not to send a read receipt.</small> <span className="mail-receipt-actions"><button type="button" disabled={busy} onClick={() => void respond('send')}>Send anyway</button></span></p>}
        {error && <p><small className="diagnostic-error">{error}</small></p>}
      </div>
    </div>
  )
}
