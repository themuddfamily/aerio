import type { MailFolder } from './mail-types'
export interface MailUnifiedView {
  id: string
  name: string
  accountIds: string[]
  /** A folder override can narrow the view's base membership, including to no accounts. */
  folderAccountIds?: Partial<Record<MailFolder, string[]>>
}
export interface MailUnifiedViewsSnapshot { views: MailUnifiedView[]; selectedId?: string }
export interface MailUnifiedViewsApi {
  snapshot(): Promise<MailUnifiedViewsSnapshot>
  save(view: Omit<MailUnifiedView, 'id'> & { id?: string }): Promise<MailUnifiedViewsSnapshot>
  remove(id: string): Promise<MailUnifiedViewsSnapshot>
  select(id?: string): Promise<MailUnifiedViewsSnapshot>
  onChanged(callback: (snapshot: MailUnifiedViewsSnapshot) => void): () => void
}
