import { Paperclip } from 'lucide-react'
import type { MouseEvent } from 'react'
import type { GmailMessageDetail, GmailThreadDetail } from '../gmail-types'
import SenderAvatar from './SenderAvatar'

interface ThreadListPreviewProps {
  thread: GmailThreadDetail
  selectedMessageId?: string
  dateLabel(value: string): string
  onSelect(message: GmailMessageDetail): void
  onContextMenu?(event: MouseEvent<HTMLElement>): void
}

function previewText(message: GmailMessageDetail) {
  return message.text.replace(/\s+/g, ' ').trim().slice(0, 140) || 'No message preview available'
}

export default function ThreadListPreview({ thread, selectedMessageId, dateLabel, onSelect, onContextMenu }: ThreadListPreviewProps) {
  return (
    <div className="thread-list-preview" role="group" aria-label={`Messages in ${thread.subject}`}>
      {thread.messages.map((message, index) => {
        const sender = message.fromName || message.fromEmail
        return <button
          type="button"
          key={message.id}
          className={`thread-list-child ${selectedMessageId === message.id ? 'active' : ''}`}
          aria-label={`Open message from ${sender}`}
          aria-current={selectedMessageId === message.id ? 'true' : undefined}
          onClick={() => onSelect(message)}
          onContextMenu={onContextMenu}
        >
          <span className="thread-list-connector" aria-hidden="true" />
          <SenderAvatar email={message.fromEmail} name={message.fromName} />
          <span className="thread-list-child-copy">
            <span className="thread-list-child-meta"><strong>{sender}</strong><time>{dateLabel(message.date)}</time></span>
            <span className="thread-list-child-subject"><em>{index === 0 ? 'Original' : `Reply ${index}`}</em>{message.subject}</span>
            <span className="thread-list-child-preview">{previewText(message)}</span>
          </span>
          {message.attachments.length > 0 && <Paperclip className="thread-list-attachment" size={13} />}
        </button>
      })}
    </div>
  )
}
