import { Flag } from 'lucide-react'
import type { MailImportance, MailProviderId, MailSendOptions } from '../mail-types'
import { normalizeSendOptions, providerReceiptSupport } from '../lib/mail-send-options'

interface MailSendOptionsControlProps {
  provider?: MailProviderId
  value?: MailSendOptions
  disabled?: boolean
  onChange(next: MailSendOptions | undefined): void
}

// Compact importance and receipt-request picker for the composer footer.
export default function MailSendOptionsControl({ provider, value, disabled, onChange }: MailSendOptionsControlProps) {
  const support = providerReceiptSupport(provider)
  const importance = value?.importance ?? 'normal'
  const active = Boolean(normalizeSendOptions(value))
  const update = (changes: Partial<MailSendOptions>) => onChange(normalizeSendOptions({ ...value, ...changes }))
  const deliveryUnsupported = support.deliveryReceipt === 'unsupported'
  const summary = [
    importance !== 'normal' ? `${importance === 'high' ? 'High' : 'Low'} importance` : '',
    value?.requestReadReceipt ? 'read receipt' : '',
    value?.requestDeliveryReceipt && !deliveryUnsupported ? 'delivery receipt' : ''
  ].filter(Boolean).join(', ')

  return (
    <details className={`mail-send-options ${active ? 'active' : ''}`}>
      <summary className="icon-button" title={summary ? `Message options: ${summary}` : 'Importance and receipts'} aria-label="Importance and receipts">
        <Flag size={16} aria-hidden="true" />
      </summary>
      <div className="mail-send-options-panel" role="group" aria-label="Importance and receipts">
        <label>
          <span>Importance</span>
          <select value={importance} disabled={disabled} onChange={(event) => update({ importance: event.target.value as MailImportance })}>
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
        </label>
        <label className="mail-send-options-check">
          <input type="checkbox" checked={Boolean(value?.requestReadReceipt)} disabled={disabled} onChange={(event) => update({ requestReadReceipt: event.target.checked })} />
          <span>Request read receipt</span>
        </label>
        <label className="mail-send-options-check" title={deliveryUnsupported ? 'This account’s provider does not support delivery receipts' : undefined}>
          <input type="checkbox" checked={Boolean(value?.requestDeliveryReceipt) && !deliveryUnsupported} disabled={disabled || deliveryUnsupported} onChange={(event) => update({ requestDeliveryReceipt: event.target.checked })} />
          <span>Request delivery receipt{deliveryUnsupported ? ' (not available)' : ''}</span>
        </label>
        <small>{support.note} A receipt is never proof that a message was delivered or read.</small>
      </div>
    </details>
  )
}
