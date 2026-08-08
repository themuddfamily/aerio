import { ChevronDown, Reply } from 'lucide-react'
import type { MouseEvent, ReactNode } from 'react'
import type { MailMessageDetail } from '../mail-types'
import { formatMailArrival, formatMailArrivalTooltip } from '../lib/mail-date'
import MessageHtml from './MessageHtml'
import SenderAvatar from './SenderAvatar'

interface ThreadMessageAccordionProps {
  message: MailMessageDetail
  expanded: boolean
  children?: ReactNode
  onToggle(): void
  onReply?(): void
  onContextMenu?(event: MouseEvent<HTMLElement>): void
}

function messagePreview(message: MailMessageDetail) {
  return message.text.replace(/\s+/g, ' ').trim().slice(0, 180) || 'No message preview available'
}

export default function ThreadMessageAccordion({
  message,
  expanded,
  children,
  onToggle,
  onReply,
  onContextMenu
}: ThreadMessageAccordionProps) {
  const sender = message.fromName || message.fromEmail
  const contentId = `thread-message-${message.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`

  return (
    <section className={`mail-message thread-message ${expanded ? 'expanded' : 'collapsed'}`} onContextMenu={onContextMenu}>
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
            <span className="thread-message-meta"><strong>{sender}</strong><time dateTime={message.date} title={formatMailArrivalTooltip(message.date)}>{formatMailArrival(message.date)}</time></span>
            <small>{message.fromEmail}</small>
            {!expanded && <span className="thread-message-preview">{messagePreview(message)}</span>}
          </span>
          <ChevronDown className="thread-message-chevron" size={17} />
        </button>
        {expanded && onReply && <button type="button" className="icon-button thread-message-reply" aria-label="Reply" title="Reply" onClick={onReply}><Reply size={16} /></button>}
      </header>
      {expanded && <div className="thread-message-content" id={contentId}>
        {message.sanitizedHtml
          ? <MessageHtml className="message-body mail-html" html={message.sanitizedHtml} />
          : <div className="message-body mail-text">{message.text}</div>}
        {children}
      </div>}
    </section>
  )
}
