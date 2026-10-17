// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { MailAccountSummary } from '../mail-types'
import type { MailSenderIdentity, MailSignature } from '../mail-identity-types'
import {
  defaultIdentityId, findSignatureBlock, identityLabel, replaceSignatureBlock, replyIdentityId, signatureBlockHtml, signatureBlockUnchanged, signatureForIdentity
} from './mail-signature'

const account: MailAccountSummary = {
  id: 'a', provider: 'imap', email: 'me@example.com', displayName: 'Me', color: '#123456', status: 'ready', archived: false,
  signature: 'Legacy <me>', notifications: true, syncEnabled: true
}
const identity = (overrides: Partial<MailSenderIdentity> = {}): MailSenderIdentity => ({
  id: 'a:primary', accountId: 'a', email: 'me@example.com', name: 'Me', replyTo: [], source: 'primary', status: 'verified', isDefault: true,
  createdAt: '', updatedAt: '', ...overrides
})
const signature = (id: string, html: string): MailSignature => ({ id, name: id, html, text: html, createdAt: '', updatedAt: '' })
const editor = (html: string) => {
  const element = document.createElement('div')
  element.innerHTML = html
  return element
}

describe('composer signature blocks', () => {
  it('chooses new-message and reply signatures with a primary-only legacy fallback', () => {
    const signatures = [signature('work', '<b>Work</b>'), signature('empty', ' ')]
    const primary = identity({ newSignatureId: 'work' })
    expect(signatureForIdentity(primary, account, signatures, 'new')).toEqual({ id: 'work', html: '<b>Work</b>' })
    expect(signatureForIdentity(primary, account, signatures, 'reply')).toEqual({ id: 'account', html: 'Legacy &lt;me&gt;' })
    expect(signatureForIdentity(identity({ replySignatureId: 'empty' }), account, signatures, 'reply')).toBeUndefined()
    expect(signatureForIdentity(identity({ replySignatureId: 'deleted' }), account, signatures, 'reply')).toBeUndefined()
    expect(signatureForIdentity(identity({ source: 'manual', id: 'alias' }), account, signatures, 'new')).toBeUndefined()
    expect(signatureForIdentity(undefined, { ...account, signature: ' ' }, [], 'new')).toBeUndefined()
    expect(signatureForIdentity(undefined, undefined, [], 'new')).toBeUndefined()
  })

  it('swaps only the marked block, leaving the body and quoted content intact', () => {
    const element = editor(`<div>Hello</div><div data-aerio-signature-spacer=""><br></div>${signatureBlockHtml({ id: 'one', html: 'One' })}<div data-aerio-quote="forward">Quoted -- text</div>`)
    expect(signatureBlockUnchanged(element, { id: 'one', html: 'One' })).toBe(true)
    expect(replaceSignatureBlock(element, { id: 'two', html: '<i>Two</i>' })).toBe(true)
    expect(element.innerHTML).toBe('<div>Hello</div><div data-aerio-signature-spacer=""><br></div><div data-aerio-signature="two">-- <br><i>Two</i></div><div data-aerio-quote="forward">Quoted -- text</div>')
    expect(replaceSignatureBlock(element, { id: 'two', html: '<i>Two</i>' })).toBe(false)
    expect(element.querySelectorAll('[data-aerio-signature]')).toHaveLength(1)
    expect(signatureBlockUnchanged(element, { id: 'one', html: 'One' })).toBe(false)
    expect(replaceSignatureBlock(element, undefined)).toBe(true)
    expect(element.innerHTML).toBe('<div>Hello</div><div data-aerio-quote="forward">Quoted -- text</div>')
    expect(replaceSignatureBlock(element, undefined)).toBe(false)
    expect(signatureBlockUnchanged(element, undefined)).toBe(true)
    expect(signatureBlockUnchanged(element, { id: 'one', html: 'One' })).toBe(false)
    // Without a block, a new signature goes above the quote, or at the end.
    expect(replaceSignatureBlock(element, { id: 'three', html: 'Three' })).toBe(true)
    expect(element.innerHTML).toBe('<div>Hello</div><div data-aerio-signature-spacer=""><br></div><div data-aerio-signature="three">-- <br>Three</div><div data-aerio-quote="forward">Quoted -- text</div>')
    const plain = editor('<div>Body</div>')
    replaceSignatureBlock(plain, { id: 'x"y', html: 'Sig' })
    expect(findSignatureBlock(plain)?.getAttribute('data-aerio-signature')).toBe('x"y')
    expect(plain.lastElementChild?.textContent).toBe('-- Sig')
  })

  it('chooses default and reply identities and labels them', () => {
    const alias = identity({ id: 'alias', email: 'Sales@example.com', source: 'manual', isDefault: false, status: 'pending', name: '' })
    expect(defaultIdentityId([], 'a')).toBe('a:primary')
    expect(defaultIdentityId([identity({ isDefault: false }), { ...alias, isDefault: true }], 'a')).toBe('alias')
    expect(replyIdentityId([identity(), alias], 'a', ['Team <sales@EXAMPLE.com>'])).toBe('alias')
    expect(replyIdentityId([identity(), alias], 'a', ['other@example.com'])).toBe('a:primary')
    expect(identityLabel(alias)).toBe('Sales@example.com (verification pending)')
    expect(identityLabel(identity())).toBe('Me · me@example.com')
  })
})
