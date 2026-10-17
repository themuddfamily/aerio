// Before a CalDAV or Exchange account is removed, its cached notes go with it
// (docs/server-notes.md). This warns about notes and unsent note changes and offers to copy them
// into Local Notes first. Returns false only when copying was requested and failed, so the
// removal should stop.
export async function confirmServerNotesRemoval(accountId: string, accountName: string): Promise<boolean> {
  const api = window.aerio?.serverNotes
  if (!api) return true
  let summary
  try { summary = await api.accountSummary(accountId) } catch { return true }
  if (!summary.notes && !summary.pendingWrites && !summary.review) return true
  const unsent = summary.pendingWrites + summary.review
  const copy = window.confirm(`${accountName} has ${summary.notes} synchronized note${summary.notes === 1 ? '' : 's'} in Aerio${unsent ? `, including ${unsent} change${unsent === 1 ? '' : 's'} not yet accepted by the server` : ''}. Removing the account removes them from Aerio; nothing is deleted on the server.\n\nOK copies these notes (with your unsent changes) into Local Notes first. Cancel removes them without copying.`)
  if (!copy) return true
  try {
    await api.copyAccountToLocal(accountId)
    return true
  } catch (error) {
    window.alert(`The notes could not be copied to Local Notes, so the account was not removed. ${error instanceof Error ? error.message : ''}`.trim())
    return false
  }
}
