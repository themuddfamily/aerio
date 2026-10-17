import type { MailImportance, MailProviderId, MailReadReceiptPolicy, MailSendOptions } from '../mail-types'

const importanceValues = new Set<MailImportance>(['low', 'normal', 'high'])
const policyValues = new Set<MailReadReceiptPolicy>(['never', 'ask', 'always'])

// Drops unknown values so a stale or tampered draft can never smuggle headers.
export function normalizeSendOptions(value: unknown): MailSendOptions | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  const options: MailSendOptions = {}
  if (importanceValues.has(candidate.importance as MailImportance) && candidate.importance !== 'normal') options.importance = candidate.importance as MailImportance
  if (candidate.requestReadReceipt === true) options.requestReadReceipt = true
  if (candidate.requestDeliveryReceipt === true) options.requestDeliveryReceipt = true
  return Object.keys(options).length ? options : undefined
}

export function hasSendOptions(options?: MailSendOptions) {
  return Boolean(normalizeSendOptions(options))
}

export function normalizeReadReceiptPolicy(value: unknown): MailReadReceiptPolicy {
  return policyValues.has(value as MailReadReceiptPolicy) ? value as MailReadReceiptPolicy : 'ask'
}

export type ReceiptSupportLevel = 'native' | 'header' | 'smtp-dsn' | 'unsupported'

export interface ProviderReceiptSupport {
  importance: ReceiptSupportLevel
  readReceipt: ReceiptSupportLevel
  deliveryReceipt: ReceiptSupportLevel
  note: string
}

// What each provider path actually does with the request. None of these are a
// guarantee: recipients and their servers may ignore or refuse receipts.
export function providerReceiptSupport(provider?: MailProviderId): ProviderReceiptSupport {
  if (provider === 'microsoft') {
    return {
      importance: 'native',
      readReceipt: 'native',
      deliveryReceipt: 'native',
      note: 'Outlook stores these as message properties. Recipients can decline read receipts, and other servers may not return delivery reports.'
    }
  }
  if (provider === 'exchange') {
    return {
      importance: 'header',
      readReceipt: 'native',
      deliveryReceipt: 'native',
      note: 'Exchange stores read and delivery receipt requests as message properties. Recipients can decline read receipts, and other servers may not return delivery reports.'
    }
  }
  if (provider === 'gmail') {
    return {
      importance: 'header',
      readReceipt: 'header',
      deliveryReceipt: 'unsupported',
      note: 'Gmail sends the read-receipt request header, but only the recipient’s mail app decides whether to answer. Gmail does not offer delivery receipts.'
    }
  }
  return {
    importance: 'header',
    readReceipt: 'header',
    deliveryReceipt: 'smtp-dsn',
    note: 'Delivery receipts are requested from your outgoing server and only work when it supports delivery status notifications. Read receipts depend on the recipient’s mail app.'
  }
}

// Applies provider support so an unsupported request is not silently kept.
export function supportedSendOptions(options: MailSendOptions | undefined, provider?: MailProviderId): MailSendOptions | undefined {
  const normalized = normalizeSendOptions(options)
  if (!normalized) return undefined
  const support = providerReceiptSupport(provider)
  const next = { ...normalized }
  if (support.deliveryReceipt === 'unsupported') delete next.requestDeliveryReceipt
  if (support.readReceipt === 'unsupported') delete next.requestReadReceipt
  return normalizeSendOptions(next)
}
