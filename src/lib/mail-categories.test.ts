import { describe, expect, it } from 'vitest'
import {
  classifyMailHeuristically,
  defaultInboxTabs,
  gmailCategoryLabelChange,
  inboxTabKeyTarget,
  inboxTabShortcutTarget,
  inboxTabsActive,
  isMailCategoryId,
  microsoftInferenceFor,
  normalizeCategoryRulePattern,
  normalizeInboxTabs,
  providerMailCategory,
  resolveMailCategory,
  validateCategoryRuleInput,
  visibleInboxTab
} from './mail-categories'

describe('inbox category provider mappings', () => {
  it('maps Gmail category labels one to one and CATEGORY_PERSONAL to Primary', () => {
    expect(providerMailCategory(['INBOX', 'CATEGORY_SOCIAL'])).toBe('social')
    expect(providerMailCategory(['CATEGORY_PROMOTIONS'])).toBe('promotions')
    expect(providerMailCategory(['CATEGORY_UPDATES'])).toBe('updates')
    expect(providerMailCategory(['CATEGORY_FORUMS'])).toBe('forums')
    expect(providerMailCategory(['CATEGORY_PERSONAL'])).toBe('primary')
    expect(providerMailCategory(['INBOX', 'UNREAD'])).toBeUndefined()
  })

  it('maps Outlook Focused to Primary and Other to the heuristic bucket or Updates', () => {
    expect(providerMailCategory(['INBOX', 'INFERENCE_FOCUSED'], 'promotions')).toBe('primary')
    expect(providerMailCategory(['INBOX', 'INFERENCE_OTHER'], 'social')).toBe('social')
    expect(providerMailCategory(['INBOX', 'INFERENCE_OTHER'], 'primary')).toBe('updates')
    expect(microsoftInferenceFor('primary')).toBe('focused')
    expect(microsoftInferenceFor('forums')).toBe('other')
  })

  it('adds the chosen Gmail category label and removes the other four', () => {
    expect(gmailCategoryLabelChange('social')).toEqual({ add: 'CATEGORY_SOCIAL', remove: ['CATEGORY_PERSONAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'] })
  })
})

describe('inbox category precedence', () => {
  it('prefers manual, then mail rules, sender rules, provider, heuristic, and Primary', () => {
    const all = { override: { category: 'social', source: 'manual' as const }, addressRule: 'updates', domainRule: 'forums', provider: 'promotions', heuristic: 'updates' }
    expect(resolveMailCategory(all)).toEqual({ category: 'social', source: 'manual' })
    expect(resolveMailCategory({ ...all, override: { category: 'forums', source: 'mail-rule' } })).toEqual({ category: 'forums', source: 'mail-rule' })
    expect(resolveMailCategory({ ...all, override: undefined })).toEqual({ category: 'updates', source: 'sender-rule' })
    expect(resolveMailCategory({ ...all, override: undefined, addressRule: undefined })).toEqual({ category: 'forums', source: 'sender-rule' })
    expect(resolveMailCategory({ provider: 'promotions', heuristic: 'updates' })).toEqual({ category: 'promotions', source: 'provider' })
    expect(resolveMailCategory({ heuristic: 'updates' })).toEqual({ category: 'updates', source: 'heuristic' })
    expect(resolveMailCategory({})).toEqual({ category: 'primary', source: 'default' })
    // Invalid stored values are ignored instead of hiding mail.
    expect(resolveMailCategory({ override: { category: 'bogus', source: 'manual' }, provider: 'social' })).toEqual({ category: 'social', source: 'provider' })
  })
})

describe('local heuristic classifier', () => {
  it('recognizes social networks, notifications, discussion lists, and bulk mail', () => {
    expect(classifyMailHeuristically({ fromEmail: 'notification@facebookmail.com' })).toBe('social')
    expect(classifyMailHeuristically({ fromEmail: 'messages-noreply@e.linkedin.com' })).toBe('social')
    expect(classifyMailHeuristically({ fromEmail: 'notifications@github.com', headers: { 'list-id': ['<repo.github.com>'] } })).toBe('updates')
    expect(classifyMailHeuristically({ fromEmail: 'robot@ci.example', headers: { 'auto-submitted': ['auto-generated'] } })).toBe('updates')
    expect(classifyMailHeuristically({ fromEmail: 'no-reply@bank.example' })).toBe('updates')
    expect(classifyMailHeuristically({ fromEmail: 'dev@lists.example', headers: { 'list-id': ['Dev <dev.lists.example>'], 'list-post': ['<mailto:dev@lists.example>'] } })).toBe('forums')
    expect(classifyMailHeuristically({ fromEmail: 'someone@example.org', headers: { 'list-id': ['<team.googlegroups.com>'] } })).toBe('forums')
    expect(classifyMailHeuristically({ fromEmail: 'news@shop.example', headers: { 'list-unsubscribe': ['<https://shop.example/u>'] } })).toBe('promotions')
    expect(classifyMailHeuristically({ fromEmail: 'no-reply@shop.example', headers: { 'list-unsubscribe': ['<https://shop.example/u>'] } })).toBe('promotions')
    expect(classifyMailHeuristically({ fromEmail: 'team@vendor.example', headers: { precedence: ['Bulk'] } })).toBe('promotions')
    expect(classifyMailHeuristically({ fromEmail: 'bounce@mail123.mcsv.net' })).toBe('promotions')
    expect(classifyMailHeuristically({ fromEmail: 'grace@example.org', headers: { 'auto-submitted': ['no'] } })).toBe('primary')
  })
})

describe('inbox tab configuration', () => {
  it('defaults to Primary, Social, Promotions, and Updates with Forums off', () => {
    const tabs = defaultInboxTabs().tabs
    expect(tabs.map((tab) => [tab.id, tab.enabled])).toEqual([['primary', true], ['social', true], ['promotions', true], ['updates', true], ['forums', false]])
    expect(inboxTabsActive(defaultInboxTabs())).toBe(true)
    expect(inboxTabsActive({ tabs: tabs.map((tab) => ({ ...tab, enabled: tab.id === 'primary' })) })).toBe(false)
    expect(inboxTabsActive(undefined)).toBe(false)
  })

  it('repairs, renames, reorders, and validates tabs', () => {
    const config = normalizeInboxTabs({ tabs: [
      { id: 'updates', name: '  Notices ', enabled: true },
      { id: 'primary', name: '', enabled: false },
      { id: 'custom:travel', name: 'Travel', enabled: true },
      { id: 'updates', name: 'Duplicate', enabled: false },
      { id: 'nope', name: 'Ignored', enabled: true }
    ] })
    expect(config.tabs.map((tab) => [tab.id, tab.name, tab.enabled, tab.builtIn])).toEqual([
      ['updates', 'Notices', true, true], ['primary', 'Primary', true, true], ['custom:travel', 'Travel', true, false],
      ['social', 'Social', false, true], ['promotions', 'Promotions', false, true], ['forums', 'Forums', false, true]
    ])
    expect(() => normalizeInboxTabs({ tabs: [{ id: 'custom:x', name: ' ', enabled: true }] })).toThrow('name')
    expect(() => normalizeInboxTabs('tabs')).toThrow('invalid')
    expect(() => normalizeInboxTabs({ tabs: Array.from({ length: 11 }, (_, index) => ({ id: `custom:t${index}`, name: `T${index}`, enabled: true })) })).toThrow('at most 10')
    expect(visibleInboxTab('custom:travel', config)).toBe('custom:travel')
    expect(visibleInboxTab('social', config)).toBe('primary')
    expect(visibleInboxTab('custom:gone', config)).toBe('primary')
  })
})

describe('classification rule validation', () => {
  it('normalizes addresses and domains and rejects anything else', () => {
    expect(normalizeCategoryRulePattern('address', ' News@Shop.Example ')).toBe('news@shop.example')
    expect(normalizeCategoryRulePattern('domain', '@Shop.Example')).toBe('shop.example')
    expect(normalizeCategoryRulePattern('domain', '*.shop.example')).toBe('shop.example')
    expect(normalizeCategoryRulePattern('domain', 'shop%')).toBeUndefined()
    expect(normalizeCategoryRulePattern('address', 'no-at-sign')).toBeUndefined()
    expect(validateCategoryRuleInput({ kind: 'domain', pattern: 'Example.com', category: 'social' })).toEqual({ kind: 'domain', pattern: 'example.com', category: 'social' })
    expect(() => validateCategoryRuleInput({ kind: 'domain', pattern: 'example.com', category: 'spam' })).toThrow('inbox tab')
    expect(() => validateCategoryRuleInput({ kind: 'regex', pattern: '.*', category: 'social' })).toThrow('address or domain')
    expect(isMailCategoryId('custom:abc-1')).toBe(true)
    expect(isMailCategoryId('custom:../x')).toBe(false)
  })
})

describe('inbox tab keyboard navigation', () => {
  it('moves through the tab list with arrows, Home, and End, wrapping at the ends', () => {
    expect(inboxTabKeyTarget('ArrowRight', 0, 4)).toBe(1)
    expect(inboxTabKeyTarget('ArrowRight', 3, 4)).toBe(0)
    expect(inboxTabKeyTarget('ArrowLeft', 0, 4)).toBe(3)
    expect(inboxTabKeyTarget('Home', 2, 4)).toBe(0)
    expect(inboxTabKeyTarget('End', 0, 4)).toBe(3)
    expect(inboxTabKeyTarget('Enter', 0, 4)).toBeUndefined()
  })

  it('switches tabs with Alt+arrows and Alt+digits only', () => {
    const key = (overrides: Partial<KeyboardEvent>) => ({ altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, key: '', code: '', ...overrides })
    expect(inboxTabShortcutTarget(key({ key: 'ArrowRight' }), 1, 4)).toBe(2)
    expect(inboxTabShortcutTarget(key({ key: 'ArrowLeft' }), 0, 4)).toBe(3)
    expect(inboxTabShortcutTarget(key({ key: '3', code: 'Digit3' }), 0, 4)).toBe(2)
    expect(inboxTabShortcutTarget(key({ key: '9', code: 'Digit9' }), 0, 4)).toBeUndefined()
    expect(inboxTabShortcutTarget(key({ key: 'ArrowRight', ctrlKey: true }), 0, 4)).toBeUndefined()
    expect(inboxTabShortcutTarget(key({ key: 'ArrowRight', altKey: false }), 0, 4)).toBeUndefined()
  })
})
