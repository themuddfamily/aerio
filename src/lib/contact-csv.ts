// RFC 4180 CSV parsing and contact column mapping for Google, Outlook, and generic exports.
import type { Contact, ContactField } from '../types'
import type { CsvTable } from '../interchange-types'
import { InterchangeFormatError } from './content-lines'

export const CSV_LIMITS = { maxChars: 20 * 1024 * 1024, maxRows: 20_000, maxColumns: 300, maxCellLength: 100_000 }

export type CsvContactField =
  | 'ignore' | 'name' | 'firstName' | 'middleName' | 'lastName' | 'email' | 'phone' | 'company' | 'title'
  | 'notes' | 'group' | 'address' | 'url' | 'birthday' | 'nickname' | 'uid'

export const CSV_FIELD_LABELS: Record<CsvContactField, string> = {
  ignore: 'Do not import', name: 'Full name', firstName: 'First name', middleName: 'Middle name', lastName: 'Last name',
  email: 'Email', phone: 'Phone', company: 'Company', title: 'Job title', notes: 'Notes', group: 'Group',
  address: 'Address', url: 'Website', birthday: 'Birthday', nickname: 'Nickname', uid: 'Source ID'
}

// Fields that may be mapped from several columns; the rest take the first non-empty mapped column.
const MULTI_FIELDS = new Set<CsvContactField>(['email', 'phone', 'address', 'url', 'notes'])

function detectDelimiter(text: string) {
  const counts = { ',': 0, ';': 0, '\t': 0 }
  let quoted = false
  for (const character of text.slice(0, 64 * 1024)) {
    if (character === '"') quoted = !quoted
    else if (!quoted && (character === '\n' || character === '\r')) break
    else if (!quoted && character in counts) counts[character as keyof typeof counts]++
  }
  const [best, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  return (count > 0 ? best : ',') as ',' | ';' | '\t'
}

export function parseCsv(input: string, limits = CSV_LIMITS): CsvTable {
  if (input.length > limits.maxChars) throw new InterchangeFormatError('The file is larger than the 20 MB import limit')
  const text = input.replace(/^﻿/, '')
  const delimiter = detectDelimiter(text)
  const records: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let index = 0
  const pushCell = () => {
    if (cell.length > limits.maxCellLength) throw new InterchangeFormatError('A CSV cell is too long to import safely')
    row.push(cell)
    cell = ''
    if (row.length > limits.maxColumns) throw new InterchangeFormatError(`The CSV file has more than ${limits.maxColumns} columns`)
  }
  const pushRow = () => {
    pushCell()
    if (row.some((value) => value.trim())) {
      records.push(row)
      if (records.length > limits.maxRows + 1) throw new InterchangeFormatError(`The CSV file has more than ${limits.maxRows.toLocaleString('en-US')} rows`)
    }
    row = []
  }
  while (index < text.length) {
    const character = text[index]
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') { cell += '"'; index++ }
        else quoted = false
      } else cell += character
    } else if (character === '"' && cell.trim() === '') {
      cell = ''
      quoted = true
    } else if (character === delimiter) pushCell()
    else if (character === '\r' || character === '\n') {
      if (character === '\r' && text[index + 1] === '\n') index++
      pushRow()
    } else cell += character
    index++
  }
  if (quoted) throw new InterchangeFormatError('The CSV file has an unterminated quoted value')
  if (cell || row.length) pushRow()
  if (!records.length) throw new InterchangeFormatError('The CSV file is empty')
  const headers = records[0].map((header, position) => header.trim() || `Column ${position + 1}`)
  const rows = records.slice(1).map((record) => headers.map((_header, position) => (record[position] ?? '').trim()))
  return { headers, rows }
}

const HEADER_RULES: [RegExp, CsvContactField][] = [
  [/^(display ?name|full ?name|name|contact ?name|formatted ?name)$/, 'name'],
  [/^(first|given)( ?name)?$/, 'firstName'],
  [/^(middle|additional)( ?name)?$/, 'middleName'],
  [/^(last|family|sur)( ?name)?$/, 'lastName'],
  [/^nick ?name$/, 'nickname'],
  [/e-?mail|email/, 'email'],
  [/\bphone\b|mobile|\bcell|\bfax\b|pager|telephone|^tel\b/, 'phone'],
  [/^(company|organi[sz]ation( 1)?( - )?( ?name)?|organi[sz]ation name|org|employer)$/, 'company'],
  [/^(job ?title|organi[sz]ation( 1)?( - )?title|organi[sz]ation title|position|role)$/, 'title'],
  [/^(notes?|comments?|description)$/, 'notes'],
  [/^(group membership|groups?|categories|category|labels?)$/, 'group'],
  [/address|street/, 'address'],
  [/web ?(page|site)|website|^url|homepage/, 'url'],
  [/birthday|date of birth|^bday/, 'birthday'],
  [/^(uid|id|contact id|source id)$/, 'uid']
]

// Columns that describe another column (types, labels) rather than carrying a value are left unmapped.
const DESCRIPTIVE = /( - )?(type|label)$|display$|^e-?mail ?(type|display name)/

export function suggestCsvMapping(headers: string[]): CsvContactField[] {
  return headers.map((header) => {
    const normalized = header.toLowerCase().replace(/[_\s]+/g, ' ').trim()
    if (DESCRIPTIVE.test(normalized) && !/^(display ?name)$/.test(normalized)) return 'ignore'
    if (/^title$/.test(normalized)) return 'ignore' // Outlook uses "Title" for honorifics such as "Dr."
    // Google splits each address into parts beside a "Formatted" column; import only the formatted value.
    if (/^address \d+ - /.test(normalized) && !/formatted$/.test(normalized)) return 'ignore'
    for (const [pattern, field] of HEADER_RULES) if (pattern.test(normalized)) return field
    return 'ignore'
  })
}

function fieldType(header: string, field: CsvContactField) {
  const normalized = header.toLowerCase()
  if (field === 'phone') {
    if (/mobile|cell/.test(normalized)) return 'cell'
    if (/fax/.test(normalized)) return 'fax'
    if (/pager/.test(normalized)) return 'pager'
  }
  if (/business|work|office|company/.test(normalized)) return 'work'
  if (/home|personal|private/.test(normalized)) return 'home'
  return undefined
}

export interface CsvMappingOptions {
  idFactory(): string
  color?: string
  group?: string
}

export interface CsvMappingResult {
  contacts: Contact[]
  skipped: number
}

export function contactsFromCsv(table: CsvTable, mapping: CsvContactField[], options: CsvMappingOptions): CsvMappingResult {
  const contacts: Contact[] = []
  let skipped = 0
  for (const row of table.rows) {
    const single = new Map<CsvContactField, string>()
    const multi = new Map<CsvContactField, ContactField[]>()
    mapping.forEach((field, column) => {
      const value = row[column]?.trim()
      if (!value || field === 'ignore') return
      if (MULTI_FIELDS.has(field)) {
        // Google exports several values in one cell separated by " ::: ".
        const values = field === 'notes' ? [value] : value.split(/\s*:::\s*/).filter(Boolean)
        const type = fieldType(table.headers[column], field)
        multi.set(field, [...(multi.get(field) ?? []), ...values.map((item) => ({ value: item, ...(type ? { type } : {}) }))])
      } else if (!single.has(field)) single.set(field, value)
    })
    const emails = (multi.get('email') ?? []).filter((field) => field.value.length <= 500).slice(0, 50)
    const phones = (multi.get('phone') ?? []).filter((field) => field.value.length <= 200).slice(0, 50)
    const addresses = (multi.get('address') ?? []).slice(0, 50)
    const urls = (multi.get('url') ?? []).slice(0, 50)
    const notes = (multi.get('notes') ?? []).map((field) => field.value).join('\n\n')
    const nameParts = [single.get('lastName') ?? '', single.get('firstName') ?? '', single.get('middleName') ?? '', '', '']
    const composed = [single.get('firstName'), single.get('middleName'), single.get('lastName')].filter(Boolean).join(' ')
    const name = (single.get('name') || composed || single.get('company') || emails[0]?.value || '').slice(0, 500)
    if (!name) {
      skipped++
      continue
    }
    const group = single.get('group')?.split(/\s*:::\s*|\s*;\s*/).map((value) => value.replace(/^\*\s*/, '').trim()).find((value) => value && value !== 'myContacts')
    contacts.push({
      id: options.idFactory(),
      name,
      email: emails[0]?.value ?? '',
      ...(phones[0] ? { phone: phones[0].value } : {}),
      ...(single.get('company') ? { company: single.get('company')!.slice(0, 500) } : {}),
      ...(single.get('title') ? { title: single.get('title')!.slice(0, 500) } : {}),
      group: (group || options.group || 'Imported').slice(0, 300),
      ...(notes ? { notes: notes.slice(0, 100_000) } : {}),
      favorite: false,
      color: options.color ?? '#4d8f78',
      ...(emails.length ? { emails } : {}),
      ...(phones.length ? { phones } : {}),
      ...(addresses.length ? { addresses } : {}),
      ...(urls.length ? { urls } : {}),
      ...(nameParts.some(Boolean) ? { nameParts } : {}),
      ...(single.get('nickname') ? { nickname: single.get('nickname') } : {}),
      ...(single.get('birthday') ? { birthday: single.get('birthday')!.slice(0, 50) } : {}),
      ...(single.get('uid') ? { sourceUid: single.get('uid')!.slice(0, 1_000) } : {})
    })
  }
  return { contacts, skipped }
}

const csvCell = (value: string | undefined) => {
  const text = value ?? ''
  // Prefix formula-like values so spreadsheet apps do not execute them.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function serializeContactsCsv(contacts: Contact[]) {
  const header = ['Name', 'First Name', 'Last Name', 'Email', 'Email 2', 'Phone', 'Phone 2', 'Company', 'Job Title', 'Address', 'Website', 'Birthday', 'Group', 'Notes', 'Source ID']
  const rows = contacts.map((contact) => {
    const emails = contact.emails?.length ? contact.emails.map((field) => field.value) : [contact.email].filter(Boolean)
    const phones = contact.phones?.length ? contact.phones.map((field) => field.value) : [contact.phone ?? ''].filter(Boolean)
    return [
      contact.name, contact.nameParts?.[1], contact.nameParts?.[0], emails[0], emails.slice(1).join(' ::: '), phones[0], phones.slice(1).join(' ::: '),
      contact.company, contact.title, contact.addresses?.[0]?.value, contact.urls?.[0]?.value, contact.birthday, contact.group, contact.notes, contact.sourceUid
    ].map(csvCell).join(',')
  })
  return `﻿${[header.join(','), ...rows].join('\r\n')}\r\n`
}
