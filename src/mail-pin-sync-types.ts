/** This is Aerio's dedicated server keyword, not an Outlook/eM Client pin property. */
export const AERIO_PIN_KEYWORD = '$AerioPinned'
export const AERIO_PIN_LABEL = `keyword:${AERIO_PIN_KEYWORD}`
export interface MailPinSyncSupport { mode: 'imap-keyword' | 'local-only'; reason: string }
export interface ImapPinTarget { folder: string; uid: number; uidValidity: string }
export function imapPinSupport(mailbox: { permanentFlags?: Set<string>; readOnly?: boolean } | false | undefined): MailPinSyncSupport {
  if (!mailbox || mailbox.readOnly) return { mode: 'local-only', reason: 'Pins stay on this computer: the IMAP folder is read-only or unavailable.' }
  const flags = [...(mailbox.permanentFlags ?? [])].map((flag) => flag.toLowerCase())
  if (flags.includes('\\*') || flags.includes(AERIO_PIN_KEYWORD.toLowerCase())) return { mode: 'imap-keyword', reason: `Pins sync between Aerio installations using the IMAP ${AERIO_PIN_KEYWORD} keyword. Other mail clients may not recognize it.` }
  return { mode: 'local-only', reason: 'Pins stay on this computer: this folder has not advertised permanent custom keyword support.' }
}
