import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { copyText } from './ContextMenu'
import Modal from './Modal'

interface MailMessageSourceModalProps {
  mode: 'headers' | 'source'
  subject: string
  content: string
  onClose(): void
}

export default function MailMessageSourceModal({ mode, subject, content, onClose }: MailMessageSourceModalProps) {
  const [copied, setCopied] = useState(false)
  const label = mode === 'headers' ? 'Message headers' : 'Message source'

  const copy = async () => {
    await copyText(content)
    setCopied(true)
  }

  return <Modal title={label} subtitle={subject} width="large" className="message-source-modal" popoutSize={{ width: 940, height: 760 }} onClose={onClose}>
    <pre className="message-source-content" tabIndex={0}>{content}</pre>
    <footer className="modal-footer">
      <button className="button ghost" onClick={() => void copy()}>{copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : `Copy ${mode}`}</button>
      <span className="spacer" />
      <button className="button primary" onClick={onClose}>Close</button>
    </footer>
  </Modal>
}
