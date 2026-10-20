// @vitest-environment jsdom
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EventRemindersField } from './EventRemindersField'

function Editor({ limit = 5, disabled = false }: { limit?: number; disabled?: boolean }) {
  const [value, setValue] = useState<number[]>([15])
  return <><EventRemindersField value={value} onChange={setValue} limit={limit} disabled={disabled} /><output>{JSON.stringify(value)}</output></>
}

describe('event reminder list editor', () => {
  it('adds, changes, and removes offsets through to an explicitly disabled list', () => {
    render(<Editor />)
    fireEvent.click(screen.getByRole('button', { name: 'Add reminder' }))
    expect(screen.getByRole('status')).toHaveTextContent('[15,30]')
    fireEvent.change(screen.getByLabelText('Reminder 2 (minutes before start)'), { target: { value: '0' } })
    expect(screen.getByRole('status')).toHaveTextContent('[15,0]')
    fireEvent.click(screen.getByRole('button', { name: 'Remove reminder 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove reminder 1' }))
    expect(screen.getByRole('status')).toHaveTextContent('[]')
    expect(screen.getByText('No reminders')).toBeInTheDocument()
  })

  it('enforces the provider reminder count and read-only access', () => {
    const { unmount } = render(<Editor limit={1} />)
    expect(screen.getByRole('button', { name: 'Add reminder' })).toBeDisabled()
    unmount()
    render(<Editor disabled />)
    expect(screen.getByLabelText('Reminder 1 (minutes before start)')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove reminder 1' })).toBeDisabled()
  })
})
