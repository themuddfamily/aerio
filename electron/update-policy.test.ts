import { describe, expect, it } from 'vitest'
import { updateSupport } from './update-policy'

describe('updateSupport', () => {
  it('allows installed packaged Windows builds', () => {
    expect(updateSupport({ packaged: true, platform: 'win32', portable: false })).toEqual({ supported: true })
  })

  it('explains why development and portable builds cannot self-update', () => {
    expect(updateSupport({ packaged: false, platform: 'win32', portable: false })).toMatchObject({ supported: false, reason: expect.stringMatching(/installed release/) })
    expect(updateSupport({ packaged: true, platform: 'win32', portable: true })).toMatchObject({ supported: false, reason: expect.stringMatching(/Portable/) })
  })
})
