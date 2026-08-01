import {
  BellOff, Copy, File, Info, MessageCircle, Paperclip, Phone, Plus, Search,
  Send, Smile, Trash2, Users, Video
} from 'lucide-react'
import { format, isToday, parseISO } from 'date-fns'
import { useEffect, useMemo, useRef, useState } from 'react'
import { uid } from '../lib/domain'
import type { AppState, ChatMessage, Contact, Conversation } from '../types'
import Modal from '../components/Modal'
import { copyText, useContextMenu, type ContextMenuItem } from '../components/ContextMenu'

interface ChatViewProps {
  state: AppState
  query: string
  requestedConversationId?: string
  onChange(next: AppState): void
  onToast(message: string): void
}

const autoReplies = [
  'Perfect — that works for me.',
  'Love it. I’ll take a closer look shortly.',
  'Sounds good! Thanks for the update.',
  'Great, I’ve added it to my list.'
]

export default function ChatView({ state, query, requestedConversationId, onChange, onToast }: ChatViewProps) {
  const { showContextMenu } = useContextMenu()
  const [selectedId, setSelectedId] = useState(state.conversations[0]?.id ?? '')
  const [message, setMessage] = useState('')
  const [showInfo, setShowInfo] = useState(() => window.innerWidth > 1180)
  const [newChatOpen, setNewChatOpen] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [conversationSearch, setConversationSearch] = useState('')
  const [muted, setMuted] = useState<Set<string>>(() => new Set())
  const handledConversationRequest = useRef<string | undefined>(undefined)
  const conversations = useMemo(() => state.conversations.filter((conversation) => !query || `${conversation.name} ${conversation.messages.map((item) => item.text).join(' ')}`.toLowerCase().includes(query.toLowerCase())), [query, state.conversations])
  const selected = conversations.find((conversation) => conversation.id === selectedId)
  const visibleMessages = selected?.messages.filter((item) => !conversationSearch || `${item.text} ${item.attachment?.name ?? ''}`.toLowerCase().includes(conversationSearch.toLowerCase())) ?? []

  useEffect(() => {
    if (requestedConversationId && handledConversationRequest.current !== requestedConversationId && state.conversations.some((conversation) => conversation.id === requestedConversationId)) {
      handledConversationRequest.current = requestedConversationId
      setSelectedId(requestedConversationId)
    }
  }, [requestedConversationId, state.conversations])

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
    try {
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
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Attachment could not be added')
    }
  }

  const startChat = (contact: Contact) => {
    const existing = state.conversations.find((conversation) => conversation.name === contact.name)
    if (existing) setSelectedId(existing.id)
    else {
      const conversation: Conversation = { id: uid('conversation'), name: contact.name, participants: [contact.name], color: contact.color, online: false, unread: 0, messages: [] }
      onChange({ ...state, conversations: [conversation, ...state.conversations] })
      setSelectedId(conversation.id)
    }
    setNewChatOpen(false)
  }

  const toggleMute = (conversation: Conversation) => {
    const wasMuted = muted.has(conversation.id)
    setMuted((current) => {
      const next = new Set(current)
      if (next.has(conversation.id)) next.delete(conversation.id)
      else next.add(conversation.id)
      return next
    })
    onToast(wasMuted ? 'Conversation unmuted' : 'Conversation muted')
  }

  const deleteConversation = (conversation: Conversation) => {
    if (!window.confirm(`Delete the local conversation with ${conversation.name}?`)) return
    onChange({ ...state, conversations: state.conversations.filter((item) => item.id !== conversation.id) })
    if (selectedId === conversation.id) setSelectedId('')
    onToast('Conversation deleted')
  }

  const conversationMenu = (conversation: Conversation): ContextMenuItem[] => [
    { label: 'Open conversation', icon: MessageCircle, action: () => select(conversation) },
    { label: conversation.unread ? 'Mark as read' : 'Mark as unread', icon: MessageCircle, separatorBefore: true, action: () => onChange({
      ...state,
      conversations: state.conversations.map((item) => item.id === conversation.id ? { ...item, unread: conversation.unread ? 0 : 1 } : item)
    }) },
    { label: muted.has(conversation.id) ? 'Unmute conversation' : 'Mute conversation', icon: BellOff, checked: muted.has(conversation.id), action: () => toggleMute(conversation) },
    { label: 'Search conversation', icon: Search, action: () => { select(conversation); setSearchOpen(true); setShowInfo(false) } },
    { label: 'Copy contact name', icon: Copy, separatorBefore: true, action: () => copyText(conversation.name) },
    { label: 'Delete conversation', icon: Trash2, separatorBefore: true, danger: true, action: () => deleteConversation(conversation) }
  ]

  const changeMessage = (conversation: Conversation, message: ChatMessage, updates: Partial<ChatMessage>) => onChange({
    ...state,
    conversations: state.conversations.map((item) => item.id === conversation.id ? {
      ...item,
      messages: item.messages.map((entry) => entry.id === message.id ? { ...entry, ...updates } : entry)
    } : item)
  })

  const messageMenu = (conversation: Conversation, chatMessage: ChatMessage): ContextMenuItem[] => [
    { label: 'Copy message', icon: Copy, action: () => copyText(chatMessage.text) },
    ...(chatMessage.attachment ? [{ label: 'Copy attachment filename', icon: File, action: () => copyText(chatMessage.attachment!.name) }] satisfies ContextMenuItem[] : []),
    ...['👍', '❤️', '😂', '🎉'].map((reaction, index) => ({
      label: `${reaction} React`, separatorBefore: index === 0, checked: chatMessage.reaction === reaction,
      action: () => changeMessage(conversation, chatMessage, { reaction: chatMessage.reaction === reaction ? undefined : reaction })
    })),
    ...(chatMessage.sender === 'me' ? [{
      label: 'Delete message', icon: Trash2, separatorBefore: true, danger: true,
      action: () => {
        onChange({ ...state, conversations: state.conversations.map((item) => item.id === conversation.id ? { ...item, messages: item.messages.filter((entry) => entry.id !== chatMessage.id) } : item) })
        onToast('Message deleted')
      }
    }] satisfies ContextMenuItem[] : [])
  ]

  const showMessageMenu = (event: React.MouseEvent, conversation: Conversation, chatMessage: ChatMessage) => {
    if (window.getSelection()?.toString()) return
    showContextMenu(event, messageMenu(conversation, chatMessage), 'Chat message')
  }

  return (
    <div className="workspace chat-workspace">
      <aside className="context-sidebar chat-sidebar">
        <button className="compose-button" onClick={() => setNewChatOpen(true)}><Plus size={18} /> New conversation</button>
        <div className="sidebar-group" onContextMenu={(event) => showContextMenu(event, [
          { label: 'New conversation', icon: Plus, action: () => setNewChatOpen(true) },
          { label: 'Mark all conversations as read', icon: MessageCircle, disabled: !state.conversations.some((conversation) => conversation.unread), action: () => onChange({ ...state, conversations: state.conversations.map((conversation) => ({ ...conversation, unread: 0 })) }) }
        ], 'Conversations')}>
          <span className="sidebar-label">Conversations</span>
          {conversations.map((conversation) => {
            const last = conversation.messages.at(-1)
            return (
              <button key={conversation.id} className={`chat-list-item ${selected?.id === conversation.id ? 'active' : ''}`} onClick={() => select(conversation)} onContextMenu={(event) => showContextMenu(event, conversationMenu(conversation), conversation.name)}>
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
            <header className="chat-header" onContextMenu={(event) => showContextMenu(event, conversationMenu(selected), selected.name)}>
              <span className="avatar large" style={{ background: selected.color }}>{selected.name.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span>
              <span><strong>{selected.name}</strong><small>{selected.online ? 'Online now' : 'Last seen recently'}</small></span>
              <span className="spacer" />
              <button className="icon-button" title="Audio call" onClick={() => onToast('Calling is not connected in demo mode')}><Phone size={18} /></button>
              <button className="icon-button" title="Video call" onClick={() => onToast('Video is not connected in demo mode')}><Video size={18} /></button>
              <button className={`icon-button ${showInfo ? 'active' : ''}`} title="Conversation details" onClick={() => setShowInfo((value) => !value)}><Info size={18} /></button>
            </header>
            {searchOpen && <div className="chat-search-row"><Search size={15} /><input autoFocus value={conversationSearch} onChange={(event) => setConversationSearch(event.target.value)} placeholder={`Search ${selected.name}`} /><button className="text-button" onClick={() => { setConversationSearch(''); setSearchOpen(false) }}>Done</button></div>}
            <div className="chat-messages">
              <div className="conversation-intro">
                <span className="avatar hero-avatar" style={{ background: selected.color }}>{selected.name.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span>
                <h2>{selected.name}</h2>
                <p>This is the beginning of your Aerio conversation.</p>
              </div>
              {visibleMessages.map((item) => (
                <div className={`chat-bubble-row ${item.sender === 'me' ? 'mine' : ''}`} key={item.id} onContextMenu={(event) => showMessageMenu(event, selected, item)}>
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
              <button className="icon-button" aria-label="Attach file" title="Attach file" onClick={() => void attach()}><Paperclip size={19} /></button>
              <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder={`Message ${selected.name}`} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) send() }} />
              <span className="emoji-control"><button className={`icon-button ${emojiOpen ? 'active' : ''}`} aria-label="Choose emoji" onClick={() => setEmojiOpen((value) => !value)}><Smile size={19} /></button>{emojiOpen && <span className="emoji-picker">{['👍', '❤️', '😊', '🎉', '😂', '🙏'].map((emoji) => <button key={emoji} onClick={() => { setMessage((value) => `${value}${emoji}`); setEmojiOpen(false) }}>{emoji}</button>)}</span>}</span>
              <button className="send-circle" aria-label="Send message" title="Send message" onClick={send}><Send size={17} /></button>
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
            <button className={searchOpen ? 'active' : ''} onClick={() => { setSearchOpen((value) => !value); setShowInfo(false) }}><span><Search size={18} /></span>Search</button>
            <button className={muted.has(selected.id) ? 'active' : ''} onClick={() => toggleMute(selected)}><span><BellOff size={18} /></span>{muted.has(selected.id) ? 'Unmute' : 'Mute'}</button>
          </div>
          <section><h3><Users size={16} /> People</h3>{selected.participants.map((person) => <div className="info-person" key={person} onContextMenu={(event) => showContextMenu(event, [{ label: 'Copy participant name', icon: Copy, action: () => copyText(person) }], person)}><span className="avatar small-avatar" style={{ background: selected.color }}>{person[0]}</span><strong>{person}</strong></div>)}</section>
          <section><h3><File size={16} /> Shared files</h3>{selected.messages.flatMap((item) => item.attachment ? [item.attachment] : []).map((attachment) => <p className="muted-copy" key={attachment.id} onContextMenu={(event) => showContextMenu(event, [{ label: 'Copy filename', icon: Copy, action: () => copyText(attachment.name) }], attachment.name)}>{attachment.name}</p>)}{!selected.messages.some((item) => item.attachment) && <p className="muted-copy">No files shared yet.</p>}</section>
        </aside>
      )}
      {newChatOpen && <Modal title="New conversation" subtitle="Choose one of your saved contacts." onClose={() => setNewChatOpen(false)}><div className="contact-picker">{state.contacts.map((contact) => <button key={contact.id} onClick={() => startChat(contact)}><span className="avatar" style={{ background: contact.color }}>{contact.name.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span><span><strong>{contact.name}</strong><small>{contact.email}</small></span></button>)}</div></Modal>}
    </div>
  )
}
