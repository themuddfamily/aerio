import type { MailAttachmentTextIndex } from '../mail-types'

/**
 * Describes whether an attachment's contents can be found by search. `notice`
 * is set only when a file that looks searchable couldn't be indexed, so the
 * attachment card stays quiet for images and other unsupported types.
 */
export function attachmentSearchStatus(index?: MailAttachmentTextIndex): { label: string; notice?: string } | undefined {
  if (!index) return undefined
  switch (index.status) {
    case 'pending': return { label: 'Contents will be searchable after indexing' }
    case 'indexed': return index.truncated
      ? { label: 'Only the first part of the contents is searchable', notice: 'Partly searchable' }
      : { label: 'Contents are searchable' }
    case 'empty': return { label: index.detail ?? 'No searchable text was found' }
    case 'unsupported': return { label: 'Contents of this file type are not searchable' }
    case 'encrypted': return { label: 'Password-protected; contents are not searchable', notice: 'Password-protected' }
    case 'too-large': return { label: 'Too large to search its contents', notice: 'Too large to search' }
    case 'timeout':
    case 'memory-limit':
    case 'failed': return { label: `Contents could not be read for search${index.detail ? `: ${index.detail}` : ''}`, notice: 'Not searchable' }
  }
}
