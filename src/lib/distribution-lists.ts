// Distribution lists as the composer and Contacts view see them: explicit local lists, Google
// contact groups, and Outlook categories, each resolved to the member addresses a message goes to.
import type { Contact, ContactList } from '../types'
import type { SyncedContact, SyncedContactGroup } from '../productivity-types'
import { contactEmailAddresses, contactGroupNames, normalizedContactEmail } from './contact-fields'

export type RecipientListKind = 'list' | 'group' | 'category'

export interface RecipientListMember {
  email: string
  name?: string
  contactId?: string
}

export interface RecipientList {
  id: string
  name: string
  kind: RecipientListKind
  source: 'local' | 'gmail' | 'microsoft' | 'dav' | 'exchange'
  accountId?: string
  // Membership cannot be changed (provider editing not enabled, or a protected group).
  readOnly: boolean
  // Rename and delete are possible (local lists and Google user groups).
  manageable: boolean
  members: RecipientListMember[]
  // Members without a usable address, e.g. a Google group member with no email.
  unreachable: number
}

const isSynced = (contact: Contact): contact is SyncedContact => 'remoteId' in contact && 'accountId' in contact && 'provider' in contact

export const recipientListLabel = (list: Pick<RecipientList, 'kind' | 'source'>) =>
  list.kind === 'list' ? 'Local list' : list.kind === 'group' ? 'Google group' : 'Outlook category'

function memberOf(contact: Contact): RecipientListMember | undefined {
  const email = contactEmailAddresses(contact)[0]
  return email ? { email, name: contact.name, contactId: contact.id } : undefined
}

function dedupe(members: RecipientListMember[]) {
  const seen = new Set<string>()
  return members.filter((member) => {
    const key = normalizedContactEmail(member.email)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function buildRecipientLists(input: { contacts: Contact[]; lists?: ContactList[]; groups?: SyncedContactGroup[] }): RecipientList[] {
  const byId = new Map(input.contacts.map((contact) => [contact.id, contact]))
  const result: RecipientList[] = []
  for (const list of input.lists ?? []) {
    // A saved contact's current primary address wins over the address remembered in the list.
    const members = list.members.map((member) => {
      const contact = member.contactId ? byId.get(member.contactId) : undefined
      const current = contact ? memberOf(contact) : undefined
      return current ?? { email: member.email, ...(member.name ? { name: member.name } : {}), ...(member.contactId ? { contactId: member.contactId } : {}) }
    })
    result.push({ id: list.id, name: list.name, kind: 'list', source: 'local', readOnly: false, manageable: true, members: dedupe(members), unreachable: 0 })
  }
  const synced = input.contacts.filter(isSynced)
  for (const group of input.groups ?? []) {
    const people = synced.filter((contact) => contact.accountId === group.accountId && contact.groupIds?.includes(group.remoteId))
    const members = people.flatMap((contact) => memberOf(contact) ?? [])
    result.push({
      id: group.id, name: group.name, kind: 'group', source: group.provider, accountId: group.accountId,
      readOnly: group.readOnly, manageable: !group.readOnly && !group.system, members: dedupe(members), unreachable: people.length - members.length
    })
  }
  const categories = new Map<string, { accountId: string; name: string; people: SyncedContact[] }>()
  for (const contact of synced.filter((item) => item.provider === 'microsoft')) {
    for (const name of contact.groups ?? []) {
      const key = `${contact.accountId}\u0000${name.toLowerCase()}`
      const entry = categories.get(key) ?? { accountId: contact.accountId, name, people: [] }
      entry.people.push(contact)
      categories.set(key, entry)
    }
  }
  for (const [key, entry] of categories) {
    const members = entry.people.flatMap((contact) => memberOf(contact) ?? [])
    result.push({
      id: `category:${key.replace('\u0000', ':')}`, name: entry.name, kind: 'category', source: 'microsoft', accountId: entry.accountId,
      readOnly: entry.people.every((contact) => contact.readOnly), manageable: false, members: dedupe(members), unreachable: entry.people.length - members.length
    })
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

// Contacts that belong to a list, for filtering the Contacts view.
export function listContactIds(list: RecipientList, contacts: Contact[]) {
  const ids = new Set(list.members.flatMap((member) => member.contactId ? [member.contactId] : []))
  const emails = new Set(list.members.map((member) => normalizedContactEmail(member.email)))
  return new Set(contacts.filter((contact) => ids.has(contact.id) || contactEmailAddresses(contact).some((email) => emails.has(normalizedContactEmail(email)))).map((contact) => contact.id))
}

export function formatRecipient(member: RecipientListMember) {
  if (!member.name || normalizedContactEmail(member.name) === normalizedContactEmail(member.email)) return member.email
  const name = /[,;<>"]/.test(member.name) ? `"${member.name.replace(/["<>]/g, '')}"` : member.name
  return `${name} <${member.email}>`
}

export function recipientListPreview(list: RecipientList, shown = 3) {
  const names = list.members.slice(0, shown).map((member) => member.name || member.email)
  const more = list.members.length - names.length
  return `${names.join(', ')}${more > 0 ? ` +${more} more` : ''}` || 'No members with an email address'
}

export function suggestRecipientLists(query: string, lists: RecipientList[], limit = 4) {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  return lists.filter((list) => list.members.length && list.name.toLowerCase().includes(needle))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(needle)) - Number(!b.name.toLowerCase().startsWith(needle)))
    .slice(0, limit)
}

// Splits a recipient field on commas and semicolons outside quotes and angle brackets.
export function splitRecipients(value: string) {
  const parts: string[] = []
  let current = ''
  let angle = 0
  let quoted = false
  for (const character of value) {
    if (character === '"') quoted = !quoted
    if (!quoted && character === '<') angle += 1
    if (!quoted && character === '>') angle = Math.max(0, angle - 1)
    if (!quoted && angle === 0 && (character === ',' || character === ';')) {
      if (current.trim()) parts.push(current.trim())
      current = ''
    } else current += character
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

const tokenEmail = (token: string) => normalizedContactEmail(token.match(/<([^<>]+)>\s*$/)?.[1] ?? token)

export interface RecipientExpansion {
  value: string
  expanded: { list: RecipientList; added: number }[]
}

// Replaces recipient tokens that name a list (or the token at `replaceLast`) with the list's member
// addresses, skipping addresses already present in the field.
export function expandRecipientLists(value: string, lists: RecipientList[], pick?: RecipientList): RecipientExpansion {
  const tokens = splitRecipients(value)
  if (pick && !/[,;]\s*$/.test(value) && tokens.length) tokens.pop()
  const byName = new Map<string, RecipientList>()
  for (const list of lists) if (list.members.length && !byName.has(list.name.trim().toLowerCase())) byName.set(list.name.trim().toLowerCase(), list)
  const output: string[] = []
  const seen = new Set<string>()
  const expanded: RecipientExpansion['expanded'] = []
  const addList = (list: RecipientList) => {
    let added = 0
    for (const member of list.members) {
      const key = normalizedContactEmail(member.email)
      if (seen.has(key)) continue
      seen.add(key)
      output.push(formatRecipient(member))
      added += 1
    }
    expanded.push({ list, added })
  }
  for (const token of tokens) {
    const list = token.includes('@') ? undefined : byName.get(token.replace(/^"|"$/g, '').trim().toLowerCase())
    if (list) {
      addList(list)
      continue
    }
    const key = tokenEmail(token)
    if (seen.has(key)) continue
    seen.add(key)
    output.push(token)
  }
  if (pick) addList(pick)
  if (!expanded.length) return { value, expanded }
  return { value: output.length ? `${output.join(', ')}, ` : '', expanded }
}

export function describeExpansion(expansion: RecipientExpansion) {
  return expansion.expanded.map(({ list, added }) => `${list.name}: ${added} ${added === 1 ? 'recipient' : 'recipients'} added${list.unreachable ? ` (${list.unreachable} without email)` : ''}`).join('; ')
}

// Outlook categories are stored on each contact, so managing a category list means editing the
// members' category lists. Returns the contacts to save for each operation.
export function categoryMembershipEdits(
  contacts: Contact[],
  category: string,
  change: { add?: string[]; remove?: string[]; rename?: string }
): Contact[] {
  const add = new Set(change.add ?? [])
  const remove = new Set(change.remove ?? [])
  const lower = category.toLowerCase()
  return contacts.flatMap((contact) => {
    const groups = contactGroupNames(contact).filter((group) => group !== 'Outlook')
    const has = groups.some((group) => group.toLowerCase() === lower)
    let next = groups
    if (add.has(contact.id) && !has) next = [...groups, category]
    else if (remove.has(contact.id) && has) next = groups.filter((group) => group.toLowerCase() !== lower)
    else if (change.rename && has) next = groups.map((group) => group.toLowerCase() === lower ? change.rename! : group)
    else return []
    return [{ ...contact, groups: next, group: next[0] ?? 'Outlook' }]
  })
}
