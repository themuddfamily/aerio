import { useState } from 'react'
import { senderFaviconUrl } from '../lib/sender-avatar'

interface SenderAvatarProps {
  email: string
  name?: string
  large?: boolean
  fallbackColor?: string
}

const colors = ['#dceae5', '#e0e7f8', '#ebe1f3', '#f3e3dc', '#f1dfe7', '#e1e8ec']

const initials = (value: string) => value.trim().split(/\s+/).filter(Boolean)
  .map((part) => part[0]).slice(0, 2).join('').toUpperCase() || '?'

const colorFor = (value: string) => {
  let hash = 0
  for (const character of value) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0
  return colors[hash % colors.length]
}

export default function SenderAvatar({ email, name, large = false, fallbackColor }: SenderAvatarProps) {
  const source = senderFaviconUrl(email)
  const [failedSource, setFailedSource] = useState<string>()
  const label = name || email

  return (
    <span
      className={`avatar sender-domain-avatar ${large ? 'large' : ''}`.trim()}
      style={{ background: fallbackColor || colorFor(email || label) }}
      aria-hidden="true"
    >
      {initials(label)}
      {source && failedSource !== source && <img src={source} alt="" onError={() => setFailedSource(source)} />}
    </span>
  )
}
