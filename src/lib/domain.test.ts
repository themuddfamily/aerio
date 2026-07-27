import { describe, expect, it } from 'vitest'
import { createDemoState } from '../demo-data'
import { formatFileSize, messageMatches, unreadCount, updateMessage } from './domain'

describe('Aerio domain helpers', () => {
  it('searches across sender, subject, body and labels', () => {
    const message = createDemoState().messages[0]
    expect(messageMatches(message, 'maya')).toBe(true)
    expect(messageMatches(message, 'typography')).toBe(true)
    expect(messageMatches(message, 'Design')).toBe(true)
    expect(messageMatches(message, 'not present')).toBe(false)
  })

  it('updates one message without mutating the original state', () => {
    const state = createDemoState()
    const next = updateMessage(state, state.messages[0].id, { unread: false })
    expect(next).not.toBe(state)
    expect(next.messages[0].unread).toBe(false)
    expect(state.messages[0].unread).toBe(true)
  })

  it('computes module badges', () => {
    const state = createDemoState()
    expect(unreadCount(state, 'mail')).toBe(2)
    expect(unreadCount(state, 'chat')).toBe(3)
  })

  it('formats file sizes', () => {
    expect(formatFileSize(4_823_000)).toBe('4.6 MB')
    expect(formatFileSize(0)).toBe('Local file')
  })
})
