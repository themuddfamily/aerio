import type { CloudShareAudience, CloudShareOptions, CloudSharedLink, CloudStorageProvider } from '../cloud-attachment-types'
import { formatFileSize } from './domain'

/** Marks links Aerio inserted so they can be re-checked before sending; stripped by the outgoing sanitizer. */
export const CLOUD_LINK_ATTRIBUTE = 'data-aerio-cloud-link'

export const cloudProviderName = (provider: CloudStorageProvider) => provider === 'google-drive' ? 'Google Drive' : 'OneDrive'

export const CLOUD_AUDIENCE_LABELS: Record<CloudShareAudience, string> = {
  anyone: 'Anyone with the link',
  organization: 'People in my organization',
  recipients: 'Only the message recipients'
}

export function shareScopeLabel(provider: CloudStorageProvider, share: CloudShareOptions) {
  const verb = share.role === 'edit' ? 'can edit' : 'can view'
  if (share.audience === 'anyone') return `Anyone with the link ${verb}`
  if (share.audience === 'organization') return `People in your organization with the link ${verb}`
  const people = share.recipients ?? []
  const who = people.length === 1 ? people[0] : `${people.length} recipients`
  return `Only ${who} ${verb} after signing in to ${provider === 'google-drive' ? 'a Google account' : 'a Microsoft account'}`
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)

/**
 * A plain `<a href>` plus text, which the outgoing sanitizer already allows;
 * the composer styles it as a chip through the marker attribute.
 */
export function cloudLinkHtml(link: CloudSharedLink) {
  const detail = `${cloudProviderName(link.provider)}${link.size ? `, ${formatFileSize(link.size)}` : ''} · ${link.scopeLabel}`
  return `<div><a href="${escapeHtml(link.url)}" title="${escapeHtml(detail)}" ${CLOUD_LINK_ATTRIBUTE}="${link.provider}">${escapeHtml(link.name)}</a> (${escapeHtml(detail)})</div>`
}

/** URLs of the cloud links Aerio inserted into this editor. */
export function cloudLinkUrls(root: ParentNode | null | undefined) {
  if (!root) return []
  return Array.from(new Set(Array.from(root.querySelectorAll<HTMLAnchorElement>(`a[${CLOUD_LINK_ATTRIBUTE}]`)).map((anchor) => anchor.getAttribute('href') ?? '').filter(Boolean)))
}

/** Total of known attachment sizes (drafts reopened from disk report 0). */
export const attachmentBytes = (items: Array<{ size: number }>) => items.reduce((total, item) => total + Math.max(0, item.size || 0), 0)
