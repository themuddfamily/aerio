import { describe, expect, it } from 'vitest'
import {
  clampMailMergeLimits,
  mailMergeDuration,
  mailMergeProviderLimits,
  mergePlaceholders,
  mergeRecipientAddress,
  mergeRecipientsFromContacts,
  mergeVariables,
  normalizeMergeRecipients,
  parseMergeRecipientList,
  renderMergeMessage,
  renderMergeTemplate
} from './mail-merge'

describe('mail merge variables', () => {
  const ada = { email: 'ada@example.com', name: 'Ada King Lovelace', company: 'Analytical', fields: { 'Favourite Number': '42', Team: 'R&D' } }

  it('exposes built-in and custom variables with case- and punctuation-insensitive names', () => {
    const variables = mergeVariables(ada)
    expect(variables.get('firstname')).toBe('Ada')
    expect(variables.get('lastname')).toBe('King Lovelace')
    expect(renderMergeTemplate('{{firstName}} {{ FIRST_NAME }} {{favourite-number}} {{email}} {{company}}', variables, 'text').value)
      .toBe('Ada Ada 42 ada@example.com Analytical')
    expect(mergeVariables({ email: 'x@example.com', firstName: 'Grace', lastName: 'Hopper' }).get('name')).toBe('Grace Hopper')
  })

  it('uses fallbacks and reports variables with neither value nor fallback', () => {
    const variables = mergeVariables({ email: 'anon@example.com' })
    expect(renderMergeTemplate('Hi {{firstName|there}}, from {{company}}{{ unknown | }}', variables, 'text')).toEqual({ value: 'Hi there, from ', missing: ['company'] })
  })

  it('HTML-escapes substituted values but keeps editor-encoded fallbacks', () => {
    const variables = mergeVariables({ email: 'x@example.com', name: '<script>alert(1)</script> "Q"', fields: { team: 'A & B' } })
    const html = renderMergeTemplate('<p>{{name}} · {{team}} · {{company|Smith &amp; Co}} · {{&nbsp;firstName&nbsp;}}</p>', variables, 'html').value
    expect(html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; &quot;Q&quot; · A &amp; B · Smith &amp; Co · &lt;script&gt;alert(1)&lt;/script&gt;</p>')
    // Placeholders broken up by formatting tags are left alone rather than half-substituted.
    expect(renderMergeTemplate('{{first<b>Name</b>}}', variables, 'html').value).toBe('{{first<b>Name</b>}}')
  })

  it('strips line breaks from header values so subjects cannot inject headers', () => {
    const rendered = renderMergeMessage({ subject: 'Hello {{name}}{{company|\r\nX}}', text: 'Line\n{{name}}' }, { email: 'x@example.com', name: 'Eve\r\nBcc: victim@example.com' })
    expect(rendered.subject).toBe('Hello Eve Bcc: victim@example.comX')
    expect(rendered.subject).not.toMatch(/[\r\n]/)
    expect(rendered.text).toBe('Line\nEve\r\nBcc: victim@example.com')
    expect(rendered.html).toBeUndefined()
  })

  it('lists placeholders in first-use order', () => {
    expect(mergePlaceholders('{{firstName|there}} {{Company}} {{plan|free}}', '<p>{{first_name}} {{&nbsp;plan&nbsp;|basic}}</p>')).toEqual([
      { name: 'firstName', fallback: false }, { name: 'Company', fallback: false }, { name: 'plan', fallback: true }
    ])
  })
})

describe('mail merge recipients', () => {
  it('formats a single safe To address', () => {
    expect(mergeRecipientAddress({ email: 'ada@example.com', name: 'Ada "The" <Countess>\r\n' })).toBe('"Ada The Countess" <ada@example.com>')
    expect(mergeRecipientAddress({ email: 'ada@example.com' })).toBe('ada@example.com')
  })

  it('parses pasted address lists, dropping invalid and duplicate entries', () => {
    const list = parseMergeRecipientList('Ada <ada@example.com>, grace@example.com; ADA@example.com\nnot-an-address\n"Hopper, Grace" <g2@example.com>')
    expect(list.recipients).toEqual([
      { email: 'ada@example.com', name: 'Ada' },
      { email: 'grace@example.com' },
      { email: 'g2@example.com', name: 'Hopper, Grace' }
    ])
    expect(list).toMatchObject({ invalid: ['not-an-address'], duplicates: 1, columns: [] })
  })

  it('parses CSV with recognised and custom columns', () => {
    const list = parseMergeRecipientList('First Name,Last Name,E-mail Address,Organization,Plan\nAda,Lovelace,ada@example.com,Analytical,Pro\n,,bad,,\nGrace,,grace@example.com,,"Free, trial"')
    expect(list.columns).toEqual(['Plan'])
    expect(list.invalid).toEqual(['bad'])
    expect(list.recipients[0]).toMatchObject({ email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace', company: 'Analytical' })
    expect(renderMergeMessage({ subject: '{{plan}} for {{firstName}} at {{organization}}', text: '' }, list.recipients[1]).subject).toBe('Free, trial for Grace at')
    expect(renderMergeMessage({ subject: '{{plan}} for {{firstName}} at {{company}}', text: '' }, list.recipients[0]).subject).toBe('Pro for Ada at Analytical')
  })

  it('keeps addresses that would split into several recipients out of the list', () => {
    expect(normalizeMergeRecipients([{ email: 'a@example.com, b@example.com' }, { email: 'c@example.com\r\nBcc: d@example.com' }]).recipients).toEqual([])
  })

  it('maps address-book contacts and skips ones without an address', () => {
    expect(mergeRecipientsFromContacts([
      { id: '1', name: 'Ada Lovelace', email: 'ada@example.com', company: 'Analytical', title: 'Countess', group: 'Friends', favorite: false, color: '#000', nameParts: ['Lovelace', 'Ada', '', '', ''] },
      { id: '2', name: 'No Mail', email: '', group: 'Friends', favorite: false, color: '#000' }
    ])).toEqual([{ email: 'ada@example.com', name: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace', company: 'Analytical', fields: { title: 'Countess', group: 'Friends' } }])
  })
})

describe('mail merge limits', () => {
  it('defaults conservatively per provider and clamps user choices', () => {
    expect(mailMergeProviderLimits('gmail', 'me@gmail.com')).toMatchObject({ dailyCap: 400, maxDailyCap: 500 })
    expect(mailMergeProviderLimits('gmail', 'me@company.example')).toMatchObject({ maxDailyCap: 2_000 })
    expect(mailMergeProviderLimits('microsoft', 'me@outlook.com')).toMatchObject({ maxDailyCap: 300 })
    expect(mailMergeProviderLimits('imap')).toMatchObject({ perMinute: 10, dailyCap: 200 })
    expect(clampMailMergeLimits({ perMinute: 500, dailyCap: 9_999 }, 'gmail', 'me@gmail.com')).toEqual({ perMinute: 60, dailyCap: 500 })
    expect(clampMailMergeLimits({ perMinute: 0.5, dailyCap: -3 }, 'gmail', 'me@gmail.com')).toEqual({ perMinute: 1, dailyCap: 1 })
    expect(clampMailMergeLimits(undefined, 'yahoo')).toEqual({ perMinute: 10, dailyCap: 300 })
    expect(mailMergeDuration(450, { perMinute: 20, dailyCap: 400 })).toEqual({ days: 1, minutes: 20 })
  })
})
