import type { MailMessageSource } from '../../src/mail-types'

export function parseMessageSource(raw: Uint8Array): MailMessageSource {
  const source = Buffer.from(raw).toString('utf8')
  const separator = source.search(/\r?\n\r?\n/)
  return {
    headers: separator >= 0 ? source.slice(0, separator) : source,
    source
  }
}
