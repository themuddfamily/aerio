import type { MailAccountSummary } from '../mail-types'

// Local Folders is a pseudo-account whose folders live only in Aerio's local
// mail store: there is no server, no credentials and nothing to synchronize.
export const LOCAL_FOLDERS_ACCOUNT_ID = 'local-folders'
export const LOCAL_FOLDER_DELIMITER = '/'

export const isLocalFoldersAccount = (account: Pick<MailAccountSummary, 'provider'> | undefined) => account?.provider === 'local'

export function localFoldersAccount(): MailAccountSummary {
  return {
    id: LOCAL_FOLDERS_ACCOUNT_ID,
    provider: 'local',
    email: 'Local Folders',
    displayName: 'Local Folders',
    color: '#7b8394',
    status: 'ready',
    archived: false,
    signature: '',
    notifications: false,
    syncEnabled: false
  }
}

export const MAIL_IMPORT_EXTENSIONS = ['mbox', 'mbx', 'eml', 'pst', 'ost']

export const mailImportExtension = (path: string) => {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

// Returns why a chosen file cannot be imported, or undefined when it can.
// Formats Aerio can't read are rejected explicitly instead of failing as "not mbox".
export function unsupportedMailImportReason(path: string) {
  const type = mailImportExtension(path)
  if (type === 'msg') return 'Outlook .msg files cannot be imported yet. Save the messages as .eml files, then import them.'
  if (type === 'emlx') return 'Apple Mail .emlx files cannot be imported directly. In Apple Mail choose Mailbox › Export Mailbox to create an MBOX, then import it.'
  return undefined
}

export type MailImportSourceKind = 'mbox' | 'eml' | 'pst'

// EML and Outlook data files (.pst, and .ost of the same format) are
// recognised by extension; everything else is read as mbox, which validates
// its own From_ framing.
export const mailImportSourceKind = (path: string): MailImportSourceKind => {
  const type = mailImportExtension(path)
  if (type === 'eml') return 'eml'
  if (type === 'pst' || type === 'ost') return 'pst'
  return 'mbox'
}
