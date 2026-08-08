export function isCompleteMailAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 500) return false
  const candidate = value.match(/<([^<>]+)>\s*$/)?.[1] ?? value
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(candidate.trim())
}

export function draftRecipientsAreSyncable(to: string[], cc: string[], bcc: string[]) {
  return [...to, ...cc, ...bcc].every(isCompleteMailAddress)
}
