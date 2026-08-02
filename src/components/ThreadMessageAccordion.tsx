import { ChevronDown, Reply } from 'lucide-react'
import type { MouseEvent, ReactNode } from 'react'
import type { GmailMessageDetail } from '../gmail-types'
import SenderAvatar from './SenderAvatar'

interface ThreadMessageAccordionProps {
  message: GmailMessageDetail
  expanded: boolean
  dateLabel: string
  children?: ReactNode
  onToggle(): void
  onReply?(): void
  onContextMenu?(event: MouseEvent<HTMLElement>): void
}

function messagePreview(message: GmailMessageDetail) {
  return message.text.replace(/\s+/g, ' ').trim().slice(0, 180) || 'No message preview available'
}

export default function ThreadMessageAccordion({
  message,
  expanded,
  dateLabel,
  children,
  onToggle,
  onReply,
  onContextMenu
}: ThreadMessageAccordionProps) {
  const sender = message.fromName || message.fromEmail
  const contentId = `thread-message-${message.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`

  return (
    <section className={`gmail-message thread-message ${expanded ? 'expanded' : 'collapsed'}`} onContextMenu={onContextMenu}>
      <header className="thread-message-header">
        <button
          type="button"
          className="thread-message-toggle"
          aria-expanded={expanded}
          aria-controls={contentId}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} message from ${sender}`}
          onClick={onToggle}
        >
          <SenderAvatar email={message.fromEmail} name={message.fromName} large={expanded} />
          <span className="thread-message-copy">
            <span className="thread-message-meta"><strong>{sender}</strong><time>{dateLabel}</time></span>
            <small>{message.fromEmail}</small>
            {!expanded && <span className="thread-message-preview">{messagePreview(message)}</span>}
          </span>
          <ChevronDown className="thread-message-chevron" size={17} />
        </button>
        {expanded && onReply && <button type="button" className="button ghost small thread-message-reply" onClick={onReply}><Reply size={15} /> Reply</button>}
      </header>
      {expanded && <div className="thread-message-content" id={contentId}>
        {message.sanitizedHtml
          ? <div className="message-body gmail-html" dangerouslySetInnerHTML={{ __html: message.sanitizedHtml }} />
          : <div className="message-body gmail-text">{message.text}</div>}
        {children}
      </div>}
    </section>
  )
}
