import type { MailAccountSummary } from '../mail-types'
import { primaryIdentityId, type MailSenderIdentity, type MailSignature } from '../mail-identity-types'

/** The composer marks the inserted signature so it can be swapped without touching the message or quoted text. */
export const SIGNATURE_ATTRIBUTE = 'data-aerio-signature'
/** Quoted or forwarded content; a newly inserted signature goes above it. */
export const QUOTE_ATTRIBUTE = 'data-aerio-quote'
export const LEGACY_SIGNATURE_ID = 'account'

export interface ComposerSignature {
  id: string
  /** Trusted HTML: sanitized by the main process or escaped plain text. */
  html: string
}

const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\n', '<br>')
const addressEmail = (value: string) => value.trim().match(/<([^<>]+)>$/)?.[1].trim().toLowerCase() ?? value.trim().toLowerCase()

/** The signature block markup, separated from the body by the conventional `-- ` line. */
export function signatureBlockHtml(signature: ComposerSignature) {
  return `<div ${SIGNATURE_ATTRIBUTE}="${escapeHtml(signature.id)}">-- <br>${signature.html}</div>`
}

/**
 * Picks the signature for an identity: the reply/forward or new-message
 * assignment, falling back to the legacy plain-text account signature only for
 * the primary address.
 */
export function signatureForIdentity(
  identity: MailSenderIdentity | undefined,
  account: MailAccountSummary | undefined,
  signatures: MailSignature[],
  context: 'new' | 'reply'
): ComposerSignature | undefined {
  const assigned = context === 'reply' ? identity?.replySignatureId : identity?.newSignatureId
  const signature = assigned ? signatures.find((item) => item.id === assigned) : undefined
  if (signature) return signature.html.trim() ? { id: signature.id, html: signature.html } : undefined
  if (assigned && signatures.length) return undefined
  const isPrimary = !identity || identity.source === 'primary'
  const legacy = account?.signature.trim()
  return isPrimary && legacy ? { id: LEGACY_SIGNATURE_ID, html: escapeHtml(legacy) } : undefined
}

export function findSignatureBlock(editor: HTMLElement) {
  return editor.querySelector<HTMLElement>(`[${SIGNATURE_ATTRIBUTE}]`) ?? undefined
}

/**
 * Replaces only the marked signature block (or removes it when `signature` is
 * undefined). Without a block, the signature is inserted above quoted content,
 * or at the end of the message. Returns whether the editor changed.
 */
export function replaceSignatureBlock(editor: HTMLElement, signature: ComposerSignature | undefined) {
  const current = findSignatureBlock(editor)
  if (!signature) {
    if (!current) return false
    // Also drop the blank spacer line Aerio inserted directly above the signature.
    const spacer = current.previousElementSibling
    if (spacer?.hasAttribute('data-aerio-signature-spacer')) spacer.remove()
    current.remove()
    return true
  }
  const template = editor.ownerDocument.createElement('template')
  template.innerHTML = signatureBlockHtml(signature)
  const block = template.content.firstElementChild!
  if (current) {
    if (current.outerHTML === block.outerHTML) return false
    current.replaceWith(block)
    return true
  }
  const spacer = editor.ownerDocument.createElement('div')
  spacer.setAttribute('data-aerio-signature-spacer', '')
  spacer.innerHTML = '<br>'
  const quote = editor.querySelector(`[${QUOTE_ATTRIBUTE}]`)
  if (quote && quote.parentNode) {
    quote.parentNode.insertBefore(spacer, quote)
    quote.parentNode.insertBefore(block, quote)
  } else editor.append(spacer, block)
  return true
}

/** True while the signature block still matches what Aerio inserted, i.e. the user has not edited it. */
export function signatureBlockUnchanged(editor: HTMLElement, inserted: ComposerSignature | undefined) {
  const current = findSignatureBlock(editor)
  if (!inserted) return !current
  if (!current) return false
  const template = editor.ownerDocument.createElement('template')
  template.innerHTML = signatureBlockHtml(inserted)
  return current.outerHTML === template.content.firstElementChild!.outerHTML
}

/** The account's default identity, or a synthetic primary identity before identities load. */
export function defaultIdentityId(identities: MailSenderIdentity[], accountId: string) {
  return identities.find((identity) => identity.accountId === accountId && identity.isDefault)?.id ?? primaryIdentityId(accountId)
}

/**
 * Replies answer from the alias the original message was sent to, otherwise
 * from the account's default identity.
 */
export function replyIdentityId(identities: MailSenderIdentity[], accountId: string, receivedAt: string[]) {
  const addresses = new Set(receivedAt.map(addressEmail))
  const own = identities.filter((identity) => identity.accountId === accountId)
  return own.find((identity) => addresses.has(identity.email.toLowerCase()))?.id ?? defaultIdentityId(identities, accountId)
}

export function identityLabel(identity: Pick<MailSenderIdentity, 'name' | 'email' | 'status'>) {
  const suffix = identity.status === 'pending' ? ' (verification pending)' : ''
  return `${identity.name ? `${identity.name} · ` : ''}${identity.email}${suffix}`
}
