import {
  BellOff, File, Info, MessageCircle, MoreHorizontal, Paperclip, Phone, Plus, Search,
  Send, Smile, Users, Video
} from 'lucide-react'
import { format, isToday, parseISO } from 'date-fns'
import { useMemo, useState } from 'react'
import { uid } from '../lib/domain'
import type { AppState, Conversation } from '../types'

interface ChatViewProps {
  state: AppState
  query: string
  onChange(next: AppState): void
  onToast(message: string): void
}

const autoReplies = [
  'Perfect — that works for me.',
  'Love it. I’ll take a closer look shortly.',
  'Sounds good! Thanks for the update.',
  'Great, I’ve added it to my list.'
]

export default function ChatView({ state, query, onChange, onToast }: ChatViewProps) {
  const [selectedId, setSelectedId] = useState(state.conversations[0]?.id ?? '')
  const [message, setMessage] = useState('')
  const [showInfo, setShowInfo] = useState(true)
  const conversations = useMemo(() => state.conversations.filter((conversation) => !query || `${conversation.name} ${conversation.messages.map((item) => item.text).join(' ')}`.toLowerCase().includes(query.toLowerCase())), [query, state.conversations])
  const selected = state.conversations.find((conversation) => conversation.id === selectedId) ?? conversations[0]

  const select = (conversation: Conversation) => {
    setSelectedId(conversation.id)
    if (conversation.unread) onChange({ ...state, conversations: state.conversations.map((item) => item.id === conversation.id ? { ...item, unread: 0 } : item) })
  }

  const send = () => {
    if (!selected || !message.trim()) return
    const text = message.trim()
    const sentAt = new Date().toISOString()
    const next: AppState = {
      ...state,
      conversations: state.conversations.map((conversation) => conversation.id === selected.id ? {
        ...conversation,
        messages: [...conversation.messages, { id: uid('chat-message'), sender: 'me', text, time: sentAt }]
      } : conversation)
    }
    onChange(next)
    setMessage('')
    if (selected.online) {
      setTimeout(() => {
        const reply = autoReplies[text.length % autoReplies.length]
        onChange({
          ...next,
          conversations: next.conversations.map((conversation) => conversation.id === selected.id ? {
            ...conversation,
            messages: [...conversation.messages, { id: uid('chat-message'), sender: 'them', text: reply, time: new Date().toISOString() }]
          } : conversation)
        })
      }, 700)
    }
  }

  const attach = async () => {
    if (!selected) return
    const [attachment] = await window.aerio.chooseAttachments()
    if (!attachment) return
    onChange({
      ...state,
      conversations: state.conversations.map((conversation) => conversation.id === selected.id ? {
        ...conversation,
        messages: [...conversation.messages, { id: uid('chat-message'), sender: 'me', text: attachment.name, time: new Date().toISOString(), attachment }]
      } : conversation)
    })
    onToast('Attachment added to conversation')
  }

  return (
    <div className="workspace chat-workspace">
      <aside className="context-sidebar chat-sidebar">
        <button className="compose-button" onClick={() => onToast('New chat uses your saved contacts')}><Plus size={18} /> New conversation</button>
        <div className="sidebar-group">
          <span className="sidebar-label">Conversations</span>
          {conversations.map((conversation) => {
            const last = conversation.messages.at(-1)
            return (
              <button key={conversation.id} className={`chat-list-item ${selected?.id === conversation.id ? 'active' : ''}`} onClick={() => select(conversation)}>
                <span className="avatar large" style={{ background: conversation.color }}>{conversation.name.split(' ').map((part) => part[0]).slice(0, 2).join('')}<i className={conversation.online ? 'online' : ''} /></span>
                <span><strong>{conversation.name}</strong><small>{last?.text}</small></span>
                <span className="chat-meta"><time>{last && (isToday(parseISO(last.time)) ? format(parseISO(last.time), 'HH:mm') : format(parseISO(last.time), 'EEE'))}</time>{conversation.unread > 0 && <em>{conversation.unread}</em>}</span>
              </button>
            )
          })}
        </div>
      </aside>
      <section className="chat-panel">
        {selected ? (
          <>
            <header className="chat-header">
              <span className="avatar large" style={{ background: selected.color }}>{selected.name.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span>
              <span><strong>{selected.name}</strong><small>{selected.online ? 'Online now' : 'Last seen recently'}</small></span>
              <span className="spacer" />
              <button className="icon-button" title="Audio call" onClick={() => onToast('Calling is not connected in demo mode')}><Phone size={18} /></button>
              <button className="icon-button" title="Video call" onClick={() => onToast('Video is not connected in demo mode')}><Video size={18} /></button>
              <button className={`icon-button ${showInfo ? 'active' : ''}`} title="Conversation details" onClick={() => setShowInfo((value) => !value)}><Info size={18} /></button>
            </header>
            <div className="chat-messages">
              <div className="conversation-intro">
                <span className="avatar hero-avatar" style={{ background: selected.color }}>{selected.name.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span>
                <h2>{selected.name}</h2>
                <p>This is the beginning of your Aerio conversation.</p>
              </div>
              {selected.messages.map((item) => (
                <div className={`chat-bubble-row ${item.sender === 'me' ? 'mine' : ''}`} key={item.id}>
                  {item.sender === 'them' && <span className="avatar small-avatar" style={{ background: selected.color }}>{selected.name[0]}</span>}
                  <div className="chat-bubble">
                    {item.attachment && <span className="chat-file"><File size={18} /><strong>{item.attachment.name}</strong></span>}
                    <p>{item.text}</p>
                    <span><time>{format(parseISO(item.time), 'HH:mm')}</time>{item.reaction && <em>{item.reaction}</em>}</span>
                  </div>
                </div>
              ))}
            </div>
            <footer className="chat-composer">
              <button className="icon-button" onClick={() => void attach()}><Paperclip size={19} /></button>
              <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder={`Message ${selected.name}`} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) send() }} />
              <button className="icon-button"><Smile size={19} /></button>
              <button className="send-circle" onClick={send}><Send size={17} /></button>
            </footer>
          </>
        ) : <div className="empty-state grow"><MessageCircle size={32} /><h3>Select a conversation</h3></div>}
      </section>
      {showInfo && selected && (
        <aside className="chat-info-panel">
          <span className="avatar hero-avatar" style={{ background: selected.color }}>{selected.name.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span>
          <h2>{selected.name}</h2>
          <p>{selected.online ? 'Active now' : 'Away'}</p>
          <div className="contact-actions compact">
            <button><span><Search size={18} /></span>Search</button>
            <button><span><BellOff size={18} /></span>Mute</button>
            <button><span><MoreHorizontal size={18} /></span>More</button>
          </div>
          <section><h3><Users size={16} /> People</h3>{selected.participants.map((person) => <div className="info-person" key={person}><span className="avatar small-avatar" style={{ background: selected.color }}>{person[0]}</span><strong>{person}</strong></div>)}</section>
          <section><h3><File size={16} /> Shared files</h3><p className="muted-copy">Files shared here stay on this computer.</p></section>
        </aside>
      )}
    </div>
  )
}
