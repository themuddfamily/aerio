// Sender identities (From aliases) and reusable HTML signatures. Provider
// identities come from Gmail send-as settings or Microsoft proxy addresses;
// IMAP aliases (and Microsoft shared/send-as mailboxes) are added manually.

export type MailSenderIdentitySource = 'primary' | 'gmail' | 'microsoft' | 'manual'

/**
 * `verified`: the provider says this address may be used. `pending`: the
 * provider knows the alias but has not confirmed it (Gmail verification).
 * `unverified`: configured locally; the provider decides when sending.
 */
export type MailSenderIdentityStatus = 'verified' | 'pending' | 'unverified'

export interface MailSenderIdentity {
  /** `<accountId>:primary` for the account's own address. */
  id: string
  accountId: string
  email: string
  name: string
  replyTo: string[]
  source: MailSenderIdentitySource
  status: MailSenderIdentityStatus
  /** Default From for new messages from this account (exactly one per account). */
  isDefault: boolean
  /** Signature inserted into new messages; unset falls back to the legacy account signature for the primary identity. */
  newSignatureId?: string
  /** Signature inserted into replies and forwards. */
  replySignatureId?: string
  createdAt: string
  updatedAt: string
}

export interface MailSenderIdentityInput {
  id?: string
  accountId: string
  /** Only manual identities may change their address. */
  email: string
  name: string
  replyTo?: string[]
  isDefault?: boolean
  /** Empty string clears the assignment. */
  newSignatureId?: string
  replySignatureId?: string
}

export interface MailSignature {
  id: string
  name: string
  /** Sanitized composer HTML. */
  html: string
  text: string
  createdAt: string
  updatedAt: string
}

export interface MailSignatureInput {
  id?: string
  name: string
  html: string
}

export interface MailIdentitiesApi {
  list(accountIds?: string[]): Promise<MailSenderIdentity[]>
  save(input: MailSenderIdentityInput): Promise<MailSenderIdentity>
  delete(id: string): Promise<void>
  /** Re-reads provider-authorized addresses (Gmail send-as, Microsoft proxy addresses). */
  refresh(accountId: string): Promise<MailSenderIdentity[]>
  signatures: {
    list(): Promise<MailSignature[]>
    save(input: MailSignatureInput): Promise<MailSignature>
    delete(id: string): Promise<void>
  }
}

export const primaryIdentityId = (accountId: string) => `${accountId}:primary`
