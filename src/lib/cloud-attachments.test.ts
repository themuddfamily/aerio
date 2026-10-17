// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { createMimeBuffer } from '../../electron/mail/mime-builder'
import { attachmentBytes, cloudAudienceLabel, cloudCapabilityRows, cloudLinkHtml, cloudLinkUrls, cloudProviderName, shareScopeLabel } from './cloud-attachments'

describe('connected storage labels', () => {
  it('names Dropbox, ownCloud and Nextcloud and describes passwords, expiry and team audiences', () => {
    expect(shareScopeLabel('nextcloud', { audience: 'anyone', role: 'view', password: 'x', expiresOn: '2026-11-01' })).toBe('Anyone with the link can view, with a password until 2026-11-01')
    expect(shareScopeLabel('dropbox', { audience: 'organization', role: 'view' })).toBe('People in your Dropbox team with the link can view')
    expect(shareScopeLabel('dropbox', { audience: 'members', role: 'view' })).toBe('Only people who already have access in Dropbox can view')
    expect(cloudAudienceLabel('dropbox', 'organization')).toBe('People in your Dropbox team')
    expect(cloudAudienceLabel('onedrive', 'organization')).toBe('People in my organization')
    expect(cloudProviderName('owncloud')).toBe('ownCloud')
    expect(cloudCapabilityRows({ audiences: ['anyone'], password: 'enforced', expiry: 'enforced', maxExpiryDays: 7, edit: 'available', resumableUpload: false, notes: [] }).map((row) => row.value))
      .toEqual(['Required', 'Required (at most 7 days)', 'Allowed', 'Single request'])
  })
})

const link = {
  provider: 'onedrive' as const, accountId: 'a', fileId: 'f', name: 'Q3 <draft>.xlsx', size: 2048, url: 'https://1drv.example.test/s!a?x=1&y="2"',
  share: { audience: 'organization' as const, role: 'view' as const }, scopeLabel: 'People in your organization with the link can view'
}

describe('cloud link helpers', () => {
  it('describes each sharing scope in plain language', () => {
    expect(shareScopeLabel('google-drive', { audience: 'anyone', role: 'edit' })).toBe('Anyone with the link can edit')
    expect(shareScopeLabel('onedrive', { audience: 'recipients', role: 'view', recipients: ['ada@example.test'] })).toBe('Only ada@example.test can view after signing in to a Microsoft account')
  })

  it('builds escaped link HTML whose URLs can be found again', () => {
    const container = document.createElement('div')
    container.innerHTML = `${cloudLinkHtml(link)}<a href="https://example.test/other">other</a>`
    const anchor = container.querySelector('a')!
    expect(anchor.textContent).toBe('Q3 <draft>.xlsx')
    expect(container.textContent).toContain('(OneDrive, 2 KB · People in your organization with the link can view)')
    expect(cloudLinkUrls(container)).toEqual([link.url])
    expect(cloudLinkUrls(null)).toEqual([])
    expect(attachmentBytes([{ size: 5 }, { size: 0 }, { size: 7 }])).toBe(12)
  })

  it('survives the outgoing sanitizer as a plain link with its marker removed', () => {
    const mime = createMimeBuffer({ id: 'd', accountId: 'a', to: ['b@example.test'], cc: [], bcc: [], subject: 'S', text: 'x', html: cloudLinkHtml(link), attachmentPaths: [] }).toString()
    expect(mime).toMatch(/<a href="https:\/\/1drv\.example\.test\/s!a\?x=1&amp;y=[^"]*"[^>]*>Q3 &lt;draft&gt;\.xlsx<\/a>/)
    expect(mime).not.toContain('data-aerio-cloud-link')
  })
})
