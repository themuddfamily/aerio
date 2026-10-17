import { describe, expect, it } from 'vitest'
import { hasSendOptions, normalizeReadReceiptPolicy, normalizeSendOptions, providerReceiptSupport, supportedSendOptions } from './mail-send-options'

describe('mail send options', () => {
  it('keeps only known non-default choices', () => {
    expect(normalizeSendOptions({ importance: 'high', requestReadReceipt: true, requestDeliveryReceipt: 'yes', extra: 1 })).toEqual({ importance: 'high', requestReadReceipt: true })
    expect(normalizeSendOptions({ importance: 'normal', requestReadReceipt: false })).toBeUndefined()
    expect(normalizeSendOptions({ importance: 'urgent' })).toBeUndefined()
    expect(normalizeSendOptions('high')).toBeUndefined()
    expect(hasSendOptions({ importance: 'low' })).toBe(true)
    expect(hasSendOptions(undefined)).toBe(false)
  })

  it('defaults the incoming read-receipt policy to asking', () => {
    expect(normalizeReadReceiptPolicy(undefined)).toBe('ask')
    expect(normalizeReadReceiptPolicy('sometimes')).toBe('ask')
    expect(normalizeReadReceiptPolicy('never')).toBe('never')
    expect(normalizeReadReceiptPolicy('always')).toBe('always')
  })

  it('describes provider receipt support and drops unsupported delivery receipts for Gmail', () => {
    expect(providerReceiptSupport('microsoft')).toMatchObject({ importance: 'native', readReceipt: 'native', deliveryReceipt: 'native' })
    expect(providerReceiptSupport('gmail').deliveryReceipt).toBe('unsupported')
    expect(providerReceiptSupport('fastmail').deliveryReceipt).toBe('smtp-dsn')
    expect(supportedSendOptions({ requestDeliveryReceipt: true }, 'gmail')).toBeUndefined()
    expect(supportedSendOptions({ requestDeliveryReceipt: true, importance: 'high' }, 'gmail')).toEqual({ importance: 'high' })
    expect(supportedSendOptions({ requestDeliveryReceipt: true }, 'imap')).toEqual({ requestDeliveryReceipt: true })
  })
})
