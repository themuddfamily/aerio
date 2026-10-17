import { describe, expect, it } from 'vitest'
import { defaultPop3Port, pop3RetentionEffects } from './pop3'

describe('POP3 helpers', () => {
  it('uses the standard ports', () => {
    expect(defaultPop3Port('tls')).toBe(995)
    expect(defaultPop3Port('starttls')).toBe(110)
    expect(defaultPop3Port('none')).toBe(110)
  })

  it('explains what each retention policy does on the server', () => {
    expect(pop3RetentionEffects({ leaveOnServer: true, removeWhenDeleted: false }).join(' ')).toMatch(/never removes anything/)
    const combined = pop3RetentionEffects({ leaveOnServer: true, deleteAfterDays: 1, removeWhenDeleted: true }).join(' ')
    expect(combined).toMatch(/1 day after/)
    expect(combined).toMatch(/moved to Trash in Aerio/)
    expect(combined).toMatch(/safely stored/)
    expect(pop3RetentionEffects({ leaveOnServer: false, removeWhenDeleted: false }).join(' ')).toMatch(/only copy/)
  })
})
