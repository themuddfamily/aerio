import { useState } from 'react'
import { Bot } from 'lucide-react'
import type { MailAccountSummary } from '../mail-types'
import { aiFeatureAvailable, useAiAssistantStatus } from '../lib/use-ai-assistant'
import AiConversationDialog from './AiConversationDialog'
export default function AiAssistantLauncher({ accounts }: { accounts: MailAccountSummary[] }) {
  const status = useAiAssistantStatus()
  const [open, setOpen] = useState(false)
  if (!status || !aiFeatureAvailable(status, 'conversation') || !window.aerio?.ai?.conversation) return null
  return <><button aria-label="AI assistant" title="AI assistant" onClick={() => setOpen(true)}><Bot size={20} /></button>{open && <AiConversationDialog accounts={accounts} status={status} onClose={() => setOpen(false)} />}</>
}
