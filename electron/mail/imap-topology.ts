/** A server mailbox rename/delete can invalidate a concurrent inventory pass. */
export class ImapTopology {
  private readonly revisions = new Map<string, number>()
  private readonly mutations = new Map<string, Promise<unknown>>()
  private revision(accountId: string) { return this.revisions.get(accountId) ?? 0 }
  mutate<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
    this.revisions.set(accountId, this.revision(accountId) + 1)
    const previous = this.mutations.get(accountId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(operation)
    this.mutations.set(accountId, next)
    const cleanup = () => { if (this.mutations.get(accountId) === next) this.mutations.delete(accountId) }
    void next.then(cleanup, cleanup)
    return next
  }
  async stable<T>(accountId: string, read: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      // A failed mutation must still release inventory; its caller receives the error.
      while (this.mutations.has(accountId)) await this.mutations.get(accountId)!.catch(() => {})
      const revision = this.revision(accountId)
      try {
        const result = await read()
        if (this.revision(accountId) === revision) return result
      } catch (error) { if (this.revision(accountId) === revision) throw error }
    }
    throw new Error('IMAP folders changed repeatedly during synchronization. Refresh after folder changes finish.')
  }
}
