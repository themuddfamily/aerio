// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { MailMessageDetail } from '../mail-types'
import ThreadMessageAccordion from './ThreadMessageAccordion'
import TrackingProtectionNotice from './TrackingProtectionNotice'

const report = {
  remoteImages: 4,
  trackers: [
    { host: 'u1.ct.sendgrid.net', reasons: ['known-tracker-host' as const, 'tracking-path' as const], count: 2 },
    { host: 'cdn.example', reasons: ['hidden-style' as const], count: 1 }
  ]
}

describe('TrackingProtectionNotice', () => {
  it('renders nothing without suspected trackers', () => {
    const { container } = render(<><TrackingProtectionNotice remoteImagesPermitted={false} /><TrackingProtectionNotice report={{ remoteImages: 2, trackers: [] }} remoteImagesPermitted /></>)
    expect(container).toBeEmptyDOMElement()
  })

  it('explains which trackers stay blocked before and after remote images are permitted', () => {
    const { rerender } = render(<TrackingProtectionNotice report={report} remoteImagesPermitted={false} />)
    expect(screen.getByText('3 suspected tracking images will stay blocked even if you load remote images.')).toBeInTheDocument()
    expect(screen.getByText('u1.ct.sendgrid.net').closest('li')).toHaveTextContent('u1.ct.sendgrid.net (2 images): blocked because it is served by a known email tracking service and its address looks like an open-tracking link.')
    expect(screen.getByText('cdn.example').closest('li')).toHaveTextContent('cdn.example: blocked because it is styled to be hidden.')
    rerender(<TrackingProtectionNotice report={{ remoteImages: 2, trackers: [{ ...report.trackers[1] }] }} remoteImagesPermitted />)
    expect(screen.getByText('1 suspected tracking image stayed blocked while other remote images loaded.')).toBeInTheDocument()
  })

  it('appears in expanded thread messages and follows the remote image choice', () => {
    const message: MailMessageDetail = {
      accountId: 'account-1', id: 'message-1', threadId: 'thread-1', fromName: 'News', fromEmail: 'news@example.com',
      to: [], cc: [], subject: 'Weekly', date: '2026-08-08T10:15:30Z', text: 'Hello', html: '', sanitizedHtml: '',
      remoteContent: report, labelIds: [], attachments: []
    }
    const { rerender } = render(<ThreadMessageAccordion message={message} expanded onToggle={() => undefined} onLoadRemoteImages={() => undefined} />)
    expect(screen.getByText(/will stay blocked even if you load remote images/)).toBeInTheDocument()
    rerender(<ThreadMessageAccordion message={message} expanded onToggle={() => undefined} />)
    expect(screen.getByText(/stayed blocked while other remote images loaded/)).toBeInTheDocument()
    rerender(<ThreadMessageAccordion message={message} expanded={false} onToggle={() => undefined} />)
    expect(screen.queryByText(/suspected tracking images/)).not.toBeInTheDocument()
  })
})
