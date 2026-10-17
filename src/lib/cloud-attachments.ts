import type { CloudCapabilityState, CloudShareAudience, CloudShareOptions, CloudSharedLink, CloudStorageCapabilities, CloudStorageProvider } from '../cloud-attachment-types'
import { formatFileSize } from './domain'

/** Marks links Aerio inserted so they can be re-checked before sending; stripped by the outgoing sanitizer. */
export const CLOUD_LINK_ATTRIBUTE = 'data-aerio-cloud-link'

const PROVIDER_NAMES: Record<CloudStorageProvider, string> = {
  'google-drive': 'Google Drive',
  onedrive: 'OneDrive',
  dropbox: 'Dropbox',
  owncloud: 'ownCloud',
  nextcloud: 'Nextcloud'
}

export const cloudProviderName = (provider: CloudStorageProvider) => PROVIDER_NAMES[provider] ?? 'cloud storage'

export const CLOUD_AUDIENCE_LABELS: Record<CloudShareAudience, string> = {
  anyone: 'Anyone with the link',
  organization: 'People in my organization',
  recipients: 'Only the message recipients',
  members: 'Only people who already have access'
}

const ORGANIZATION_LABEL: Partial<Record<CloudStorageProvider, string>> = { dropbox: 'People in your Dropbox team' }

/** Audience label for one provider (Dropbox calls its organization a team). */
export const cloudAudienceLabel = (provider: CloudStorageProvider, audience: CloudShareAudience) =>
  audience === 'organization' && ORGANIZATION_LABEL[provider] ? ORGANIZATION_LABEL[provider]! : CLOUD_AUDIENCE_LABELS[audience]

const linkExtras = (share: CloudShareOptions) => `${share.password ? ', with a password' : ''}${share.expiresOn ? ` until ${share.expiresOn}` : ''}`

export function shareScopeLabel(provider: CloudStorageProvider, share: CloudShareOptions) {
  const verb = share.role === 'edit' ? 'can edit' : 'can view'
  if (share.audience === 'anyone') return `Anyone with the link ${verb}${linkExtras(share)}`
  if (share.audience === 'organization') return `People in your ${provider === 'dropbox' ? 'Dropbox team' : 'organization'} with the link ${verb}${linkExtras(share)}`
  if (share.audience === 'members') return `Only people who already have access in ${cloudProviderName(provider)} ${verb}${linkExtras(share)}`
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

const CAPABILITY_TEXT: Record<CloudCapabilityState, string> = { enforced: 'Required', available: 'Optional', unavailable: 'Not available' }

/** The rows of a storage account's capability summary, in the order the UI shows them. */
export function cloudCapabilityRows(capabilities: CloudStorageCapabilities) {
  const expiry = capabilities.expiry === 'enforced' && capabilities.maxExpiryDays ? `Required (at most ${capabilities.maxExpiryDays} days)` : CAPABILITY_TEXT[capabilities.expiry]
  return [
    { label: 'Link password', value: CAPABILITY_TEXT[capabilities.password], state: capabilities.password },
    { label: 'Expiry date', value: expiry, state: capabilities.expiry },
    { label: 'Editing', value: capabilities.edit === 'unavailable' ? 'View only' : 'Allowed', state: capabilities.edit },
    { label: 'Large uploads', value: capabilities.resumableUpload ? 'Chunked, resumable' : 'Single request', state: (capabilities.resumableUpload ? 'available' : 'unavailable') as CloudCapabilityState }
  ]
}

/** Total of known attachment sizes (drafts reopened from disk report 0). */
export const attachmentBytes = (items: Array<{ size: number }>) => items.reduce((total, item) => total + Math.max(0, item.size || 0), 0)
