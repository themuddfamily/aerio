import { CalendarDays, CheckCircle2, Keyboard, Mail, NotebookPen, Search, ShieldCheck, Sparkles } from 'lucide-react'
import Modal from './Modal'

interface AppInfoModalProps {
  kind: 'help' | 'whats-new'
  onClose(): void
}

const shortcuts = [
  ['Ctrl K', 'Search the current module or run a command'],
  ['Ctrl N', 'Compose a new message'],
  ['Ctrl 1–5', 'Open Mail, Calendar, Contacts, Tasks, or Notes'],
  ['Esc', 'Close the active panel or dialog']
]

export default function AppInfoModal({ kind, onClose }: AppInfoModalProps) {
  if (kind === 'whats-new') {
    return (
      <Modal title="What’s new in Aerio" subtitle="The latest Windows preview" onClose={onClose}>
        <div className="app-info-content">
          <div className="app-info-hero"><Sparkles size={24} /><div><strong>A calmer, clearer inbox</strong><p>This build focuses on mail navigation and everyday reliability.</p></div></div>
          <ul className="app-info-list">
            <li><Mail size={18} /><span><strong>Unread counts everywhere</strong><small>Folder and account badges update with your mailbox.</small></span></li>
            <li><Search size={18} /><span><strong>Working module search</strong><small>Use Ctrl K to carry a query into the current module.</small></span></li>
            <li><CheckCircle2 size={18} /><span><strong>Real recurring tasks</strong><small>Completing a repeating task now schedules its next occurrence.</small></span></li>
            <li><CalendarDays size={18} /><span><strong>Better event editing</strong><small>Choose an event reminder instead of relying on a fixed default.</small></span></li>
          </ul>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Aerio help" subtitle="Shortcuts and useful starting points" onClose={onClose}>
      <div className="app-info-content">
        <div className="app-info-hero"><Keyboard size={24} /><div><strong>Move quickly without losing focus</strong><p>Search, navigation, and composition are available from the keyboard.</p></div></div>
        <dl className="shortcut-list">
          {shortcuts.map(([keys, description]) => <div key={keys}><dt><kbd>{keys}</kbd></dt><dd>{description}</dd></div>)}
        </dl>
        <ul className="app-info-list compact">
          <li><ShieldCheck size={18} /><span><strong>Your local work is stored on this PC</strong><small>Use Settings to export a backup of Tasks, Notes, and local Contacts.</small></span></li>
          <li><NotebookPen size={18} /><span><strong>Mail is provider-backed; Tasks and Notes are local</strong><small>Calendar and Contacts show their latest synchronization time in their module.</small></span></li>
        </ul>
      </div>
    </Modal>
  )
}
