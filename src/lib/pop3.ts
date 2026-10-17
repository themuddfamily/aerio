import type { Pop3RetentionPolicy, Pop3Security } from '../pop3-types'

export const defaultPop3Port = (security: Pop3Security) => security === 'tls' ? 995 : 110

/** Plain-language effects of a retention policy on the POP3 server, shown before it is saved. */
export function pop3RetentionEffects(policy: Pop3RetentionPolicy): string[] {
  if (!policy.leaveOnServer) {
    return [
      'Each message is removed from the server after Aerio has saved it on this computer.',
      'Other devices and mail apps using this account will no longer receive those messages, and webmail will not show them.',
      'This computer then holds the only copy, so keep a profile backup.'
    ]
  }
  const effects = ['Messages stay on the server after download, so other devices and webmail still see them. Aerio downloads each message only once.']
  if (policy.deleteAfterDays) effects.push(`Messages are removed from the server ${policy.deleteAfterDays.toLocaleString()} day${policy.deleteAfterDays === 1 ? '' : 's'} after Aerio downloaded them, even if you keep them in Aerio.`)
  if (policy.removeWhenDeleted) effects.push('A message moved to Trash in Aerio (once its Undo window has passed), or deleted from Aerio entirely, is removed from the server at the next check. Restoring it from Trash afterwards does not put it back on the server.')
  if (!policy.deleteAfterDays && !policy.removeWhenDeleted) effects.push('Aerio never removes anything from the server; the mailbox keeps growing until it is cleaned up elsewhere.')
  effects.push('Nothing is removed from the server until the message is safely stored on this computer.')
  return effects
}
