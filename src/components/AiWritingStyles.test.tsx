// @vitest-environment jsdom
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import AiWritingStyles from './AiWritingStyles'
import type { AiAssistantStatus } from '../ai-assistant-types'
const learn = vi.fn()
const status = { provider: 'anthropic', enabled: true, model: 'test' } as AiAssistantStatus
beforeEach(() => {
  vi.clearAllMocks()
  learn.mockResolvedValue('Friendly short sentences.')
  Object.defineProperty(window, 'aerio', { configurable: true, value: { ai: { learnStyle: learn, cancel: vi.fn().mockResolvedValue(true) }, mail: { accounts: { list: vi.fn().mockResolvedValue([{ id: 'a', email: 'a@example.test' }, { id: 'b', email: 'b@example.test' }]) } } } })
})
function Example() {
  const [styles, setStyles] = useState<Record<string, string>>({ a: 'Formal', b: 'Casual' })
  return <AiWritingStyles status={status} value={styles} onChange={setStyles} />
}
it('isolates styles, analyzes only on click and applies an editable preview explicitly', async () => {
  const user = userEvent.setup()
  render(<Example />)
  const preferences = await screen.findByLabelText('Saved writing preferences')
  expect(preferences).toHaveValue('Formal')
  await user.selectOptions(screen.getByLabelText('Writing style account'), 'b')
  expect(preferences).toHaveValue('Casual')
  await user.type(screen.getByLabelText('Optional selected sent-mail examples'), 'Thanks. See you soon.')
  expect(learn).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Analyze selected examples' }))
  expect(await screen.findByLabelText('Writing style preview')).toHaveValue('Friendly short sentences.')
  expect(preferences).toHaveValue('Casual')
  await user.click(screen.getByRole('button', { name: 'Use this style' }))
  expect(preferences).toHaveValue('Friendly short sentences.')
  await user.selectOptions(screen.getByLabelText('Writing style account'), 'a')
  expect(preferences).toHaveValue('Formal')
})
