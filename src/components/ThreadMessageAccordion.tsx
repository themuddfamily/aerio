import { ChevronDown, MoreVertical, Reply, TriangleAlert } from 'lucide-react'
import type { CSSProperties, MouseEvent, ReactNode } from 'react'
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
  onLoadRemoteImages?(): void
  onMoreActions?(event: MouseEvent<HTMLButtonElement>): void
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
  onLoadRemoteImages,
  onMoreActions,
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
            <span className="thread-message-preview" aria-hidden={expanded}>{messagePreview(message)}</span>
          </span>
          <ChevronDown className="thread-message-chevron" size={17} />
        </button>
        {onReply && <button type="button" className="icon-button thread-message-reply" aria-label="Reply" aria-hidden={!expanded} tabIndex={expanded ? 0 : -1} title="Reply" onClick={onReply}><Reply size={16} /></button>}
        {onMoreActions && <button type="button" className="icon-button thread-message-more" aria-label="Message options" aria-haspopup="menu" title="Message options" onClick={onMoreActions}><MoreVertical size={16} /></button>}
      </header>
      <div className="thread-message-content-shell" aria-hidden={!expanded} inert={!expanded}>
        <div className={`thread-message-content ${message.local && message.local.fontSize !== 14 ? 'message-custom-format' : ''}`} id={contentId} style={message.local ? { '--message-font-size': `${message.local.fontSize}px` } as CSSProperties : undefined}>
          {message.local && (message.local.categories.length > 0 || message.local.noteIds.length > 0) && <div className="message-local-details">{message.local.categories.map((category) => <span className="message-category" key={category}>{category}</span>)}{message.local.noteIds.length > 0 && <small>{message.local.noteIds.length} attached note{message.local.noteIds.length === 1 ? '' : 's'} · open Add note to read</small>}</div>}
          {expanded && onLoadRemoteImages && <div className="remote-images-notice">
            <TriangleAlert size={15} aria-hidden="true" />
            <p><button type="button" onClick={onLoadRemoteImages}>Load remote images</button><span>. To preserve your privacy, external images have been blocked.</span></p>
          </div>}
          {message.sanitizedHtml && message.local?.format !== 'plain'
            ? <MessageHtml className="message-body mail-html" html={message.sanitizedHtml} />
            : <div className="message-body mail-text">{message.text}</div>}
          {children}
        </div>
      </div>
    </section>
  )
}
